import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"

/**
 * 自动重试配置接口
 */
interface AutoRetryConfig {
  enabled: boolean
  maxRetries: number
  backoffMs: number[]
  retryOn: Array<"silent" | "network" | "timeout">
}

/** 默认配置 */
const DEFAULT_CONFIG: AutoRetryConfig = {
  enabled: true,
  maxRetries: 3,
  backoffMs: [3000, 6000, 12000],
  retryOn: ["silent", "network"],
}

/** 会话重试计数器（Map<sessionId, retryCount>） */
const sessionRetryCount = new Map<string, number>()

/** 重试定时器（Map<sessionId, timer>） */
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * 分类错误类型
 * @param error - SDK 错误对象或错误消息
 * @returns 错误分类标签
 */
function classifyError(error: unknown): "silent" | "network" | "timeout" | "other" {
  if (!error) return "silent"
  
  // SDK 错误对象的 data.message 结构做运行时提取
  const anyErr = error as { data?: { message?: string }, message?: string }
  const errorStr = typeof error === "string" 
    ? error 
    : (anyErr?.data?.message || anyErr?.message || JSON.stringify(error)) as string
  
  // 网络错误特征
  if (errorStr.includes("ECONNRESET") || 
      errorStr.includes("ETIMEDOUT") ||
      errorStr.includes("network") ||
      errorStr.includes("fetch failed") ||
      errorStr.includes("ECONNREFUSED")) {
    return "network"
  }
  
  // 超时特征
  if (errorStr.includes("timeout") || errorStr.includes("Timeout") || errorStr.includes("EAI_AGAIN")) {
    return "timeout"
  }
  
  // 静默中断特征（unknown error + 空输出片段）
  if (errorStr.includes("unknown") || 
      errorStr.includes("empty") ||
      errorStr.includes("no output") ||
      errorStr.includes("aborted")) {
    return "silent"
  }
  
  // API key / auth 错误也标记为网络相关
  if (errorStr.includes("api key") ||
      errorStr.includes("authentication") ||
      errorStr.includes("forbidden") ||
      errorStr.includes("401") ||
      errorStr.includes("403")) {
    return "network"
  }
  
  return "other"
}

/**
 * 判断错误是否应该重试
 */
function shouldRetry(errorType: string, config: AutoRetryConfig): boolean {
  return config.retryOn.includes(errorType as any)
}

/**
 * 获取退避时间（毫秒）
 */
function getBackoffMs(retryCount: number, config: AutoRetryConfig): number {
  const index = Math.min(retryCount, config.backoffMs.length - 1)
  return config.backoffMs[index]
}

/**
 * AutoRetry 插件主函数
 * 监听 session.error 和 session.idle 事件，自动重试中断的对话
 */
export const AutoRetryPlugin: Plugin = async (input: PluginInput) => {
  const { client } = input
  
  // 尝试读取用户配置（如果 opencode.json 中有 autoretry 块）
  let config = DEFAULT_CONFIG
  
  try {
    const configResult = await client.config.get()
    if (configResult?.data) {
      const autoretryConfig = (configResult.data as Record<string, unknown>).autoretry
      if (autoretryConfig && typeof autoretryConfig === "object") {
        config = {
          ...DEFAULT_CONFIG,
          ...autoretryConfig as Partial<AutoRetryConfig>
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
        message: "插件已禁用，跳过初始化",
      },
    })
    return {}
  }
  
  await client.app.log({
    body: {
      service: "autoretry",
      level: "info",
      message: "插件已初始化",
      extra: { config },
    },
  })
  
  return {
    /**
     * 监听通用事件流
     * - session.error：会话错误（中断时触发）
     * - session.idle：会话空闲（正常结束时触发，用于清理计数器）
     */
    event: async (eventInput: { event: Event }) => {
      const { event } = eventInput
      
      // 只处理会话相关事件
      if (
        event.type !== "session.error" &&
        event.type !== "session.idle"
      ) {
        return
      }
      
      // 提取会话 ID
      const sessionId = event.properties?.sessionID
      
      if (!sessionId) {
        await client.app.log({
          body: {
            service: "autoretry",
            level: "warn",
            message: `${event.type} event missing sessionId`,
            extra: { event },
          },
        })
        return
      }
      
      // 处理会话空闲事件（清理重试状态）
      if (event.type === "session.idle") {
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
      
      // 处理会话错误事件（自动重试）
      if (event.type === "session.error") {
        const errorPayload = event.properties?.error
        
        const errorType = classifyError(errorPayload)
        
        await client.app.log({
          body: {
            service: "autoretry",
            level: "info",
            message: `检测到会话错误: ${errorType}`,
            extra: { sessionId, errorType, error: errorPayload },
          },
        })
        
        if (!shouldRetry(errorType, config)) {
          await client.tui.showToast({
            body: {
              message: `会话中断（${errorType}），不自动重试`,
              variant: "error",
            },
          })
          return
        }
        
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
        
        const backoff = getBackoffMs(retryCount, config)
        await client.tui.showToast({
          body: {
            message: `检测到中断，${backoff / 1000}s 后自动重试（第 ${retryCount + 1} 次）`,
            variant: "info",
          },
        })
        
        const oldTimer = retryTimers.get(sessionId)
        if (oldTimer) clearTimeout(oldTimer)
        
        const timer = setTimeout(async () => {
          retryTimers.delete(sessionId)
          
          try {
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
            
            const messages = messagesResult.data
            const lastUserMessage = [...messages]
              .reverse()
              .find((m) => m.info?.role === "user")
            
            if (!lastUserMessage) {
              await client.tui.showToast({
                body: {
                  message: "未找到用户消息，无法重试",
                  variant: "error",
                },
              })
              return
            }
            
            const parts = lastUserMessage.parts || []
            
            if (parts.length === 0) {
              await client.tui.showToast({
                body: {
                  message: "用户消息为空，无法重试",
                  variant: "error",
                },
              })
              return
            }
            
            // 重发消息（parts 类型在运行时可接受，但 TS 类型不兼容，使用 any 暂时绕过）
            await client.session.prompt({
              path: { id: sessionId },
              body: { parts: parts as any },
            })
            
            sessionRetryCount.set(sessionId, retryCount + 1)
            
            await client.app.log({
              body: {
                service: "autoretry",
                level: "info",
                message: `已重试第 ${retryCount + 1} 次`,
                extra: { sessionId, retryCount: retryCount + 1 },
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
      }
    },
  }
}

export default AutoRetryPlugin