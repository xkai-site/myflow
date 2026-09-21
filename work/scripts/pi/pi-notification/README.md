# pi-notification

Pi 扩展：**在一次 agent 运行真正结束时**（而不是每次底层 run 结束时）产生一条**系统桌面通知**，可配置、可关闭。

设计方案与全部实测依据：`plans/pi-notification-plugin-design.md`（v1.2，§17 渠道抽象、§18 实测修订）。

> 当前进度：**MVP 已完成** —— S1 骨架 + S1.5 回归 + S3 终端渠道 + S5 最小配置面
> （用户级/项目级配置读盘、`/notify status|test`、`--no-notify`）。
> 尚未做：队列冷却/合并（S4）、工具失败与压缩失败通知（S6）、Webhook 等外部渠道（S7）、macOS 原生横幅。

---

## 为什么不是 `agent_end`

官方文档明确：`agent_end` 之后 Pi 还可能**自动重试**、**自动压缩后重试**、或继续处理**排队消息**。
一次 provider 失败在实测中产生了 **4 条 `agent_end`**，但只有 **1 条 `agent_settled`**。
更糟的是 `agent_settled` 本身**也不等于成功**——用户按 Esc 会被 settle、provider 报错也会 settle。
所以判定必须"出口用 `agent_settled`，语义用最后一次 assistant 的 `stopReason`"：

| 最后 stopReason | 判定 | 默认是否通知 |
|---|---|---|
| `stop` / `length` / `toolUse` | completed | ✅ info |
| `error` | failed | ✅ error |
| `aborted` | aborted | ❌ 默认关（人就在终端旁） |
| 拿不到（`pending` / `deferred` / 无 assistant） | unknown | ❌ 默认关（宁可少发不误报） |

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

本插件**没有任何第三方依赖**，也不注册模型 provider、不注册 `tool_call` / `input` / `session_before_*`。

---

## 配置

| 层级 | 路径 | 何时读取 |
|---|---|---|
| 默认值 | 内置 | 总是 |
| 用户级 | `~/.pi/agent/pi-notification/config.json` | 总是 |
| 项目级 | `<项目>/.pi/pi-notification/config.json` | **仅当项目被信任**（`ctx.isProjectTrusted()`） |

后面的层覆盖前面的层（逐字段）。**项目级不得定义 `providers`**：该字段会被忽略并告警——
渠道将来会承载 URL 与密钥，不能让一个 clone 下来的仓库决定把通知发到哪里（设计 §13 第 7 项）。

最小可用配置（缺失即用默认：启用、`info` 门槛）：

```json
{ "version": 1, "enabled": true, "minLevel": "info" }
```

完整可配字段：

```jsonc
{
  "version": 1,
  "enabled": true,                       // 总开关
  "minLevel": "info",                    // "info" | "warning" | "error"
  "rules": {
    "runCompleted": { "enabled": true,  "level": "info",  "channels": ["terminal"] },
    "runFailed":    { "enabled": true,  "level": "error", "channels": ["terminal"] },
    "runAborted":   { "enabled": false, "level": "info",  "channels": ["terminal"] }
  },
  "content": { "includeDuration": true, "includeToolFailureNames": true, "maxMessageChars": 300 },
  "delivery": { "timeoutMs": 8000, "concurrency": 1, "queueLimit": 50 },
  "providers": [{ "id": "terminal", "type": "terminal", "enabled": true, "options": {} }]
}
```

### 配置写错会怎样（重要）

**不会静默全关。** 解析失败或字段非法时，插件降级为安全子集：
**只发失败通知（`run_failed` / error 门槛 / `terminal` 渠道）**，并在 `/notify status` 与诊断日志里写明原因。
理由：用户写错一个逗号就再也收不到失败通知，是这个插件最糟糕的失败模式。

### 环境变量

| 变量 | 作用 |
|---|---|
| `PI_NOTIFY_DISABLE=1` | 整个插件的会话级静默（不改配置文件） |
| `PI_NOTIFY_CHANNEL=off` | 只静默**本地通知**渠道（`auto`/`osc777`/`osc99`/`toast`/`off`） |
| `PI_NOTIFY_LOG_FILE=<path>` | 打开 JSONL 诊断记录（测试与排障用；不设置则零开销） |
| `PI_NOTIFY_DEBUG=1` | 把人类可读日志镜像到 stderr |

---

## 命令

| 命令 | 作用 |
|---|---|
| `/notify status` | 开关、生效规则/渠道、配置来源、终端机制、投递统计（成功/失败/去重/丢弃）、上次成功时间、上次错误、配置错误与告警 |
| `/notify test` | 立即走一遍完整投递链路（含渠道选择与清洗），用来确认"通知到底能不能到" |

CLI 开关：`--no-notify` 让本会话不发通知（不改配置文件）。

---

## 通知走哪条路

| 机制 | 触发条件 | 覆盖的终端 |
|---|---|---|
| **OSC 99** | `KITTY_WINDOW_ID` 或 `TERM_PROGRAM=kitty` | Kitty |
| **OSC 777** | 其它有 TTY 的环境（默认） | Ghostty / iTerm2 / WezTerm / rxvt-unicode |
| **Windows toast** | `platform === "win32"` | Windows Terminal 及其它 Windows 终端（WT 不渲染 OSC 777） |

按上面的顺序自动选择，也可用 `PI_NOTIFY_CHANNEL` 强制。
**能不能真的看见，取决于终端模拟器**（设计 §13 第 18 项：没有终端焦点 API）。
macOS 只走 OSC 777，因此 Apple Terminal 不会显示；原生横幅（`osascript`）未实现。

### TTY 纪律（重要）

**写 `stdout` 的机制（OSC 777 / OSC 99）必须先确认 `stdout` 是 TTY。**
`pi -p`、`--mode json`、输出被重定向都属于这种情况：stdout 是调用方读走的数据，
往里塞 OSC 序列会直接破坏输出。此时本地渠道降级为 noop，并在诊断日志里留一条
`channel_degraded`（说明原因），而不是静默消失、也不会报错。

`auto` 在非 TTY 下一律不发（避免脚本化运行意外弹系统通知）；
但 **`PI_NOTIFY_CHANNEL=toast` 是显式指定，不受 TTY 限制**——toast 写的是操作系统通知，不碰 stdout。

---

## 当前能力与缺口

**能做**：判定 completed/failed/aborted/unknown → 规则映射等级与渠道 → 门槛/去重 → 入队 →
在独立任务里投递到终端/系统通知；用户级与项目级配置读盘（含降级）；`/notify status|test`；
`reload` 后旧实例失效、不重复投递；quit 时在 200ms 预算内尽力投递。

**还没做**：

- ❌ 队列冷却 / 合并窗口 / 熔断 / 重试（S4）——因此**极短时间内的多次运行会各发一条**
- ❌ 工具失败聚合、压缩失败告警、等待用户输入提醒（S6）
- ❌ Webhook / Telegram / Discord / Slack（S7）
- ❌ 配置向导与写盘（`/notify on|off|config`、原子写）；目前配置只能手工编辑 JSON
- ❌ macOS 原生横幅（`osascript`）

### 覆盖范围的硬边界（实测结论，不是猜测）

1. **纯 `/command` 型业务任务不在覆盖范围。** 扩展命令在 `input` 之前分发并直接返回，
   **不进入 agent 生命周期 → 不产生 `agent_settled`**。图片/视频生成这类任务因此无法被通知，
   也**不能**靠重名注册劫持（重名会变成 `:1`/`:2` 并存）。已用真实 CLI 固化为回归断言。
2. **子会话与后台子任务不在覆盖范围。** 前台 `subagent` 可从 `tool_execution_end` 观察；后台
   `async: true` 的完成发生在 **detached runner 进程**里，父进程看不到。
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
- 错误信息脱敏：`Bearer …`、`apiKey=`/`token=`/`secret=`、`sk-`/`ghp_`/`xox*` 前缀、JWT、
  40+ 位随机串、家目录路径。
- **默认不外传用户输入或完整回复**；密钥只以环境变量名引用。

---

## 开发与测试

```bash
cd work/scripts/pi/pi-notification

npm test                                            # 全部三套（40 条断言）
MSYS_NO_PATHCONV=1 node test/terminal-channel.mjs   # 渠道：选择/渲染/注入面/TTY 纪律（不需要 SDK）
MSYS_NO_PATHCONV=1 node test/host-lifecycle.mjs     # 真实宿主会话：判定/去重/配置/命令（A–K）
MSYS_NO_PATHCONV=1 node test/cli-smoke.mjs          # 真实 pi 进程（G–K）
PI_SKIP_CLI=1 node test/cli-smoke.mjs               # 只想跑纯 SDK 时跳过
```

Git Bash 下 **务必带 `MSYS_NO_PATHCONV=1`**：MSYS 会把 `/probe-cmd` 这类参数改写成
`C:/Program Files/Git/probe-cmd`，命令会静默退化成普通 prompt 并真的调用一次模型（费钱且结论错）。
三个脚本都会给子进程强制带上这个变量。

**测试不会弹出真实系统通知**：`host-lifecycle` 把终端机制钉成 `osc777` 并从转发副本里剔除通知序列；
`cli-smoke` 的 stdout 是管道，按 TTY 纪律本来就不发；`terminal-channel` 全部使用注入的假 IO。

### 人工验证（唯一无法自动化的部分）

通知到底有没有显示在你的终端/通知中心，需要你自己看一眼——用 `/notify test`：

```bash
pi -e work/scripts/pi/pi-notification/extensions/index.ts
# 然后在会话里：
/notify test      # 立即发一条
/notify status    # 看机制、统计、上次错误
```

Windows 上如果 `auto` 没选中预期机制，可以用 `PI_NOTIFY_CHANNEL=toast` 强制。

### 回归断言覆盖什么（40 条）

| 组 | 内容 |
|---|---|
| 渠道（10） | 机制选择表与 `PI_NOTIFY_CHANNEL` 覆盖、OSC 渲染字节、10 组恶意载荷注入面、toast 静态脚本与 base64 载荷、非 TTY 零字节、toast 失败冒泡、abort 不写字节、截断不切代理对 |
| 判定与去重（A–F, H, 对照） | 纯命令不产生生命周期、一次运行 1 条投递且真的写出 1 条通知、settled→下一次 run < 250ms、**带阻塞对照组（> 1s）**、reload 后不叠加、失败判定、非 TTY 跳过留痕 |
| 配置（I1–I11） | 默认值、`enabled=false`、`minLevel` 门槛、规则开关、**损坏配置降级且失败通知仍发得出**、非法字段值、渠道切换、未定义渠道、项目级生效/未信任忽略/不得定义 providers |
| 命令（J1–J4） | `/notify status` 走真实分发且不产生生命周期、`/notify test` 真发一条、未知子命令给用法、降级原因会露出 |
| 真实 CLI（G–K） | `pi -e` 能加载、纯命令零生命周期零投递、stdout 不被转义序列污染、`/notify status` 可用、配置 `enabled=false` 真实生效、损坏配置降级后失败通知仍发出 |

断言 C 的对照组是关键：没有它，"不阻塞"只是一个看起来通过的观察。

---

## 架构与不变量

```
extensions/index.ts   薄接线：注册 + 形状转换 + 配置装配；注册 /notify 与 --no-notify
   ├─ config.ts       默认值 / 读盘 / 校验 / 降级 / 项目级合并
   ├─ lifecycle.ts    运行状态机；唯一完成判定点；sessionId 绑定与陈旧实例丢弃
   │    └─ rules.ts   纯函数：RunOutcome → NotificationRequest | null（不认识任何渠道名）
   │         └─ service.ts  同步入队 → 异步投递；去重(键 = sessionId:runId:kind)、超时、有界队列、统计
   │              └─ providers/{registry,noop,terminal,debug}.ts   同一个 Notifier 接口
   ├─ commands.ts     /notify status|test（只读状态 + 立即自检，不写盘）
   └─ log.ts          控制字符清洗 / 脱敏 / 可选 JSONL 诊断
```

新增一个渠道的成本：**新增 1 个 provider 文件 + registry 注册 1 行 + 配置加 1 条**，
`lifecycle.ts` / `rules.ts` / `service.ts` 的改动为 0（下一阶段的 Webhook 就是这条规则的测试）。

不可违反的 5 条（都来自实测，不是风格偏好）：

1. 完成判定只认 `agent_settled`，**不注册 `agent_end`**。
2. `agent_settled` 的 handler **只入队后立即返回**（handler 体内零 `await`）——它会被 await，
   在里面做网络投递会直接拖慢用户的下一次输入（实测 +2027ms）。
3. `session_shutdown` 内的收尾投递必须带**短超时**（默认 200ms）。
4. 旧实例在 `session_shutdown` 之后不得再产生任何结论（reload 会重建实例）。
5. 投递前一律清洗控制字符；**写 stdout 的渠道必须先确认 stdout 是 TTY**。

---

## 未验证 / 已知不确定（如实记录）

以下项**没有**被实测覆盖，不要当成已解决：

- **三种机制是否真的在对应终端里显示**：Windows toast 已确认（生产代码路径实发成功、开发者肉眼确认）；
  OSC 777 / OSC 99 **未在真实终端上肉眼确认**（本开发环境无 TTY、非 kitty）。
- OSC 99 的 kitty 协议实现（两段 `d=0`/`d=1`）未在 kitty 上实测。
- TUI 下 Ctrl+C/SIGINT、`ctx.ui.notify` 可见性。
- TUI 内真实 `/reload` 的交互路径（本轮的 reload 断言走 SDK 的 `session.reload()`，语义相同但入口不同）。
- `session_shutdown` 的 `reason = "new" | "resume" | "fork"` 语义（需要交互流程）。
- `/notify status` 在真实 TUI 里的排版效果（print 模式下只有文本，TUI 渲染未看）。
- 后台子任务是否在 runner 进程内二次加载本扩展（S0 源码预测会，未实测）。
- 无 `tsc`（仓库不允许装依赖），所以类型**未经编译器校验**；运行时加载已在 SDK 与真实 CLI 两侧验证。
