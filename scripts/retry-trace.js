/**
 * 追踪 autoretry 插件的触发记录
 *
 * 查找 autoretry 发送的"继续"/"继续！！！"消息，
 * 并显示每次触发时的上下文（前一条 assistant 消息的状态）。
 *
 * 用法：
 *   node scripts/retry-trace.js              # 最近 10 次触发
 *   node scripts/retry-trace.js 30           # 最近 30 天内的触发
 *   node scripts/retry-trace.js <session-id> # 特定 session 的触发
 */
import { DatabaseSync } from "node:sqlite"
import { getDbPath, printDbInfo } from "./db-utils.js"

const arg = process.argv[2]
const db = new DatabaseSync(getDbPath(), { readOnly: true })

let since = 0
let sessionId = null

if (arg && arg.startsWith("ses_")) {
  sessionId = arg
} else if (arg) {
  const days = parseInt(arg, 10)
  if (!isNaN(days)) since = Date.now() - days * 86400000
}

if (!sessionId) printDbInfo(db)

// 查找 autoretry 发的消息（"继续" 或 "继续！！！"）
const query = sessionId
  ? `AND session_id = ?`
  : `AND time_created >= ?`
const params = sessionId || since

const retryMsgs = db.prepare(`
  SELECT id, session_id, time_created, data,
         datetime(time_created/1000, 'unixepoch', 'localtime') as time
  FROM message
  WHERE json_extract(data, '$.role') = 'user'
    AND (data LIKE '%继续！！！%' OR data LIKE '%"继续"%')
    ${query}
  ORDER BY time_created DESC
  LIMIT 20
`).all(params)

console.log(`=== autoretry 触发记录 (${retryMsgs.length} 次) ===\n`)

if (retryMsgs.length === 0) {
  console.log("✓ 未发现 autoretry 触发记录")
  db.close()
  process.exit(0)
}

for (let i = 0; i < retryMsgs.length; i++) {
  const m = retryMsgs[i]
  const msg = JSON.parse(m.data)
  const text = msg.parts?.find(p => p.type === "text")?.text || ""
  const ts = m.time

  console.log(`[${i + 1}] ${ts}  session=${m.session_id}`)
  console.log(`     触发消息: "${text.substring(0, 40)}"`)

  // 找这条 user 消息之前的最后一条 assistant 消息
  const prevAssistant = db.prepare(`
    SELECT id, time_created, data
    FROM message
    WHERE session_id = ? AND time_created < ? AND json_extract(data, '$.role') = 'assistant'
    ORDER BY time_created DESC LIMIT 1
  `).get(m.session_id, m.time_created)

  if (prevAssistant) {
    const a = JSON.parse(prevAssistant.data)
    const parts = a.parts || []
    const hasTool = parts.some(p => p.type === "tool")
    const hasText = parts.some(p => p.type === "text" && p.text?.trim())
    const errName = a.error?.name
    const errMsg = a.error?.data?.message || a.error?.message

    console.log(`     触发原因:`)
    console.log(`       finish:    ${a.finish || "undefined"}`)
    console.log(`       output:    ${a.tokens?.output ?? 0}`)
    console.log(`       input:     ${a.tokens?.input ?? 0}`)
    console.log(`       cacheRead: ${a.tokens?.cache?.read ?? 0}`)
    console.log(`       hasTool:   ${hasTool}`)
    console.log(`       hasText:   ${hasText}`)
    console.log(`       parts:     ${parts.length}`)
    if (errName) {
      console.log(`       error:     ${errName}: ${(errMsg || "").substring(0, 60)}`)
    }

    // 判断触发类型
    let triggerType = "未知"
    if (text === "继续！！！") {
      triggerType = "scheduleRetry（中断重试）"
    } else if (text === "继续") {
      if ((a.finish === "stop" || a.finish === "length") && (a.tokens?.output ?? 0) === 0) {
        triggerType = "空白完成续写"
      } else {
        triggerType = "输出截断续写"
      }
    }
    console.log(`       触发类型:  ${triggerType}`)
  } else {
    console.log(`     ⚠ 未找到前一条 assistant 消息`)
  }

  // 检查重试是否成功（下一条 assistant 是否有 output）
  const nextAssistant = db.prepare(`
    SELECT data
    FROM message
    WHERE session_id = ? AND time_created > ? AND json_extract(data, '$.role') = 'assistant'
    ORDER BY time_created ASC LIMIT 1
  `).get(m.session_id, m.time_created)

  if (nextAssistant) {
    const na = JSON.parse(nextAssistant.data)
    const naOut = na.tokens?.output ?? 0
    const naErr = na.error?.name
    if (naOut > 0 && !naErr) {
      console.log(`       结果:      ✓ 重试成功 (output=${naOut})`)
    } else if (naErr) {
      console.log(`       结果:      ✗ 重试失败 (${naErr})`)
    } else {
      console.log(`       结果:      ? 重试后仍空白 (output=${naOut})`)
    }
  }

  console.log()
}

console.log("─".repeat(50))
console.log(`共 ${retryMsgs.length} 次触发`)

db.close()
