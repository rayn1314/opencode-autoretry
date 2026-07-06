/**
 * opencode-autoretry 插件
 * 智能检测静默中断，自动重试
 *
 * 策略：
 * 1. 只在 session idle 后检查最后一条消息状态
 * 2. 如果 finish=unknown + output=0，才触发重试
 * 3. 轮询作为极端情况的兜底（超长时间无事件）
 */

type PartialMessage = {
  id?: string;
  role?: string;
  finish?: string | undefined;
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } | undefined;
  error?: { name?: string; message?: string; data?: Record<string, unknown> | string } | undefined;
  parts?: unknown[];
  providerID?: string;
  modelID?: string;
};

type InterruptClassify = {
  tag: string;
  kind: 'skip' | 'interrupt' | 'warn';
};

interface DefaultConfig {
  enabled: boolean;
  maxRetries: number;
  backoffMs: number[];
  pollIntervalMs: number;
  retryOn: string[];
}

const DEFAULT_CONFIG: DefaultConfig = {
  enabled: true,
  maxRetries: 2,
  backoffMs: [5000, 10000],
  pollIntervalMs: 60000, // 60 秒无事件才轮询（极端兜底）
  retryOn: ["输出截断", "静默中断", "数据流截断", "连接断开", "请求超时"],
};

const sessionState = new Map<string, {
  blankCount?: number;
  retryCount?: number;
  lastActivity?: number;
  autoSendPending?: boolean;
}>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();

// 多路径取值：opencode 的 error 对象结构随版本/来源变化，
// 日志里见过 error.error="..."、error.data.message 和 error.data="..." 三种形式，
// 这里把所有常见路径都覆盖，确保能拿到真实的错误信息
function getErrorFields(error: unknown): { name: string; message: string } {
  if (!error) return { name: "", message: "" };
  const name =
    (error as any)?.name ??
    (error as any)?.error?.name ??
    "";
  const message =
    (error as any)?.data?.message ??
    (typeof (error as any)?.data === "string" ? (error as any).data : undefined) ??
    (error as any)?.message ??
    (error as any)?.error?.message ??
    (typeof (error as any)?.error === "string" ? (error as any).error : "") ??
    (typeof error === "string" ? error : "") ??
    "";
  return { name, message };
}

function classifyInterrupt(msg: PartialMessage): InterruptClassify {
  const { name: errName, message: errMsg } = getErrorFields(msg.error);
  const outTok = msg.tokens?.output ?? 0;

  if (errName === "MessageAbortedError") {
    return { tag: "用户中止", kind: "skip" };
  }

  if (outTok > 0) {
    return { tag: "输出截断", kind: "interrupt" };
  }

  if (!errName) {
    return { tag: "静默中断", kind: "interrupt" };
  }

  if (/JSON parsing|JSON Parse|Unterminated/i.test(errMsg)) {
    return { tag: "数据流截断", kind: "interrupt" };
  }
  if (/Connection failed|Server disconnected|ECONNRESET|fetch failed|socket/i.test(errMsg)) {
    return { tag: "连接断开", kind: "interrupt" };
  }
  if (/timeout|timed out/i.test(errMsg)) {
    return { tag: "请求超时", kind: "interrupt" };
  }
  if (/rate limit|429|quota/i.test(errMsg)) {
    return { tag: "限流", kind: "warn" };
  }
  if (/模型厂商异常|provider|upstream|5\d\d/i.test(errMsg)) {
    return { tag: "服务商异常", kind: "warn" };
  }
  if (/400|invalid|bad request/i.test(errMsg)) {
    return { tag: "请求参数错", kind: "warn" };
  }

  return { tag: "其它错误", kind: "warn" };
}

function shouldRetry(classify: InterruptClassify, config: DefaultConfig): boolean {
  if (classify.kind === "skip" || classify.kind === "warn") return false;
  return config.retryOn.includes(classify.tag);
}

function getBackoffMs(retryCount: number, config: DefaultConfig): number {
  const index = Math.min(retryCount, config.backoffMs.length - 1);
  return config.backoffMs[index];
}

/**
 * 统一的续写发送——所有需要发 prompt 的分支都调这个。
 * model 保持只在这里维护一次：从 lastAssistant 提取 providerID/modelID 传给 session.prompt，
 * 保证续写/重试不会切换到默认模型。
 */
async function sendContinuation(sessionId: string, client: any, lastAssistant: PartialMessage, text: string): Promise<void> {
  await client.session.prompt({
    path: { id: sessionId },
    body: {
      parts: [{ type: "text", text }],
      model: {
        providerID: lastAssistant.providerID!,
        modelID: lastAssistant.modelID!,
      },
    },
  });
}

/**
 * 子代理等待检测——在 checkAndRetry 入口处调一次，命中则跳过所有重试。
 *
 * 场景：Sisyphus/ultraworker 等编排型 agent 发了 task() 后等子代理返回，
 * session 自然 idle，最后一条 assistant 消息可能是空白 stop 或 undefined。
 * 这时不应发"继续"/"继续！！！"，否则会打断编排逻辑。
 *
 * 判定条件（全部满足才算子代理等待）：
 * 1. 上一条 assistant 消息有 tool calls（task 调用）
 * 2. 当前消息无 error（真中断通常有 error）
 * 3. 当前消息 output=0（有输出说明不是等待）
 * 4. finish 不是 length——中转伪造的 length（output=0）需要重试，不在此列
 */
function isSubagentWait(messages: unknown[], lastAssistant: PartialMessage): boolean {
  const assistants = messages.filter((m: any) => m?.info?.role === "assistant") as any[];
  const prevMsg = assistants.length >= 2 ? assistants[assistants.length - 2] : null;
  const prevHasToolCalls = prevMsg?.parts?.some((p: any) => p.type === "tool") ?? false;
  if (!prevHasToolCalls) return false;

  const outTok = lastAssistant.tokens?.output ?? 0;
  const finish = lastAssistant.finish;
  const hasError = !!lastAssistant.error;

  // 中转伪造的 length（output=0）需要重试，不视为子代理等待
  if (finish === "length" && outTok === 0) return false;

  return !hasError && outTok === 0;
}

// ── 工具函数：日志、提示、状态更新、安全续写 ──
// 所有分支共用，配套功能各只维护一次

function log(client: any, message: string, extra: Record<string, unknown> = {}): Promise<void> {
  return client.app.log({
    body: { service: "autoretry", level: "info", message, extra },
  });
}

function toast(client: any, message: string, variant: "info" | "warning" | "error" = "info"): Promise<void> {
  return client.tui.showToast({ body: { message, variant } });
}

function updateSessionState(sessionId: string, updates: Partial<{ blankCount: number; retryCount: number; lastActivity: number; autoSendPending: boolean }>): void {
  const current = sessionState.get(sessionId) || {};
  sessionState.set(sessionId, { ...current, ...updates });
}

/**
 * 带错误处理的续写发送：失败时自动 toast，返回是否成功。
 * 设置 autoSendPending 标记，让 chat.message / session.status handler 知道
 * 下一条 user 消息是 autoretry 发的，不要重置 blankCount/retryCount。
 */
async function safeSendContinuation(sessionId: string, client: any, lastAssistant: PartialMessage, text: string, errorLabel: string): Promise<boolean> {
  try {
    updateSessionState(sessionId, { autoSendPending: true });
    await sendContinuation(sessionId, client, lastAssistant, text);
    return true;
  } catch (err) {
    await toast(client, `${errorLabel}: ${(err as any).message}`, "error");
    return false;
  }
}

async function checkAndRetry(sessionId: string, client: any, config: DefaultConfig, reason: string = "unknown"): Promise<void> {
  let messagesResult;
  try {
    messagesResult = await client.session.messages({
      path: { id: sessionId },
    });
  } catch (err) {
    return;
  }

  if (!messagesResult?.data) return;

  const messages = messagesResult.data;
  const lastMessage = [...messages]
    .reverse()
    .find((m: any) => m.info?.role === "assistant");
  const lastAssistant = lastMessage?.info;

  if (!lastAssistant) return;

  const finish = lastAssistant.finish;
  const outTok = lastAssistant.tokens?.output ?? 0;

  // 统一入口检测：子代理等待场景跳过所有重试/续写。
  if (isSubagentWait(messages, lastAssistant)) {
    await log(client, "subagent wait detected, skipping all retry/continuation",
      { sessionId, reason, finish, outTok });
    return;
  }

  // 空白完成检测：finish=stop 或 finish=length 但没有产出任何文本或工具调用。
  if ((finish === "stop" || finish === "length") && outTok === 0 && !lastAssistant.error) {
    const parts = lastMessage?.parts ?? [];
    const hasText = parts.some((p: any) => p.type === "text" && p.text?.trim());
    const hasTool = parts.some((p: any) => p.type === "tool");
    if (!hasText && !hasTool) {
      const state = sessionState.get(sessionId) || {};
      const blankCount = state.blankCount || 0;

      if (blankCount >= config.maxRetries) {
        await toast(client, `连续 ${blankCount} 次空白输出，已停止自动续写`, "error");
        return;
      }
      const nextBlank = blankCount + 1;
      updateSessionState(sessionId, { blankCount: nextBlank });

      await log(client, `blank completion detected, sending continuation (blank #${nextBlank})`,
        { sessionId, reason, messageId: lastAssistant.id });

      await safeSendContinuation(sessionId, client, lastAssistant, "继续", "续写失败");
      return;
    }
  }

  // 核心判断：finish 未设(undefined)或为 unknown 都算中断
  if (finish && finish !== "unknown") {
    await log(client, `check skipped: finish=${finish} (not interrupt)`,
      { sessionId, reason, outTok });
    return;
  }

  const classify = classifyInterrupt(lastAssistant);

  await log(client, `detected interrupt: ${classify.tag}`,
    { sessionId, reason, tag: classify.tag, kind: classify.kind,
      outputTokens: outTok, errName: lastAssistant.error?.name });

  await scheduleRetry(sessionId, client, config, classify, lastAssistant, reason);
}

/**
 * 统一的重试调度——checkAndRetry 和 session.error handler 共用。
 * 负责：retryCount 检查、backoff 计算、toast 提示、setTimeout 发送续写。
 */
async function scheduleRetry(sessionId: string, client: any, config: DefaultConfig, classify: InterruptClassify, lastAssistant: PartialMessage, reason: string): Promise<void> {
  if (!shouldRetry(classify, config)) {
    await toast(client, `${classify.tag}：不自动重试`, "error");
    return;
  }

  const state = sessionState.get(sessionId) || { retryCount: 0 };
  const retryCount = state.retryCount || 0;

  if (retryCount >= config.maxRetries) {
    await toast(client, `已重试 ${retryCount} 次仍失败`, "error");
    sessionState.delete(sessionId);
    return;
  }

  const backoff = getBackoffMs(retryCount, config);

  await toast(client, `${classify.tag}，${backoff / 1000}s 后重试（第 ${retryCount + 1} 次）`);

  const oldTimer = retryTimers.get(sessionId);
  if (oldTimer) clearTimeout(oldTimer);

  const timer = setTimeout(async () => {
    retryTimers.delete(sessionId);

    const ok = await safeSendContinuation(sessionId, client, lastAssistant, "继续！！！", "重试失败");
    if (!ok) return;

    updateSessionState(sessionId, { retryCount: retryCount + 1, lastActivity: Date.now() });
    await log(client, `retry sent (${retryCount + 1})`, { sessionId, reason });
  }, backoff);

  retryTimers.set(sessionId, timer);
}

function schedulePoll(sessionId: string, client: any, config: DefaultConfig): void {
  const oldTimer = pollTimers.get(sessionId);
  if (oldTimer) clearTimeout(oldTimer);

  const timer = setTimeout(async () => {
    pollTimers.delete(sessionId);

    const state = sessionState.get(sessionId);
    if (!state) return;

    const now = Date.now();
    const elapsed = now - state.lastActivity!;

    if (elapsed < config.pollIntervalMs) return;

    await log(client, `poll check triggered (${elapsed / 1000}s elapsed)`, { sessionId });
    await checkAndRetry(sessionId, client, config, "poll");
  }, config.pollIntervalMs);

  pollTimers.set(sessionId, timer);
}

export const AutoRetryPlugin = async ({ client }: { client: any }) => {
  await log(client, "autoretry plugin loaded (idle-check)");

  const config = DEFAULT_CONFIG;

  return {
    event: async ({ event }: { event: any }) => {
      const sessionId = event.properties?.sessionID || event.properties?.info?.sessionID;

      // 核心检查点：session idle 后才判断是否中断
      if (event.type === "session.idle") {
        if (sessionId && sessionState.has(sessionId)) {
          // 先检查最后一条消息状态
          await checkAndRetry(sessionId, client, config, "idle");

          // 如果 checkAndRetry / session.error 已经安排了重试 timer，
          // 不要清理 sessionState 和 retryTimer——让 timer 自然执行。
          // 否则会杀掉刚安排的重试，导致永远不重试。
          if (retryTimers.has(sessionId)) {
            // 只清理 pollTimer，保留 retryTimer 和 sessionState
            const pollTimer = pollTimers.get(sessionId);
            if (pollTimer) {
              clearTimeout(pollTimer);
              pollTimers.delete(sessionId);
            }
            return;
          }

          // 没有 pending retry，正常清理
          sessionState.delete(sessionId);

          const pollTimer = pollTimers.get(sessionId);
          if (pollTimer) {
            clearTimeout(pollTimer);
            pollTimers.delete(sessionId);
          }
        }
        return;
      }

      if (event.type === "session.status") {
        const status = event.properties?.status;
        if (sessionId && status === "running") {
          // autoretry 发的续写消息会触发 running——不重置 blankCount/retryCount
          // 注意：不在这里重置 autoSendPending，留给 chat.message handler 重置，
          // 因为 chat.message 可能在 session.status 之后才触发
          const state = sessionState.get(sessionId);
          if (state?.autoSendPending) {
            updateSessionState(sessionId, { lastActivity: Date.now() });
          } else {
            // 真正用户消息或恢复会话：重置 blankCount（新一轮对话的开始）
            updateSessionState(sessionId, { blankCount: 0, lastActivity: Date.now() });
          }
          schedulePoll(sessionId, client, config);
        }
        return;
      }

      // message.updated：更新时间戳；assistant 有有效输出时重置空白计数
      if (event.type === "message.updated") {
        const msg = event.properties?.info;
        if (!msg || msg.role !== "assistant") return;
        if (!sessionId) return;

        const outTok = msg.tokens?.output ?? 0;
        const updates: Partial<{ blankCount: number; lastActivity: number }> = { lastActivity: Date.now() };
        if (outTok > 0) updates.blankCount = 0;
        updateSessionState(sessionId, updates);
        return;
      }

      if (event.type === "session.error") {
        if (!sessionId) return;

        // session.error 事件直接带 error 对象（SDK types EventSessionError）。
        // 此时错误消息可能还没入库——checkAndRetry 查消息列表只能看到前一条
        // 正常消息（finish=tool-calls/stop），会因 finish 非 unknown 而跳过。
        // 所以这里直接用事件里的 error 做分类和重试，不依赖 DB 时序。
        const eventError = event.properties?.error;
        if (eventError) {
          // 构造合成消息给 classifyInterrupt：error 来自事件，output=0
          const classify = classifyInterrupt({ error: eventError, tokens: { output: 0 } });

          await log(client, `session.error: ${classify.tag}`,
            { sessionId, tag: classify.tag, kind: classify.kind, errName: eventError?.name });

          // 取最近 assistant 消息拿 providerID/modelID（可能是前一条正常消息）
          let lastAssistant: PartialMessage | null = null;
          try {
            const result = await client.session.messages({ path: { id: sessionId } });
            const msgs = result?.data || [];
            lastAssistant = [...msgs].reverse().find((m: any) => m.info?.role === "assistant")?.info || null;
          } catch { /* 查询失败时 lastAssistant 保持 null */ }

          if (!lastAssistant) {
            await toast(client, `${classify.tag}：无法获取模型信息，重试失败`, "error");
            return;
          }

          await scheduleRetry(sessionId, client, config, classify, lastAssistant, "session.error");
          return;
        }

        // 没有 eventError 时走常规路径
        await checkAndRetry(sessionId, client, config, "error");
        return;
      }
    },

    "chat.message": async ({ sessionID }: { sessionID: string }, { message }: { message: any }) => {
      if (message.role === "user") {
        const state = sessionState.get(sessionID);
        if (state?.autoSendPending) {
          // autoretry 发的续写消息：只更新时间戳，不重置计数器
          updateSessionState(sessionID, { autoSendPending: false, lastActivity: Date.now() });
        } else {
          // 真正用户消息：重置 blankCount 和 retryCount（新一轮对话）
          updateSessionState(sessionID, { blankCount: 0, retryCount: 0, lastActivity: Date.now() });
        }
        schedulePoll(sessionID, client, config);
        await log(client, "user message received, session activated", { sessionID });
      }
    },
  };
};

export default AutoRetryPlugin;
