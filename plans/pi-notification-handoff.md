# pi-notification 交接（新会话入口）

> **读法**：本文件只保留「别处没有」的内容（环境陷阱、实现期发现、下一步）。能力/配置/断言表的权威在
> 插件 `README.md`，本文件**不复述**，需要时点链接。
>
> | 文档 | 权威范围 |
> |---|---|
> | `plans/pi-notification-plugin-design.md`（v1.2） | 设计权威：§7 目录 / §10 配置 / §12 判定 / §15 步骤与状态 / §17 渠道抽象 / §18 实测修订 |
> | `work/scripts/pi/pi-notification/README.md` | 用户面：安装/配置/命令/渠道/安全/**当前能力与缺口**/**76 条断言表**/**未验证项** |
> | `plans/pi-notification-plugin-m2.md` | 里程碑 2（S4+S6+S7）的决策、文件清单、验收与风险 |
> | 本文件 | 新会话入口：状态一句话 + **M3 可执行步骤** + 环境陷阱 + 实现期发现 |

---

## 0. 30 秒上手

```bash
cd work/scripts/pi/pi-notification
MSYS_NO_PATHCONV=1 npm test        # 五套脚本，76 条断言，全绿；全离线（仅 127.0.0.1）、零 LLM、不弹真通知
```

改任何代码后**必跑**。`MSYS_NO_PATHCONV=1` 是硬约束（见 §3）。

**当前工作区状态**：S4+S6+S7 的全部改动**尚未提交**（`git status` 里能看到 `pi-notification/**` +
`plans/pi-notification-plugin-{design,m2,handoff}.md` + 根 `README.md` 一行）。新会话开工前建议先提交一次，
把「上一里程碑的完成」与本轮改动分开。

## 1. 状态（一句话）

设计 §15 的 S0–S9 **全部完成**，唯一 ⚠ 是 **S5 完整形态**（配置写盘 + 向导）。
未做项/未验证项的完整清单在插件 `README.md` 的「当前能力与缺口」与「未验证 / 已知不确定」两节 —— 不要在这里重复维护。

## 2. 下一步：M3（可直接开工的步骤）

> 目标：把「配置面」补齐并收口。M3-1 与 M3-2 共用同一套校验/写盘代码，建议同一个会话做完。
> 边界不变：**只改 `work/scripts/pi/pi-notification/`**；不装第三方依赖；不碰 `plans/archive/` 与工作区既有删除态文件。

### M3-1 `quietHours` 静默时段（小，唯一「设计已定、代码 0 行」的配置项）

依据：设计 §10.2 schema、§8 service 职责、§12.1 第 5 步（`enabled? minLevel? quietHours? cooldown?`）。

1. `src/types.ts`：`NotificationConfig.quietHours = { enabled: boolean; start: string; end: string; exceptLevels: NotifyLevel[] }`。
2. `src/config.ts`：默认 `{ enabled: false, start: "23:00", end: "08:00", exceptLevels: ["error"] }`；
   校验 `HH:MM`（严格两位，`00:00`–`23:59`，非法即 error → 触发既有降级路径）；
   `exceptLevels` 必须是等级数组且去重；**降级配置里保持 `enabled: false`**（配置坏掉时不要再引入新的静默逻辑）。
3. `src/service.ts`：在 `filtered()` 里加一道**静默时段**判定（放在门槛之后、去重之前或之后都可以，但要写清顺序）。
   区间语义必须定义清楚：`start > end` 视为**跨午夜**（`[start, 24h) ∪ [0, end)`）；`start === end` 视为全天（或明确拒绝，二选一写进校验）。
   判定要用 `service` 已有的注入时钟 `now()`，**不要**依赖 `Date.now()` 直读（否则单测无法固定时间）。
4. `/notify status`：显示当前是否处于静默时段（例如 `静默时段: 23:00–08:00（当前生效）`）。
5. **需要决策（建议：`/notify test` 绕过静默时段）**：自检的意义是「确认渠道可用」，
   被静默时段吃掉会再次变成「自检没反应 = 渠道坏了」的误判；建议绕过，并在输出里提示
   「当前处于静默时段，真实通知会被静默」。若选择不绕过，就在 README 明写。
6. 断言落位（`test/service-coalesce.mjs`，假时钟直接给固定时间戳）：
   23:30 静默 / 07:59 静默 / 08:00 放行 / 12:00 放行 / 跨午夜两端都静默 / `exceptLevels:["error"]` 时 error 仍发 /
   `enabled:false` 时全时段放行；再加 2 条 config 校验（`"25:00"`、`"8:00"` → 降级并留原因）。

### M3-2 配置写盘 + 向导（中，S5 的完整形态）

依据：设计 §10.3（原子写：先校验 → 临时文件 `0o600` → `rename` → 失败保留原文件）。

1. `src/config.ts`：新增 `writeUserConfig(agentDir, config)`：
   先 `mergeConfig` 校验（**不合法就拒绝写入**并返回 problems）→ 写同目录临时文件（`mode: 0o600`）→ `renameSync` 覆盖；
   任何一步失败都**保留原文件**并把错误返回给调用方（不抛回 hook）。
2. `src/commands.ts`：新增子命令 `on` / `off` / `config`（TUI 向导入口）/ `reload`（重新读盘并校验，不触发扩展重载）。
   非 TUI 下 `config` 只打印配置文件路径 + 当前值（不要强开终端 UI）。
3. `src/ui.ts`（新文件）：TUI 向导，用 `ctx.mode === "tui"` 守卫（**不要用 `hasUI`**：RPC 下也为真但对话框语义不同，设计 §2.2 第 6 点）。
   最小形态：`select` 选规则 → `confirm` 开关 → 等级选择 → 保存走 `writeUserConfig`。
4. 断言落位（`test/host-lifecycle.mjs` 新增 J5–J9）：
   ① `/notify off` 后下一次运行不发通知、且**配置文件真的被改写**；
   ② 写入非法值被拒（内存态与磁盘都不变）；
   ③ 临时文件不残留、`0o600`（Windows 上断言降级为「不报错」并注明）；
   ④ agentDir 不可写时命令报错但**内存态不变**、不抛异常；
   ⑤ `/notify reload` 重新读盘（改文件后 reload 生效）。
   可选：`test/cli-smoke.mjs` 加一条「`/notify off` → 真实 CLI 下一次运行零投递」。

### M3-3 人工验证（真终端，小）

- `/notify test` 看本地通知是否显示（Windows toast 已确认；OSC 777/99 仍待看）。
- TUI 里跑一次会弹 `confirm` 的扩展（例如 `pi-image-generation` 的确认流程），确认
  `waitingForUser`（默认关闭 → 临时在配置里打开）真的在“轮到你输入”时提醒。
- `/notify status` 在 TUI 下的排版。

### 验收（M3 完成判据）

```bash
cd work/scripts/pi/pi-notification && MSYS_NO_PATHCONV=1 npm test   # 全绿
```

- 断言数从当前 **76** 增加到 **≈95**（M3-1 ≈9 条、M3-2 ≈10 条），且**旧断言一条都不许改语义**
  （若某条旧断言必须改，说明设计变了 —— 要先在设计文档里记录，再改断言）。
- `test/host-lifecycle.mjs` 的 **M3 反回退断言**必须仍然绿（`lifecycle.ts`/`rules.ts` 无渠道名、
  `service.ts` 无渠道名、未注册 `agent_end`）。
- README 的「当前能力与缺口」与「断言覆盖」两节同步更新；设计 §15 状态列把 S5 从 ⚠ 改为 ✅。

### M3 之后可选（不在 M3 范围，随时可做）

macOS 原生横幅（`osascript`，小）· Telegram/Discord/Slack 专用渠道（每个 ≈1 文件 + 配置 1 条）·
成本/上下文占比（先采 usage：`turn_end` 或 `ctx.getContextUsage()`，再让 `content.includeCost` 生效）·
通知历史与状态行（`pi.appendEntry` + `registerEntryRenderer`、`ctx.ui.setStatus`，设计列为可选）·
决策 `content.includePromptExcerpt`（当前被校验但无人读取的 no-op：删掉或写明“保留字段、无效果”）。

---

## 3. 环境陷阱（只有本文件记录，踩过一次就够）

1. **Git Bash 必须 `MSYS_NO_PATHCONV=1`**：否则 `/probe-cmd` 这类参数被改写成 `C:/Program Files/Git/probe-cmd`，
   扩展命令静默失效、退化成普通 prompt 并**真的调用一次模型**（费钱且结论错）。五个测试脚本都会给子进程强制带上它。
2. **TTY 纪律**：写 stdout 的渠道（OSC）必须先确认 `stdout.isTTY`，否则污染 `pi -p` / `--mode json`。
   本机是 Windows + Git Bash，标准输出是管道 ⇒ 测试里 `selectTerminalChannel` 返回 `none`；
   `host-lifecycle` 因此强制 `isTTY=true` 并用 `PI_NOTIFY_CHANNEL=osc777` **钉住机制，避免自动化弹真通知**，
   同时把通知序列从转发副本里剔除。
3. **网络陷阱放行 `127.0.0.1`**：S7 端到端需要一个本机 HTTP 服务；其它地址的任何 `fetch` 都会让回归失败。
   本机没有外部网络依赖。
4. **没有 `tsc`、不允许装依赖** ⇒ 类型未经编译器校验，只有运行时加载 + 断言兜底。改类型后务必跑全套测试。
5. **每个 host 独立**：`PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` / `PROBE_LOG` / `PI_NOTIFY_LOG_FILE`
   逐 host 隔离（跨 host 共享游标曾导致 3 条假失败）。
6. **投递是异步的**：`agent_settled` 只入队 → 读日志/断言前必须 `await host.drain()`。
7. **断言 C 取 3 次最小值**：单次采样会被 GC/调度抖动影响（基线出现过 265ms 的假失败，阈值 250ms）；
   对照组必须仍 > 1000ms，否则说明测量失去区分度。
8. **假 provider 的注入点**：需要「运行中」的时刻（例如 S6 的工具失败）时，用 `PROBE_DELAY_MS` 让假 provider
   晚回包，并轮询探针文件的 `agent_start` 事件来定位注入点，**不要 sleep 猜时机**。

## 4. 实测硬约束（6 条，违反即回退）

1. 完成判定只认 `agent_settled`，**不注册 `agent_end`**（一次 provider 失败实测 4 条 `agent_end` / 1 条 settled）。
2. `agent_settled` handler **只入队后立即返回**，**体内零 `await`**（实测：内 await 2000ms → 下一次 run 推迟 2027ms）。
3. 其它通知型 hook（`tool_execution_end`、`ui_prompt_*`、`session_compact_failed`）同样只入队、不 await。
4. `session_shutdown` 内投递带短超时（`shutdownFlushMs=200`），并兜底复位等待状态。
5. 旧实例在 `session_shutdown` 之后不得再产生任何结论（`reload` 会重建实例）。
6. 投递前一律清洗控制字符；写 stdout 的渠道必须先确认 `stdout.isTTY`。

（原始证据与推导：设计 §18.4 / §18.5。）

## 5. 实现期发现（别处没有，丢一次就得重新踩）

1. **`session.extensionRunner.emit(event)` 是公开的**（`agent-session.js` 的 `extensionRunner` getter）：
   可以直接把真实 `tool_execution_end` / `ui_prompt_*` / `session_compact_failed` 送进被测插件 ——
   S6 的宿主级回归就是这么做的（handler 会按扩展加载顺序依次 await）。
2. **`ui_prompt_*` 由 runner 的 `withUIPrompt` 包装产生**（`runner.js:300-340`）：
   嵌套 prompt **只发外层 span**、`end.kind` 报的是**外层 kind**、`custom` 在 RPC 下也会触发、
   事件通过 `queueMicrotask` 异步发出。→ 只能做「非 custom 的 start +1 / end −1」深度计数。
3. **`sanitize()` 是整段删除转义序列（含载荷）**：`sanitize("\x1b]777;notify;a\x07b")` ⇒ `"b"`。
   只删控制字符会把 `]777;notify;a` 留成可见正文 = 伪造通知的素材。
4. **webhook 响应体会回显凭据**：非 2xx 的响应体片段必须 `sanitizeError()`（清洗 + 脱敏）后才进日志/错误消息
   （这是回归断言抓出的真实缺陷；初版只做了 `sanitize()`）。
5. **合并窗口语义**：窗口一旦被某条通知打开，该 run 的后续通知**一律合并**（不取决于后续通知自己带没带窗口）。
6. **可靠性装饰器**：`redaction(circuit(retry(timeout(inner))))`；熔断在重试之外（一次投递彻底失败只计一次）；
   **每次尝试必须有自己的 deadline**，否则第一次尝试吃光外层预算后重试会在已 abort 的 signal 上立刻失败。
7. **SDK 下不调 `session.bindExtensions({...})` 则 `session_start` 完全不触发**
   （`agent-session.js:2333` 的 `hasBindings` 守卫）；`getAgentDir()` **动态**读 `PI_CODING_AGENT_DIR`
   （所以测试可以按 host 隔离用户级配置）。
8. **shell 会拆 prompt**：`spawn(..., {shell:true})` 经过 cmd.exe 时带空格的 prompt 被拆成多条用户消息 →
   Pi 真的跑多次运行、产生多条通知。CLI 测试因此直接 `node <pi>/dist/bundle/cli.js`。

## 6. 新增断言放哪里

| 目录 | 适合放什么 |
|---|---|
| `test/terminal-channel.mjs` | 渠道机制选择、渲染字节、注入面、TTY 纪律（纯函数 + 注入 IO，不需要 SDK） |
| `test/service-coalesce.mjs` | 门槛/去重/合并/冷却/**静默时段**/队列/超时（注入假时钟 + 假渠道，M3-1 的断言放这里） |
| `test/webhook-channel.mjs` | 渠道校验/payload/签名/错误处理 + 装饰器（回环 HTTP 服务；另有 §17.3 反回退读源码断言） |
| `test/host-lifecycle.mjs` | 真实宿主会话：判定/去重/阻塞/reload/配置读盘/命令/S4/S6/S7；**写盘类断言放这里**（M3-2） |
| `test/cli-smoke.mjs` | 真实 `pi` 进程才能暴露的问题：加载、stdout 不得被转义序列污染、`--no-notify`、配置真实生效 |

## 7. 明确不做（设计已裁定，别顺手加）

持久 outbox / exactly-once / 事件总线做渠道通信 / 重名注册劫持 / `pi.registerProvider`（那是模型服务商）/
`input` handler（§18.5 修订 6）/ 子任务通知（§18.5 修订 4）。
