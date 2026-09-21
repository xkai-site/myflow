# pi-notification 交接（新会话入口）

> **定位**：保留下一步、环境陷阱与实现期经验，不重复维护配置说明和能力清单。
>
> | 文档 | 用途 |
> |---|---|
> | [插件 README](../work/scripts/pi/pi-notification/README.md) | **当前实现状态的权威**：安装、配置、命令、能力与缺口、105 条断言、未验证项 |
> | [设计文档](pi-notification-plugin-design.md)（v1.2） | 架构与设计依据；M3 实现状态已同步（§7/§8/§10/§15） |
> | [M2 记录](pi-notification-plugin-m2.md) | S4+S6+S7 的历史决策、验收与风险，不代表当前待办 |
> | 本文件 | 新会话入口、人工验收待办、环境陷阱、实现期发现 |

---

## 0. 30 秒上手

```bash
cd work/scripts/pi/pi-notification
MSYS_NO_PATHCONV=1 npm test        # 五套脚本，105 条断言；离线回环、零 LLM、不弹真通知
```

最近一次自动化验收：**105 项全绿**（原 76 项语义不变；M3 新增 24 项、M4 新增 5 项）；渠道解耦反回退仍绿。
改任何代码后**必跑**。`MSYS_NO_PATHCONV=1` 是硬约束（见 §3）。

开工前先看 `git status --short` / `git diff`，不要把交接里的历史提交状态当作当前事实；
已有未提交改动不得覆盖，也不要自动代用户提交。

## 1. 当前状态

**M3-1/M3-2（配置面）与 M4（正文内容字段）已交付；M3-3 真终端人工验收已由维护者执行并通过。**

- M3：静默时段、原子写盘、`/notify on|off|config|reload`、最小 TUI 规则向导。
- M4（设计 §19）：正文首段标识（会话名 → 未命名时回退**项目目录名**）、成本（本次+累计）、
  上下文占比、assistant 摘录（默认关，前 10 个字，真截断时标 `…`）；
  同时删除了“被校验但无人读取”的 `content.includePromptExcerpt`。

具体语义、能力缺口与测试覆盖以插件 README 为准；设计语义以 §10.2 / §15 / §19 为准。

注意区分三类事项：
- **已开发、待人工看**：仅剩 M4 的正文口味（下次真实运行时顺带看，见 §2）。
- **可选后续开发**：见 README「当前能力与缺口」，不自动纳入本轮。
- **明确不覆盖的边界**：见 README「覆盖范围的硬边界」与本文件 §7，不视为漏实现。

## 2. 下一步

### M4 内容字段的“顺带一看”（自动化已完成，无需单独一轮）

真实运行一次后看一条通知：

```
[重构登录] · 用时 42.3s · 但 1 个工具失败: bash · 成本 $0.0123（累计 $0.0456） · 上下文 42% · 已修复登录 bug…
```

（未 `/name` 的会话首段是项目目录名，如 `[myflow]`；两者都无则整段省略。）

- [ ] 正文长度与信息量是否合意（不满意就关 `content.includeCost` / `content.includeSessionLabel`，都是纯元数据）。
- [ ] 真实 provider 下是否出现成本/占比（拿不到就不显示；若有已知计费模型，顺手确认量级）。
- [ ] 若要开 `includeAssistantExcerpt`，确认它带出的句子可接受（它是 agent 产出，但仍可能含文件内容）。

### 可选后续（随时可做，不属于任何已完成里程碑）

macOS 原生横幅（`osascript`）、Telegram/Discord/Slack 专用渠道、通知历史与状态行、
累计成本的跨实例口径（当前 `/reload` 后归零）。详见 README「当前能力与缺口」。

### M3-3 人工验收记录（已通过）

已由维护者在真终端执行：`/notify test` 的通知显示、`/notify status` 排版、`/notify config` 向导按键，
以及 `waitingForUser` 打开后真实 `confirm` 的等待提醒与复位。
需区分：“显示正常”不等于 OSC 777/99 在**其它终端**上也正常（见 README 的未验证清单）。

### 文档同步（已完成）

- [x] 设计 §15 的 S5 已改为开发完成；静默时段、配置写盘/向导的“未做”旧描述已清理。
- [x] 已同步设计 §7 目录（新增 `ui.ts`）、§8 职责、§10.2/§10.3 已落地语义与命令示例；
  §6 架构图、§14 对应表、§18.6 时区条目一并修正，MVP 历史章节保留但已标注为历史范围。
- [x] 已移除插件 README 与本文件的“设计状态待同步”提示。

文档同步只改状态与描述，未改任何代码或断言。后续代码修改仍限于 `work/scripts/pi/pi-notification/`（除非用户另行授权），
不装第三方依赖，不碰 `plans/archive/` 与工作区既有删除态文件。可选功能不在本轮收口范围。

---

### 安装到用户级（已完成）

```bash
pi install "D:\XuKai\Project\myflow\work\scripts\pi\pi-notification"   # 写入 packages，不复制文件
```

- 验证方式（**不触发任何通知**，因为纯命令不进入 agent 生命周期）：
  `PI_NOTIFY_LOG_FILE=<win 路径> pi --no-session -p "/notify status"` → 应看到
  `plugin_session_start`（`enabled: true` / `providers: ["terminal"]` / `degraded: false`）与 `notify_status`。
- 注意 `MSYS_NO_PATHCONV=1` + Windows 风格的 `PI_NOTIFY_LOG_FILE`：`/tmp/...` 会被 node 解成 `C:\tmp\...`，
  日志写入失败时 sink 是**静默禁用**的（看不到报错，容易误判成“插件没加载”）。
- 卸载：`pi remove "<同一个路径>"`（只删 settings 里的登记）。

## 3. 环境陷阱（踩过一次就够）

1. **Git Bash 必须 `MSYS_NO_PATHCONV=1`**：否则 `/probe-cmd` 这类参数被改写成 `C:/Program Files/Git/probe-cmd`，
   扩展命令静默失效、退化成普通 prompt 并**真的调用一次模型**（费钱且结论错）。五个测试脚本都会给子进程强制带上它。
2. **TTY 纪律**：写 stdout 的渠道（OSC）必须先确认 `stdout.isTTY`，否则污染 `pi -p` / `--mode json`。
   本机是 Windows + Git Bash，标准输出是管道 ⇒ 测试里 `selectTerminalChannel` 返回 `none`；
   `host-lifecycle` 因此强制 `isTTY=true` 并用 `PI_NOTIFY_CHANNEL=osc777` **钉住机制，避免自动化弹真通知**，
   同时把通知序列从转发副本里剔除。
3. **网络陷阱放行回环地址**：S7 端到端使用 `127.0.0.1` 的本机 HTTP 服务；外部地址的 `fetch` 会让回归失败。
   没有外部网络依赖。
4. **没有 `tsc`、不允许装依赖** ⇒ 类型未经编译器校验，只有运行时加载 + 断言兜底。改类型后务必跑全套测试。
5. **每个 host 独立**：`PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` / `PROBE_LOG` / `PI_NOTIFY_LOG_FILE`
   逐 host 隔离（跨 host 共享游标曾导致 3 条假失败）。
6. **投递是异步的**：`agent_settled` 只入队 → 读日志/断言前必须 `await host.drain()`。
7. **断言 C 取 3 次最小值**：单次采样会被 GC/调度抖动影响（基线出现过 265ms 的假失败，阈值 250ms）；
   对照组必须仍 > 1000ms，否则说明测量失去区分度。
8. **假 provider 的注入点**：需要“运行中”的时刻（例如 S6 的工具失败）时，用 `PROBE_DELAY_MS` 让假 provider
   晚回包，并轮询探针文件的 `agent_start` 事件来定位注入点，**不要 sleep 猜时机**。
9. **SDK/jiti 的 fs 导入快照**：M3 的 J8 曾在运行中替换 `fs.openSync` 注入 EACCES，但未影响宿主已加载的插件，
   导致测试桩无效。现改用真实文件占据 agentDir 目录路径制造 `ENOTDIR`，验证失败不改内存/原文件。
   Windows `chmod` 也不能可靠模拟 POSIX 不可写目录；`0o600` 在 Windows 上不等于已验证 ACL 隔离。
10. **`/notify off` 会把整份用户级配置快照写盘**（含 `enabled: false`）——手工验收/调试后如果不恢复，
    就会得到“插件装好了但永不通知”的假故障（真实踩过：M3-3 验收后残留 `enabled: false`，安装验证时才发现）。
    排查顺序：`/notify status` 看开关 → 看 `config.json` 的 `enabled` → 必要时删配置文件回归默认。
    注意快照会**钉住当时的默认值**（后续插件默认值变化不会生效）；只想改一个开关就直接编辑 JSON。

## 4. 实测硬约束（6 条，违反即回退）

1. 完成判定只认 `agent_settled`，**不注册 `agent_end`**（一次 provider 失败实测 4 条 `agent_end` / 1 条 settled）。
2. `agent_settled` handler **只入队后立即返回**，**体内零 `await`**（实测：内 await 2000ms → 下一次 run 推迟 2027ms）。
3. 其它通知型 hook（`tool_execution_end`、`ui_prompt_*`、`session_compact_failed`）同样只入队、不 await。
4. `session_shutdown` 内投递带短超时（`shutdownFlushMs=200`），并兜底复位等待状态。
5. 旧实例在 `session_shutdown` 之后不得再产生任何结论（扩展 `/reload` 会重建实例；`/notify reload` 只重读配置）。
6. 投递前一律清洗控制字符；写 stdout 的渠道必须先确认 `stdout.isTTY`。

（原始证据与推导：设计 §18.4 / §18.5。）

## 5. 实现期发现（丢一次就得重新踩）

1. **`session.extensionRunner.emit(event)` 是公开的**（`agent-session.js` 的 `extensionRunner` getter）：
   可以直接把真实 `tool_execution_end` / `ui_prompt_*` / `session_compact_failed` 送进被测插件 ——
   S6 的宿主级回归就是这么做的（handler 会按扩展加载顺序依次 await）。
2. **`ui_prompt_*` 由 runner 的 `withUIPrompt` 包装产生**（实测版本 `runner.js:300-340`）：
   嵌套 prompt **只发外层 span**、`end.kind` 报的是**外层 kind**、`custom` 在 RPC 下也会触发、
   事件通过 `queueMicrotask` 异步发出。→ 只能做“非 custom 的 start +1 / end −1”深度计数。
3. **`sanitize()` 是整段删除转义序列（含载荷）**：`sanitize("\x1b]777;notify;a\x07b")` ⇒ `"b"`。
   只删控制字符会把 `]777;notify;a` 留成可见正文 = 伪造通知的素材。
4. **webhook 响应体会回显凭据**：非 2xx 的响应体片段必须 `sanitizeError()`（清洗 + 脱敏）后才进日志/错误消息
   （这是回归断言抓出的真实缺陷；初版只做了 `sanitize()`）。
5. **合并窗口语义**：窗口一旦被某条通知打开，该 run 的后续通知**一律合并**（不取决于后续通知自己带没带窗口）。
6. **可靠性装饰器**：`redaction(circuit(retry(timeout(inner))))`；熔断在重试之外（一次投递彻底失败只计一次）；
   **每次尝试必须有自己的 deadline**，否则第一次尝试吃光外层预算后重试会在已 abort 的 signal 上立刻失败。
7. **SDK 下不调 `session.bindExtensions({...})` 则 `session_start` 完全不触发**
   （实测版本 `agent-session.js:2333` 的 `hasBindings` 守卫）；`getAgentDir()` **动态**读 `PI_CODING_AGENT_DIR`
   （所以测试可以按 host 隔离用户级配置）。
8. **shell 会拆 prompt**：`spawn(..., {shell:true})` 经过 cmd.exe 时带空格的 prompt 被拆成多条用户消息 →
   Pi 真的跑多次运行、产生多条通知。CLI 测试因此直接 `node <pi>/dist/bundle/cli.js`。
9. **配置热读的缓存顺序**：必须先检测配置引用变化，再查 notifier 缓存。原先反过来时，
   相同渠道 id 更改类型/开关仍会命中旧实例；M3 已修正，J9 用相同 id 切换渠道机制回归。
10. **UI 模式不能用 `hasUI` 猜**：RPC 下也为真，规则向导只允许 `ctx.mode === "tui"`。
    print/json 下 `ui.notify` 是 no-op，新增配置命令用 stderr 回显，不能污染 stdout。
    `confirm(false)` 不能区分“否”与 Esc，因此向导增加最终保存确认；此前只改副本。
11. **`session.setSessionName()` 发出的 `session_info_changed` 是 `void emit`（不 await）**：
    测试里设完名字必须 `await host.drain()` 再断言，否则会话名可能还没进插件状态。
    同理，日志里**不要记名字本身**，只记“有没有名字”（否则会话名会被写进诊断日志）。
12. **内容字段的三个采集点**（M4）：成本来自 `message_end` 里 assistant 的 `usage.cost.total`（按 run 累加，
    同一条消息的 usage 也是 `ctx.getContextUsage()` 的来源）；上下文占比需要 `getContextUsage().tokens`
    **与** `ctx.model.contextWindow` 两者都拿得到；摘录必须**先 `sanitize()` 再截 10 字**，
    反过来会把消息开头的换行/缩进截进摘录、清洗后反而变空。截断时再去掉末尾悬空标点并补 `…`，
    但**只在真的超长时**做——否则会把模型自己写的完整句子变成截断标记。
    首段标识同理：会话名优先，回退 `basename(ctx.cwd)`，两者都无则整段省略（磁盘根的 basename 是空串）。
    测试旋钮 `PROBE_ASSISTANT_TEXT` / `PROBE_COST_USD` / `PROBE_CONTEXT_TOKENS` 与 `PROBE_DELAY_MS` 同一套写法：
    **每次调用时读 env**，用完即清（跨 host 泄漏过一次游标，同类错误不要重犯）。

## 6. 新增断言放哪里

| 文件（相对插件目录） | 适合放什么 |
|---|---|
| `test/terminal-channel.mjs` | 渠道机制选择、渲染字节、注入面、TTY 纪律（纯函数 + 注入 IO，不需要 SDK） |
| `test/service-coalesce.mjs` | 门槛/去重/合并/冷却/静默时段/队列/超时（注入假时钟 + 假渠道；时间测试用固定本地日历时间） |
| `test/webhook-channel.mjs` | 渠道校验/payload/签名/错误处理 + 可靠性装饰器（回环 HTTP 服务） |
| `test/host-lifecycle.mjs` | 真实宿主判定、配置读写/热读、命令、TUI 桩、S4/S6/S7、**正文内容字段（R1–R5）**；**J5–J14 是 M3 新增覆盖，M3 是既有 §17.3 架构反回退断言名**，勿混淆 |
| `test/cli-smoke.mjs` | 真实进程加载、stdout 纪律、会话静默；M/N 覆盖 off 跨进程持久化及非 TUI config 的 stderr 输出 |

完整断言表只维护在插件 README；旧断言不得随意改语义。

## 7. 明确不做（设计已裁定，别顺手加）

持久 outbox / exactly-once / 事件总线做渠道通信 / 重名注册劫持 / `pi.registerProvider`（那是模型服务商）/
`input` handler（§18.5 修订 6）/ 子任务通知（§18.5 修订 4）。
