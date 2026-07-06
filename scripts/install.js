/**
 * opencode-autoretry 安装脚本
 * 将编译后的插件部署到全局插件目录
 *   Windows: %USERPROFILE%\.config\opencode\plugins\
 *   Linux/macOS: ~/.config/opencode/plugins/
 *
 * 重要：插件文件直接放在 plugins/ 下，不放在子目录里
 * （与 OpenCode 文档示例一致：~/.opencode/plugins/notification.js）
 */
import { existsSync, mkdirSync, copyFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join, dirname, basename } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const projectRoot = join(__dirname, "..")

// 插件目标路径：直接放在 plugins/ 目录下，不建子目录
const pluginsDir = join(homedir(), ".config", "opencode", "plugins")
const distDir = join(projectRoot, "dist")

function log(msg) {
  console.log(`[autoretry-install] ${msg}`)
}

function fail(msg) {
  console.error(`[autoretry-install] 错误: ${msg}`)
  process.exit(1)
}

// 1. 检查 dist 目录
if (!existsSync(distDir)) {
  fail("dist/ 目录不存在，请先运行 npm run build")
}

// 2. 创建 plugins 目录（如果不存在）
if (!existsSync(pluginsDir)) {
  mkdirSync(pluginsDir, { recursive: true })
  log(`创建插件目录: ${pluginsDir}`)
}

// 3. 清理旧版安装（子目录形式 + 直接文件形式）
const oldSubdir = join(pluginsDir, "autoretry")
if (existsSync(oldSubdir)) {
  rmSync(oldSubdir, { recursive: true, force: true })
  log(`清理旧子目录: ${oldSubdir}`)
}

for (const file of readdirSync(pluginsDir)) {
  if (file.startsWith("autoretry")) {
    const filePath = join(pluginsDir, file)
    rmSync(filePath, { recursive: true, force: true })
    log(`清理旧文件: ${file}`)
  }
}

// 4. 复制 dist/index.js → plugins/autoretry.js（只复制 js，不复制 d.ts/map）
const srcJs = join(distDir, "index.js")
const destJs = join(pluginsDir, "autoretry.js")
copyFileSync(srcJs, destJs)
log(`安装: autoretry.js`)

log("")
log("安装完成！")
log(`插件位置: ${destJs}`)
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