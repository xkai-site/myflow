# 通知插件历史验证摘录

以下段落从整理前的设计与交付文件原样摘录，保留当时命令、环境、结果及限制。旧命令、仓库外路径和测试计数属于历史记录；当前入口见[插件测试说明](../../../work/scripts/pi/pi-notification/README.md#开发与测试)。这些摘录没有关联完整运行日志，证据强度限于原文记载。

## 初期设计报告

> 状态：**MVP + S4/S6/S7 + M3-1/M3-2 + M4 已实现**，S5 完整配置面与正文内容字段均已落地；最近一次自动化验收 105 项全绿。
> **M3-3 真终端人工验收已由维护者执行并通过**；M4 的视觉口味建议在下一次真实运行时顺带看一眼（见 §19 末尾）。
> 目标宿主：`@earendil-works/pi-coding-agent` **0.86.1**（下方简写 `O/` = `D:/Nodejs/node_modules/@earendil-works/pi-coding-agent`）。
> 研究时仓库：`D:/XuKai/Project/myflow`，当时 HEAD `a0059283327b5d8f56fa117077f4a55fac9e1265`（历史基线，不代表当前工作区）。
> **命名修订（v1.2 之后）**：插件目录与配置目录统一为 **`pi-notification`**（原文档写作 `pi-message-notification`），已全文替换。
> **当前能力与验收范围见插件 `README.md`；下一步与实现经验见 `plans/pi-notification-handoff.md`**。本次已同步 M3 实现状态，历史研究与草稿片段仍按其标注保留。
> 标记约定：**【官方】**= 当前 0.86.1 文档/源码可验证；**【设计】**= 本方案自定；**【待验证】**= 编码前必须实测。

## 18. S0 实测结论与设计修订（v1.2）

> 本轮由 3 个子代理并行执行（workflow `b3fe1393-3cd8-496a-b5e8-33aa29afa5c8`），**全部完成、无 BLOCKED**。E3 真的跑了 8 次真实 provider 调用。
>
> 报告原文：
> - `C:\Users\HP\.pi\agent\sessions\--D--XuKai-Project-myflow--\subagent-artifacts\outputs\b3fe1393-3cd8-496a-b5e8-33aa29afa5c8\research\s0-a-no-llm.md`（E1/E5/E6）
> - `...\s0-b-ui-settled.md`（E4/E3）
> - `...\s0-c-subagent-reach.md`（E2）

### 18.1 实验隔离与一个工程陷阱

隔离配方（不污染真实环境，已由报告验证零写入）：

```bash
EXP=%TEMP%/pi-notify-s0/<key>
# 只复制（不读取内容）auth.json / models.json / models-store.json
# 写入最小 settings.json（不含 packages/extensions）
PI_CODING_AGENT_DIR=$EXP/agent PI_CODING_AGENT_SESSION_DIR=$EXP/sessions \
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 \
pi --no-session --approve -e <探针> ...
```

**【实测·陷阱 U0】Git Bash / MSYS 会把 `/命令` 改写成 Windows 路径。**
`pi -p "/probe-cmd"` 实际收到 `C:/Program Files/Git/probe-cmd` → 命令不派发，退化成普通 prompt **并真的调用了 LLM**。
→ 任何在 Git Bash 下测试 `pi -p "/cmd"` 的脚本（含本项目未来的 `test/` 与 CI）**必须**加 `MSYS_NO_PATHCONV=1`。

### 18.2 六项不确定性的最终判定

| # | 原问题 | 判定 | 关键实测证据 |
|---|---|---|---|
| 1 | 纯 `/command` 是否产生 `agent_settled` | **已否证** | 一次纯命令运行的全部事件只有 `session_start` / `resources_discover` / `session_shutdown`；无 `input`、无任何 agent 事件。对照实验（同探针 + 普通 prompt）产生完整 11 个 turn 的事件 |
| 2 | 子任务完成能否被父进程感知 | **已证实（分场景）** | 前台：能（官方 `tool_execution_end`/`tool_result` 中 `toolName==="subagent"`）；后台 `async:true`：**不能**（完成发生在 detached runner 进程）。官方 37 个事件中**无**任何子会话事件 |
| 3 | `agent_settled` 时 `ctx.isIdle()` 是否恒真 | **已证实** | print/rpc 各 5+ 次均为 `isIdle:true`、`hasPendingMessages:false`；而 `agent_end` 时 `isIdle:false` |
| 4 | `ui_prompt_start` 在 RPC / 原生弹窗下是否触发 | **已证实（但需白名单）** | RPC：`confirm` 与 `custom` 都触发；print/json：**完全不触发**。`custom` 在 RPC 下是「空转 span」（无任何 `extension_ui_request`） |
| 5 | `session_shutdown` 内能否完成异步 flush | **已证实能** | `reason=quit` 与 `reload` 都 await handler（1.5s await → 退出推迟 1.5s）；handler 之间**串行** |
| 6 | 多扩展 Hook 顺序是否等于加载顺序 | **已证实** | 顺序 = `-e` 出现顺序（反转即反转）；项目级 `.pi/extensions` **恒在最后**且必须 `--approve` 才加载 |

### 18.3 三份报告的冲突裁决（主 Agent 职责）

| 冲突点 | 子代理说法 | 裁决 |
|---|---|---|
| 子代理 B 称“**print 模式下斜杠命令不会被派发**”，以此解释 `pi -p "/probe-ui"` 未被派发的现象 | 误 | **否定。** 真正原因是 **MSYS 路径改写**（子代理 A 的 U0 已确证：探针日志里 argv 变成了 `C:/Program Files/Git/probe-ui`）。子代理 A 加 `MSYS_NO_PATHCONV=1` 后，同一环境下命令**确实在 print 模式被派发**（`CMD_HANDLER_ENTER`）。B 的**结论**（print 无 `ui_prompt_*`）成立且证据有效，但**归因错误**。编码时不要“修复”一个不存在的问题 |
| 官方 `on()` 事件总数 | A 说 38，C 说 37 | **37**。已用 `grep -c 'on(event:' types.d.ts` 复核 = 37 |
| C 将 pi-subagents 的 `subagent:*` 常量表标为“官方事件常量权威表” | 用词不当 | 那些是 **pi-subagents 自有通道**，不是 Pi 核心事件。C 的 §6 已给出真正的官方 37 项清单，以那份为准 |

### 18.4 新增硬约束（变更了原设计假设）

**【实测·关键】`agent_settled` 的 handler 是被 await 的，会阻塞 Pi。**

| 实验 | settled 内 await 2000ms | 结果 |
|---|---|---|
| print，A/B 交替各 2 次 | 否 | settled→exit 仅 +8~12ms |
| print，B 组 | 是 | settled→exit **+2020ms** |
| RPC，settled 后立即发第二个 prompt | 否 | settled 后 **7ms** 启动第二次 run |
| RPC，同上 | 是 | 第二次 run 启动被 **推迟 2027ms** |

→ 这**证实了原设计“Hook 内只入队、投递异步化”是正确的**，并把“快速返回”从“良好实践”升级为**硬约束**：
在 `agent_settled` 内做任何网络投递都会直接拖慢用户的下一次输入。
同理 `session_shutdown` 内的投递必须带短超时（否则拖慢用户退出）。

### 18.5 由此产生的设计修订

**修订 1：删除 `waitingForUser` 的默认启用可能性。**
`ui_prompt_start` 必须白名单化：仅 `select`/`confirm`/`input`/`editor`；**永久排除 `custom`**。实测双重误报：
- TUI 下 `custom()` 常被用作纯进度加载器（本仓库图片/视频插件正是如此）→ span 时长 = 加载器时长，与用户无关；
- RPC 下 `custom()` 根本无 UI，仍然触发 `kind=custom` 的 span。

**额外发现（影响成对判定）**：嵌套/重叠 prompt **不会**产生内层 span，且 `ui_prompt_end.kind` 报告的是**外层** kind。
→ 不可用 “start.kind === end.kind” 做配对校验；并且必须在 `session_shutdown` 兜底重置 waiting 状态（强杀时可能不补发 `ui_prompt_end`）。

**修订 2：覆盖范围必须诚实对外。**
纯 `/command` 型业务任务（图片/视频生成）**无法被通知**，且**不能**通过重名注册劫持（重名 → `:1`/`:2` 并存，各调各的）。
→ README 必须明写此限制；若将来要覆盖这类任务，只能走 §18.6 的 **opt-in 集成**，不能靠 Hook。

**修订 3：为“命令型/子任务型”提供 opt-in 集成面（现在有了必要性与证据）。**
原先 §1.7 判定“Event Bus 核心不需要”——仍然成立（核心链路不靠它），但现在它有**明确且被实测支撑的用途**：

```ts
// 由业务扩展主动上报（因为 Hook 看不到这些时刻）
pi.events.emit("pi-notification:emit", {
  source: "pi-image-generation",   // 业务方自报来源
  level: "info",
  title: "图片生成完成",
  body: "...",
  sessionId, runId?,                 // 必填：用于跨会话防御
});
```
→ 订阅方必须做**来源防御**：`pi.events` 是全局字符串命名空间，**任何扩展都能伪造**同名事件（S0-C 已核实 pi-subagents 自己也不做来源校验）。因此 opt-in 集成只能当“便利通道”，不得当安全边界。

**修订 4：子任务通知分两条路（不得混为一谈）。**

| 场景 | 能否用官方 API | 方案 |
|---|---|---|
| 前台 `subagent`（阻塞） | ✅ 能 | `tool_execution_end` / `tool_result` 中 `toolName === "subagent"` 即完成时刻 |
| 前台 detach / 后台 `async:true` | ❌ 不能 | 只能走 pi-subagents **私有**通道 `pi.events.on("subagent:async-complete")`（载荷字段无 schema 保证，随 `lifecycleArtifactVersion` 演进）或轮询 `asyncDir/status.json` |

私有通道的已知风险（已记录，必须防御）：无版本协商、载荷是内部实现投影、仅对 spawn 它的会话可见、可被伪造。
**MVP 不实现子任务通知**；将来实现时必须做字段防御 + 去重。

**修订 5：去重从“最佳实践”升级为“硬需求”。**
两个新证据：
- S0-C 预测（源码依据，**待实测 T1**）：后台子任务可能在 **detached runner 进程内再次加载 ambient 扩展**，导致通知插件**双实例**；
- 快照语义（U11）：一次派发中 `unsubscribe()` 不立即生效。
→ 去重键必须自包含：`(sessionId, runId, kind)`，不依赖“我是第几个 handler”，也不依赖“我现在就取消了自己”。

**修订 6：`input` 使用纪律。**
`input` handler 返回 `{action:"handled"}` 会**短路**其他扩展的 input 处理（与快照语义是两个不同机制）。
→ 通知插件 MVP **不使用 `input`**；若将来用，只允许条件性返回，绝不无条件 `handled`。

**修订 7：安装位置。**
项目级 `.pi/extensions` 扩展在未信任项目里**静默不加载**，且恒晚于 CLI 扩展加载。
→ 要保证通知一定生效，应装在**用户级** `~/.pi/agent/extensions/`。这也与 §10 的“用户级配置为主”一致。

### 18.6 仍未证实 / 建议第二轮实测（不得当作已解决）

| 项 | 状态 | 最小验证方法 |
|---|---|---|
| T1：后台子任务是否在 runner 进程内加载 ambient 扩展 → 通知插件是否双实例 | 未测（有源码预测） | 隔离目录 + 探针包加到 `packages`，跑一次 `async:true`，比较日志 `pid` 列 |
| T3：`subagent:async-complete` 是否真能被第三方扩展在父进程收到 | 未测 | 探针 `pi.events.on(...)` + 一次 async 子任务 |
| T4：`subagent-notify` 自定义消息是否可被 `message_*` 观测（官方文档说不） | 未测（官方文档明确“不”） | 记录所有 `message_*` 的 `message.role` |
| interactive 下 Ctrl+C/SIGINT、TUI 下 `ctx.ui.notify` 可见性 | 未测（本环境无 TTY） | 需真终端人工验证 |
| `reason="new"\|"resume"\|"fork"` 的 shutdown 语义 | 未测（需交互流程） | 手工跑 `/new`、`/resume`、`/fork` 并观察日志 |
| `input`/`editor` 两个 kind 的 span 行为 | 未单独测（仅 `confirm`/`custom`/`select`） | 同一探针补测；实现上按白名单同等处理 |
| `--mode json` 下的 `hasUI`/`ui_prompt_*` | 未测（仅源码推断无 uiContext） | 跑一次 `--mode json` |
| 进程在 prompt 未闭合时被强杀是否补发 `ui_prompt_end` | 未测（**兜底已实现**） | 需要一个 `session_shutdown` 兜底复位（已写入修订 1）——S6 已实现并断言 reload 路径；SIGKILL 本身仍无法在测试中复现 |

**S7 落地后的状态补充**：上表中与“实现”相关的两条已有结论——
「强杀兜底复位」已实现（`lifecycle.onShutdown` 复位 + 断言 K6）；
「`input`/`editor` kind」在实现上按白名单同等处理、`select`/`confirm` 已用**真触发**验证，但仍**未单独实测** `input`/`editor`。
其余各项（T1/T3/T4、TUI 可见性、`new\|resume\|fork`、`--mode json`）仍**未测**，不得当成已解决；
当前完整的未验证清单以插件 `README.md` 的「未验证 / 已知不确定」为准（它还包含 Webhook 真实端点、熔断阈值等 S7 新增项）。

### 18.7 对实现顺序的影响

原 §15 的 S0 已完成 → 现在可直接从 **S1 骨架** 开始；但建议在 S1 之后插入一项：

- **S1.5 回归脚本**：把本轮的可复现配方固化成 `test/host-lifecycle.mjs`（带 `MSYS_NO_PATHCONV=1`），断言：纯命令不产生 `agent_settled`、settled 内不留阻塞、reload 后不重复投递。这样“覆盖范围边界”会被持续验证而不是靠记忆。

---


## M2 验证与限制

## Verification

### 1. 全套回归（硬约束：必须带 `MSYS_NO_PATHCONV=1`）

```bash
cd work/scripts/pi/pi-notification
MSYS_NO_PATHCONV=1 npm test      # 五套脚本，76 条断言，全绿
```

| 脚本 | 断言 | 覆盖 |
|---|---|---|
| `terminal-channel.mjs` | 10 | 机制选择/渲染字节/注入面/TTY 纪律 |
| `service-coalesce.mjs` | 10 | 默认值、去重、门槛、冷却+恢复、合并窗口、请求级窗口、`bypassFilters`、队列上限、挂起超时、dispose 幂等 |
| `webhook-channel.mjs` | 13 | 校验（URL/协议/内嵌凭据/`secretEnv`/headers）、payload 形状、真实 POST + HMAC 可复算、无密钥不签名、非 2xx 脱敏报错、不跟随重定向、abort、重试退避、熔断开/半开/关闭、单次 deadline、出口脱敏、契约透传 |
| `host-lifecycle.mjs` | 37 | P0/P1、A–F/H（判定/去重/不阻塞/对照/reload）、E（无异常/无外网/不改写配置）、I1–I11（配置读盘与降级）、J1–J4（命令面）、L0–L2（合并冷却真实生效）、K1–K6（S6）、M1–M3（S7 端到端 + 反回退） |
| `cli-smoke.mjs` | 6 | 真实 `pi`：加载、纯命令零生命周期、stdout 不被污染、`/notify status`、配置关闭/损坏降级、`--no-notify` |

### 2. 反回退自检（已断言化，见 M3）

- `extensions/index.ts`：不出现 `pi.on("agent_end"`。
- `src/lifecycle.ts` / `src/rules.ts`：不出现渠道名、不 `import providers/*`（注释里提到约束不算违规）。
- `src/service.ts`：不出现 `terminal` / `webhook`（即“新增渠道不改核心”）。
- `src/providers/webhook.ts`：不 import `lifecycle`/`rules`/`config`。
- `git status`：只改 `work/scripts/pi/pi-notification/**` 与 `plans/pi-notification-plugin-design.md`、
  `plans/pi-notification-plugin-m2.md`（由 m1 改名）、`plans/pi-notification-handoff.md`；
  不碰 `plans/archive/`；根 `README.md` 只增插件清单一行。

### 3. 回归发现并修掉的真实缺陷（不是“顺手改”）

1. **webhook 错误响应体会把凭据带进日志**：初版对响应体只做 `sanitize()`，断言发现
   `apiKey=sk-…` 原样出现在错误消息里 → 改为 `sanitizeError()`（清洗 + 脱敏）。
2. **合并窗口对“后续不含窗口的通知”不生效**：初版只在 `windowMs > 0` 时才查表，导致
   immediate 工具失败开的窗拦不住随后到达的结果通知 → 改为“窗口一旦打开，该 run 的后续通知一律合并”。
3. **`custom` 提示会污染 waiting 状态**：深度计数把 `custom` 也算进去，TUI 加载器会让
   `/notify status` 一直显示“正在等你输入” → `custom` 不参与计数。
4. **断言 C 的抖动假失败**：基线单次采样曾测到 265ms（阈值 250ms）→ 改为取 3 次最小值，
   对照组仍必须 > 1000ms（保持区分度）。

### 4. 人工一次性（属 §18.6 未测项，如实记录而非当作已验证；本节为 M2 当时状态）

真终端里 `/notify test` 看本地通知是否显示；`webhook` 指向真实第三方端点（Slack/Discord）跑一次。
`/notify status` 在 TUI 下的排版也需人眼确认。

---

## 风险与未覆盖（诚实声明）

- **Webhook 只与本机回环服务对过端到端**（HMAC 由测试按同一算法复算）。真实端点的字段容忍度、代理、
  TLS、429/5xx 重试节奏**未验证**。
- **熔断/重试只在单测里用假渠道验证**：默认 3 次 / 1 次重试 / 30s 冷却是**拍的**，没有真实抖动数据支撑。
- `ui_prompt_*` 的 `input` / `editor` kind 未单独实测（实现上按白名单同等处理；`select`/`confirm` 已真触发验证）。
- 强杀（SIGKILL）时 `session_shutdown` 是否来得及跑，无法在测试里复现；只验证了 reload 路径。
- 依然**没有 `tsc`**（仓库不允许装依赖）→ 类型未经编译器校验，只有运行时加载与断言。
- 本地通知是否真的显示，仍取决于终端模拟器（本环境无 TTY）。

---


## 设置界面早期验收

## 实施结果与差异（2025 收尾）

- [x] 全量回归：`MSYS_NO_PATHCONV=1 npm test` 退出码 0，共 **128 条断言**（原 105 条）。
- [x] 新增 `test/settings-ui.mjs`（23 条：渲染/标记列/溢出/键盘/Ctrl+S/三层值/fork 不继承）。
- [x] `host-lifecycle.mjs` 重写命令面（J1–J14）并把 I9–I11 合并为「项目级层已删除」反向断言。
- [x] `cli-smoke.mjs` 的 I/M/N 改为单一入口，并新增「稀疏用户默认跨进程生效」。

与计划的差异：

1. footer 的状态总览键用 **Ctrl+O** 而不是 Ctrl+I：多数终端里 Ctrl+I 就是 Tab，无法与缩进键区分。
2. 新增 `src/patch.ts`（两处都要用同一套稀疏合并工具，抽出来避免循环依赖）。
3. 父级列表降级策略落定：标签至少留 14 列，剩余宽度先给 `✓ 当前值` 再给 `default X`；
   候选项列表则先留行尾 ` · default` 再截值（两端都有回归断言）。
4. `sessionId` 过滤抽成可测的纯函数 `restoreOverlayFromEntries()`，`/fork` 不继承因此有直接单测。
5. 数值项预设集沿用计划中的提议，未额外确认（改预设只动 `settings.ts` 一处）。

仍待人工（唯一无法自动化的部分）：

- 真实 TUI 里过一遍 `/notify`：列表排版、滚动、`Ctrl+S` 的 ` · default` 迁移与状态行提示、
  `Ctrl+T` 是否真的弹出通知、`Ctrl+O` 状态总览是否读得顺，以及三个 Ctrl 键是否与宿主全局绑定冲突。
  步骤写在 `README.md` 的「人工验证」。

不在本次范围、但需要同步的残留：

- `plans/pi-notification-handoff.md` 仍描述旧行为（`/notify status|off`、off 写整份快照），与本次改动不一致。

## 测试与注释整理验收

## 执行结果（收尾记录）

状态：**14/14 步完成**。四个插件测试全绿：`pi-notification`（10 套，165 步）、`pi-video-generation`（4 单测 + 1 渲染套）、`pi-image-generation`（31）、`pi-codex-official`（24）。

与计划的差异（均已单独列出并取证）：

- **发现了 3 个计划外的缺陷**：D3（`providers[].enabled` 非布尔被静默当作 true）、D4（`redact` 对 `Authorization: <scheme> <secret>` 与 Cookie 头漏掉凭据）、D5（`pi-video-generation` 的 `npm test` 在本仓库解析不到宿主 SDK，属既有缺陷）。三者与 D1、D2 一并修复。
- **subagent 通道不可用**：受控车道启动即失败（`pi-subagents` 解析不到 `@earendil-works/pi-coding-agent` peer，其自身目录下 peer 未安装）。经 owner 明确批准后改为父会话直接修复，仍按原约束执行（最小改动、逐条复查 diff、跑全套取证）。
- `expected failure` 机制随缺陷修复一并退役：D1/D3/D4 的断言已提升为普通断言（不保留"永远绿"的旁路）。

新增测试（4 个通知脚本 + 1 个视频脚本，共 42 步 + 4 测）：`test/config-validation.mjs`、`test/settings-patch.mjs`、`test/registry-log.mjs`、`test/lifecycle-state.mjs`、`pi-video-generation/test/adapters.test.ts`。

注释改造：中文注释行 601 → 0（src + extensions）、259 → 0（test，保留中文用例名与输出文案）；`§` 108 → 0；外部文档/文件引用 40 → 0。

## 分层设置界面验收

## Progress

### 终验收结论（父助手，步骤 1–23 全部完成）

- 独立复跑：`npm test` exit 0，211 项通过（含真实 CLI 冒烟）；`test/settings-ui.mjs` 50 项通过。
- 全页面渲染扫描（自建外部工具，不经子代理）：首页/五个分类/规则页/字段候选/`?` 只读页/搜索/确认/预览/状态页在 20/24/30/40/80 列下无 `undefined`/`[object`/`null` 且不超宽。
- 持久化独立抽查（`deleteUserDefault` + overlay 恢复）：缺文件删除不建文件；删字段保留兄弟/未知字段、空祖先裁剪正确；删渠道 enabled 保留定义/options/自定义字段；重复删除幂等；损坏文件拒绝且原文不变；空快照恢复为空 overlay（最后一项清除不复活），其它 sessionId 快照仍正常。
- 阶段二 P1/P2 修复已在 24 列验证：分类行标签可读、规则摘要为「4 类已开启」、footer 首行为 `Ctrl+S 保存为默认`。
- 交付：10 个包内文件改动、未提交未暂存；两份故障快照 `/tmp/pi-notification-timeout-3SLhDz.patch`、`/tmp/pi-notification-startup-failure-7q36j1.patch`；外部验收脚本 `D:/tmp/render-check*.mjs`、`D:/tmp/check-restore.mjs`（均在仓库外，未污染包）。
- 未覆盖/风险：`/resume` 跨进程恢复仅有间接证据；真实终端目测需用户本人执行；本包无类型检查（环境无 typescript），已用渲染扫描与“类型与实现一致”手改补位；README 另有历史数字曾在中间阶段被顺手纠正，仍可能有少量过期描述。

- 阶段二检查点（步骤 7–15）父助手验收：独立复跑 test:ui（42 项）与 test:host（53 项）全通过；用真实组件渲染首页/规则分类/规则详情/免打扰/高级设置/渠道/状态与诊断帧（20/30/40/80 列），确认首页 9 项、规则一行摘要、自动收起、Space 切换、可见重读入口与“送达前提”文案。发现上述两项窄屏缺陷，已转为阶段三必做回归，现已勾选步骤 7–15。

- 已完成规划探索：UI/字段表、命令桥接、测试入口、既有 UX 约束、单项写盘与原子写入、provider 缺省语义、空 overlay 恢复边界、正文预览复用点及条件字段实际消费位置。
- 实施前预检：worker 阅读完整相关实现/测试和 Pi 官方文档，记录基线测试结果；基础设施或既有失败单独报告，不掩盖为本次改造结果。
- 规划阶段只修改 Markdown。执行阶段由 worker 修改本包代码，父助手仅审查与验证；步骤1–4已通过核验并调用 mark_done。
- 父助手独立验证：步骤3后 `MSYS_NO_PATHCONV=1 npm run test:ui` 28项通过；步骤4后 `MSYS_NO_PATHCONV=1 npm run test:patch` 12项通过。
- 基础设施中断：顶层 workflow `8e5ea2da-dd4c-4d60-8663-1201e453418c` / phase1 child `78d259f7-5ad4-4ac5-ae48-625d0e2b6a50` 于步骤4回报后触发 `Subagent timed out after 1800000ms`，顶层状态 failed；阶段二/三未启动。父助手放行步骤5的 supervisor reply 因请求已消失未送达。
- 中断现场：cwd `D:/XuKai/Project/myflow`，分支及 HEAD 仍为上述基线；6个本包文件有实现改动、无暂存；部分 diff 已保存 `/tmp/pi-notification-timeout-3SLhDz.patch`（Git Bash临时目录）。`children.list` 确认该 child resumable。
- 恢复策略：明确进行同协议恢复，从阶段一剩余步骤5–6继续，不重复勾选1–4，不切换模型/执行模式。后续新阶段使用更宽裕的显式运行时限，保留逐项验收门禁。
- 恢复尝试也发生基础设施失败：workflow `b3b8ebb2-8f93-4e2b-8ff1-61f1d205ae04` / child `efc704aa-74ce-4068-bfab-cbd8434458be` 启动时 `Timed out after 10000ms waiting for the async runner startup state 'ready'`，无新 child session，顶层 failed。已暂停，不再自动重试。
- 二次故障后状态未变：同一 cwd/main/HEAD、无暂存、原6个实现文件。新快照 `/tmp/pi-notification-startup-failure-7q36j1.patch` 与第一次快照 `cmp` exit0，证明本次启动失败未产生额外代码变化。doctor 显示 async available、原生 supervisor 可用、active async capacity 0；尚不能据此确定启动超时根因。
- 下一决策：是否按相同 subagent 协议/指定模型启动 fresh-context worker，读取本计划与现有diff，从步骤5–6继续；不绕过为外部CLI或父助手代写。

## 后续任务界面记录

后续界面调整的完整运行记录保留在 [progress.md](pi-notification-ux/progress.md)。其中日期和 UI 数量按原文保留；它们不是本次整理的执行结果。


## 原交接中的人工验收记载

### M3-3 人工验收记录（已通过）

已由维护者在真终端执行：`/notify test` 的通知显示、`/notify status` 排版、`/notify config` 向导按键，
以及 `waitingForUser` 打开后真实 `confirm` 的等待提醒与复位。
需区分：“显示正常”不等于 OSC 777/99 在**其它终端**上也正常（见 README 的未验证清单）。

