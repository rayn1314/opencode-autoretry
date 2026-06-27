import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import type { Event, AssistantMessage, Part } from "@opencode-ai/sdk"

/**
 * 自动重试配置接口
 */
interface AutoRetryConfig {
  enabled: boolean
  maxRetries: number
  backoffMs: number[]
  /** 触发重试的错误类型（按 watchdog 分类） */
  retryOn: Array<"输出截断" | "静默中断" | "数据流截断" | "连接断开" | "请求超时">
}

/** 默认配置 */
const DEFAULT_CONFIG: AutoRetryConfig = {
  enabled: true,
  maxRetries: 3,
  backoffMs: [3000, 6000, 12000],
  retryOn: ["输出截断", "静默中断", "数据流截断", "连接断开", "请求超时"],
}

/** 会话重试计数器 */
const sessionRetryCount = new Map<string, number>()

/** 重试定时器 */
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * 错误分类结果（移植自 watchdog classify.js）
 */
interface ClassifyResult {
  tag: string
  kind: "interrupt" | "warn" | "skip"
  tip: string
}

/**
 * 错误分类逻辑（移植自 watchdog）
 * @param msg - AssistantMessage 对象
 * @returns 分类结果
 */
function classifyInterrupt(msg: AssistantMessage): ClassifyResult {
  const errName = msg.error?.name
  const errMsg = (msg.error as any)?.data?.message ?? ""
  const outTok = msg.tokens?.output ?? 0

  // 1. 用户主动中止：跳过
  if (errName === "MessageAbortedError") {
    return { tag: "用户中止", kind: "skip", tip: "" }
  }

  // 2. 输出被截断：output>0 但 finish=unknown
  if (outTok > 0) {
    return {
      tag: "输出截断",
      kind: "interrupt",
      tip: "AI 说到一半被中途截断了。自动发送「继续」让它接着说。",
    }
  }

  // 3. 静默中断：output=0 且无 error
  if (!errName) {
    return {
      tag: "静默中断",
      kind: "interrupt",
      tip: "请求发出去了，但什么都没返回。自动重试上一条消息。",
    }
  }

  // 4. 有 error 的细分：按错误内容归类
  if (/JSON parsing|JSON Parse|Unterminated/i.test(errMsg)) {
    return {
      tag: "数据流截断",
      kind: "interrupt",
      tip: "上游把响应流中途掐断了。自动发送「继续」恢复。",
    }
  }
  if (/Connection failed|Server disconnected|ECONNRESET|fetch failed|socket/i.test(errMsg)) {
    return {
      tag: "连接断开",
      kind: "interrupt",
      tip: "与 AI 服务商的连接断了。自动重试。",
    }
  }
  if (/timeout|timed out/i.test(errMsg)) {
    return {
      tag: "请求超时",
      kind: "interrupt",
      tip: "等待 AI 响应太久。自动重试。",
    }
  }
  if (/rate limit|429|quota/i.test(errMsg)) {
    return {
      tag: "限流",
      kind: "warn",
      tip: "触发服务商速率限制，等一会儿再手动继续。",
    }
  }
  if (/模型厂商异常|provider|upstream|5\d\d/i.test(errMsg)) {
    return {
      tag: "服务商异常",
      kind: "warn",
      tip: "AI 服务商报错，重试可能恢复，持续失败需换 provider。",
    }
  }
  if (/400|invalid|bad request/i.test(errMsg)) {
    return {
      tag: "请求参数错",
      kind: "warn",
      tip: "请求参数有问题，继续可能还会失败。",
    }
  }

  return {
    tag: "其它错误",
    kind: "warn",
    tip: "未归类错误，查看详情判断要不要继续。",
  }
}

/**
 * 判断是否应该重试
 */
function shouldRetry(classify: ClassifyResult, config: AutoRetryConfig): boolean {
  if (classify.kind === "skip") return false
  if (classify.kind === "warn") return false
  return config.retryOn.includes(classify.tag as any)
}

/**
 * 获取退避时间
 */
function getBackoffMs(retryCount: number, config: AutoRetryConfig): number {
  const index = Math.min(retryCount, config.backoffMs.length - 1)
  return config.backoffMs[index]
}

/**
 * 构造重试消息的 parts
 * - 输出截断：追加 "继续" 文本
 * - 静默中断：直接重发原消息
 */
function buildRetryParts(
  lastUserParts: Part[],
  classify: ClassifyResult
): Part[] {
  if (classify.tag === "输出截断" || classify.tag === "数据流截断") {
    // 追加 "继续" 文本 Part
    return [
      ...lastUserParts,
      { type: "text", text: "继续" } as Part,
    ]
  }
  // 其他情况：直接重发原消息
  return lastUserParts
}

/**
 * AutoRetry 插件主函数
 */
export const AutoRetryPlugin: Plugin = async (input: PluginInput) => {
  const { client } = input

  // 读取用户配置
  let config = DEFAULT_CONFIG
  try {
    const configResult = await client.config.get()
    if (configResult?.data) {
      const autoretryConfig = (configResult.data as Record<string, unknown>).autoretry
      if (autoretryConfig && typeof autoretryConfig === "object") {
        config = {
          ...DEFAULT_CONFIG,
          ...autoretryConfig as Partial<AutoRetryConfig>,
        }
      }
    }
  } catch (err) {
    await client.app.log({
      body: {
        service: "autoretry",
        level: "warn",
        message: "读取配置失败，使用默认配置",
        extra: { error: String(err) },
      },
    })
  }

  if (!config.enabled) {
    await client.app.log({
      body: {
        service: "autoretry",
        level: "info",
        message: "插件已禁用",
      },
    })
    return {}
  }

  await client.app.log({
    body: {
      service: "autoretry",
      level: "info",
      message: "插件已初始化（移植 watchdog 分类逻辑）",
      extra: { config },
    },
  })

  return {
    event: async (eventInput: { event: Event }) => {
      const { event } = eventInput

      // 处理 session.idle：清理重试状态
      if (event.type === "session.idle") {
        const sessionId = event.properties?.sessionID
        if (!sessionId) return

        if (sessionRetryCount.has(sessionId)) {
          sessionRetryCount.delete(sessionId)
          const timer = retryTimers.get(sessionId)
          if (timer) {
            clearTimeout(timer)
            retryTimers.delete(sessionId)
          }

          await client.app.log({
            body: {
              service: "autoretry",
              level: "info",
              message: "会话正常结束，清理重试状态",
              extra: { sessionId },
            },
          })
        }
        return
      }

      // 只处理 session.error
      if (event.type !== "session.error") return

      const sessionId = event.properties?.sessionID
      if (!sessionId) {
        await client.app.log({
          body: {
            service: "autoretry",
            level: "warn",
            message: "session.error 缺少 sessionId",
            extra: { event },
          },
        })
        return
      }

      // 获取会话消息列表
      const messagesResult = await client.session.messages({
        path: { id: sessionId },
      })

      if (!messagesResult?.data) {
        await client.app.log({
          body: {
            service: "autoretry",
            level: "error",
            message: "无法获取会话消息列表",
            extra: { sessionId },
          },
        })
        return
      }

      // 找最后一条 AssistantMessage（用于判断 finish/tokens/error）
      const messages = messagesResult.data
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.info?.role === "assistant")?.info as AssistantMessage | undefined

      if (!lastAssistant) {
        await client.app.log({
          body: {
            service: "autoretry",
            level: "warn",
            message: "未找到 AssistantMessage",
            extra: { sessionId },
          },
        })
        return
      }

      // 用 watchdog 逻辑分类
      const classify = classifyInterrupt(lastAssistant)

      await client.app.log({
        body: {
          service: "autoretry",
          level: "info",
          message: `检测到中断: ${classify.tag}`,
          extra: {
            sessionId,
            tag: classify.tag,
            kind: classify.kind,
            finish: lastAssistant.finish,
            outputTokens: lastAssistant.tokens?.output,
            errName: lastAssistant.error?.name,
          },
        },
      })

      // 判断是否重试
      if (!shouldRetry(classify, config)) {
        await client.tui.showToast({
          body: {
            message: `${classify.tag}：${classify.tip}`,
            variant: classify.kind === "skip" ? "info" : "error",
          },
        })
        return
      }

      // 检查重试次数
      const retryCount = sessionRetryCount.get(sessionId) || 0
      if (retryCount >= config.maxRetries) {
        await client.tui.showToast({
          body: {
            message: `已重试 ${retryCount} 次仍失败，请手动处理`,
            variant: "error",
          },
        })
        sessionRetryCount.delete(sessionId)
        return
      }

      // 找最后一条用户消息
      const lastUser = [...messages]
        .reverse()
        .find((m) => m.info?.role === "user")

      if (!lastUser) {
        await client.tui.showToast({
          body: {
            message: "未找到用户消息，无法重试",
            variant: "error",
          },
        })
        return
      }

      const lastUserParts = lastUser.parts || []
      if (lastUserParts.length === 0) {
        await client.tui.showToast({
          body: {
            message: "用户消息为空，无法重试",
            variant: "error",
          },
        })
        return
      }

      // 构造重试消息
      const retryParts = buildRetryParts(lastUserParts, classify)

      const backoff = getBackoffMs(retryCount, config)
      await client.tui.showToast({
        body: {
          message: `${classify.tag}，${backoff / 1000}s 后自动重试（第 ${retryCount + 1} 次）`,
          variant: "info",
        },
      })

      // 清理旧定时器
      const oldTimer = retryTimers.get(sessionId)
      if (oldTimer) clearTimeout(oldTimer)

      // 设置退避定时器
      const timer = setTimeout(async () => {
        retryTimers.delete(sessionId)

        try {
          await client.session.prompt({
            path: { id: sessionId },
            body: { parts: retryParts as any },
          })

          sessionRetryCount.set(sessionId, retryCount + 1)

          await client.app.log({
            body: {
              service: "autoretry",
              level: "info",
              message: `已重试第 ${retryCount + 1} 次`,
              extra: {
                sessionId,
                retryCount: retryCount + 1,
                tag: classify.tag,
                retryPartsCount: retryParts.length,
              },
            },
          })
        } catch (err) {
          await client.app.log({
            body: {
              service: "autoretry",
              level: "error",
              message: "重试执行失败",
              extra: { sessionId, error: String(err) },
            },
          })

          await client.tui.showToast({
            body: {
              message: `重试失败: ${(err as Error).message}`,
              variant: "error",
            },
          })
        }
      }, backoff)

      retryTimers.set(sessionId, timer)
    },
  }
}

export default AutoRetryPlugin