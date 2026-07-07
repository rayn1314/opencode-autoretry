/**
 * 按关键词查找错误消息，查看完整 JSON 结构
 *
 * 用法：
 *   node scripts/error-lookup.js <关键词>
 *   node scripts/error-lookup.js "Connection failed"
 *   node scripts/error-lookup.js "disconnected"
 *   node scripts/error-lookup.js "UnknownError"
 *
 * 不带参数时列出最近 10 条有 error 的 assistant 消息摘要
 */
import { DatabaseSync } from "node:sqlite"
import { getDbPath, printDbInfo } from "./db-utils.js"

const keyword = process.argv[2]
const db = new DatabaseSync(getDbPath(), { readOnly: true })

if (!keyword) {
  // 无参数：列出最近有 error 的消息
  console.log("最近有 error 的 assistant 消息（使用关键词查看详情）:\n")
  const rows = db.prepare(`
    SELECT id, session_id, data,
           datetime(time_created/1000, 'unixepoch', 'localtime') as time
    FROM message
    WHERE json_extract(data, '$.role') = 'assistant'
      AND json_extract(data, '$.error') IS NOT NULL
    ORDER BY time_created DESC
    LIMIT 10
  `).all()

  for (const r of rows) {
    const msg = JSON.parse(r.data)
    const errName = msg.error?.name || "?"
    const errMsg = msg.error?.data?.message || msg.error?.message || ""
    console.log(`[${r.time}] ses=${r.session_id.slice(-12)} msg=${r.id.slice(-12)}`)
    console.log(`  ${errName}: ${(errMsg || "").substring(0, 80)}`)
    console.log(`  用法: node scripts/error-lookup.js "${(errMsg || errName).substring(0, 30)}"`)
    console.log()
  }
  if (rows.length === 0) console.log("✓ 未发现任何有 error 的消息")
  db.close()
  process.exit(0)
}

// 有关键词：搜索匹配的消息
console.log(`搜索关键词: "${keyword}"\n`)

const rows = db.prepare(`
  SELECT id, session_id, time_created, data,
         datetime(time_created/1000, 'unixepoch', 'localtime') as time
  FROM message
  WHERE data LIKE ?
  ORDER BY time_created DESC
  LIMIT 5
`).all(`%${keyword}%`)

if (rows.length === 0) {
  console.log("✓ 未找到匹配消息")
  db.close()
  process.exit(0)
}

console.log(`找到 ${rows.length} 条匹配消息:\n`)

for (const r of rows) {
  const msg = JSON.parse(r.data)

  console.log(`[${r.time}] session=${r.session_id}`)
  console.log(`  msg id:    ${r.id}`)
  console.log(`  role:      ${msg.role}`)
  console.log(`  finish:    ${JSON.stringify(msg.finish)}`)
  console.log(`  tokens:    ${JSON.stringify(msg.tokens)}`)
  console.log(`  parts:     ${msg.parts?.length || 0} 个`)
  console.log(`  provider:  ${msg.providerID}`)
  console.log(`  model:     ${msg.modelID}`)

  if (msg.error) {
    console.log(`  error:`)
    console.log(`    name:    ${msg.error.name}`)
    console.log(`    message: ${msg.error.data?.message || msg.error.message || "(无)"}`)
    if (msg.error.data && typeof msg.error.data === "object") {
      console.log(`    data:    ${JSON.stringify(msg.error.data)}`)
    }
  }

  // 如果是 assistant 消息，也显示前一条 assistant 消息的状态
  if (msg.role === "assistant") {
    const prev = db.prepare(`
      SELECT data FROM message
      WHERE session_id = ? AND time_created < ?
        AND json_extract(data, '$.role') = 'assistant'
      ORDER BY time_created DESC LIMIT 1
    `).get(r.session_id, r.time_created)

    if (prev) {
      const prevMsg = JSON.parse(prev.data)
      console.log(`  ---`)
      console.log(`  前一条 assistant:`)
      console.log(`    finish:   ${prevMsg.finish}`)
      console.log(`    output:   ${prevMsg.tokens?.output ?? 0}`)
      console.log(`    hasTool:  ${prevMsg.parts?.some(p => p.type === "tool") ?? false}`)
    }
  }

  console.log("\n" + "─".repeat(50) + "\n")
}

db.close()
