# opencode-autoretry

OpenCode 插件：智能检测静默中断并自动重试。

当 OpenCode 会话因网络抖动、中转网关超时（60s nginx 超时）或静默中断失败时，插件能识别不同类型的错误类型并重试，让工作持续推进不被打断。

## 功能特性

### 自动检测三大类中断

- **连接断开**：`ECONNRESET`、`Server disconnected`、网络抖动
- **静默中断**：0 输出、`finish=unknown`，OpenCode 自己都检测不到的本质错误
- **超时断开**：`Connection failed: Server disconnected without sending a response.`

### 空白完成保护

- 识别中转网关 60s 超时的伪造 `finish=length` + 0 output + 空 parts
- 避免下游组件（如大纲页时间轴）误判为"正常截断"
- 只对真正空白（无文本无工具调用）触发续写

### 子代理等待防护

- Sisyphus/ultraworker 等编排型 agent 发 task() 后等子代理返回时，session 自然 idle
- 插件不发送"继续"/"继续！！！"，避免打断编排逻辑

### 可靠的重试机制

- 最大重试 2 次（避免死循环）
- 退避：5s → 10s（避免和网关 HTTP keepalive 冲突）
- 轮询兜底：60 秒无事件才轮询（极端情况）

### 三大防奔溃机制

1. `session.error` 触发时直接用事件 error 对象，不依赖 DB 时序
2. `session.idle` 不杀 pending retryTimer（之前会杀）
3. `chat.message`/`session.status` 看到标记不重置空白计数（避免无限循环）

### 清洁的单一真相源

- 核心逻辑统一在 `src/index.ts`
- `npm run build && npm run install-plugin` 部署
- 与本地 `autoretry.js` 分离，永远保持同步

## 安装

### 从源码安装

```bash
git clone https://github.com/rayn1314/opencode-autoretry.git
cd opencode-autoretry
npm install
npm run build
npm run install-plugin
```

安装脚本会将 `dist/index.js` 拷到 `~/.config/opencode/plugins/autoretry.js`。

### 预编译版本

（待发布）

## 配置

插件目前使用硬编码默认配置（单一真相源），未来可扩展为 `opencode.json` 可选配置：

```json
{
  // 未来可能添加的配置
  "autoretry": {
    "enabled": true,
    "maxRetries": 2,
    "backoffMs": [5000, 10000],
    "pollIntervalMs": 60000,
    "retryOn": ["输出截断", "静默中断", "数据流截断", "连接断开", "请求超时"]
  }
}
```

暂不可配的原因：
- 检测逻辑依赖 FFT（可视化反馈）
- 子代理等待防护当前对所有 agent 一致
- 空白检测已收敛为唯一出口，无需额外配置

## 错误分类

| 分类 | 触发条件 | 奔溃行为 |
|------|----------|----------|
| **用户中止** | `MessageAbortedError` | 跳过，不打扰 |
| **输出截断** | output>0 | 重试发送"继续" |
| **静默中断** | 0 output + 无 error + finish=unknown | 重试发送上一条消息 |
| **数据流截断** | JSON parsing / Unterminated | 重试发送"继续" |
| **连接断开** | `Connection failed` / `Server disconnected` / `ECONNRESET` | 重试发送上一条消息 |
| **请求超时** | `timeout` / `timed out` | 重试发送上一条消息 |
| **限流** | `429` / `rate limit` | toast 提醒，不重试 |
| **服务商异常** | `5xx` / `provider` | toast 提醒，不重试 |

## 工作原理

### session.error 路径（第一防线）

```
session.error 事件 ← OpenCode 服务端
    ↓
直接提取 error.name + error.message（事件自带）
    ↓
分类错误类型
    ↓
可重试？ → 否 → toast 提醒
    ↓
是 → 检查 retryCount < maxRetries
    ↓
是 → scheduleRetry(5s/10s)
```

**特点**：错误消息还没入库也能分类，不依赖 DB 时序。

### session.idle 路径（第二防线）

```
用户发消息 → session idle
    ↓
checkAndRetry 查消息列表
    ↓
finish=stop/length + output=0 → 空白完成检测
    ↓
finish=unknown → 分类错误，scheduleRetry
    ↓
若 retryTimer 存在 → 只清 pollTimer，保留 retryTimer
    ↓
否则 → 清空所有状态和定时器
```

**特点**：`session.idle` 看到 pending retryTimer 时不杀掉它（之前会杀）。

### 轮询路径（极端兜底）

```
60s 内无任何事件 → poll check 触发
    ↓
检查 lastActivity 是否 ≥ 60s
    ↓
是 → checkAndRetry（同 session.idle 路径）
    ↓
清空 pollTimer
```

### chat.message 防循环机制

```
用户发消息 → autoSendPending? 
    ├─ 是（autoretry 发的）→ 只更新时间戳，不重置 blankCount/retryCount
    └─ 否（真正用户）→ 重置 blankCount=0, retryCount=0
```

**特点**：`chat.message` 不应看到自己的续写消息，否则 blankCount 永远到不了 maxRetries。

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
level: info
message: autoretry plugin loaded (idle-check)
message: detected interrupt: 连接断开
message: retry sent (1)
message: subagent wait detected, skipping all retry/continuation
```

### 什么时候触发分类

- `session.error`：最后一条 assistant 消息有 error
- `session.idle`：最后一条 assistant 消息无 error + finish=undefined
- `poll check`：最后一条 assistant 消息无 error + finish=undefined + 超过 60s

### 什么时候跳过

- `session.idle` 检测到 `finish=stop`/`finish=length` → 不走分类
- 子代理等待（前条消息有 tool calls + 当前无 error + output=0） → 不发续写
- finish=stop 且有文本/工具 → 不触发空白完成续写

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

## 诊断脚本

仓库提供 4 个只读诊断脚本，直接查询 OpenCode 的 SQLite 数据库，帮助定位异常消息和验证 autoretry 行为。

### diagnose — 综合诊断

扫描数据库中的异常消息模式，快速掌握整体状况。

```bash
npm run diagnose          # 扫描最近 7 天
npm run diagnose -- 30    # 扫描最近 30 天
npm run diagnose -- 0     # 扫描全部记录
```

检测项：
1. 空白完成（finish=stop/length + output=0）
2. 中转网关伪造 length（finish=length + output=0 + input>0）
3. 连接断开（Connection failed / disconnected / ECONNRESET）
4. 静默中断（finish=undefined + output=0 + 无 error）
5. 零 token 消息（input=0 + output=0）
6. autoretry 触发记录（"继续"/"继续！！！"消息）

### timeline — Session 消息时间线

查看特定 session 的完整消息流，包括角色、finish、token、错误、工具调用。

```bash
npm run timeline -- <session-id>
# 示例：
npm run timeline -- ses_0c82b5cf5ffeDHr2ayODq7mlX8
```

输出包含每条消息的 finish 状态、token 用量、error 详情、工具调用摘要。如果发现错误消息，会自动检查错误后是否有 autoretry 介入。

### errors — 错误消息查找

按关键词搜索消息，查看完整 JSON 结构和上下文。

```bash
npm run errors -- "Connection failed"
npm run errors -- "disconnected"
npm run errors -- "UnknownError"
npm run errors                          # 不带参数：列出最近 10 条有 error 的消息
```

每条匹配消息会显示：role、finish、tokens、error 完整结构、provider/model，以及前一条 assistant 消息的状态（用于判断 isSubagentWait 是否应该拦截）。

### trace — autoretry 触发追踪

查找 autoretry 发送的"继续"/"继续！！！"消息，显示每次触发的上下文和结果。

```bash
npm run trace             # 最近所有触发
npm run trace -- 7        # 最近 7 天
npm run trace -- <session-id>  # 特定 session
```

每次触发显示：
- 触发原因（前一条 assistant 的 finish、output、error、hasTool）
- 触发类型（空白完成续写 / 中断重试 / 输出截断续写）
- 重试结果（✓ 成功 / ✗ 失败 / ? 仍空白）

### 数据库路径

脚本自动定位 `~/.local/share/opencode/opencode.db`。可通过环境变量覆盖：

```bash
OPENCODE_DB=/path/to/opencode.db npm run diagnose
```

## 已知限制

1. **依赖 OpenCode 事件结构**：`session.error` 的 payload 结构未在文档中明确，当前做防御性处理
2. **配置读取**：当前配置硬编码在 `src/index.ts`，未来可扩展为全局配置
3. **重试内容**：当前只重发用户消息的 `parts`，不处理 attachments

## License

MIT
