/**
 * 共享工具：定位 OpenCode 数据库路径
 *
 * 跨平台定位 ~/.local/share/opencode/opencode.db
 * 支持通过环境变量 OPENCODE_DB 覆盖
 */
import { homedir } from "node:os"
import { join } from "node:path"
import { existsSync } from "node:fs"

export function getDbPath() {
  // 1. 环境变量优先
  if (process.env.OPENCODE_DB && existsSync(process.env.OPENCODE_DB)) {
    return process.env.OPENCODE_DB
  }

  // 2. 默认路径：~/.local/share/opencode/opencode.db
  const home = homedir()
  const candidates = [
    join(home, ".local", "share", "opencode", "opencode.db"),
    // Windows 备选：某些安装可能放在 AppData
    join(home, "AppData", "Local", "opencode", "opencode.db"),
  ]

  for (const p of candidates) {
    if (existsSync(p)) return p
  }

  // 3. 返回默认路径（即使不存在，让调用方报错时显示完整路径）
  return candidates[0]
}

/**
 * 打印数据库基本信息
 */
export function printDbInfo(db) {
  const path = getDbPath()
  const stats = db.prepare("SELECT COUNT(*) as cnt FROM message").get()
  const sessions = db.prepare("SELECT COUNT(*) as cnt FROM session").get()
  console.log(`DB: ${path}`)
  console.log(`Messages: ${stats.cnt}  Sessions: ${sessions.cnt}`)
  console.log()
}
