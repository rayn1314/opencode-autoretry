# opencode-autoretry

OpenCode 插件：自动重试中断的 AI 对话。

当 OpenCode 会话因网络抖动、供应商超时或静默中断失败时，自动检测并重试发送上一条用户消息，让工作持续推进而不被打断。

## 功能

- **自动检测中断**：监听 `session.error` 事件，识别静默中断、网络错误、超时等
- **智能重试**：只在可恢复错误上重试，避免无效重试烧 token
- **退避策略**：3s → 6s → 12s 指数退避，给供应商网络喘息时间
- **重试上限**：默认最多 3 次，防止死循环
- **可视化反馈**：toast 提示当前重试状态
- **可配置**：在 `opencode.json` 中调整所有参数

## 安装

### 方式一：从源码安装

```bash
git clone https://github.com/rayn1314/opencode-autoretry.git
cd opencode-autoretry
npm install
npm run build
npm run install-plugin
```

### 方式二：下载预编译版本

（待发布到 npm 后补充）

## 配置

在 `opencode.json` 中添加 `autoretry` 块：

```json
{
  "autoretry": {
    "enabled": true,
    "maxRetries": 3,
    "backoffMs": [3000, 6000, 12000],
    "retryOn": ["silent", "network"]
  }
}
```

### 配置项说明

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | `true` | 是否启用自动重试 |
| `maxRetries` | number | `3` | 最大重试次数 |
| `backoffMs` | number[] | `[3000, 6000, 12000]` | 退避时间（毫秒），按重试次数递增 |
| `retryOn` | string[] | `["silent", "network"]` | 触发重试的错误类型 |

### 错误类型说明

| 类型 | 含义 | 是否默认重试 |
|------|------|--------------|
| `silent` | 静默中断（0 输出、finish=unknown） | ✅ |
| `network` | 网络错误（ECONNRESET、fetch failed） | ✅ |
| `timeout` | 超时错误 | ❌ |
| `other` | 其他错误（如 API key 错误） | ❌ |

## 工作原理

```
用户发消息 → AI 响应中 → 触发 session.error
                              ↓
                    插件收到错误事件
                              ↓
                    分类错误类型
                              ↓
           可重试类型          不可重试类型
                ↓                    ↓
        检查重试次数 < 上限      toast 提醒用户
                ↓
        等待退避时间（3s/6s/12s）
                ↓
        session.prompt() 重发上一条用户消息
                ↓
        计数 +1，继续监听
```

## 与 watchdog 的关系

- **opencode-autoretry（本插件）**：运行在 OpenCode 内部，负责自愈
- **opencode-watchdog（外部工具）**：独立进程，负责外部监控备份

两者互补，不冲突：
- 插件在内部自动重试，推进工作
- watchdog 在外部兜底，当插件重试失败或禁用时仍能提醒

## 日志查看

插件使用 OpenCode 内置日志系统，可在 OpenCode 日志中查看：

```
service: autoretry
level: info/warn/error
message: 插件已初始化 / 检测到会话错误 / 已重试第 N 次
```

## 开发

```bash
# 安装依赖
npm install

# 编译 TypeScript
npm run build

# 类型检查
npm run typecheck

# 部署到全局插件目录
npm run install-plugin
```

## 已知限制

1. **依赖 OpenCode 事件结构**：`session.error` 的 payload 结构未在文档中明确，当前做防御性处理
2. **配置读取**：`opencode.json` 中的 `autoretry` 配置读取依赖 OpenCode SDK 行为
3. **重试内容**：当前只重发用户消息的 `parts`，不处理 attachments

## License

MIT