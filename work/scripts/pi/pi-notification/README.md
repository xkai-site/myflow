# pi-notification

Pi 扩展：**在一次 agent 运行真正结束时**（而不是每次底层 run 结束时）产生一条**系统桌面通知或 Webhook**，可配置、可关闭。

设计方案与全部实测依据：`plans/pi-notification-plugin-design.md`（v1.2，§17 渠道抽象、§18 实测修订）。
交接与后续计划：`plans/pi-notification-handoff.md`、`plans/pi-notification-plugin-m2.md`。

> 当前进度：**MVP + S4 + S6 + S7 已完成** —— S1 骨架、S1.5 回归、S3 终端渠道、S5 最小配置面、
> **S4 合并窗口/冷却**、**S6 工具失败/压缩失败/等待输入**、**S7 Webhook 渠道（+ 可靠性装饰器）**。
> 尚未做：`quietHours` 静默时段、配置向导与写盘（`/notify on|off|config|reload`）、
> 成本/上下文占比、macOS 原生横幅（`osascript`）、Telegram/Discord/Slack、通知历史与状态行
> （详见下方「当前能力与缺口」与 `plans/pi-notification-handoff.md` §2）。

---

## 为什么不是 `agent_end`

官方文档明确：`agent_end` 之后 Pi 还可能**自动重试**、**自动压缩后重试**、或继续处理**排队消息**。
一次 provider 失败在实测中产生了 **4 条 `agent_end`**，但只有 **1 条 `agent_settled`**。
更糟的是 `agent_settled` 本身**也不等于成功**——用户按 Esc 会被 settle、provider 报错也会 settle。
所以判定必须“出口用 `agent_settled`，语义用最后一次 assistant 的 `stopReason`”：

| 最后 stopReason | 判定 | 默认是否通知 |
|---|---|---|
| `stop` / `toolUse` | completed | ✅ info |
| `length` | completed（**输出被截断**） | ✅ 强制 `warning`，标题写明截断 |
| `error` | failed | ✅ error |
| `aborted` | aborted | ❌ 默认关（人就在终端旁） |
| 拿不到（`pending` / `deferred` / 无 assistant） | unknown | ❌ 默认关（宁可少发不误报） |

**一次运行最多一条通知**：同一「逻辑运行」（`sessionId + runId`）内的多条事件会被合并窗口吸收；
同一 `kind` 的两次通知之间有冷却窗口。工具失败的名字并入结果通知正文，而不是另发一条。

---

## 安装

推荐装在**用户级**（`~/.pi/agent/extensions/`）而不是项目级：项目级 `.pi/extensions` 在未信任的项目里
**静默不加载**，且恒晚于 CLI 扩展加载。

```bash
# 直接引用本目录（不复制），开发期最方便
pi -e work/scripts/pi/pi-notification/extensions/index.ts

# 或作为包安装（package.json 已声明 pi.extensions）
#   ~/.pi/agent/settings.json 的 packages 中登记本目录
```

本插件**没有任何第三方依赖**（HTTP 用 Node 内置 `fetch`），也不注册模型 provider、不注册
`tool_call` / `input` / `session_before_*`。

---

## 配置

| 层级 | 路径 | 何时读取 |
|---|---|---|
| 默认值 | 内置 | 总是 |
| 用户级 | `~/.pi/agent/pi-notification/config.json` | 总是 |
| 项目级 | `<项目>/.pi/pi-notification/config.json` | **仅当项目被信任**（`ctx.isProjectTrusted()`） |

后面的层覆盖前面的层（逐字段）。**项目级不得定义 `providers`**：该字段会被忽略并告警——
渠道会承载 URL 与密钥，不能让一个 clone 下来的仓库决定把通知发到哪里（设计 §13 第 7 项）。

完整可配字段（含默认值）：

```jsonc
{
  "version": 1,
  "enabled": true,                       // 总开关
  "minLevel": "info",                    // "info" | "warning" | "error"

  "rules": {
    "runCompleted":  { "enabled": true,  "level": "info",    "channels": ["terminal"] },
    "runFailed":     { "enabled": true,  "level": "error",   "channels": ["terminal"] },
    "runAborted":    { "enabled": false, "level": "info",    "channels": ["terminal"] },

    // 工具失败：aggregate（默认）= 并入本次运行的结果通知；
    //            immediate = 某工具失败达到 threshold 时立刻提醒（长任务里没人盯着终端）
    "toolFailed":    { "enabled": true,  "level": "warning", "channels": ["terminal"],
                       "mode": "aggregate", "threshold": 1 },

    "compactFailed": { "enabled": true,  "level": "error",   "channels": ["terminal"] },

    // 等待用户输入：与 runCompleted 高度重叠，默认关闭；`custom` 永久排除（见下）
    "waitingForUser":{ "enabled": false, "level": "info",    "channels": ["terminal"],
                       "kinds": ["select", "confirm", "input", "editor"] }
  },

  // 合并/冷却（0 = 关闭该项过滤）
  "coalesce": {
    "windowMs": 1500,             // 同一「逻辑运行」内只放行一条通知
    "toolFailureWindowMs": 10000, // immediate 模式下把并行失败聚合成一条的窗口
    "cooldownMs": 3000            // 同一 kind 两次通知的最小间隔
  },

  "content": { "includeDuration": true, "includeToolFailureNames": true, "maxMessageChars": 300 },

  "delivery": {
    "timeoutMs": 8000,            // 单次投递的总预算（超时算失败）
    "maxRetries": 1,              // 额外重试次数（指数退避；每次尝试有自己的 deadline）
    "concurrency": 1,
    "queueLimit": 50,
    "circuitBreakerFailures": 3   // 连续失败多少次后熔断该渠道（30s 后放行一次探测）
  },

  "providers": [
    { "id": "terminal", "type": "terminal", "enabled": true, "options": {} },
    { "id": "hook", "type": "webhook", "enabled": false,
      "options": {
        "url": "https://example.invalid/hook",   // 只允许 http/https，且不得内嵌凭据
        "secretEnv": "PI_NOTIFY_WEBHOOK_SECRET", // **只存环境变量名**，不存明文
        "headers": {}                            // 可选附加请求头
      } }
  ],

  "shutdownFlushMs": 200          // quit 时允许等待收尾投递的预算
}
```

### 只想每次运行都收到通知？

把两个过滤关掉即可（`coalesce` 里两个 0）。默认值是为了防刷屏：
用户连点两次、或一次输入触发了多次运行，默认只会收到一条。

### 配置写错会怎样（重要）

**不会静默全关。** 解析失败或字段非法时，插件降级为安全子集：
**只发失败通知（`run_failed` / error 门槛 / `terminal` 渠道）**，并在 `/notify status` 与诊断日志里写明原因。
理由：用户写错一个逗号就再也收不到失败通知，是这个插件最糟糕的失败模式。

### 环境变量

| 变量 | 作用 |
|---|---|
| `PI_NOTIFY_DISABLE=1` | 整个插件的会话级静默（不改配置文件） |
| `PI_NOTIFY_CHANNEL=off` | 只静默**本地通知**渠道（`auto`/`osc777`/`osc99`/`toast`/`off`） |
| `PI_NOTIFY_WEBHOOK_SECRET=<值>` | webhook 签名密钥（**值只在这里**，配置里只出现变量名） |
| `PI_NOTIFY_LOG_FILE=<path>` | 打开 JSONL 诊断记录（测试与排障用；不设置则零开销） |
| `PI_NOTIFY_DEBUG=1` | 把人类可读日志镜像到 stderr |

---

## 命令

| 命令 | 作用 |
|---|---|
| `/notify status` | 开关、生效规则/渠道、合并/冷却参数、配置来源、终端机制、投递统计（成功/失败/去重/合并/冷却/丢弃）、上次成功时间、上次错误、是否正在等你输入、配置错误与告警 |
| `/notify test` | 立即走一遍完整投递链路（含渠道选择与清洗），用来确认“通知到底能不能到”。**自检绕过合并/冷却**，否则“自检没收到”会被误读成渠道坏了 |

CLI 开关：`--no-notify` 让本会话不发通知（不改配置文件）。

---

## 通知走哪条路

| 渠道类型 | 机制 | 触发条件 / 说明 |
|---|---|---|
| `terminal` | **OSC 99** | `KITTY_WINDOW_ID` 或 `TERM_PROGRAM=kitty` |
| `terminal` | **OSC 777** | 其它有 TTY 的环境（默认） |
| `terminal` | **Windows toast** | `platform === "win32"`（Windows Terminal 不渲染 OSC 777） |
| `webhook` | **HTTP POST** | 需要 `url`；有 `secretEnv` 时对**实际发送的字节**做 HMAC-SHA256 签名 |

本地三种机制按上表自动选择，也可用 `PI_NOTIFY_CHANNEL` 强制。
**能不能真的看见，取决于终端模拟器**（设计 §13 第 18 项：没有终端焦点 API）。
macOS 只走 OSC 777，因此 Apple Terminal 不会显示；原生横幅（`osascript`）未实现。

### Webhook 细节

请求形态（`POST`，`content-type: application/json; charset=utf-8`）：

```json
{
  "source": "pi-notification",
  "version": 1,
  "event": "run_failed",
  "level": "error",
  "title": "任务失败",
  "body": "用时 1.2s · 1 个工具失败: bash",
  "dedupeKey": "<sessionId>:<runId>:run_failed",
  "sessionId": "…", "runId": "…", "durationMs": 1200, "at": 1700000000000
}
```

- 附加请求头：`X-Pi-Notify-Event: <kind>`，以及（有密钥时）`X-Pi-Notify-Signature: sha256=<hex>`；
  接收方用同一个 secret 对**原始 body** 重算 HMAC 即可验证。
- **配置里只出现环境变量名**；密钥缺失时该渠道判定为不可用并降级为 noop（不会静默发到错地方）。
- **不跟随重定向**（`redirect: "error"`），避免把签名/载荷带到另一个主机；URL 不得内嵌用户名/密码。
- 响应非 2xx 即失败（错误信息带状态码与**脱敏后**的响应体片段）；日志里只记录 `origin + pathname`，
  **丢弃 query**（query 常被用来传 token）。
- 只发结构化元数据：不含用户输入原文、不含完整回复。

### TTY 纪律（重要）

**写 `stdout` 的机制（OSC 777 / OSC 99）必须先确认 `stdout` 是 TTY。**
`pi -p`、`--mode json`、输出被重定向都属于这种情况：stdout 是调用方读走的数据，
往里塞 OSC 序列会直接破坏输出。此时本地渠道降级为 noop，并在诊断日志里留一条
`channel_degraded`（说明原因），而不是静默消失、也不会报错。

`auto` 在非 TTY 下一律不发（避免脚本化运行意外弹系统通知）；
但 **`PI_NOTIFY_CHANNEL=toast` 是显式指定，不受 TTY 限制**——toast 写的是操作系统通知，不碰 stdout。

---

## 通知的触发时刻

| hook | 时机 | 产出 |
|---|---|---|
| `agent_settled` | **唯一**完成出口 | `run_completed` / `run_failed` / `run_aborted`，或（当结果不通知时）聚合的 `tool_failed` |
| `tool_execution_end` | 某次工具执行失败 | `mode: aggregate`：只累积；`mode: immediate`：达到 threshold 立刻发 `tool_failed` |
| `session_compact_failed` | 压缩失败（含手工 `/compact`） | `compact_failed`（error）；`aborted: true` 不发（用户自己取消的） |
| `ui_prompt_start` | Pi 开始等待用户（`select`/`confirm`/`input`/`editor`） | `waiting_for_user`（默认关闭）；**`custom` 永久排除** |
| `ui_prompt_end` / `session_shutdown` | 不再等待 | 复位等待状态（强杀时可能收不到 `end`，所以 shutdown 也兜底复位） |

两个刻意的取舍，都有实测依据（设计 §18.5 修订 1）：

1. **`custom` 永久排除**：TUI 下 `custom()` 常被当作纯进度加载器，RPC 下它根本没有 UI 却仍会触发 span，
   与“用户在输入”无关。即使把它写进 `kinds` 也不生效（会给出告警）。
2. **不靠 `kind` 配对 start/end**：嵌套 prompt **不会**产生内层 span，`ui_prompt_end.kind` 报的是**外层**，
   所以只做“开始 +1 / 结束 −1”的簿记。

---

## 当前能力与缺口

**能做**：判定 completed/failed/aborted/unknown（含 `length` → warning）→ 规则映射等级与渠道 →
门槛/去重/**合并窗口/冷却** → 入队 → 在独立任务里投递（终端/系统通知、Webhook）→
内置超时/重试/熔断/脱敏；工具失败聚合、压缩失败、等待输入；
用户级与项目级配置读盘（含降级）；`/notify status|test`；`--no-notify`；
`reload` 后旧实例失效、不重复投递；quit 时在 200ms 预算内尽力投递。

**还没做**：

- ❌ **`quietHours` 静默时段**（设计 §10.2/§8/§12.1 已定，代码尚未实现）——目前**不能**按“23:00–08:00 静音”这类策略过滤
- ❌ 配置向导与写盘（`/notify on|off|config|reload`、原子写 + `0o600`）；目前配置只能手工编辑 JSON
- ❌ 成本/上下文占比（`content.includeCost`）：usage **尚未采集**，所以打开它也不会有效果
- ❌ macOS 原生横幅（`osascript`）
- ❌ Telegram / Discord / Slack 等专用渠道（Webhook 已是它们的通用底座）
- ❌ 通知历史与状态行（`pi.appendEntry` + `registerEntryRenderer`、`ctx.ui.setStatus`；设计列为可选）
- ❌ 子任务通知（前台 `subagent` 可用 `tool_execution_end` 观察；后台 `async:true` 的完成
  发生在 detached runner 进程里，父进程看不到——设计 §18.5 修订 4 裁定 MVP 不做）

**“接受但不生效”的字段**：`content.includePromptExcerpt` 会被校验但**没有任何代码读它**
（插件从不外传 prompt 原文，所以它永远是 no-op）；目前保留仅为前向兼容，待决定删除或实现。

### 覆盖范围的硬边界（实测结论，不是猜测）

1. **纯 `/command` 型业务任务不在覆盖范围。** 扩展命令在 `input` 之前分发并直接返回，
   **不进入 agent 生命周期 → 不产生 `agent_settled`**。图片/视频生成这类任务因此无法被通知，
   也**不能**靠重名注册劫持（重名会变成 `:1`/`:2` 并存）。已用真实 CLI 固化为回归断言。
2. **子会话与后台子任务不在覆盖范围。** 见上。
3. **一次用户输入可能产生多次运行。** 例如把带空格的 prompt 交给 shell（`cmd.exe`）传递时被拆成
   多个位置参数，Pi 会**真的**当作多条用户消息、跑多次运行——这时收到多条通知是**正确**的。
   用 `pi -p "..."` 时确保引号被正确传递。

---

## 安全

- 所有对外文案都经过同一处 `sanitize()`：**整段删除** OSC/CSI/DCS 等转义序列（含载荷）、剥离
  C0/C1 与双向文本覆盖字符、归一换行、按 `maxMessageChars` 截断；渲染前再确保载荷里不可能出现
  能提前终止序列或夹带新序列的字节。官方 `examples/extensions/notify.ts` 直接内插未清洗字符串，本插件不复刻。
- **Windows toast 不存在脚本注入面**：官方示例把 title/body 直接插值进 PowerShell 脚本
  （还把 title 当 AUMID 用）；本实现的脚本是**静态常量、零插值**，载荷以 **base64 放进环境变量**传入，
  再用 DOM `CreateTextNode` 写入，既不做字符串拼 XML 也不做字符串拼脚本。
- **Webhook 渠道**：密钥只以环境变量名引用；HMAC 签名；不跟随重定向；URL 不得内嵌凭据；
  非 2xx 的响应体片段先脱敏再进日志；日志丢弃 URL query。
- 渠道出口统一套一层 `withRedaction()`：任何异常文本出 provider 层之前都会被脱敏。
- 错误信息脱敏：`Bearer …`、`apiKey=`/`token=`/`secret=`、`sk-`/`ghp_`/`xox*` 前缀、JWT、
  40+ 位随机串、家目录路径。
- **默认不外传用户输入或完整回复**；密钥只以环境变量名引用。

---

## 开发与测试

```bash
cd work/scripts/pi/pi-notification

npm test                                            # 全部五套（76 条断言）
MSYS_NO_PATHCONV=1 node test/terminal-channel.mjs   # 终端渠道：选择/渲染/注入面/TTY 纪律（不需要 SDK）
MSYS_NO_PATHCONV=1 node test/service-coalesce.mjs   # 投递服务：门槛/去重/合并/冷却/队列/超时（注入假时钟）
MSYS_NO_PATHCONV=1 node test/webhook-channel.mjs    # Webhook + 装饰器（回环 HTTP 服务，不出网）
MSYS_NO_PATHCONV=1 node test/host-lifecycle.mjs     # 真实宿主会话：判定/去重/阻塞/reload/配置/命令/S4/S6/S7
MSYS_NO_PATHCONV=1 node test/cli-smoke.mjs          # 真实 pi 进程（G–L）
PI_SKIP_CLI=1 node test/cli-smoke.mjs               # 只想跑纯 SDK 时跳过
```

Git Bash 下 **务必带 `MSYS_NO_PATHCONV=1`**：MSYS 会把 `/probe-cmd` 这类参数改写成
`C:/Program Files/Git/probe-cmd`，命令会静默退化成普通 prompt 并真的调用一次模型（费钱且结论错）。
五个脚本都会给子进程强制带上这个变量。

**测试不会弹出真实系统通知**：`host-lifecycle` 把终端机制钉成 `osc777` 并从转发副本里剔除通知序列；
`cli-smoke` 的 stdout 是管道，按 TTY 纪律本来就不发；其余脚本用注入的假 IO 或假渠道。
网络陷阱：除 `127.0.0.1`（Webhook 端到端断言用）之外的任何 `fetch` 都会让回归失败。

### 人工验证（唯一无法自动化的部分）

通知到底有没有显示在你的终端/通知中心，需要你自己看一眼——用 `/notify test`：

```bash
pi -e work/scripts/pi/pi-notification/extensions/index.ts
# 然后在会话里：
/notify test      # 立即发一条
/notify status    # 看机制、统计、上次错误
```

Windows 上如果 `auto` 没选中预期机制，可以用 `PI_NOTIFY_CHANNEL=toast` 强制。

### 回归断言覆盖什么（76 条）

| 组 | 内容 |
|---|---|
| 终端渠道（10） | 机制选择表与 `PI_NOTIFY_CHANNEL` 覆盖、OSC 渲染字节、10 组恶意载荷注入面、toast 静态脚本与 base64 载荷、非 TTY 零字节、toast 失败冒泡、abort 不写字节、截断不切代理对 |
| 投递服务（10） | 默认值、精确去重、`enabled`/`minLevel`/空渠道、同 kind 冷却与恢复、同运行合并窗口、请求级窗口覆盖、`bypassFilters`、队列上限丢最低级、provider 挂起超时算失败、dispose 幂等 |
| Webhook + 装饰器（13） | URL/`secretEnv`/headers 校验、载荷字段形状、真实 POST + HMAC 可复算、无密钥不签名、非 2xx 报错且脱敏、不跟随重定向、abort、重试与退避、熔断开/半开/关闭、单次 deadline、出口脱敏、`validate/format/dispose` 透传 |
| 判定与去重（A–F, H, 对照） | 纯命令不产生生命周期、一次运行 1 条投递且真的写出 1 条通知、settled→下一次 run < 250ms（取 3 次最小值，**带阻塞对照组**）、reload 后不叠加、失败判定、非 TTY 跳过留痕、不改写配置文件 |
| 配置（I1–I11） | 默认值、`enabled=false`、`minLevel` 门槛、规则开关、**损坏配置降级且失败通知仍发得出**、非法字段值、渠道切换、未定义渠道、项目级生效/未信任忽略/不得定义 providers |
| 命令（J1–J4） | `/notify status` 走真实分发且不产生生命周期、`/notify test` 真发一条、未知子命令给用法、降级原因会露出 |
| 合并/冷却（L0–L2） | 默认参数符合设计、默认配置下 1.5s 内两次运行只发一条（并留 `cooldown_drop`）、`cooldownMs=0` 后恢复每条 |
| 工具失败/压缩失败/等待输入（K1–K6） | 聚合进结果通知、结果不通知时单独发、immediate 立刻发且并行失败被合并、压缩失败 error（用户取消不发）、真 `select` 触发等待通知、`custom` 排除、`end`/reload 复位等待 |
| Webhook 端到端（M1–M3） | 真实 POST + HMAC、日志不出现 query/密钥、非法配置降级为 noop 且不发、`§17.3` 反回退（lifecycle/rules 无渠道名、service 不认识 webhook、未注册 `agent_end`） |
| 真实 CLI（G–L） | `pi -e` 能加载、纯命令零生命周期零投递、stdout 不被转义序列污染、`/notify status` 可用、配置 `enabled=false` 真实生效、损坏配置降级后失败通知仍发出、`--no-notify` 静默 |

断言 C 的对照组是关键：没有它，“不阻塞”只是一个看起来通过的观察。
断言 M3 是**结构约束**的可执行版本：`lifecycle.ts` / `rules.ts` 里出现渠道名、或 `service.ts` 出现
`webhook`，测试就会失败——这正是 §17.3 那条“新增渠道不改核心”的验收标准。

---

## 架构与不变量

```
extensions/index.ts   薄接线：注册 + 形状转换 + 配置装配；注册 /notify 与 --no-notify
   ├─ config.ts       默认值 / 读盘 / 校验 / 降级 / 项目级合并
   ├─ lifecycle.ts    运行状态机、工具失败与等待输入的簿记；唯一完成判定点；陈旧实例丢弃
   │    └─ rules.ts   纯函数：RunOutcome / 工具失败 / 压缩失败 / 等待 → NotificationRequest | null
   │         │        （不认识任何渠道名；一个运行最多一条由 evaluateSettlement 保证）
   │         └─ service.ts  同步入队 → 异步投递；门槛/去重/合并窗口/冷却/超时/有界队列/统计
   │              └─ providers/{registry,decorators,noop,terminal,debug,webhook}.ts
   │                   同一个 Notifier 接口；decorators 统一提供超时/重试/熔断/脱敏
   ├─ commands.ts     /notify status|test（只读状态 + 立即自检，不写盘）
   └─ log.ts          控制字符清洗 / 脱敏 / 可选 JSONL 诊断
```

新增一个渠道的成本：**新增 1 个 provider 文件 + registry 注册 1 行 + 配置加 1 条**，
`lifecycle.ts` / `rules.ts` / `service.ts` 的改动为 0 —— S7 的 Webhook 就是这条规则的实测：
`lifecycle.ts` / `rules.ts` / `service.ts` 一个字都没改，只加了 `providers/webhook.ts` 与
`providers/decorators.ts`，并把渠道包进可靠性装饰器。

不可违反的 6 条（都来自实测，不是风格偏好）：

1. 完成判定只认 `agent_settled`，**不注册 `agent_end`**。
2. `agent_settled` 的 handler **只入队后立即返回**（handler 体内零 `await`）——它会被 await，
   在里面做网络投递会直接拖慢用户的下一次输入（实测 +2027ms）。
3. 其余通知型 hook（`tool_execution_end`、`ui_prompt_*`、`session_compact_failed`）同样只入队，不 await。
4. `session_shutdown` 内的收尾投递必须带**短超时**（默认 200ms），并兜底复位等待状态。
5. 旧实例在 `session_shutdown` 之后不得再产生任何结论（reload 会重建实例）。
6. 投递前一律清洗控制字符；**写 stdout 的渠道必须先确认 stdout 是 TTY**。

---

## 未验证 / 已知不确定（如实记录）

以下项**没有**被实测覆盖，不要当成已解决：

- **三种本地机制是否真的在对应终端里显示**：Windows toast 已确认（生产代码路径实发成功、开发者肉眼确认）；
  OSC 777 / OSC 99 **未在真实终端上肉眼确认**（本开发环境无 TTY、非 kitty）。
- OSC 99 的 kitty 协议实现（两段 `d=0`/`d=1`）未在 kitty 上实测。
- **Webhook 只与本机回环服务对过端到端**（HMAC 由测试自己按同一算法复算）：真实第三方端点
  （Slack/Discord/Telegram）的字段容忍度、代理、TLS、429/5xx 重试节奏都**未验证**。
- **熔断/重试只在单测里用假渠道验证**，未在真实网络抖动下观察过阈值是否合适（默认 3 次 / 1 次重试 / 30s）。
- `ui_prompt_*` 的 `input` / `editor` 两个 kind 未单独实测（实现上按白名单同等处理，
  `confirm`/`select` 已用真触发验证）。
- 进程在 prompt 未闭合时被强杀：`session_shutdown` 兜底复位已实现并断言（reload 路径），
  但“强杀（SIGKILL）”本身无法在测试里复现。
- TUI 下 Ctrl+C/SIGINT、`ctx.ui.notify` 可见性。
- TUI 内真实 `/reload` 的交互路径（本轮的 reload 断言走 SDK 的 `session.reload()`，语义相同但入口不同）。
- `session_shutdown` 的 `reason = "new" | "resume" | "fork"` 语义（需要交互流程）。
- `/notify status` 在真实 TUI 里的排版效果（print 模式下只有文本，TUI 渲染未看）。
- 后台子任务是否在 runner 进程内二次加载本扩展（S0 源码预测会，未实测）。
- 无 `tsc`（仓库不允许装依赖），所以类型**未经编译器校验**；运行时加载已在 SDK 与真实 CLI 两侧验证。
