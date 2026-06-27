/**
 * opencode-autoretry 安装脚本
 * 将编译后的插件部署到全局插件目录
 *   Windows: %USERPROFILE%\.config\opencode\plugins\
 *   Linux/macOS: ~/.config/opencode/plugins/
 */
import { existsSync, mkdirSync, copyFileSync, renameSync, readdirSync, rmSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const projectRoot = join(__dirname, "..")

// 插件目标目录：~/.config/opencode/plugins/autoretry/
const pluginsDir = join(homedir(), ".config", "opencode", "plugins", "autoretry")
const distDir = join(projectRoot, "dist")

function log(msg) {
  console.log(`[autoretry-install] ${msg}`)
}

function fail(msg) {
  console.error(`[autoretry-install] 错误: ${msg}`)
  process.exit(1)
}

// 1. 检查 dist 目录是否存在
if (!existsSync(distDir)) {
  fail("dist/ 目录不存在，请先运行 npm run build")
}

// 2. 创建目标目录
if (!existsSync(pluginsDir)) {
  mkdirSync(pluginsDir, { recursive: true })
  log(`创建插件目录: ${pluginsDir}`)
}

// 3. 清理旧文件
for (const file of readdirSync(pluginsDir)) {
  const filePath = join(pluginsDir, file)
  rmSync(filePath, { recursive: true, force: true })
  log(`清理旧文件: ${file}`)
}

// 4. 复制 dist 内容到目标目录
const distFiles = readdirSync(distDir)
for (const file of distFiles) {
  const src = join(distDir, file)
  const dest = join(pluginsDir, file)
  copyFileSync(src, dest)
  log(`安装: ${file}`)
}

// 5. 创建 package.json（让 OpenCode 识别为模块）
const pkgContent = JSON.stringify({
  name: "opencode-autoretry",
  version: "1.0.0",
  type: "module",
  main: "index.js",
}, null, 2)

import { writeFileSync } from "node:fs"
writeFileSync(join(pluginsDir, "package.json"), pkgContent, "utf-8")
log("创建 package.json")

log("")
log("安装完成！")
log(`插件位置: ${pluginsDir}`)
log("")
log("重启 OpenCode 后自动生效。")
log("如需配置，在 opencode.json 中添加 autoretry 块：")
log(JSON.stringify({
  autoretry: {
    enabled: true,
    maxRetries: 3,
    backoffMs: [3000, 6000, 12000],
    "retryOn": ["silent", "network"]
  }
}, null, 2))