/**
 * 综合诊断：扫描 OpenCode 数据库中的异常消息模式
 *
 * 检测项：
 *   1. 空白完成（finish=stop/length + output=0 + 空 parts）
 *   2. 中转网关伪造 length（finish=length + output=0 + input>0）
 *   3. 连接断开（error 包含 Connection failed / disconnected / ECONNRESET）
 *   4. 静默中断（finish=undefined + output=0 + 无 error）
 *   5. 零 token 消息（input=0 + output=0）
 *
 * 用法：
 *   node scripts/diagnose.js              # 扫描最近 7 天
 *   node scripts/diagnose.js 30           # 扫描最近 30 天
 *   node scripts/diagnose.js 0            # 扫描全部
 */
import { DatabaseSync } from "node:sqlite"
import { getDbPath, printDbInfo } from "./db-utils.js"

const days = parseInt(process.argv[2] || "7", 10)
const since = days > 0 ? Date.now() - days * 86400000 : 0

const db = new DatabaseSync(getDbPath(), { readOnly: true })
printDbInfo(db)

console.log(`扫描范围: ${days > 0 ? `最近 ${days} 天` : "全部记录"}`)
console.log("=".repeat(60))

// ── 1. 空白完成（finish=stop/length + output=0 + 无 error） ──
const blank = db.prepare(`
  SELECT id, session_id,
         json_extract(data, '$.finish') as finish,
         json_extract(data, '$.tokens.input') as tok_in,
         json_extract(data, '$.tokens.output') as tok_out,
         json_extract(data, '$.tokens.cache.read') as cache_read,
         datetime(time_created/1000, 'unixepoch', 'localtime') as time
  FROM message
  WHERE json_extract(data, '$.role') = 'assistant'
    AND json_extract(data, '$.finish') IN ('stop', 'length')
    AND COALESCE(json_extract(data, '$.tokens.output'), 0) = 0
    AND json_extract(data, '$.error') IS NULL
    AND time_created >= ?
  ORDER BY time_created DESC
  LIMIT 20
`).all(since)

console.log("\n1. 空白完成 (finish=stop/length + output=0 + 无 error)")
if (blank.length === 0) {
  console.log("   ✓ 未发现")
} else {
  console.log(`   ⚠ 发现 ${blank.length} 条:`)
  for (const r of blank) {
    console.log(`   [${r.time}] ses=${r.session_id.slice(-12)} finish=${r.finish} in=${r.tok_in} cacheRead=${r.cache_read}`)
  }
}

// ── 2. 中转网关伪造 length（finish=length + output=0 + input>0） ──
const fakeLength = db.prepare(`
  SELECT id, session_id,
         json_extract(data, '$.tokens.input') as tok_in,
         json_extract(data, '$.tokens.cache.read') as cache_read,
         datetime(time_created/1000, 'unixepoch', 'localtime') as time
  FROM message
  WHERE json_extract(data, '$.role') = 'assistant'
    AND json_extract(data, '$.finish') = 'length'
    AND COALESCE(json_extract(data, '$.tokens.output'), 0) = 0
    AND COALESCE(json_extract(data, '$.tokens.input'), 0) > 0
    AND time_created >= ?
  ORDER BY time_created DESC
  LIMIT 20
`).all(since)

console.log("\n2. 中转网关伪造 length (finish=length + output=0 + input>0)")
if (fakeLength.length === 0) {
  console.log("   ✓ 未发现")
} else {
  console.log(`   ⚠ 发现 ${fakeLength.length} 条:`)
  for (const r of fakeLength) {
    console.log(`   [${r.time}] ses=${r.session_id.slice(-12)} in=${r.tok_in} cacheRead=${r.cache_read}`)
  }
}

// ── 3. 连接断开 ──
const connErr = db.prepare(`
  SELECT id, session_id,
         json_extract(data, '$.error.name') as err_name,
         json_extract(data, '$.error.data.message') as err_msg,
         json_extract(data, '$.finish') as finish,
         datetime(time_created/1000, 'unixepoch', 'localtime') as time
  FROM message
  WHERE json_extract(data, '$.role') = 'assistant'
    AND (
      data LIKE '%Connection failed%'
      OR data LIKE '%Server disconnected%'
      OR data LIKE '%ECONNRESET%'
      OR data LIKE '%fetch failed%'
      OR data LIKE '%socket%'
    )
    AND time_created >= ?
  ORDER BY time_created DESC
  LIMIT 20
`).all(since)

console.log("\n3. 连接断开 (Connection failed / disconnected / ECONNRESET)")
if (connErr.length === 0) {
  console.log("   ✓ 未发现")
} else {
  console.log(`   ⚠ 发现 ${connErr.length} 条:`)
  for (const r of connErr) {
    const msg = r.err_msg ? r.err_msg.substring(0, 60) : "(无消息)"
    console.log(`   [${r.time}] ses=${r.session_id.slice(-12)} ${r.err_name}: ${msg}`)
  }
}

// ── 4. 静默中断（finish=undefined + output=0 + 无 error） ──
const silent = db.prepare(`
  SELECT id, session_id,
         json_extract(data, '$.finish') as finish,
         json_extract(data, '$.tokens.output') as tok_out,
         datetime(time_created/1000, 'unixepoch', 'localtime') as time
  FROM message
  WHERE json_extract(data, '$.role') = 'assistant'
    AND json_extract(data, '$.finish') IS NULL
    AND json_extract(data, '$.error') IS NULL
    AND COALESCE(json_extract(data, '$.tokens.output'), 0) = 0
    AND time_created >= ?
  ORDER BY time_created DESC
  LIMIT 20
`).all(since)

console.log("\n4. 静默中断 (finish=undefined + output=0 + 无 error)")
if (silent.length === 0) {
  console.log("   ✓ 未发现")
} else {
  console.log(`   ⚠ 发现 ${silent.length} 条:`)
  for (const r of silent) {
    console.log(`   [${r.time}] ses=${r.session_id.slice(-12)} out=${r.tok_out}`)
  }
}

// ── 5. 零 token 消息（input=0 + output=0） ──
const zeroToken = db.prepare(`
  SELECT id, session_id,
         json_extract(data, '$.error.name') as err_name,
         datetime(time_created/1000, 'unixepoch', 'localtime') as time
  FROM message
  WHERE json_extract(data, '$.role') = 'assistant'
    AND COALESCE(json_extract(data, '$.tokens.input'), 0) = 0
    AND COALESCE(json_extract(data, '$.tokens.output'), 0) = 0
    AND time_created >= ?
  ORDER BY time_created DESC
  LIMIT 20
`).all(since)

console.log("\n5. 零 token 消息 (input=0 + output=0)")
if (zeroToken.length === 0) {
  console.log("   ✓ 未发现")
} else {
  console.log(`   ⚠ 发现 ${zeroToken.length} 条:`)
  for (const r of zeroToken) {
    console.log(`   [${r.time}] ses=${r.session_id.slice(-12)} err=${r.err_name || "none"}`)
  }
}

// ── 6. autoretry 触发记录（"继续"/"继续！！！"消息） ──
const retryMsgs = db.prepare(`
  SELECT session_id,
         json_extract(data, '$.parts[0].text') as text,
         datetime(time_created/1000, 'unixepoch', 'localtime') as time
  FROM message
  WHERE json_extract(data, '$.role') = 'user'
    AND (data LIKE '%继续！！！%' OR data LIKE '%"继续"%')
    AND time_created >= ?
  ORDER BY time_created DESC
  LIMIT 20
`).all(since)

console.log("\n6. autoretry 触发记录 (继续 / 继续！！！)")
if (retryMsgs.length === 0) {
  console.log("   ✓ 未发现 autoretry 触发")
} else {
  console.log(`   ℹ 发现 ${retryMsgs.length} 次触发:`)
  for (const r of retryMsgs) {
    console.log(`   [${r.time}] ses=${r.session_id.slice(-12)} text="${r.text?.substring(0, 20)}"`)
  }
}

console.log("\n" + "=".repeat(60))
console.log("诊断完成。")

db.close()
