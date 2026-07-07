/**
 * 查看 OpenCode session 的完整消息时间线
 *
 * 显示每条消息的：角色、finish、token 用量、错误、工具调用摘要
 *
 * 用法：
 *   node scripts/session-timeline.js <session-id>
 *   node scripts/session-timeline.js ses_0c82b5cf5ffeDHr2ayODq7mlX8
 */
import { DatabaseSync } from "node:sqlite"
import { getDbPath } from "./db-utils.js"

const sessionId = process.argv[2]
if (!sessionId) {
  console.error("用法: node scripts/session-timeline.js <session-id>")
  console.error("示例: node scripts/session-timeline.js ses_0c82b5cf5ffeDHr2ayODq7mlX8")
  process.exit(1)
}

const db = new DatabaseSync(getDbPath(), { readOnly: true })

// 验证 session 存在
const session = db.prepare("SELECT id, time_created FROM session WHERE id = ?").get(sessionId)
if (!session) {
  console.error(`Session 不存在: ${sessionId}`)
  db.close()
  process.exit(1)
}

const rows = db.prepare(`
  SELECT id, time_created, data
  FROM message
  WHERE session_id = ?
  ORDER BY time_created ASC
`).all(sessionId)

console.log(`=== Session ${sessionId} (${rows.length} messages) ===\n`)

for (let i = 0; i < rows.length; i++) {
  const row = rows[i]
  const msg = JSON.parse(row.data)
  const role = msg.role
  const parts = msg.parts || []
  const finish = msg.finish
  const tokens = msg.tokens || {}
  const outTok = tokens.output ?? 0
  const inTok = tokens.input ?? 0
  const cacheRead = tokens.cache?.read ?? 0

  const ts = new Date(row.time_created).toISOString().slice(11, 19)

  if (role === "user") {
    const text = parts.find(p => p.type === "text")?.text || ""
    const preview = text.slice(0, 80).replace(/\n/g, "\\n")
    console.log(`[${i + 1}] ${ts} USER`)
    if (preview) console.log(`     text: "${preview}"`)
  } else {
    const textParts = parts.filter(p => p.type === "text")
    const toolCalls = parts.filter(p => p.type === "tool")
    const reasoningParts = parts.filter(p => p.type === "reasoning")

    const textPreview = textParts
      .map(t => (t.text || "").slice(0, 80).replace(/\n/g, "\\n"))
      .filter(Boolean).join(" | ")
    const reasoningPreview = reasoningParts
      .map(t => (t.text || "").slice(0, 60).replace(/\n/g, "\\n"))
      .filter(Boolean).join(" | ")
    const toolSummary = toolCalls
      .map(t => `${t.tool}(${t.callID?.slice(-8) || ""})[${t.state?.status || "?"}]`)
      .join("; ")

    const errName = msg.error?.name
    const errMsg = msg.error?.data?.message || msg.error?.message
    const errStr = errName ? ` err=${errName}: ${(errMsg || "").substring(0, 60)}` : ""

    console.log(`[${i + 1}] ${ts} ASST finish=${finish || "undefined"} in=${inTok} out=${outTok} cacheRead=${cacheRead}${errStr}`)
    if (reasoningPreview) console.log(`     reasoning: "${reasoningPreview}"`)
    if (toolSummary) console.log(`     tools: ${toolSummary}`)
    if (textPreview) console.log(`     text: "${textPreview}"`)
    if (parts.length === 0 && !toolSummary && !textPreview && !reasoningPreview) {
      console.log(`     (empty parts)`)
    }
  }
  console.log()
}

// ── 检查错误后是否有 autoretry 介入 ──
const errorRow = rows.find(r => {
  const msg = JSON.parse(r.data)
  return msg.role === "assistant" && msg.error
})

if (errorRow) {
  const errorIdx = rows.indexOf(errorRow)
  const after = rows.slice(errorIdx + 1)
  console.log("─".repeat(50))
  console.log(`错误发生在第 ${errorIdx + 1} 条消息`)
  if (after.length === 0) {
    console.log("⚠ 错误后无后续消息 — autoretry 可能未介入")
  } else {
    console.log(`错误后有 ${after.length} 条后续消息 — autoretry 可能已介入`)
    // 检查下一条是否是 autoretry 发的"继续"
    const next = after[0]
    const nextMsg = JSON.parse(next.data)
    if (nextMsg.role === "user") {
      const text = nextMsg.parts?.find(p => p.type === "text")?.text || ""
      if (text.includes("继续")) {
        console.log(`✓ 下一条是 autoretry 发的: "${text.substring(0, 30)}"`)
      }
    }
  }
}

db.close()
