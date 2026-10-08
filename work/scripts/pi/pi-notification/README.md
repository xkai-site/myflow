# pi-notification

Pi 通知扩展，要求 **Pi ≥ 1.1.0**。

- **人类通知**：运行结束、工具失败、压缩失败或等待输入时，发送本机、Webhook 或邮件提醒。
- **消息 API**：独立的只读 HTTP 推送，供 Dashboard 和自动化接收结构化事件与状态快照，默认关闭。

## 安装与快速上手

```bash
# 推荐用户级安装；本地路径指向本插件目录
pi install /absolute/path/to/pi-notification

# 或只在本次运行加载
pi -e work/scripts/pi/pi-notification/extensions/index.ts
```

项目级扩展需要项目已被信任。装好后默认只用本机提醒：执行完成和执行失败会提醒，需要回复默认关闭。

打开 `/notify`，按任务逐项配置：

1. **提醒时机**：执行完成、执行失败、需要我回复。失败包含运行失败和上下文压缩失败。
2. **接收方式**：本机和邮箱可以同时选择；新提醒默认使用统一接收方式，不必逐类设置。
3. **发送测试通知**：查看未发送的原因或发送结果，再确认自己是否看到。
4. **更多设置**：内容与隐私、免打扰、专业设置、状态与诊断。

普通修改立即生效，但**只影响这次对话**；想以后也这样，在目标项按 `Ctrl+S`。

| 操作 | 作用 |
|---|---|
| `↑↓` / `Enter` / `Esc` | 浏览、选择、返回 |
| `Space` | 快速切换开关 |
| `?` / `/` | 查看设置详情 / 搜索界面可编辑的设置 |
| `Ctrl+S` | 把当前项**已生效的值**保存为以后默认，不保存悬停候选或整个页面 |
| `Ctrl+T` | 测试当前接收方式；在专业提醒里测试该类接收方式 |
| `Ctrl+R` | 重读配置 |
| `Ctrl+O` | 查看状态、投递统计与配置错误 |
| 详情中的 `a` / `d` | 使用以后默认 / 确认后恢复此项初始设置 |

测试会忽略提醒重要程度、免打扰和频率限制，但**不绕过**强制静默、提醒总开关或已关闭的接收方式。

非 TUI 下 `/notify` 只打印状态，不打开设置或写盘；print/json 模式通过 stderr 回显，保持 stdout 干净。`--no-notify` 或 `PI_NOTIFY_DISABLE=1` 强制停止通知和消息 API 的所有外发，不改配置文件。

## 配置

用户配置位于 `~/.pi/agent/pi-notification/config.json`（使用自定义 agent 目录时随之变化），不读取项目级通知配置。生效顺序为**内置默认 → 用户配置 → 本对话选择**，配置文件只写需要覆盖的字段：

```json
{
  "version": 1,
  "quietHours": { "enabled": true, "start": "23:00", "end": "08:00", "exceptLevels": ["error"] }
}
```

- `Enter` 的修改只影响本对话；同一会话 `/reload`、`/resume` 后保留，`/new`、`/fork` 不继承。
- `Ctrl+S` 只保存当前一项已生效的值：「执行失败」保存两个失败开关，「接收方式」保存完整多选及所选接收方式当前的开关状态，不夹带邮箱地址、凭据或其他项的修改。
- 保存后仍保留本对话选择；详情中的 `a` 才取消该项的本对话修改。`d` 确认后删除同范围长期设置并取消本对话修改，不删除接收定义、地址或凭据。
- 手工或 Agent 编辑同一个 JSON 后按 `Ctrl+R` 或 `/reload` 生效；已修改的本对话项继续优先，并明确标识。
- 损坏的配置文件拒绝覆盖：通知降级为仅本机失败提醒，API 单独关闭。
- API 参数、Webhook URL 与认证 headers 只通过 JSON 配置，不进入本对话选择。

### 统一接收方式与规则

顶层 `channels` 默认 `["terminal"]`，每条规则默认 `channels: "inherit"`，表示跟随统一接收方式。

- 规则的显式数组是**单独设置**，`[]` 表示该类不发送。即使某个显式数组恰好与统一设置相同，也仍按单独设置处理，改统一选择不会覆盖它。
- 要让所有提醒跟随统一设置，在接收页明确确认「让所有提醒跟随统一接收方式」。该确认默认只改本对话，结果项 `Ctrl+S` 才长期保存；只改六条接收方式，不改开关或等级。
- 取消某个统一接收方式不会关闭仍被单独设置的提醒在用的渠道，接收页会提示例外；彻底停用某渠道请在专业设置中关闭它。
- 顶层 `channels` 与 `"inherit"` 是 version 1 的扩展：新版插件可读旧 JSON，旧插件不识别，使用新配置前请升级插件。

| 规则 | 默认 | 等级 | 说明 |
|---|---|---|---|
| `runCompleted` | 开启 | info | 最终运行完成；输出截断时改为 warning |
| `runFailed` | 开启 | error | 最终运行失败 |
| `runAborted` | 关闭 | info | 用户取消 |
| `toolFailed` | 开启 | warning | 默认并入运行结果；可设 `mode: "immediate"` 按 `threshold` 提醒 |
| `compactFailed` | 开启 | error | 压缩失败；主动取消不提醒 |
| `waitingForUser` | 关闭 | info | select / confirm / input / editor；不包含 custom |

完成判定使用最终 `agent_settled`：取消标记优先，否则读取最新 assistant 结果。自动重试和继续执行不作为独立完成通知；没有足够证据时为 unknown，默认不通知。completed 不保证业务目标成功。

### 常用参数

| 配置项 | 默认 | 用途 |
|---|---|---|
| `enabled` | true | 人类通知开关，不影响显式开启的 API |
| `channels` | ["terminal"] | 统一接收方式，可多选；与独立消息 API 无关 |
| `rules.*.channels` | "inherit" | 跟随统一选择，或显式自定义数组（`[]` 不投递） |
| `minLevel` | info | 最低通知等级：info / warning / error |
| `coalesce.windowMs` | 1500 | 同一运行的通知合并窗口 |
| `coalesce.cooldownMs` | 3000 | 同类通知的冷却时间 |
| `quietHours.enabled` | false | 本地时间免打扰，支持跨午夜；起止相同表示全天 |
| `content.includeSessionLabel` | true | 标题包含会话名，未命名时使用项目目录名 |
| `content.includeAssistantExcerpt` | false | 开启后附最终回复的短摘录，可能泄露敏感内容 |
| `content.includeCost` | true | 显示已上报成本与上下文占比；缺失时不猜测 |
| `content.maxMessageChars` | 300 | 通知正文长度上限 |
| `shutdownFlushMs` | 200 | 退出时通知与 API 共用的收尾预算 |

希望每次运行都提醒，就把 `coalesce.windowMs` 和 `coalesce.cooldownMs` 都设为 `0`。规则开启只表示通过筛选：还需通过等级、免打扰及频率限制，并有可用渠道。其余可靠性参数（工具失败策略与阈值、等待输入类型、超时/重试/并发/队列/熔断等）只在 JSON 中调整。完整默认值见 [`src/config.ts`](src/config.ts)，配置类型见 [`src/types.ts`](src/types.ts)。成本只覆盖当前扩展实例，重载或切换会话后重新累计。

## 接收渠道

### 本机通知

自动选择 Windows toast、kitty OSC 99 或其它终端的 OSC 777；能否显示取决于终端支持，macOS 不提供原生横幅。

非 TTY 默认不发本机通知，避免污染 print/json 的 stdout 或意外弹窗。显式指定 `PI_NOTIFY_CHANNEL=toast` 可在非 TTY 下使用系统通知，不写 stdout。

### QQ 邮箱

在 `/notify → 接收方式 → 邮箱提醒` 中：

1. 填写 QQ 发件地址和收件地址（支持多个）。每项 `Enter` 只对本对话生效，想长期使用需各自按 `Ctrl+S`；主题前缀默认 `[Pi]`。
2. 在 [QQ 邮箱](https://mail.qq.com/) 开启 SMTP 并生成**授权码**（不是登录密码），再用「设置邮箱授权码」保存。Windows 存入当前用户的凭据管理器，所有对话可用，不写 JSON、会话或日志；其它系统可用 `PI_NOTIFY_QQ_SMTP_AUTH_CODE` 注入。
3. **明确确认启用邮箱并加入统一接收方式**。填地址或存授权码都不会自动开启、不会自动选邮箱、也不会自动测试；本机可继续同时选中。
4. 手动发送邮箱测试并检查收件箱/垃圾邮件。测试失败会保留你的明确选择，不会偷偷改路由。

使用 `smtp.qq.com:465` / TLS。只想收邮件时，取消统一接收方式里的本机选择即可；若仍有提醒被单独设置为本机，页面会提示。SMTP 接受不保证进入收件箱。

以下字段位于配置区（不含授权码），Agent 也可直接编辑；`channels` 与规则里的 `"inherit"` 写法与界面一致：

```json
{
  "version": 1,
  "channels": ["terminal", "email"],
  "providers": [{
    "id": "email", "type": "email", "enabled": true,
    "options": { "from": "sender@qq.com", "to": ["reader@example.com"] }
  }],
  "rules": { "runFailed": { "channels": "inherit", "level": "error" } }
}
```

### Webhook v1（通知）

Webhook 接收经过通知规则筛选的标题与正文，和下面的消息 API 是不同契约。

```json
{
  "version": 1,
  "providers": [
    { "id": "terminal", "type": "terminal", "enabled": true, "options": {} },
    {
      "id": "hook",
      "type": "webhook",
      "enabled": true,
      "options": { "url": "https://example.com/notify", "secretEnv": "PI_NOTIFY_WEBHOOK_SECRET" }
    }
  ],
  "rules": {
    "runCompleted": { "channels": ["terminal", "hook"] },
    "runFailed": { "channels": ["terminal", "hook"] }
  }
}
```

启动 Pi 前设置 `PI_NOTIFY_WEBHOOK_SECRET`：配置只保存环境变量名，不保存密钥。`options.headers` 可加认证头，但不能覆盖保留头。

POST 载荷示例：

```json
{
  "source": "pi-notification",
  "version": 1,
  "event": "run_failed",
  "level": "error",
  "title": "任务未完成",
  "body": "失败原因：provider error",
  "dedupeKey": "<sessionId>:<runId>:run_failed",
  "sessionId": "…",
  "runId": "…",
  "durationMs": 1200,
  "at": 1700000000000
}
```

请求头为 `X-Pi-Notify-Event` 和可选 `X-Pi-Notify-Signature: sha256=<hex>`，签名方式与消息 API 相同（原始 body 的 HMAC-SHA256）。

## 消息 API（Dashboard / 自动化）

### 开启

```json
{
  "version": 1,
  "enabled": false,
  "api": {
    "enabled": true,
    "url": "https://dashboard.example.com/pi/messages",
    "secretEnv": "PI_MESSAGE_SECRET"
  }
}
```

启动前设置 `PI_MESSAGE_SECRET`，重读配置后生效。上面的 `enabled: false` 只关闭人类通知；API 不受通知规则、免打扰或频率限制。

| API 参数 | 默认 | 说明 |
|---|---|---|
| `enabled` | false | 独立输出开关 |
| `url` | 空 | 单个 HTTP(S) POST 地址 |
| `secretEnv` | 空 | HMAC 密钥的环境变量名；为空时无签名 |
| `headers` | `{}` | 附加认证头，不得覆盖保留头 |
| `includeLabels` | false | 是否包含清洗、限长的会话名/项目短标签 |
| `timeoutMs` | 5000 | 单条投递总预算，含重试；1–120000ms |
| `maxRetries` | 1 | 额外重试次数；0–10 |
| `queueLimit` | 100 | 等待队列上限；1–1000 |

### 接收契约

每条事件是一个独立 POST，`Content-Type: application/json; charset=utf-8`，携带**事件后的完整快照**：

```json
{
  "source": "pi-notification",
  "schemaVersion": 1,
  "type": "run.settled",
  "eventId": "stream-uuid:3",
  "streamId": "stream-uuid",
  "seq": 3,
  "sessionId": "session-uuid",
  "runId": "stream-uuid-1",
  "occurredAt": 1700000001000,
  "data": { "runId": "stream-uuid-1", "status": "completed", "stopReason": "stop", "toolFailures": [] },
  "snapshot": {
    "state": "done",
    "prompts": [],
    "lastRun": { "runId": "stream-uuid-1", "status": "completed", "startObserved": true, "durationMs": 1000 }
  }
}
```

| 事件 | 含义 |
|---|---|
| `session.started` / `session.updated` / `session.ended` | 会话开始、标签更新或结束；started 声明观察覆盖范围 |
| `run.started` / `run.settled` | 逻辑运行开始/最终结果 |
| `tool.failed` | 工具失败及计数 |
| `compaction.started` / `compaction.settled` | 压缩操作开始/结果；可能只有 settled |
| `prompt.opened` / `prompt.closed` | 可观察的输入对话打开/关闭 |
| `state.snapshot` | 当前状态，例如重新开启 API 或切换端点后 |

- run 结果为 `completed | failed | aborted | unknown`；`length` 表示截断，unknown 不当作成功。快照状态为 `idle | working | blocked | done | error | unknown`。
- 未观察到开始时 `startObserved=false`，不提供开始时间或耗时；成本仅在所有已观察 assistant 消息完整上报时提供。
- 非 agent 操作使用 `operationId` / `promptId`，不伪造 runId。不发送输入、回复摘录、工具参数/结果、压缩内容或完整 cwd；标签默认关闭，错误说明限长并脱敏。完整字段见 [`src/types.ts`](src/types.ts)。

### 签名、去重与顺序

请求头：`X-Pi-Message-Event`、`X-Pi-Message-Id`、可选 `X-Pi-Message-Signature: sha256=<hex>`。接收端应限制 body 大小，校验 schema 和签名后返回 2xx。签名使用**实际 UTF-8 body 字节**，不可 parse 后重新序列化：

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, signature, secret) {
  if (!secret || !/^sha256=[a-f0-9]{64}$/.test(signature ?? "")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}
```

- 使用 `eventId` 做幂等；2xx 只表示接受消息，不代表自动化动作完成。
- `seq` 只在同一 `streamId` 内递增；重复或迟到消息不能覆盖较新快照，**不能跨 stream 比较 seq**。runtime 重建时 streamId 改变，建立新流后拒绝已退休旧流的迟到消息；用 sessionId/runId 关联任务。

### 投递与覆盖限制

- **Best-effort**：有界 FIFO；网络错误、408、429、5xx 可有限重试，普通永久 4xx 不重试。重试保持相同 body 和 ID，但可能重复或丢失。
- 队列满时丢最旧的未发送事件，seq 可缺号；没有离线补发、重启重放或 exactly-once 保证。
- 端点或安全参数改变时取消旧请求/队列，重新开启或切换后发送当前快照；已被接收的请求不能撤回。reload/new/resume/fork 立即丢弃旧实例，`session.ended` 不保证送达。
- **无心跳、无控制接口**：Dashboard 应显示最后更新时间，不能据此宣称进程仍存活。仅覆盖公共扩展事件：登录/auth、部分内部对话、纯命令和后台子任务不完整可观察；custom 不视为等待输入。

## 安全与排障

HTTP 输出仅支持 http/https，拒绝内嵌 URL 凭据和重定向。配置指定 secretEnv 后，缺失密钥会拒绝发送，不会降级为无签名。公网推荐 HTTPS + HMAC，并限制接收端访问与留存。

人类通知默认包含会话名或项目目录名；不希望外传时关闭 `content.includeSessionLabel`。回复摘录默认关闭。错误脱敏无法保证识别所有敏感文本，不要把通知接收端当作公开日志。

| 环境变量 | 用途 |
|---|---|
| `PI_NOTIFY_DISABLE=1` | 强制停止所有外发 |
| `PI_NOTIFY_CHANNEL` | 本机机制：auto / osc777 / osc99 / toast / off；off 不影响 HTTP 或邮件 |
| `PI_NOTIFY_QQ_SMTP_AUTH_CODE` | QQ SMTP 授权码的兼容注入方式 |
| `PI_NOTIFY_WEBHOOK_SECRET` / `PI_MESSAGE_SECRET` | 示例使用的签名密钥名，可通过 secretEnv 自定义 |
| `PI_NOTIFY_LOG_FILE` | 启用 JSONL 诊断日志 |
| `PI_NOTIFY_DEBUG=1` | 将人类可读日志输出到 stderr |

未收到提醒时先按 `Ctrl+T` 测试：反馈会区分未发送及原因、排队、发送中、已提交给接收服务、失败，多个接收方式分别报告。终端/系统接口、SMTP 与 HTTP 的接受都**不等于**实际看到或到箱，需自行确认。再用 `Ctrl+O` 查看当前阻断原因和下一步，技术统计在后面的诊断详情。

## 开发与测试

```bash
cd work/scripts/pi/pi-notification
npm test          # 全部专项
npm run test:api  # 单个专项，其余见 package.json
```

完整测试需要同版本 Pi SDK/CLI，可用 `PI_SDK=/path/to/pi-coding-agent/dist/index.js` 指定；Git Bash 下加 `MSYS_NO_PATHCONV=1`，避免参数被改写。

测试使用临时目录、假模型/SMTP/凭据库与回环 HTTP，不修改真实用户配置、不读真实授权码，也不发送真实邮件或系统通知。真实终端显示与邮件到箱需另行获得许可后人工验证。
