# Pi「消息通知插件」设计方案

> 状态：**MVP + S4/S6/S7 + M3-1/M3-2 + M4 已实现**，S5 完整配置面与正文内容字段均已落地；最近一次自动化验收 105 项全绿。
> **M3-3 真终端人工验收已由维护者执行并通过**；M4 的视觉口味建议在下一次真实运行时顺带看一眼（见 §19 末尾）。
> 目标宿主：`@earendil-works/pi-coding-agent` **0.86.1**（下方简写 `O/` = `D:/Nodejs/node_modules/@earendil-works/pi-coding-agent`）。
> 研究时仓库：`D:/XuKai/Project/myflow`，当时 HEAD `a0059283327b5d8f56fa117077f4a55fac9e1265`（历史基线，不代表当前工作区）。
> **命名修订（v1.2 之后）**：插件目录与配置目录统一为 **`pi-notification`**（原文档写作 `pi-message-notification`），已全文替换。
> **当前能力与验收范围见插件 `README.md`；下一步与实现经验见 `plans/pi-notification-handoff.md`**。本次已同步 M3 实现状态，历史研究与草稿片段仍按其标注保留。
> 标记约定：**【官方】**= 当前 0.86.1 文档/源码可验证；**【设计】**= 本方案自定；**【待验证】**= 编码前必须实测。

---

## 0. 研究分工与一处失败（必须如实记录）

| 子任务 | 执行者 | 结果 |
|---|---|---|
| SubAgent 1 现有插件架构 | `delegate`（子 run `2437645a`） | ✅ 完成，产出三插件对比与可复用模式 |
| SubAgent 2 官方 Extension API | `delegate`（子 run `9a39e30d`） | ❌ **失败**：`Codex error: The usage limit has been reached` |
| SubAgent 3 通知插件设计 | 未启动（依赖前两项） | 由主 Agent 承担 |

**处理方式**：SubAgent 2 属于 lane 基础设施阻塞，未静默换模型重试。官方接口结论改由主 Agent 直接核对本地 0.86.1 源码与全套文档获得：

- `O/docs/extensions.md`（全 19 节，含事件生命周期图）、`docs/packages.md`、`docs/tui.md`、`docs/sessions.md`、`docs/session-format.md`、`docs/compaction.md`、`docs/rpc.md` 全文读取
- `O/dist/core/extensions/types.d.ts`（事件与 `ExtensionAPI` 全量签名）、`dist/core/extensions/runner.js`、`dist/core/extensions/loader.js`、`dist/core/event-bus.js`、`dist/core/agent-session.js`、`dist/core/resource-loader.js`、`dist/core/package-manager.js`
- `O/examples/extensions/notify.ts`（官方通知示例）

因此下文的 **【官方】** 结论均有路径依据；【设计】部分是本方案主张，不是 Pi 既有能力。

---

## 1. Pi 插件机制中与本插件有关的接口

### 1.1 插件形态与加载【官方】

- 插件就是一个 **默认导出工厂函数**的 TS/JS 模块：`export default function (pi: ExtensionAPI) {...}`，由宿主通过 jiti 加载，无需编译。
  `ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>`（`O/dist/core/extensions/types.d.ts:1169`）。
- 工厂可同步或异步；异步工厂会被 `await`，用于一次性启动准备（`O/docs/extensions.md` "Async factory functions"）。
- **自动发现目录**：`~/.pi/agent/extensions/*.ts`、`~/.pi/agent/extensions/*/index.ts`、`.pi/extensions/*.ts`、`.pi/extensions/*/index.ts`。
- **包形式**：`package.json` 的 `pi.extensions` 显式声明入口；带 `pi-package` keyword 可分发。三个现有插件都用 `pi.extensions: ["./extensions/index.ts"]`。
- 项目级插件仅在项目被 trust 后加载；`ctx.isProjectTrusted()` 可查询运行时 trust 状态。
- `ExtensionAPI` 是**类型**；运行时实例由宿主创建注入。`O/dist/core/extensions/loader.js:445-455` 为每个扩展新建注册集合、调用 `createExtensionAPI()`、`await factory(api)`，成功 `commit()`、失败 `discard()`。

> 设计含义：工厂内**只能**做本地校验、实例状态与注册；不得在工厂里发通知、起定时器、读整份会话。

### 1.2 Handler 调度语义（决定多插件共存）【官方】

`O/dist/core/extensions/runner.js` `emit()`：

1. 每次派发用 `snapshotEventHandlers()` 取**快照**，因此某 handler 中途 `unsubscribe` **不影响本次派发**。
2. 顺序 = **扩展加载顺序**，同一扩展内 = **注册顺序**。二者是两件事，不要混为"handler 优先级"。
3. 每个 handler 被 `try/catch` 包裹，异常走 `emitError()` 上报，**不中断其他扩展、不中断 agent**。
4. `pi.on()` 返回 `() => void`，只移除该次注册。

**唯一的"抛异常即阻断"例外**：`tool_call`。`agent-session.js` `_installAgentToolHooks()` 中 `beforeToolCall` 若抛错，会变成 `Extension failed, blocking execution: ...` 直接阻断工具。通知插件**不应注册 `tool_call`**。

### 1.3 Hook 分类矩阵【官方】

| 类别 | 事件 | 返回值影响 |
|---|---|---|
| **纯通知型**（返回值被忽略） | `agent_start` `agent_end` `agent_settled` `turn_start` `turn_end` `message_start` `message_update` `tool_execution_start` `tool_execution_update` `tool_execution_end` `session_start` `session_info_changed` `session_compact` `session_compact_failed` `session_shutdown` `session_tree` `model_select` `thinking_level_select` `ui_prompt_start` `ui_prompt_end` `resources_discover` `after_provider_response` | 忽略 |
| **可修改数据** | `context`（换 messages）、`message_end`（同 role 替换消息）、`tool_result`（部分 patch content/details/isError/usage）、`before_agent_start`（注入 message / 改 systemPrompt）、`before_provider_headers`（原地改 headers）、`before_provider_request`（替换 payload） | 链式生效 |
| **可 block / cancel** | `tool_call`（`{block:true,reason?,terminate?}`）、`input`（`handled` 短路）、`user_bash`（拦截）、`session_before_switch`/`session_before_fork`/`session_before_compact`/`session_before_tree`（`{cancel:true}`） | 首个 cancel 即返回；否则后者覆盖前者 |

**重要细节**：`session_before_*` 在 runner 中是"最后一个非 cancel 结果胜出，但一旦出现 cancel 立即返回"。所以多个扩展都返回自定义摘要时是**后者覆盖**，不是合并。

**通知插件只使用纯通知型事件**，唯一例外是**只读**的 `message_end`（用于错误分类，不改返回值）。

### 1.4 与"完成/等待/错误"直接相关的 Hook【官方】

| 需求 | 正确 Hook | 依据 |
|---|---|---|
| Agent 真正结束 | **`agent_settled`** | `docs/extensions.md`；`agent-session.js:367-373` |
| 单次底层运行结束 | `agent_end`（**不可**当完成用） | Pi 之后还可能 auto-retry / auto-compact+retry / 处理排队 follow-up |
| 等待用户输入 | **没有专用 Hook** | 完整 `on()` 签名清单（`types.d.ts:912-948`）中不存在 idle/waiting hook |
| 扩展 UI 等待用户 | `ui_prompt_start` / `ui_prompt_end` | `runner.js:304-340` |
| 会话出错 | **没有 `session_error`** | 同上清单无此事件 |
| 压缩失败 | `session_compact_failed` | `types.d.ts:498-512` |
| Provider 429 等 | `after_provider_response`（`event.status`） | 每次请求都触发，频率高 |
| 工具失败 | `tool_execution_end.isError` | 见 1.5 |
| 退出/重载/换会话 | `session_shutdown.reason` = `quit`\|`reload`\|`new`\|`resume`\|`fork` | `types.d.ts:479-489` |

**关键更正 1：`agent_end` ≠ 任务完成。**
官方文档明确："Pi may still auto-retry, auto-compact and retry, or continue with queued follow-up messages. Use `agent_settled` for status integrations."

**关键更正 2：`agent_settled` ≠ 业务成功。**
`agent-session.js:860-879`：

```js
async _runAgentPrompt(messages) {
  this._isAgentRunActive = true;
  try { ... } finally {
    this._flushPendingBashMessages();
    this._flushPendingCustomMessages();
    await this._emitAgentSettled();   // finally 分支：异常/取消也会 settle
  }
}
```

用户按 Esc 中断、provider 报错，**都会**触发 `agent_settled`。因此必须结合最后一次 assistant 的 `stopReason` 判定语义（见 §12）。

**关键更正 3：`ui_prompt_start` 不等于"等待人类"。**
`runner.js:304-340` 把 `select / confirm / input / editor / custom` 全部纳入；而 `custom()` 常被用作纯进度加载器——**本仓库的图片/视频插件正是这么做的**（`work/scripts/pi/pi-image-generation/extensions/index.ts` 与 `pi-video-plugin` 用 `ctx.ui.custom` + `BorderedLoader` 显示生成进度，全程无人操作）。若把 `kind: "custom"` 当"等待用户"，会产生大量误报。且该事件用 `queueMicrotask` + `void this.emit(...)` 发出，**不 await handler**，也不覆盖 TUI 原生弹窗、原生编辑器输入或 RPC 客户端侧 UI。

**关键更正 4：扩展侧 `agent_end` 载荷里没有 `willRetry`。**
`agent-session.js:498` 扩展事件为 `{ type: "agent_end", messages }`；带 `willRetry` 的那份（`:407`）走的是 session 事件流（TUI/RPC），**不是**扩展。想判断"是否还会自动重试"只能靠 assistant `stopReason === "error"` 推断。

### 1.5 工具失败语义【官方】

`agent-session.js` `_installAgentToolHooks()` 的 `afterToolCall` 会先跑 `tool_result` 链，并把 `hookResult?.isError ?? isError` 作为最终错误状态返回给 agent core；因此 **`tool_execution_end.isError` 已经是"被其他扩展修改过"的最终值**，可以作为唯一失败判据。

并行工具模式下：`tool_execution_end` 按**完成顺序**发出，`tool_execution_start` 按 assistant source order 预检发出。失败通知要按 `toolCallId` 关联，不要假设顺序。

### 1.6 Extension Context 与 Runtime Control【官方】

`ExtensionContext`（`types.d.ts:210-250`）可用：`ui`、`mode`（`tui|rpc|json|print`）、`hasUI`、`cwd`、`sessionManager`、`modelRegistry`、`model`、`thinkingLevel`、`isIdle()`、`isProjectTrusted()`、`signal`、`hasPendingMessages()`、`shutdown()`、`getContextUsage()`、`compact()`、`getSystemPrompt()`。

命令专属（`ExtensionCommandContext`）：`waitForIdle()`、`newSession()`、`fork()`、`navigateTree()`、`switchSession()`、`reload()`。

> 这些是 **Runtime Control**（读状态 / 控制 Pi），不是通知能力；通知插件只读其中极少数（`mode`、`hasUI`、`isIdle`、`sessionManager`、`signal`）。

### 1.7 Event Bus【官方】

`O/dist/core/event-bus.js` 是 **Node `EventEmitter` 的薄包装**：

```js
on: (channel, handler) => { const safeHandler = async (data) => { try { await handler(data) } catch (err) { console.error(...) } }; ... }
```

性质：**仅同进程**、`emit` 不 await（无投递确认）、无持久化、无跨进程/跨 session 保证、handler 异常只打日志。仓库内三个插件**都没有**使用它。

→ **通知核心不需要 Event Bus**；它只适合作可选的"跨扩展投递入口"（§7.6）。

### 1.8 配置、持久化、UI 的官方能力边界【官方】

- **没有**通用的"扩展设置注册"API。`ExtensionAPI` 全量成员中不存在 settings/configuration 注册项。
- 官方给的手段：`pi.registerFlag()/getFlag()`（CLI 标志）、`pi.registerCommand()`（命令自管配置）、`pi.appendEntry()/registerEntryRenderer()`（非 LLM 上下文的持久化 + TUI 渲染）、`getAgentDir()`/`CONFIG_DIR_NAME`（定位配置目录）、`ctx.isProjectTrusted()`（读项目配置前必须检查）。
- `pi.registerProvider()` 是**注册模型服务商**（LLM endpoint/OAuth/catalog），与"通知 Provider"同名不同义。**通知插件绝不能调用它**——`pi-codex-official` 用它是因为它真的是 provider 适配器。
- `ctx.ui.notify()` 只在 TUI/RPC 输出；print/json 模式 `hasUI=false` 且为 no-op。它**不是**外部投递成功的证据。
- Session 替换（`new`/`resume`/`fork`）会：旧实例 `session_shutdown` → 销毁旧 runtime → 重建 → 新实例 `session_start`。官方明确警告：替换后**旧 `pi`/`ctx` 已失效，调用会 throw**（`agent-session.js` `dispose()` 的 invalidate 文案；`docs/extensions.md` "Session replacement lifecycle and footguns"）。宿主只自动取消它自己追踪的 event-bus 订阅，**不会**替你取消 fetch、timer、子进程。

---

## 2. 三个现有插件值得复用的设计模式

来源：SubAgent 1 报告（基于 `work/scripts/pi/pi-codex-official` = **C**、`pi-image-generation` = **I**、`pi-video-generation` = **V** 的源码核对）。

### 2.1 统一结构（三者一致）

```
<plugin>/
  package.json          # type:module + pi.extensions: ["./extensions/index.ts"]（显式唯一入口）
  README.md
  extensions/index.ts   # 默认导出的薄接线层：注册 + 实例状态 + 清理
  src/                  # 配置 / 校验 / 业务 / transport / 文件，按职责分层
  test/
```

### 2.2 值得复用的 6 点

| # | 模式 | 出处 | 对本插件的价值 |
|---|---|---|---|
| 1 | **显式 manifest 单入口**，helper 是普通模块而非入口 | C/I/V 一致 | 保证 `/reload` 语义与发现顺序可控 |
| 2 | **工厂只注册 + 建实例闭包状态**；需要 `ctx` 时由 handler 传入 | C/I/V | 避免旧 ctx 泄漏 |
| 3 | **配置严格校验、失败不静默回退** | I `src/model-config.ts` | 通知规则写错必须报错，不能静默失效 |
| 4 | **敏感值独立存放 + 错误统一脱敏** | I `src/credentials.ts`、`src/http.ts` `sanitizeError` | webhook/secret 必须脱敏 |
| 5 | **配置先校验再临时文件原子替换** | V `src/config.ts:58` | `/notify config` 写盘安全 |
| 6 | **`ctx.mode` 而非 `hasUI` 守卫终端 UI**（RPC 下 `hasUI=true`） | I `extensions/index.ts:73-81` | 通知配置向导只在 `tui` 下开 |

### 2.3 明确**不**复制的 5 点（含三插件自身缺陷）

| # | 反模式 | 原因 |
|---|---|---|
| 1 | registerProvider 抢占 provider ID / OAuth | 通知不是模型服务商 |
| 2 | 依赖声明不完整（I 运行时用 pi-ai/pi-tui，`package.json` 只声明 pi-coding-agent peer） | 官方要求真实 runtime import 进 peers（`docs/packages.md`） |
| 3 | **无 `session_shutdown` 清理**（I、V 均未注册） | 通知插件有队列/定时器/请求，必须幂等 dispose |
| 4 | 把 `ctx.isIdle()` 当业务互斥锁（V） | 它只表示 Pi 空闲，不表示别的插件任务结束 |
| 5 | 复制 V 的 `.tasks.json` 远端任务恢复存储当通知 outbox | 那是为收费远端任务设计；通知 MVP 不需要 exactly-once |

**结论性判断**：可复用的是 **"薄工厂 + 独立 src 分层 + 实例闭包状态 + 显式清理"**，不是媒体插件那套 provider/凭据/任务恢复栈。I/V 的 `host-lifecycle` 测试用 stub 模拟 reload，**不能**作为"旧 hook 不会重复触发"的证明。

---

## 3. 消息通知插件的需求拆解

### 3.1 原始需求 → 判定

| 需求 | 判定 | 依据 / 实现位置 |
|---|---|---|
| Agent 完成时通知 | ✅ 核心 | `agent_settled` + 成功判定 |
| Agent 等待用户输入时通知 | ⚠️ **降级实现**：`agent_settled` 后 `ctx.isIdle()` 即"轮到你"。**无专用 Hook** | 见 §1.4 更正 3 |
| Tool 执行失败通知 | ✅（聚合，非逐条） | `tool_execution_end.isError` + 去重 |
| 长任务完成时通知 | ✅ 与"完成通知"合并，附时长；**不做心跳** | `agent_start` 记时 |
| Session 出错通知 | ✅ 有界实现 | 无 `session_error`；用 assistant error + `session_compact_failed` |
| 分级 | ✅ | `info / warning / error`，规则映射 |
| debounce / 去重 | ✅ **必须**（否则 agent_end 重试与 settled 连发会刷屏） | 服务层 |
| 用户可配置 | ✅ | 用户级 JSON + `/notify` 命令 |
| 需要 `registerCommand` | ✅ 需要（状态/测试/开关/配置） | §10 |
| 需要 UI 配置 | ✅ 仅 TUI 的规则向导；非 TUI 显示文件路径与当前值（隐藏渠道 options） | `ctx.ui.select` / `confirm`，最终确认后保存 |
| 通知正文有内容 | ✅ 会话名 / 成本（本次+累计） / 上下文占比 / assistant 摘录 | 均不读用户 prompt 原文（§19） |
| 需要 Event Bus | ❌ 核心不需要；仅作可选扩展入口 | §7.6 |
| 渠道与生命周期解耦 | ✅ **硬性要求** | Provider 接口 + 规则/服务分层 |

### 3.2 明确**不做**的事（避免架构膨胀）

- ❌ 注册 LLM 工具（通知不需要模型调用）
- ❌ 注册 `tool_call` / `input` / 任何 `session_before_*`（不阻断、不改写、不取消）
- ❌ 自建 provider / OAuth / session / 独立进程
- ❌ 为 MVP 做持久化 outbox、exactly-once、跨进程锁
- ❌ 保存完整 assistant 文本或完整 prompt 到日志/通知（隐私）

---

## 4. 推荐监听的 Hook 及选择理由

**核心 5 个 + 可选 2 个，全部为纯通知型（除只读的 `message_end`）。**

| Hook | 用途 | 为什么选它 | 不选替代的原因 |
|---|---|---|---|
| **`session_start`** | 建实例态、读配置、创建 session 级 `AbortController` | 唯一可靠的"本实例从此刻起负责该会话"起点；`reason` 可区分 startup/reload/new/resume/fork | 工厂里做会拿到未绑定的旧态 |
| **`agent_start`** | 记录运行起点、清空本次运行累积器 | 每次运行都发，是"长任务计时"的唯一起点 | `before_agent_start` 可改数据且只在有 prompt 时发 |
| **`message_end`** | **只读**捕获 assistant `stopReason`/`errorMessage` | 扩展 `agent_end` 无 `willRetry`；`stopReason` 是唯一能区分 error/aborted/length 的字段，且在持久化前可见 | 扫 `sessionManager` 分支要遍历，且 `agent_settled` 时 `_lastAssistantMessage` 已被清空 |
| **`tool_execution_end`** | 工具失败通知（聚合用） | `isError` 已是 `tool_result` 修改后的最终值；纯通知型，不干扰中间件 | `tool_result` 是修改型，注册它会进入他人链路 |
| **`agent_settled`** | **完成/失败/取消的唯一出口判定点 + 实际发通知** | 官方指定的"不会再自动继续"时点 | `agent_end` 会被重试/压缩/follow-up 续跑，必然误报 |
| **`session_compact_failed`** | 压缩失败告警 | 官方有专门终态事件（含 `errorMessage`/`aborted`） | 用 `session_compact` 反推无法拿到失败原因 |
| **`session_shutdown`** | 幂等 dispose：取消队列、abort 在途请求、清 timer | 唯一清理时机；`reason` 决定"quit 需尽力 flush"还是"reload/new 直接丢弃" | 无其他退出 Hook |
| （可选）**`ui_prompt_start`/`ui_prompt_end`** | "扩展正在等你输入"提醒 | 官方唯一等待语义事件 | 必须默认排除 `kind: "custom"`；不覆盖原生 UI |
| （可选）**`after_provider_response`** | 调试/限流观测（默认关） | 唯一能拿到 HTTP status 的扩展点 | 每次请求触发，默认开启会放大噪声 |

**不监听**：`message_update`（token 级，性能灾难）、`turn_*`（过细）、`context`/`before_*`（修改型，越界）、`model_select`/`thinking_level_select`（与通知无关）。

---

## 5. 插件完整生命周期

```
[进程启动 / 每次 reload]
  └─ 工厂执行（可异步）
       ├─ 读取并校验用户级配置（失败→记录 error，仍完成注册，保证 /notify 可用）
       ├─ 创建实例闭包：queue、dedup 窗口、provider 注册表、session 级 AbortController（未绑定）
       └─ 注册：on(session_start/agent_start/message_end/tool_execution_end/agent_settled
                  /session_compact_failed/session_shutdown[/ui_prompt_*])
                 registerCommand("notify"), registerFlag("no-notify")

[会话开始]  session_start(reason)
       ├─ 重建 session 级状态：runId、累积器、AbortController
       ├─ 若 reason ∈ {new,resume,fork}：放弃上一会话残留的在途通知
       └─ 校验 provider；失败→ctx.ui.notify 警告 + 状态置 degraded

[一次 agent 运行]
  agent_start ──► 记录 startedAt、重置 run 累积器
  message_end* ─► 若是 assistant：记录 stopReason / errorMessage / usage（只读）
  tool_execution_end* ─► isError=true → 累积失败（默认不发，除非规则要求即时）
  agent_settled ─► 【唯一出口】
       ├─ 分类：completed | failed | aborted | compact_failed
       ├─ 汇总：时长、工具失败数、成本/上下文（按配置）
       ├─ 规则求值 → 等级映射 → 去重/debounce
       ├─ 入队 → 异步投递（不阻塞 agent）
       └─ flush 本 run 累积器

[会话结束]  session_shutdown(reason)
       ├─ abort 在途请求（AbortController.abort()）
       ├─ quit → 在极短预算内尽力 flush 已入队项
       ├─ reload/new/resume/fork → 丢弃未投递项（避免"你已离开的会话"继续弹通知）
       └─ 幂等 dispose providers（重复调用安全）

[实例作废]  旧 pi/ctx 调用会 throw → 所有异步回调必须检查"本实例是否仍属当前 session"
```

关键不变式：

1. **任何 Hook 内都不 await 外部网络投递**（只入队）；投递在自己的异步任务里跑。
2. **通知必须绑定 `sessionId`**，投递前校验会话未变。
3. **dispose 幂等**，且不依赖 `ctx`（`session_shutdown` 后 `ctx` 可能已作废）。

---

## 6. 插件架构图

```
                    ┌─────────────────────────────────────────────┐
                    │            extensions/index.ts              │
                    │        （薄接线层：只注册 + 转发）             │
                    └───────────────┬─────────────────────────────┘
                                    │ raw events + ctx（当次）
                                    ▼
        ┌───────────────────────────────────────────────────────────┐
        │                     lifecycle.ts                          │
        │  · 会话/运行状态机（runId, startedAt, lastAssistant, errors）│
        │  · 唯一完成判定点：agent_settled → RunOutcome              │
        │  · sessionId 绑定与过期检查                                 │
        └───────────────┬───────────────────────────────────────────┘
                        │ RunOutcome / SignalEvent（纯数据）
                        ▼
        ┌───────────────────────────────────────────────────────────┐
        │                      rules.ts                             │
        │  事件 → 是否通知 / 等级 / 渠道 / 是否合并（纯函数，可测）      │
        └───────────────┬───────────────────────────────────────────┘
                        │ NotificationRequest
                        ▼
        ┌───────────────────────────────────────────────────────────┐
        │                    service.ts                             │
        │  · 合并窗口 / 去重 / 冷却 / 级别阈值 / 静默时段              │
        │  · 有界队列 + 并发上限 + 超时 + 重试(有限) + 熔断            │
        │  · 路由到 providers（并行，互不阻塞）                        │
        └───────────────┬───────────────────────────────────────────┘
                        │ Delivery
        ┌───────────────┴───────────────┬───────────────┬───────────┐
        ▼                               ▼               ▼           ▼
  providers/terminal.ts       providers/webhook.ts  providers/…  （未来）
  (OSC777/99/toast)           (HTTP POST)          telegram/discord/slack
        ▲
        │ 全部实现同一 Notifier 接口（§11）
  config.ts ── 读取/校验/原子写；被 index/lifecycle/rules/service 只读消费
  commands.ts ── /notify（status|test|on|off|config|reload）
  ui.ts ── TUI 规则向导（已实现）；状态行 / 历史 entry 渲染仍属可选未实现
  events.ts ── 可选：pi.events 对外的 "pi-notification:emit" 入站通道（非依赖）
```

**分层理由**：`lifecycle` 只认 Pi 生命周期；`rules` 是纯函数；`service` 只管投递可靠性；`providers` 只认自己的协议。四层互不 import 具体实现，因此新增 Telegram/Discord 不改任何生命周期代码，新增规则不改任何 provider 代码。

---

## 7. 目录结构（M3-1/M3-2 落地后的实际状态）

> 本节记录实际实现与测试文件，避免设计与代码漂移。`ui.ts` 已在 M3 落地；
> 草稿中的 `test/*.test.ts` 仍由零依赖 `.mjs` 脚本替代。本目录只放运行架构相关内容，不含会话性笔记。

```
work/scripts/pi/pi-notification/
├── package.json                 # type:module, keywords:[pi-package], pi.extensions:[./extensions/index.ts]
├── README.md                    # 安装/启用/配置/命令/隐私与失败边界/未验证项
├── extensions/
│   └── index.ts                 # 默认工厂：组装 + 注册 10 个 hook + /notify + --no-notify（薄接线，不判定）
├── src/
│   ├── types.ts                 # 共享契约（§11 + §17.4）；唯一的跨层类型来源
│   ├── config.ts                # 默认值 / 用户级+项目级读盘 / 严格校验 / 降级 / 用户级原子写盘
│   ├── lifecycle.ts             # 运行状态机 + 工具失败/等待输入簿记；唯一完成判定点
│   ├── rules.ts                 # 纯函数：RunOutcome/工具失败/压缩失败/等待 → NotificationRequest | null
│   ├── service.ts               # 门槛/去重/静默时段/合并窗口/冷却/超时/有界队列/统计/路由
│   ├── commands.ts              # /notify status|test|on|off|config|reload
│   ├── ui.ts                    # TUI 规则向导：副本编辑 + 最终确认，命令层统一写盘
│   ├── log.ts                   # 控制字符清洗 / 脱敏 / 可选 JSONL 诊断 sink
│   └── providers/
│       ├── registry.ts          # Factory + Registry（唯一分派点）
│       ├── decorators.ts        # withTimeout/withRetry/withCircuitBreaker/withRedaction
│       ├── noop.ts              # Null Object（禁用/未注册/校验失败）
│       ├── terminal.ts          # 阶段 1：OSC 777 / OSC 99 / Windows toast（+ TTY 纪律）
│       ├── debug.ts             # 排障渠道：把通知写成一行日志（不碰终端）
│       └── webhook.ts           # 阶段 2：通用 HTTP POST + HMAC（Telegram/Discord/Slack 的底座）
└── test/
    ├── sdk-path.mjs             # 定位 SDK / pi 可执行文件（两个宿主脚本共用）
    ├── terminal-channel.mjs     # 渠道：机制选择/渲染字节/注入面/TTY 纪律（不需要 SDK）
    ├── service-coalesce.mjs     # 门槛/去重/静默/合并/冷却/队列/超时（注入假时钟与假渠道）
    ├── webhook-channel.mjs      # Webhook + 装饰器（回环 HTTP 服务；外部 fetch 一律失败）
    ├── host-lifecycle.mjs       # 真实宿主判定/S4/S6/S7、配置读写/热读、命令与 TUI 桩
    ├── cli-smoke.mjs            # 真实 pi 进程：stdout 纪律、off 跨进程持久化、非 TUI 配置展示
    └── fixtures/
        ├── probe-ext.ts         # 离线假 provider + /probe-cmd + /probe-prompt + 事件打点
        └── blocking-ext.ts      # 阻塞对照组（证明“不阻塞”的测量有区分度）
```

**与设计草稿的差异（都是刻意的）**：

| 草稿 | 实际 | 理由 |
|---|---|---|
| `ui.ts`（TUI 向导 / 状态行 / 历史渲染） | M3 已实现最小规则向导 | 使用标准 `select` / `confirm`，不引入 `SettingsList`；状态行与历史渲染仍未做 |
| `test/rules.test.ts`、`service.test.ts`、`config.test.ts` | `service-coalesce.mjs` + 宿主脚本里的 P0/I*/J* 段 | 仓库不允许装依赖、没有测试框架；用 `node:test` 之外的零依赖脚本反而更直接 |
| `commands.ts` 覆盖 `on\|off\|config\|reload` | 已实现，连同原有 `status\|test` 共 6 个子命令 | 保存只写用户层，成功后重读；`/notify reload` 不重建扩展 |
| 无 `decorators.ts` / `webhook.ts` | 已落地 | S7 阶段 2 的目标 |

不做 `dist/`、`main`、`bin`、构建流程——Pi 直接加载 TS。第三方依赖为零（HTTP 用 Node 内置 `fetch`）。

---

## 8. 核心模块职责

| 模块 | 职责 | 明确不做 |
|---|---|---|
| `extensions/index.ts` | 组装依赖、注册 Hook/命令/标志、把原始事件转成 `SignalEvent` | 业务判定、网络、读配置细节 |
| `config.ts` | 路径解析（`getAgentDir()` / `CONFIG_DIR_NAME` + `isProjectTrusted()`）、schema 校验、默认值、原子写 | 决定要不要通知 |
| `lifecycle.ts` | **唯一**判定"运行是完成/失败/取消"的地方；维护 run 累积器；保证 sessionId 绑定与过期丢弃 | 投递、去重策略 |
| `rules.ts` | 纯函数：`(SignalEvent | RunOutcome, Config) → NotificationRequest | null` | IO、时间、随机 |
| `service.ts` | 合并窗口、去重键、冷却、级别阈值、静默时段、有界队列、并发、超时、有限重试、连续失败熔断 | 关心事件从哪来 |
| `providers/*` | 把 `NotificationRequest` 变成实际投递；自带 timeout/abort | 读配置之外的状态、读会话内容 |
| `commands.ts` | `/notify status\|test\|on\|off\|config\|reload` | 直接发网络（走 service） |
| `ui.ts` | TUI 规则向导（`select` / `confirm`），只改副本并在最终确认后返回给命令层保存；状态行/历史未实现 | 在非 TUI 强开终端 UI；直接写盘或改运行内存态 |

---

## 9. 模块之间的数据流

```
Pi 原始事件
   │  (index.ts 只做形状转换，不判定)
   ▼
SignalEvent ──────────────► lifecycle.ts
                              │ 累积 & 判定
                              ▼
                          RunOutcome ──┐
                                       ├──► rules.ts ──► NotificationRequest | null
SignalEvent（工具失败等）───────────────┘                     │
                                                             ▼
                                                        service.ts
                                                             │ 去重/冷却/路由
                                                             ▼
                                                   Notifier[] （providers）
                                                             │
                                                             ▼
                                                        DeliveryResult
                                                             │
                                        ┌────────────────────┴──────────────┐
                                        ▼                                   ▼
                                  log.ts（脱敏）                    ui.ts（可选状态/历史）
```

要点：

- **单向数据流**，无回环；`rules`/`service` 不反向 import `lifecycle`。
- 所有时间相关逻辑通过**注入 clock**，便于测试与冷却判定。
- `RunOutcome` 是纯 JSON 数据，不含 `ctx`、不含 `SessionManager` 引用（防旧 ctx 泄漏）。

---

## 10. 配置设计

### 10.1 位置与优先级

```
用户级（默认，始终可读）:
  <getAgentDir()>/pi-notification/config.json     # 例: ~/.pi/agent/pi-notification/config.json
项目级（仅 ctx.isProjectTrusted() 为真时读取）:
  <cwd>/<CONFIG_DIR_NAME>/pi-notification/config.json
优先级: 项目级覆盖用户级（逐字段），但**不**允许项目级定义或覆盖任何 secret（防恶意仓库外传）
```

沿用现有插件做法：`getAgentDir()` 定位；参考 V 的用户级活动配置文件思路，但**不把 Key 与普通偏好混存**（V 的明文 Key 混存 + 直接抛 `JSON.parse` 错误不适合 webhook secret）。

### 10.2 Schema（v1）

以下保留为**设计示例，不是当前默认配置的逐字副本**：
当前并发默认值为 `1`（草稿为 `2`），规则默认渠道均为 `terminal`，内置 providers 仅有 `terminal`；
`content` 字段的实际集合与默认值以 §19 为准（已删除 `includePromptExcerpt`）。
实际字段与默认值以 `src/types.ts` / `src/config.ts` 和插件 README 为准。

```jsonc
{
  "version": 1,
  "enabled": true,

  // 全局门槛：低于此级别的通知一律不发
  "minLevel": "info",              // "info" | "warning" | "error"

  // 事件规则：逐个可关，可覆盖等级与渠道
  "rules": {
    "runCompleted":  { "enabled": true,  "level": "info",    "channels": ["terminal"] },
    "runFailed":     { "enabled": true,  "level": "error",   "channels": ["terminal", "webhook"] },
    "runAborted":    { "enabled": false, "level": "info",    "channels": ["terminal"] },
    "toolFailed":    { "enabled": true,  "level": "warning", "mode": "aggregate", "threshold": 1 },
    "compactFailed": { "enabled": true,  "level": "error",   "channels": ["terminal"] },
    "waitingForUser":{ "enabled": false, "level": "info",    "kinds": ["select", "confirm", "input", "editor"] }
  },

  // 合并/去重
  "coalesce": {
    "windowMs": 1500,              // 同一逻辑运行的多次事件合并
    "toolFailureWindowMs": 10000,  // 工具失败聚合窗口
    "cooldownMs": 3000             // 同 kind 最小间隔
  },

  // 静默时段（本地时间，可选）
  "quietHours": { "enabled": false, "start": "23:00", "end": "08:00", "exceptLevels": ["error"] },

  // 内容与隐私
  "content": {
    "includeDuration": true,
    "includeToolFailureNames": true,
    "includeSessionLabel": true,
    "includeCost": true,
    "includeAssistantExcerpt": false,  // 默认 false：不外传 assistant 回复（§19）
    "maxMessageChars": 300
  },

  // 投递可靠性
  "delivery": { "timeoutMs": 8000, "maxRetries": 1, "concurrency": 2,
                "queueLimit": 50, "circuitBreakerFailures": 3 },

  // 渠道
  "providers": [
    { "id": "terminal", "type": "terminal", "enabled": true, "options": {} },
    { "id": "hook", "type": "webhook", "enabled": false,
      "options": { "url": "https://example.invalid/hook",
                   "secretEnv": "PI_NOTIFY_WEBHOOK_SECRET" } }   // 只引用环境变量名，不存明文
  ]
}
```

### 10.2 补充：落地后的真实语义（S4 实现）

已落地的合并/冷却与熔断参数语义如下；不要把上面的设计示例当作全部实现默认值：

| 字段 | 真实含义 | 实现位置 |
|---|---|---|
| `coalesce.windowMs` | **同一「逻辑运行」（`sessionId + runId`）内最多放行一条通知**：第一条进入后开窗，窗口内该 run 的后续通知被合并（计数 `coalesced`）。窗口一旦被任一条通知打开，后续通知即使自带不同窗口也会被吸进去 | `service.ts` |
| `coalesce.toolFailureWindowMs` | `toolFailed.mode = "immediate"` 时，把同一 run 内**并行工具失败**聚合成一条的窗口。通过 `NotificationRequest.coalesceWindowMs` 逐条下达（规则层知道“这是工具失败”） | `rules.ts` → `service.ts` |
| `coalesce.cooldownMs` | 同一 `kind` 两次**入队**之间的最小间隔（跨会话、跨 run）；不足则丢弃并计数 `cooled` | `service.ts` |
| `delivery.circuitBreakerFailures` | 连续多少次**投递彻底失败**（重试已耗尽）后熔断该渠道；30s 后放行一次探测（半开）。`0` = 关闭熔断 | `providers/decorators.ts` |

两个 0 是合法值（测试与「每次运行都要提醒」的用户需要它）。`/notify status` 会展示这三个数字与计数；
`/notify test` 的自检通知**绕过**静默时段/合并/冷却（但不绕过去重、总开关与等级门槛）。

**静默时段落地语义（M3-1）**：

- 默认 `{ enabled: false, start: "23:00", end: "08:00", exceptLevels: ["error"] }`；降级配置保持静默关闭。
- 时间严格校验为两位 `HH:MM`（`00:00`–`23:59`）；等级数组校验并去重，允许空数组。
- 使用 service 注入的 `now()`，按本地时间判断 `[start,end)`；`start > end` 跨午夜，`start === end` 表示全天。
- 顺序：总开关/等级门槛 → 去重 → 静默时段 → 合并/冷却 → 入队；静默不推进窗口，记录 `quiet_hours_drop`。
  已入队/在途通知不会因进入静默时段而被撤回。
- `/notify status` 展示当前时段是否生效；自检绕过静默并提示真实通知受静默影响（等级例外除外）。

### 10.3 配置访问方式

| 方式 | 用途 |
|---|---|
| 直接编辑 JSON | 主要方式（与现有插件一致） |
| `/notify status` / `/notify test` | 状态展示（含静默时段）/ 自检投递（绕过静默时段、合并与冷却） |
| `/notify on` / `/notify off` | 原子保存用户级总开关，成功后重新应用配置 |
| `/notify config` | 仅 `ctx.mode === "tui"` 开规则向导：select 规则 → confirm 开关 → select 等级 → 最终确认保存；非 TUI 只显示文件路径与当前值（隐藏渠道 options） |
| `/notify reload` | 重新读盘并校验、刷新渠道缓存；不触发扩展重载，不重建生命周期 |
| `pi.registerFlag("no-notify")` / `getFlag` | 会话级静默，不改配置文件 |
| 环境变量 | 仅用于 secret 引用与调试覆盖（如 `PI_NOTIFY_DISABLE=1`） |

**写盘已实现（M3-2）**：`writeUserConfig(agentDir, raw)` 先经 `mergeConfig` 校验，非法即返回 problems，
不把安全降级结果当作有效配置写回。合法时独占创建同目录临时文件（`wx` / `0o600`）→ 写入并关闭 →
`rename` 覆盖；失败返回错误、保留原文件、尽力清理临时文件，命令不更新内存态。
Windows 的 mode 位不代表 ACL 隔离，测试只验证创建/替换不报错。

`on/off/config` 基于用户层读盘，不把项目覆盖或环境静默固化到用户文件；成功后重读并保留既有优先级。
**写盘写的是完整快照**（用户层 + 默认值合并后的全量）：好处是状态完全可预测，代价是**钉住当时的默认值**
（后续默认值变化不会自动生效）。只想改一个开关又不想固化其余字段时，直接编辑 JSON。
项目显式 `enabled: true` 因此可以覆盖用户级 `/notify off`。向导最终确认前只改副本，取消不写盘；
静默时间、渠道及其它参数继续通过 JSON 编辑。损坏用户文件会被拒绝覆盖，需先修复。

print/json 下新增配置命令通过 **stderr** 回显，保持 stdout 协议干净；RPC 使用 `ui.notify`，不弹规则向导。
`/notify reload` 读到坏配置时沿用安全降级路径，不等同于写盘失败时“内存态不变”。

---

## 11. 关键 TypeScript interface / type 设计

> 以下是**契约设计**，不是实现。

```ts
// ---------- 等级与来源 ----------
export type NotifyLevel = "info" | "warning" | "error";

export type SignalKind =
  | "run_started"
  | "assistant_message"      // 只读捕获 stopReason
  | "tool_finished"          // tool_execution_end
  | "run_settled"            // agent_settled（唯一出口）
  | "compact_failed"
  | "ui_prompt_start"
  | "ui_prompt_end"
  | "session_shutdown";

/** index.ts 产出的最小事实；不含 ctx / SessionManager 引用 */
export interface SignalEvent {
  kind: SignalKind;
  sessionId: string;
  at: number;                       // epoch ms（由注入 clock 提供）
  tool?: { toolCallId: string; toolName: string; isError: boolean };
  assistant?: { stopReason: AssistantStopReason; errorMessage?: string };
  uiPrompt?: { kind: UIPromptKind; title?: string };
  shutdown?: { reason: "quit" | "reload" | "new" | "resume" | "fork" };
}

// ---------- 运行判定结果（lifecycle 的唯一产出） ----------
export type RunStatus = "completed" | "failed" | "aborted" | "unknown";

export interface RunOutcome {
  sessionId: string;
  runId: string;                    // 实例内自增/随机，用于去重键
  status: RunStatus;
  startedAt: number;
  durationMs: number;
  /** 最终 assistant 的 stopReason；无法确定时 undefined */
  stopReason?: AssistantStopReason;
  errorMessage?: string;            // 已脱敏
  toolFailures: Array<{ toolName: string; count: number }>;
  compactFailed?: boolean;
}

// ---------- 规则层 ----------
export interface RunSummary {
  runStatus: RunStatus;
  durationMs: number;
  toolFailures: Array<{ toolName: string; count: number }>;
  costUsd?: number;
  contextPercent?: number;
}

export interface NotificationRequest {
  level: NotifyLevel;
  /** 稳定的规则标识，用于去重/冷却/日志，不用文案做键 */
  kind:
    | "run_completed" | "run_failed" | "run_aborted"
    | "tool_failed" | "compact_failed" | "waiting_for_user";
  title: string;
  body: string;
  /** 允许跨会话合并/冷却的稳定键 */
  dedupeKey: string;
  channels: string[];              // provider id 列表
  /** 元数据仅用于投递与日志，不含原始 prompt/完整回复 */
  meta: {
    sessionId: string;
    runId: string;
    cwd: string;
    durationMs?: number;
    level: NotifyLevel;
  };
}

/** 纯函数，无 IO */
export type RuleEvaluator = (
  input: { event: SignalEvent; summary?: RunSummary },
  config: NotificationConfig,
) => NotificationRequest | null;

// ---------- 服务层 ----------
export interface DeliveryResult {
  providerId: string;
  ok: boolean;
  attempts: number;
  error?: string;                  // 已脱敏
  durationMs: number;
}

export interface NotificationService {
  submit(req: NotificationRequest): void;      // 立即返回（入队）
  flush(timeoutMs: number): Promise<void>;     // 仅 quit 时用，有预算
  dispose(): Promise<void>;                    // 幂等
}

// ---------- Provider 契约（渠道解耦的关键） ----------
export interface Notifier {
  readonly id: string;
  readonly type: string;
  /** 校验自身配置；返回错误字符串表示不可用 */
  validate(options: unknown): string | undefined;
  /** 单次投递；必须尊重 signal，超时由 service 控制 */
  send(req: NotificationRequest, signal: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

export type NotifierFactory = (id: string, options: unknown) => Notifier;

// ---------- 配置 ----------
export interface NotificationConfig {
  version: 1;
  enabled: boolean;
  minLevel: NotifyLevel;
  rules: Record<string, RuleConfig>;
  coalesce: { windowMs: number; toolFailureWindowMs: number; cooldownMs: number };
  quietHours: { enabled: boolean; start: string; end: string; exceptLevels: NotifyLevel[] };
  content: { /* 见 §10.2 */ };
  delivery: { timeoutMs: number; maxRetries: number; concurrency: number; queueLimit: number; circuitBreakerFailures: number };
  providers: ProviderConfig[];
}

// ---------- 生命周期宿主契约（便于测试注入） ----------
export interface LifecycleDeps {
  now(): number;
  emit(req: NotificationRequest): void;   // → service.submit
  newAbortController(): AbortController;
  log(level: NotifyLevel, message: string): void;
}
```

`AssistantStopReason` 直接复用 Pi 的联合类型：`"pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"`（`O/docs/session-format.md`）。

> **落地差异（S4/S6/S7/M3）**：本节是设计草稿；实际契约以 `src/types.ts` 为唯一来源，相对本节新增了：
> `UIPromptKind` / `ToolFailureMode` / `ToolFailureEvent`、`SignalEvent` 扩到 8 种 kind
> （`tool_finished` / `compact_failed` / `ui_prompt_start` / `ui_prompt_end`）、
> `NotificationRequest.coalesceWindowMs`（逐条下达合并窗口，工具失败 immediate 模式用）、
> `NotificationService.submit(req, { bypassFilters })`、`isQuietHours()`（M3，共用注入时钟）、快照新增 `coalesced` / `cooled`，
> 以及 `rules` 下新增 `toolFailed`（含 `mode`/`threshold`）/ `compactFailed` / `waitingForUser`（含 `kinds`）三条。
> 内置默认值以 `src/config.ts` 与插件 README 为准；§10.2 已区分草稿示例与实际语义。

---

## 12. 事件触发与通知判定流程

### 12.1 `agent_settled` 是唯一出口

```
agent_settled 触发
  ├─ 1. 实例/会话有效性检查
  │     · 本实例仍绑定当前 sessionId？ 否 → 丢弃（防旧实例误报）
  │
  ├─ 2. 取判定输入（不读完整回复）
  │     · stopReason  ← message_end 阶段捕获
  │     · ctx.isIdle()  ← 官方语义："除非另一扩展启动了新 run"
  │     · durationMs   ← now() - startedAt
  │     · toolFailures ← 本 run 累积
  │
  ├─ 3. 分类
  │     ├─ stopReason === "error"        → failed
  │     ├─ stopReason === "aborted"      → aborted（默认不通知：用户就在终端旁）
  │     ├─ stopReason === "length"       → completed + 截断提示（等级 warning）
  │     ├─ 无 assistant / 无法判定        → unknown（默认不通知，仅 debug 日志）
  │     └─ 其他（stop/undefined）         → completed
  │
  ├─ 4. 规则求值（rules.ts 纯函数）
  │     · 合并本 run 的工具失败为一条（不逐条）
  │     · 若 failed/aborted，取消"run_completed"候选
  │
  ├─ 5. 门槛与过滤（service）
  │     · enabled / minLevel / 非空渠道 → 去重 → quietHours → 合并窗口 → cooldown
  │
  ├─ 6. 入队 → 异步投递（**不 await**）
  └─ 7. 清空 run 累积器
```

### 12.2 为什么不能只靠 `agent_end`

```
用户提问 → agent_start → turn... → agent_end(stopReason=error)
                                        │  Pi 自动重试
                                        ▼
                                    agent_start → ... → agent_end(stopReason=stop)
                                        │  压缩溢出恢复
                                        ▼
                                    session_before_compact → compact → 继续
                                        │  排队 follow-up 续跑
                                        ▼
                                  agent_settled   ← 只有这里才是"真的结束"
```

若监听从 `agent_end` 发通知：一次重试失败的用户会收到 **2~3 条**通知，第一次还是假的。
若只监听 `agent_settled` 而不看 `stopReason`：**Esc 取消也会**报"已完成"。

### 12.3 工具失败：为何聚合而非逐条

并行工具模式下一次 turn 可能同时失败 5 个工具（`tool_execution_end` 按完成顺序乱序发出）。逐条通知 = 刷屏。策略：

- 默认 `mode: "aggregate"`：累积到 `toolFailureWindowMs`（默认 10s）或 `agent_settled`，合成一条 `N 个工具失败: read, bash`。
- 若某工具失败可能长时间无人管（例如长任务中途），可配 `mode: "immediate"` + `threshold`。
- 去重键 = `sessionId + toolName`，同 run 内相同工具失败只计一次计数。

**落地后的真实行为（S6）**：

- `aggregate`：**不单独发一条**——失败工具名已并入本次运行的结果通知正文（`content.includeToolFailureNames`）；
  只有本 run **没有结果通知**时（`runCompleted` 被关、`run_aborted`/`unknown` 不通知）才单独发 `tool_failed`。
  这就是“一次运行最多一条通知”的实现方式（`rules.evaluateSettlement` 取第一个非空候选）。
- `immediate`：某工具失败计数达到 `threshold` 时**立即**发一条，文案用**本 run 至今的完整汇总**
  （不只刚失败的那个工具）；去重键含 `toolName`（每个工具只提醒一次），
  并行失败再由 `toolFailureWindowMs` 合并成一条（同时会把该 run 后续的结果通知一起吸收，这是有意的）。

### 12.4 等待用户输入

```
ui_prompt_start(kind ≠ custom)  → 记 waiting=true，发"等待你选择：<title>"
ui_prompt_end                    → 记 waiting=false
agent_settled + ctx.isIdle()     → 发"轮到你输入"（默认策略）
```

默认 `waitingForUser.enabled = false`，因为它与 `run_completed` 高度重叠；开启后需排除 `kind: "custom"`。

**落地后的真实行为（S6）**：

- 通知只在 `ui_prompt_start` 那一刻发（不需要等到 `agent_settled`，且 RPC/print 下也能触发）。
- `custom` **永久排除**：配置校验时就会从 `kinds` 里剔除并告警，`rules` 里还有一道硬检查（双保险）。
- 不依赖 `start.kind === end.kind` 配对（实测嵌套 prompt 不发内层 span，`end.kind` 报的是外层）：
  只做「非 custom 的 start +1 / end −1」深度计数；`session_shutdown` 兜底复位（强杀时收不到 `end`）。
- `custom` 也不参与深度计数——它不代表用户在输入（TUI 加载器就是 `custom`），否则状态会一直显示“正在等你输入”。
- `session_compact_failed` 不走 settled 出口：它在**当下**投递（手工 `/compact` 没有 run 可 settle），
  `aborted === true`（用户自己取消）不发。这与 §12.1 把 compact 失败当作 settled 输入的写法不同，是 S6 的修订。

---

## 13. 错误处理与边界情况

| # | 场景 | 处理 | 依据 |
|---|---|---|---|
| 1 | Provider 网络失败 | 有界重试（默认 1 次，指数退避）→ 记脱敏日志 → 连续 N 次失败熔断该 provider | 【设计】 |
| 2 | Provider 挂起 | `AbortSignal.timeout(delivery.timeoutMs)`；超时算失败 | 【设计】 |
| 3 | 通知卡住 agent | **不可能**：Hook 内只入队；投递在独立任务 | 【设计】 |
| 4 | 队列溢出 | 丢弃最低等级的最新项并计数（不无限增长） | 【设计】 |
| 5 | 配置损坏/非法 | 读盘降级为“仅 run_failed + 终端 + error 门槛 + 静默关闭”，留下原因，**不静默全关**；非法写入则拒绝保存、内存不变 | 借鉴 I；M3 已落地 |
| 6 | 配置目录不可写 | 命令报错，不改内存态；临时文件尽力清理 | 【设计】M3 已落地（J7/J8） |
| 7 | 项目级配置被恶意利用 | 项目配置**不得**定义 secret/URL；仅在 `isProjectTrusted()` 为真时读 | 【官方】`ctx.isProjectTrusted()` |
| 8 | 换会话/重载时旧实例在途请求 | `session_shutdown` 中 `abort()`；投递前校验 sessionId | 【官方】旧 ctx throw |
| 9 | 重复通知 | `dedupeKey` + 冷却窗口；`agent_settled` 每次 runId 唯一 | 【设计】 |
| 10 | Esc 取消 | `stopReason === "aborted"` → 默认静默 | 【官方】`stopReason` 取值 |
| 11 | 扩展自身异常 | 绝不向 Hook 外抛；内部 try/catch；宁可少发通知也不阻断 Pi | 【官方】runner try/catch；`tool_call` 抛错会阻断 |
| 12 | 非 TUI 模式（print/json） | UI 不弹对话框，仍可走外部 provider；新增配置命令经 stderr 回显，不污染 stdout；RPC 也不启动规则向导 | 【官方】Mode Behavior；M3 模式守卫 |
| 13 | 终端转义注入 | 所有标题/正文剥离控制字符（OSC 序列、`\x1b`、`\n` 归一）后再拼 OSC 777/99 | 【官方】`examples/extensions/notify.ts` 直接内插字符串，**存在注入面** |
| 14 | Windows toast | 需 `WT_SESSION` 判定；命令行参数需转义，避免 PowerShell 注入 | 同上示例的 `windowsToastScript` 直接拼字符串 |
| 15 | 消息过长 | `maxMessageChars` 截断；不发送完整 diff/文件内容 | 【设计】 |
| 16 | 隐私 | 默认不发 prompt 摘录、不发完整回复；secret 只从环境变量读 | 【设计】 |
| 17 | `message_end` 被用于判定是否越界 | 只读，**不返回**任何值 | 【官方】返回即进入替换链 |
| 18 | 通知与"用户正在看终端" | **无法检测终端焦点**（无 API）→ 只能靠配置让用户自选静默策略 | 【待验证】 |
| 19 | 子 Agent / 后台任务 | 子 Pi 会话是**独立 session**，父实例的 `agent_settled` **不覆盖** | 【待验证】见 §16 |
| 20 | 纯 `/command` 业务任务 | 扩展命令在 `input` 之前分发并直接返回，**不进入 agent 生命周期 → 无 `agent_settled`** | 【官方】`agent-session.js:937-958`；【实测】S0-A U1 证实 |
| 21 | **`agent_settled` handler 会阻塞 Pi** | 必须只入队后立即返回，禁止在 settled 内 await 网络 | 【实测】S0-B U-E3-4：await 2000ms → 下一次 run 启动推迟 2027ms、进程退出推迟约 2020ms |
| 22 | **`session_shutdown` 会阻塞退出且 handler 串行** | 收尾投递必须带短超时；失败即放弃 | 【实测】S0-A U6/U7/U8 |
| 23 | **Git Bash 会把 `/命令` 改写成 Windows 路径** | 命令静默失效并退化成 LLM 提示词（费钱且得到错误结论） | 【实测】S0-A U0：必须 `MSYS_NO_PATHCONV=1` |
| 24 | **`input` 返回 `handled` 会短路其它扩展** | 通知插件绝不无条件返回 `handled` | 【实测】S0-A U11（与「快照语义」是两个不同机制，不可混同） |
| 25 | **`pi.events` 是全局字符串命名空间，可被任意扩展伪造** | 若用它接收子任务完成，必须做来源与 sessionId 防御 | 【官方】`event-bus.js`；【实测】S0-C E2-c |

**原“最大风险条目”#19 与 #20 已实测**，结论见 §18：它们不是“需要验证的不确定点”，而是**已确认的覆盖范围硬边界**。

---

## 14. 与 Pi Extension API 的对应关系

| 我们的模块/能力 | Pi 官方机制 | 性质 |
|---|---|---|
| 插件入口 `extensions/index.ts` | 默认导出工厂 + `pi.extensions` manifest + jiti 加载 | 官方 |
| 生命周期监听 | `pi.on(...)`（11 个事件），返回 unsubscribe | 官方 |
| 配置读取（用户级） | `getAgentDir()`、`CONFIG_DIR_NAME` | 官方 |
| 配置读取（项目级） | `ctx.isProjectTrusted()` 守卫 | 官方 |
| 会话/运行状态判定 | `AgentSettledEvent`、`ToolExecutionEndEvent`、`MessageEndEvent`、`SessionCompactFailedEvent`、`SessionShutdownEvent` | 官方 |
| 会话标识 | `ctx.sessionManager.getSessionId()` | 官方 |
| 在途取消 | `ctx.signal`（turn 内）/ 自建 AbortController（跨 Hook） | 官方 + 设计 |
| 命令 | `pi.registerCommand` | 官方 |
| CLI 开关 | `pi.registerFlag` / `pi.getFlag` | 官方 |
| 持久化（可选） | `pi.appendEntry` + `registerEntryRenderer` | 官方 |
| 状态行 | `ctx.ui.setStatus` | 官方 |
| 配置向导 | 当前使用 `ctx.ui.select/confirm`，`ctx.mode === "tui"` 守卫；未使用 `custom` / `SettingsList` | 官方 API + M3 实现 |
| 本地回显 | `ctx.ui.notify`（**不等于外部投递成功**） | 官方 |
| 渠道扩展入口（可选） | `pi.events.on/emit`（同进程） | 官方 |
| **通知投递本身** | **Pi 无此能力** | **我们自建（Provider 层）** |
| **DB/outbox/重试基础设施** | **Pi 无此能力** | **我们自建（service 层，MVP 可极简）** |

**判断结论**：

- **通过 Hook 实现**：所有生命周期感知与完成/失败判定。
- **通过 Registry 实现**：Provider 注册表（`NotifierFactory` 映射）——这是**我们自己的** registry，Pi 没有通用 registry API（`registerProvider` 是模型服务商，不可复用）。
- **属于 Runtime Control**：`ctx.isIdle()`、`ctx.hasPendingMessages()`、`ctx.shutdown()`、`ctx.waitForIdle()`——**只读/不自用**，通知插件不控制 Pi 运行。
- **Event Bus 是否真需要**：**不需要**。核心是"Pi 事件 → 我的判定 → 投递"，没有跨扩展协作需求。仅当未来允许其它扩展"请本插件发通知"时，才加一条 `pi.events` 入站通道，且不参与核心链路。

---

## 15. 实现步骤（按开发顺序）

> **状态（M3-1/M3-2 落地后）**：表中 ✅ 表示阶段开发完成，并有列出的回归证据；不代表所有平台或交互路径都已人工验证。
> 最近一次 `MSYS_NO_PATHCONV=1 npm test`：五套 **105 项全绿**。
> M3-3 真终端人工验收**已通过**；M4 只建议下次真实运行时顺带看一眼正文口味（见 §19.6）。

| 阶段 | 内容 | 完成判据 | 状态 |
|---|---|---|---|
| **S0 前置验证** | 完成 §16 的 6 项 API 实测（尤其纯命令是否无 settled、子会话是否无 settled） | 6 项都有结论，写进 README | ✅ 见 §18 |
| **S1 骨架** | `package.json` + `extensions/index.ts` + `src/types.ts`；注册 `session_start`/`session_shutdown`，只打日志 | `pi -e` 加载成功；`/reload` 无重复注册；退出无报错 | ✅ |
| **S1.5 回归脚本**（§18.7 插入） | 把 S0 的可复现配方固化成宿主级断言（带 `MSYS_NO_PATHCONV=1`） | 纯命令无 settled、settled 内不阻塞（含阻塞对照组）、reload 不重复投递 | ✅ `test/host-lifecycle.mjs` |
| **S2 判定核心** | `src/lifecycle.ts` + `rules.ts`（纯函数）；`run_completed` / `run_failed` / `run_aborted` | 覆盖 7 种 stopReason + 无 assistant 情况 | ✅ 断言 A–F（宿主级，未单独建单测） |
| **S3 终端渠道** | `src/providers/terminal.ts`（OSC 777 / OSC 99 / Windows toast）+ 控制字符清洗 + 平台探测 + TTY 纪律 | 注入字符串测试通过；本机 toast 人工确认 | ✅ `test/terminal-channel.mjs` |
| **S4 服务层** | `src/service.ts`：队列、去重、**合并窗口**、冷却、静默时段（M3）、超时、dispose | fake clock + fake notifier：重复事件只发 1 条；静默边界/例外/自检绕过 | ✅ `test/service-coalesce.mjs`（22 项）+ 断言 L0–L2（熔断/重试在 `decorators.ts`，属 S7） |
| **S5 配置** | `config.ts`：schema v1、校验、降级、quietHours、用户级原子写盘；`commands.ts` 六个子命令；`ui.ts` 最小规则向导 | 非法写入/IO 失败保留原文件与内存；on/off 持久化；热读不重载扩展；向导取消不保存、非 TUI 不弹框 | ✅ M3-1/M3-2 完成；I1–I11 / J1–J14、服务静默测试、CLI M/N；真实 TUI 体验仍待 M3-3 |
| **S6 工具失败与压缩失败** | `tool_execution_end` 聚合 + `session_compact_failed` + `ui_prompt_start/end`（修订 1） | 并行多工具失败只产生 1 条通知；`custom` 不误报 | ✅ 断言 K1–K6 |
| **S7 外部渠道** | `src/providers/webhook.ts` + `src/providers/decorators.ts`（首个非终端渠道） | 本地 echo 服务验证 payload、超时、密钥来自 env | ✅ `test/webhook-channel.mjs` + 断言 M1–M3（回环 HTTP 服务即“本地 echo 服务”） |
| **S8 生命周期加固** | 会话替换/重载/退出场景；旧实例丢弃；quit 尽力 flush | 连续 `/reload` 不叠加、换会话不误报 | ✅ 断言 D / E / K6 |
| **S9 文档与默认值** | README：安装、隐私、模式降级、覆盖范围限制 | 明写“不覆盖子会话 / 不覆盖纯命令任务” | ✅ 插件 README |
| **M4 正文内容字段**（§19，后续里程碑） | 会话名 / 成本（本次+累计） / 上下文占比 / assistant 摘录；删除 no-op 的 `includePromptExcerpt` | 会话名与成本进正文、摘录默认关且 10 字截断/先清洗、拿不到就不写 | ✅ 断言 R1–R5 |

顺序理由：先钉死判定正确性（S2），再谈渠道（S3/S7）；可靠性（S4）在配置（S5）之前，因为配置要靠 service 生效。

**M3/M4 自动化验收**：M3 新增 24 项，M4 新增 5 项（R1–R5），总计 **105 项**，
均已在原 76 项语义不变的前提下全绿。
宿主断言 **M3** 是 §17.3 渠道解耦反回退的名称（不是里程碑编号），仍全绿；未注册 `agent_end`。

**已开发但待人工确认**：M3-3（通知显示 / 等待提醒 / TUI 排版 / 向导按键）已由维护者执行并**通过**；
M4 的内容字段只建议在下一次真实运行时顺带看一眼（见 §19 末尾）。SDK UI 桩不等同于肉眼验收。

**可选未开发项（不在 M3/M4 范围）**：通知历史与状态行（`pi.appendEntry`+`registerEntryRenderer`、`ctx.ui.setStatus`）、
macOS 原生横幅（`osascript`）、Telegram/Discord/Slack 专用渠道、
累计成本的跨实例口径（当前为实例内存累计，`/reload` 后归零）。
子任务通知是 §18.5 修订 4 裁定不做的覆盖边界，不是遗留开发项。

**已交付的内容字段（M4）**：会话名 / 成本（本次+累计） / 上下文占比 / assistant 摘录。
语义、边界与断言映射见 **§19**；原先“接受但不生效”的 `content.includePromptExcerpt` 已随 M4 删除。

---

## 16. API 不确定性（编码前必须验证）

> **更新（v1.2）**：本节 6 项已在 S0 轮次全部实测完毕，逐项判定与由此产生的设计修订见 **§18**。本表保留为原始问题清单。

| # | 不确定点 | 影响 | 验证方法 |
|---|---|---|---|
| 1 | **纯 `/command` 业务任务不产生 `agent_settled`**（官方分发路径如此，但需实测确认） | 决定"我能否通知图片/视频生成完成" | 跑一个只注册命令的扩展 + 一个命令任务，观察是否收到 settled |
| 2 | **子 Agent 会话的完成是否在本进程产生任何父侧 Hook** | 决定"能否通知子任务完成" | 启动一个 subagent，在父扩展里打点所有 Hook |
| 3 | `agent_settled` 时 `ctx.isIdle()` 是否**恒为真**（另一扩展启动新 run 时应为假） | 决定 idle 判定能否作为完成条件 | 两个扩展交互测试 |
| 4 | `ui_prompt_start` 在 RPC 模式、以及宿主内置弹窗下是否触发 | 决定 `waitingForUser` 规则的价值 | `--mode rpc` + 客户端模拟 |
| 5 | `session_shutdown` 内能否在进程退出前完成异步 flush | 决定 quit 时通知是否可能丢 | `quit` 时故意延迟发送并观察 |
| 6 | 多扩展监听同一 Hook 的顺序是否严格等于加载顺序（源码显示如此，但要确认 CLI/项目/包三来源的合并顺序） | 影响去重键与"谁先看到" | 注册多个扩展打点顺序 |

补充不确定点（非阻塞，但要写进 README）：

- 终端是否真的展示 OSC 通知取决于终端模拟器，无法由 Pi 保证。
- `tool_execution_end` 在"被 `tool_call` block 的工具"上是否发出（被阻断的工具可能无 end 事件）——需实测，否则会漏报。
- 静默时段的时区已在 M3 明确：使用注入时钟对应的本地时间，边界语义见 §10.2；不再是未决项。
- 真实 provider 的 `usage.cost.total` 形态（是否都提供、是否含缓存读写、与 Pi `/session` 统计是否一致）**未验证**；
  插件因此采取“拿不到就不写”，见 §19。

---

# 最小可行版本 MVP

**目标**：在本机 TUI 下，Agent 真正结束时发出一次可靠的系统通知，并能一键关闭。

| 组成 | 内容 |
|---|---|
| 模块（4 个） | `extensions/index.ts`、`src/lifecycle.ts`、`src/rules.ts`、`src/providers/terminal.ts`（+ `types.ts`） |
| Hook（4 个） | `session_start`、`message_end`（只读取 stopReason）、`agent_settled`（唯一出口）、`session_shutdown`（清 timer/abort） |
| 命令（1 个） | `/notify status`（显示开关、等级、上次通知时间、错误） |
| 配置 | 只需 `~/.pi/agent/pi-notification/config.json` 的 `{ enabled, minLevel }`（缺失即用默认：启用、info） |
| 通知规则 | `completed` → info；`failed` → error；`aborted` → 静默 |
| 去重 | 单条 `dedupeKey = sessionId + runId`，进程内存 Set |
| 渠道 | 仅终端：OSC 777 / OSC 99 / Windows toast（保留控制字符清洗） |
| 明确不做（MVP 当时的范围） | Webhook、Telegram 等任何外部渠道；配置向导；UI 历史；工具失败通知；压缩失败通知；Event Bus；持久化；重试/熔断 |
| **覆盖范围（重要）** | **MVP 只覆盖 agent 生命周期型任务**。纯 `/command` 型业务任务（如图片/视频生成）**不在覆盖范围**——0.86.1 不存在任何可观测的「命令结束」时刻（§18 实测）。此限制**必须写进 README**，不得含糊 |

**MVP 也必须做对的五件事**（否则等于错）：

1. 用 `agent_settled` 而不是 `agent_end`（实测：一次 provider 失败产生 **4 条 `agent_end`**、仅 1 条 `agent_settled`）。
2. 用 `stopReason` 区分 completed / failed / aborted（实测三类取值均可读）。
3. **`agent_settled` handler 内只入队后立即返回**，绝不 await 网络（实测：handler 会阻塞下一次 run 与进程退出）。
4. `session_shutdown` 里清理，且旧实例不得再发通知（实测：reload 会重建实例）。
5. 终端输出前清洗控制字符（官方示例存在注入面）。

**MVP 预计规模**：约 300–400 行 TS（含类型），无第三方依赖。

> **状态更新（M3-1/M3-2 落地后）**：本节是**设计当时的范围切分**，不是当前能力表。
> Webhook、工具失败/压缩失败通知、重试/熔断已在 S4/S6/S7 实现；静默时段、配置写盘/向导已在 M3 实现。
> 当前未开发项与覆盖边界见 §15 末尾；M3-3 真终端人工验收仍未完成。
> 历史规模（S7 时统计）：实现 3349 行 + 测试 2718 行，不代表 M3 后当前行数。

---

# 后续可扩展方向

**扩展方式**：只需新增 `src/providers/<name>.ts` 实现 `Notifier`（`validate` / `send` / `dispose`），并在配置的 `providers[]` 里加一条；**不改动任何 lifecycle / rules 代码**。

| Provider | 关键点 | 备注 |
|---|---|---|
| **系统桌面通知** | 已由 `terminal.ts` 覆盖（OSC 777/99、Windows toast）。macOS 若要原生横幅可加 `osascript`，但优先级低于终端方案 | 让"终端内"成为默认，无需额外依赖 |
| **Webhook** | 通用 HTTP POST（`fetch` + `AbortSignal.timeout`）；HMAC 签名；secret 只从 env；payload 为 `NotificationRequest` 子集 | 应作为**第二个** provider，因为它是其它渠道的通用底座 |
| **Telegram** | Bot API `sendMessage`；`chatId` + token（env）；需注意消息长度与速率限制 | 典型的 `Notifier` 实现，验证接口是否够用 |
| **Discord** | Webhook URL 或 Bot；embed 需要结构化字段 → 可能需要 `Notifier.format()` 可选钩子 | 用于检验接口是否需要"渠道特定格式化"扩展点 |
| **Slack** | Incoming Webhook / chat.postMessage；Block Kit | 同上 |

**建议的接口演进**（只有当 Discord/Slack 真的需要时再加，避免提前设计）：

```ts
export interface Notifier {
  readonly id: string;
  readonly type: string;
  validate(options: unknown): string | undefined;
  /** 可选：渠道特定格式化；缺省则用通用 title/body */
  format?(req: NotificationRequest): unknown;
  send(req: NotificationRequest, signal: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}
```

**未来若需要更可靠投递**（明确不在 MVP）：

- 持久 outbox（**重新设计**跨进程锁、幂等键、敏感内容、过期清理；**不要**直接复制 V 的 `.tasks.json`）。
- 分级升级（warning 先终端，error 同时外部）。
- 通知历史（`pi.appendEntry` + `registerEntryRenderer`，TUI 内可查）。
- 跨扩展入站（`pi.events.on("pi-notification:emit", ...)`），并明确它是**同进程尽力投递**，不是可靠通道。

---

## 17. 渠道抽象设计与落地顺序（v1.1 追加）

> 用户补充要求：先把**系统桌面通知**做完，再做 **Webhook**；且消息通道必须抽象成**接口**，用设计模式隔离，避免与具体渠道耦合。
> 本节取代 §7/§11 中关于 provider 的具体描述，其余章节不变。

### 17.1 落地顺序（先桌面，后 Webhook）

| 阶段 | 渠道 | 理由 | 依赖 |
|---|---|---|---|
| **P1** | **系统桌面通知**（`terminal.ts`） | 零凭据、零网络、零第三方依赖；验证「判定是否正确」所需的反馈闭环最短 | 无 |
| **P2** | **Webhook**（`webhook.ts`） | 它是 Telegram/Discord/Slack 的**通用底座**（都能用 HTTP POST 表达）；先做它可反过来检验接口设计是否够用 | 仅 Node 内置 `fetch` |
| P3+ | Telegram / Discord / Slack | 真正验证「接口是否可扩展到异构协议」 | 视需要 |

**关键判断**：桌面通知**不是**「一个 provider 的特例」，而是「进程内无依赖渠道」这一类；Webhook 是「需要凭据与网络的外部渠道」这一类。两类都落在同一个 `Notifier` 接口下，说明抽象是成功的。

### 17.2 设计模式映射

| 模式 | 在本插件中的形态 | 解决的问题 |
|---|---|---|
| **Strategy（策略）** | `Notifier` 接口 + 每个渠道一个实现 | 投递算法可替换，核心不感知渠道 |
| **Factory Method + Registry（工厂 + 注册表）** | `registry.ts`：`type -> NotifierFactory` 映射，`createNotifier(type, options)` 分派 | 避免 `switch(channel)` 散落在 `service`/`rules`；新增渠道不改分派逻辑 |
| **Adapter（适配器）** | 每个渠道内部把自身协议（ANSI 转义序列 / HTTP JSON）适配为 `send(req)` | 隔离协议细节，`NotificationRequest` 是唯一跨层契约 |
| **Decorator（装饰器）** | `decorators.ts`：`withTimeout` / `withRetry` / `withCircuitBreaker` / `withRedaction`，包裹任意 `Notifier` | 把「可靠性关注点」从渠道实现里剥离，渠道只管「发一次」 |
| **Null Object** | `noop.ts` | 禁用/配置非法渠道返回空实现，消灭调用点的 `if` |
| **Template Method（可选，仅当渠道变多再引入）** | `BaseNotifier` 骨架：`validate` → 日志 → `deliver()` 抽象钩子 | 避免每个渠道重复写校验/日志/脱敏。**MVP 不引入**（只有 2 个渠道时不值得） |
| **Observer** | `service` 对 `Notifier[]` 广播投递 | 多渠道并行，互不阻塞 |

**刻意不引入的模式**（避免为架构而架构）：不使用 Chain of Responsibility（渠道之间不需要串联降级）、不使用 Abstract Factory（不存在产品族）、不使用事件总线做渠道通信（§1.7 已说明）。

### 17.3 依赖方向（防耦合的硬性规则）

```
lifecycle ──┐
rules ──────┴──► NotificationRequest ──► service ──► Notifier[]（providers）
                                              │
                                        decorators 包裹
```

必须遵守：

1. `lifecycle` / `rules` **不得 import 任何 `providers/*`**（编译期可验证）。
2. `rules` 里**不得出现渠道名**；它只产出 `level` + `channels`（白名单）与 `NotificationRequest`，路由由 `service` 完成。
3. `providers/*` **不得 import** `lifecycle` / `rules` / `config`（只接收 `options` 与 `NotificationRequest`）。
4. `NotificationRequest` 是唯一跨层契约；渠道若需要不同形状，用可选 `format?(req)`，**不得**把渠道分支写回 `rules`。
5. 所有可靠性关注点（超时/重试/熔断/脱敏）在 `decorators` 里实现一次，渠道实现保持「只负责一次投递」。

**验收这条抽象是否真的成立**：新增一个渠道，改动应仅限于「新增 1 个文件 + `registry.ts` 注册 1 行 + 配置加 1 条」，`lifecycle.ts` / `rules.ts` / `service.ts` 的 diff 必须为 0。

> **S7 实测结果（Webhook）**：成立。`lifecycle.ts` / `rules.ts` 一个字未改，`service.ts` 的改动来自同期的 S4（合并窗口/冷却），
> 与渠道无关；新增文件只有 `providers/webhook.ts`、`providers/decorators.ts` 与对应的回归脚本。
> 这条验收已固化为可执行断言：`test/host-lifecycle.mjs` 的 **M3** 会读源码，
> 一旦 `lifecycle.ts` / `rules.ts` 出现渠道名或 `providers/*` import、`service.ts` 出现 `webhook`，测试即失败。

### 17.4 渠道接口（最终版）

```ts
/** 策略接口：渠道只实现“发一次” */
export interface Notifier {
  readonly id: string;      // 配置中的实例 id，如 "desktop"
  readonly type: string;    // 渠道类型，如 "terminal" | "webhook"

  /** 校验自身配置；返回错误字符串表示不可用。不得抛异常。 */
  validate(options: unknown): string | undefined;

  /** 可选：渠道特定格式化；缺省走通用 title/body。 */
  format?(req: NotificationRequest): unknown;

  /** 单次投递。必须尊重 signal，不自行重试（重试由 decorator 负责）。 */
  send(req: NotificationRequest, signal: AbortSignal): Promise<void>;

  /** 幂等释放。不得依赖 Pi 的 ctx。 */
  dispose(): Promise<void>;
}

/** 工厂签名（注册表的值） */
export type NotifierFactory = (id: string, options: unknown) => Notifier;

/** 注册表（唯一的分派点） */
export interface NotifierRegistry {
  register(type: string, factory: NotifierFactory): void;
  create(id: string, type: string, options: unknown): Notifier; // 未注册 -> NoopNotifier + 警告
}
```

阶段 1（系统桌面）与阶段 2（Webhook）的差异被压到最小：

| | `terminal.ts` | `webhook.ts` |
|---|---|---|
| `validate` | 探测终端能力（`WT_SESSION` / `KITTY_WINDOW_ID` / 默认 OSC 777）；不可用返回错误 | 校验 URL 合法（http/https、不得内嵌凭据、不得含换行）+ **若配了 `secretEnv` 则要求该环境变量存在**（只存变量名） |
| `send` | `process.stdout.write` OSC 序列 / PowerShell toast，**先清洗控制字符** | `fetch(url, {signal, headers, body, redirect: "error"})`，HMAC 签名 |
| `format` | 不需要（用 title/body） | 结构化 payload；`send()` 内部复用同一个 `format`，**payload 形状只有一处定义** |
| 失败模式 | 写 stdout 失败、终端不支持、Windows 转义 | 网络错误、非 2xx（错误信息带状态码 + **脱敏后**的响应体片段）、超时 |

两者都不需要知道「为什么发这条通知」——这正是解耦要达成的效果。

#### 17.4.1 落地记录（S7 实现后的真实语义）

接口本身未变，以下是实现时补上的细节（都是**刻意**的，不是遗漏）：

1. **`secretEnv` 是可选的**：不配就发送但不签名（`signed=false` 记入日志）；配了但环境变量不存在则
   `validate` 返回错误 → `registry` 降级为 Noop（**不会静默发到错地方**）。密钥从不进日志/载荷。
2. **不跟随重定向**（`redirect: "error"`）：否则签名与载荷可能被带到另一个主机（重定向后的 host 不可控）。
3. **日志丢弃 URL query**（只记 `origin + pathname`）：query 常被用来传 token。
4. **响应体片段先 `sanitizeError()`（清洗 + 脱敏）再入日志/错误消息**：真实端点常在错误响应里回显凭据。
   这条是回归断言发现的真实缺陷（初版只做了 `sanitize()`）。
5. **签名对象是“实际发送的字节”**：接收方用同一 secret 对原始 body 重算 HMAC 即可验证。
6. **装饰器组合顺序：`redaction(circuit(retry(timeout(inner))))`**，理由：
   - 熔断在**重试之外** → “一次投递彻底失败”只计一次失败，而不是每次尝试都计；
   - 脱敏在最外层 → 任何异常文本出 provider 层之前已被处理；
   - **每次尝试有自己的 deadline**（`attemptTimeoutMs`），否则第一次尝试吃光外层
     `delivery.timeoutMs` 后，重试会在已 abort 的 signal 上立刻失败（等于没有重试）。
     组装点按 `max(250, timeoutMs / (maxRetries+1))` 派生单次预算。
7. **超时由两处共同保证**：外层 `service` 用 `AbortSignal.timeout(delivery.timeoutMs)` 管总量，
   `withTimeout` 管单次尝试。内层即使“吃掉” abort 并正常返回，也会被判为超时失败。
8. `Notifier.format?()` 目前**不被 `service` 调用**（`send` 收到的是原始 `NotificationRequest`）；
   它的用途是「渠道特定形状有一个官方归属」，webhook 在自己的 `send` 里复用同一个函数。
9. 本地渠道同样被可靠性装饰器包住（同一套机制只实现一次）；终端渠道实际几乎不会触发重试，
   但这保证了新增渠道不需要自己写重试/熔断。

### 17.5 与 MVP 的关系

MVP 的渠道范围**收紧并明确**为：

- **MVP = 阶段 1（系统桌面通知）**，单渠道、无装饰器（但保留 `Notifier` 接口与 `registry`，以便阶段 2 零改动接入）。
- 超时/重试/熔断在 MVP 只做**最简形态**：`Promise.race` + 8s 超时 + 失败日志。
- **阶段 2（Webhook）** 是第一个真正的"异构渠道"，也是检验 §17.3 抽象是否成立的第一个测试。

---

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

## 19. 正文内容字段（M4 追加）

> 目标：让一条通知能回答两个问题——“**这是哪个任务**”与“**这事办完没有**”——而**不把用户输入原文送出去**。
> 本节是 §10.2 `content` 块的语义权威；实现分散在 `rules.ts`（拼装与格式化）、`lifecycle.ts`（运行级采集）、
> `extensions/index.ts`（会话名与上下文占比的采集）。

### 19.1 字段与默认值

| 字段 | 默认 | 值来源 | 正文位置 |
|---|---|---|---|
| `includeDuration` | `true` | 既有 | 第 3 段 |
| `includeToolFailureNames` | `true` | 既有 | 第 4 段 |
| `includeSessionLabel` | `true` | 会话名（`session_info_changed.name`，初值 `pi.getSessionName()`）→ 缺失时回退 `basename(ctx.cwd)` | **首段** `[标识]` |
| `includeCost` | `true` | `usage.cost.total` 累计 + `ctx.getContextUsage()` / `ctx.model.contextWindow` | 第 5、6 段 |
| `includeAssistantExcerpt` | `false` | `message_end` 里 assistant 消息的文本片段 | **末段**（真截断时标 `…`） |
| `maxMessageChars` | `300` | 既有 | 整串上限 |

正文按阅读优先级拼接（` · ` 分隔，整串仍受 `maxMessageChars` 限制）：

```
[重构登录] · 用时 42.3s · 但 1 个工具失败: bash · 成本 $0.0123（累计 $0.0456） · 上下文 42% · 已修复登录 bug…
```

### 19.2 五条边界（都是刻意的）

1. **拿不到就不写，不猜数字。** `provider` 不报 `usage`、金额为 0（本地模型/免费额度）、
   拿不到 `contextWindow` 时，对应片段直接不出现；金额四舍五入到 `$0.0000` 也当作没有。
   宁可少写一节，也不要让用户看到“免费”的假象。
2. **累计的口径是“本实例内存”。** 同一会话内跨次运行累加，`/reload` 或换会话后归零。
   不读 `SessionManager`：那会把会话内容搬进只吃纯数据的判定层，与 §17.3 的依赖方向冲突。
   本次与累计四舍五入后相同时只显示一次（避免“累计”重复同一个数字）。
3. **成本与上下文共用 `includeCost` 一个开关**，且占比低于 1% 不显示（“上下文 0%”是噪声）。
4. **摘录默认关闭，且“先清洗再截断”。** 顺序不能反：回复常以换行/缩进开头，
   先截断会把空白截进摘录、清洗后反而变空。长度固定为 `ASSISTANT_EXCERPT_CHARS = 10`
   ——**刻意不做成配置项**：多一个配置项就多一个“设了没效果”的机会，而 10 个字只够当提示。
   真要在真实使用中发现不够，再按“真被读到的需求”加配置，而不是现在猜一个更大的默认值。
5. **首段标识有回退，且截断只在真的截断时动手。**
   - 标识：**会话名优先，未命名时回退项目目录名**。绝大多数人从不 `/name`，没有回退这一栏对他们永远不出现（等于白做）。
     两者都无（如磁盘根目录的 basename 为空）则整段省略；`includeSessionLabel: false` 可整栏关闭。
   - 摘录：超长时去掉被切在末尾的悬空标点并补 `…`；**未超长就原样呈现**，
     不把模型自己写的完整句号改成截断标记（“被我们截了”与“模型本来就写了半句”必须可区分）。

### 19.3 为什么删掉 `includePromptExcerpt`

它被校验但**无一处读取**，属于典型的假开关：用户设了 `true` 却什么也没发生，也不报错。
另外它要求插件读取并外传**用户输入原文**，与“默认不外传 prompt / 完整回复”的立场直接冲突。
两个真实需求分别由 `includeSessionLabel`（展示用元数据 + 项目名回退）与 `includeAssistantExcerpt`（agent 自己的产出）满足。
删除后的兼容性：旧配置里残留该字段**不会**导致降级（它已不是被校验的字段），但也不再有任何效果。

### 19.4 隐私与注入面

- 日志**不记**条目正文、不记会话名、不记 assistant 文本；`session_info_changed` 只记“有没有名字”。
- 摘录进入正文前经 `sanitize()`：**整段删除**转义序列（含载荷），因此模型回复无法伪造通知或夹带新序列。
- 首段标识（会话名或**项目目录名**）会随正文发到所有已配渠道（包括 Webhook）；不想外传就关掉 `includeSessionLabel`。
- `webhook` 渠道的载荷形状未变（仍只有元数据 + title/body），正文里的内容因此也只会随 title/body 上浮。

### 19.5 断言映射

| 断言 | 覆盖 |
|---|---|
| R1 | 新字段默认值与更名、已删字段不复活（且旧配置不因此降级）、新字段类型错仍触发降级 |
| R2 | 未命名时回退项目目录名；`setSessionName` 后会话名优先；`includeSessionLabel: false` 整栏关闭；日志不落会话名 |
| R3 | 摘录默认关闭；开启后 10 字截断 + `…` 标记、恰好 10 字不补标记、悬空标点去除、换行归一、转义序列整段删除（注入面）|
| R4 | 成本本次与跨 run 累计；`includeCost=false` 时成本与占比一起消失 |
| R5 | 上下文占比 42% 显示、<1% 不显示 |

测试旋钮（**仅测试夹具**）：`PROBE_ASSISTANT_TEXT` / `PROBE_COST_USD` / `PROBE_CONTEXT_TOKENS`，
与 `PROBE_DELAY_MS` 同一套做法（每次调用时读 env，用完即清，避免跨 host 泄漏）。

### 19.6 仍未验证（不得当成已解决）

- 真实 provider 的 `usage.cost.total`：是否都提供、是否含缓存读写、与 Pi 自带 `/session` 统计是否一致。
  这是“拿不到就不写”的其中一个原因。
- 多轮（带工具调用）运行时“最后一条非空 assistant 文本”是否总是用户想看的那句（只与假 provider 对过）。
- 内容字段的**视觉口味**（正文长度是否合意）需真终端看一眼：这是 M4 唯一的人工项，
  不必单独一轮，下次真实运行时顺带确认即可。

---

## 附录：本次研究的可验证证据索引

| 结论 | 证据位置 |
|---|---|
| 插件 = 默认导出工厂，可同步/异步 | `O/docs/extensions.md` "Writing an Extension"；`O/dist/core/extensions/types.d.ts:1169` |
| Handler 顺序 / 快照 / try-catch 隔离 | `O/dist/core/extensions/runner.js` `emit()`（约 :650-680） |
| `agent_settled` 语义与 finally 触发 | `O/docs/extensions.md` "agent_start / agent_end / agent_settled"；`O/dist/core/agent-session.js:367-373, 860-879` |
| 扩展侧 `agent_end` 无 `willRetry` | `O/dist/core/agent-session.js:498`（对比 session 事件 :407） |
| 无 session_error / 无 waiting Hook | `O/dist/core/extensions/types.d.ts:912-948`（`on()` 全量重载） |
| `ui_prompt_start` 覆盖 select/confirm/input/editor/custom，且不 await | `O/dist/core/extensions/runner.js:304-340` |
| `tool_result` 修改后的 isError 进入 `tool_execution_end` | `O/dist/core/agent-session.js` `_installAgentToolHooks()` |
| `tool_call` 抛错会阻断工具 | 同上 `beforeToolCall` 的 "Extension failed, blocking execution" |
| 扩展命令先于 `input` 分发并直接返回 | `O/dist/core/agent-session.js:937-958`、`:1062-1085` |
| Session 替换重建实例、旧 ctx 失效 | `O/docs/extensions.md` "Session replacement lifecycle and footguns"；`agent-session.js` `dispose()` invalidate |
| Event Bus 仅同进程、不 await | `O/dist/core/event-bus.js` |
| 无扩展 settings API；用 registerFlag/Command + 自管文件 | `O/dist/core/extensions/types.d.ts:950-1010`；`O/docs/extensions.md` "ExtensionAPI Methods" |
| 官方通知示例在 `agent_settled` 发送（但字符串未清洗、无错误处理） | `O/examples/extensions/notify.ts` |
| 图片/视频插件用 `ctx.ui.custom` 做纯进度加载 | `work/scripts/pi/pi-image-generation/extensions/index.ts`、`pi-video-generation/extensions/index.ts` |
| 三插件结构/依赖/清理差异 | SubAgent 1 报告 `.../research/existing-plugins.md` |
