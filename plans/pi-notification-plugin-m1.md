# Pi 消息通知插件 — 里程碑 1（S1 骨架 + S1.5 回归脚本）

> 状态：**待评审**（决策已锁定，见下）
> 权威设计：`plans/pi-notification-plugin-design.md` v1.2（§17 渠道抽象、§18 实测修订、§10 配置、§11 类型、§12 判定、§15 步骤）
> 目标宿主：`@earendil-works/pi-coding-agent` **0.86.1**
> 实现位置：`work/scripts/pi/pi-notification/`（**只在此目录下新建文件**；不碰仓库 `README.md`、`plans/archive/`、工作区既有删除态文件）

---

## Context

设计（v1.2）与 S0 实测均已完成，**尚无任何实现代码**。本轮交付 **里程碑 1 = S1 骨架 + S1.5 回归脚本**，把 §18 的实测结论固化成可执行断言，防止后续开发退回三个已知坑：用 `agent_end` 造成误报、`agent_settled` 内阻塞 Pi、reload 后重复投递。

### 本轮已实测（可复现，零网络/零 LLM/零真实配置写入）

| # | 结论 | 证据 |
|---|---|---|
| 1 | `session.prompt("/cmd")` 走扩展命令分支**立即返回，不产生 `agent_start`/`agent_end`/`agent_settled`** | SDK 驱动；复现 §18.2 第 1 项 |
| 2 | `pi.registerProvider(name,{api,streamSimple})` + `createAssistantMessageEventStream()` 可造**离线确定性假 provider**，一次 prompt 产生完整 `agent_start → message_end(stopReason=stop) → agent_settled` | 复现 §18.4 对照组所需 |
| 3 | settled handler 内 `await sleep(2000)` → 下一次 run 的 `agent_start` 推迟 **2004ms**；非阻塞时 **7ms** | 复现 §18.4（+2027ms）；证明"不阻塞"可量化且有对照 |
| 4 | `await session.reload()` = `session_shutdown(reload)` → `loader.reload()`（**重跑工厂、新实例**）→ `session_start(reload)`；每次 run 仍**只有 1** 条 settled | §18.5 修订 5 的回归靶子 |
| 5 | **陷阱**：SDK 下不调 `session.bindExtensions({...})` 则 `session_start` **完全不触发**（`agent-session.js:2333` 的 `hasBindings` 守卫） | 测试必须显式绑定（同时可用 `onError` 收集插件异常） |
| 6 | `agent_settled` 时 `ctx.isIdle()===true`、`hasPendingMessages()===false`、`sessionId` 跨 reload 稳定 | `isIdle` 可作为 settled 出口门槛 |
| 7 | **真实 CLI 全链路离线可跑**：`MSYS_NO_PATHCONV=1 pi --no-session --approve --no-tools --model probe-fake/fake-model -e probe.ts -p "只回复 OK"` → exit 0、stdout `OK`、stderr 空、日志完整 5 事件 | 直接支撑"`pi -e` 能加载 / 退出无报错"验收 |
| 8 | **真实 CLI 纯命令零成本**：`pi -e probe.ts -p "/probe-cmd"` → exit 0，仅 `session_start → CMD_HANDLER → session_shutdown(quit)`，**无 agent 事件、无 LLM 调用** | §18.5 修订 2 的 CLI 侧证据 |
| 9 | Git Bash/node 下 `spawn("pi.cmd", args, {shell:true})` 不会把 `/probe-cmd` 改写成路径（MSYS 改写只发生在 bash exec 原生程序的路径上） | 仍按硬约束在子进程 env 里强制 `MSYS_NO_PATHCONV=1` |

### 决策（已锁定）

1. 目录：`work/scripts/pi/pi-notification/`
2. S1 范围：**最小端到端骨架**（判定 + 入队 + 去重 + 一个可观测 debug 渠道），接口/分层按 §17 一次到位
3. 观测面：`PI_NOTIFY_LOG_FILE=<path>` 写 JSONL 诊断日志（确定性、S3+ 复用）
4. 包含真实 CLI 冒烟：`test/cli-smoke.mjs`
5. 配置：S1 **只内置默认值**；读盘/校验/原子写留给 S5

---

## Approach

```
extensions/index.ts      薄接线：注册 5 个 hook + 形状转换（无业务判定、无 IO）
   └─> lifecycle.ts      运行状态机、sessionId 绑定、RunOutcome（唯一完成判定点）
         └─> rules.ts    纯函数：(RunOutcome, Config) -> NotificationRequest | null
               └─> service.ts   同步入队 + 异步 worker + 去重 + 超时 + dispose
                     └─> providers/{registry,noop,debug}.ts   实现 Notifier
log.ts      控制字符清洗 + 脱敏 + 可选 JSONL sink（所有渠道出口必经）
```

依赖方向严格按 §17.3：`lifecycle`/`rules` **不 import** 任何 `providers/*`；`rules` 内**不出现渠道名**；`providers/*` **不 import** `lifecycle`/`rules`/`config`。新增渠道只需"加 1 个文件 + registry 注册 1 行"，`lifecycle`/`rules`/`service` 的 diff 为 0。

### 硬约束 → 落地方式（逐条对应 §18）

| 硬约束 | 落地 |
|---|---|
| 只用 `agent_settled`，**不用** `agent_end` | `index.ts` 不注册 `agent_end`；反回退检查脚本 grep 兜底 |
| 用 `stopReason` 区分 completed/failed/aborted | `message_end` **只读**捕获（不返回值）→ lifecycle 分类 |
| settled 内只入队、立即返回 | handler 内唯一动作 `service.submit(req)`（同步返回 `void`）；handler 体内**零 `await`** |
| `session_shutdown` 投递带短超时 | `quit` → `service.flush(shortTimeoutMs≈200ms)`；`reload/new/resume/fork` → `abort + discard` |
| 终端输出前清洗控制字符 | `log.sanitize()`：剥 C0/`\x1b`/OSC、`\r\n` 归一、按 `maxMessageChars` 截断 |
| 不注册 `tool_call`/`input`/`session_before_*` | 零注册（§18.5 修订 6） |
| 去重键自包含 | `${sessionId}:${runId}:${kind}`（§18.5 修订 5），有界 Set（防无界增长） |
| 旧实例不得投递 | 每次 handler 校验 `sessionId` + `ctx.isIdle()`；`dispose()` 后 `submit()` 直接丢弃 |

### S1 明确不做（留给后续阶段）

真桌面通知 OSC 777/99/toast（S3）· 工具失败聚合 + `session_compact_failed` + `ui_prompt_*`（S6/修订 1）· `length`/`unknown` 细分与成本/上下文占比（S2）· 配置读盘/校验/原子写/`/notify` 命令/`registerFlag`（S5）· Webhook（S7）· 子任务通知与 `pi.events` 入站（§18.5 修订 4，永久不做）· 静默时段/熔断/重试（S4；S1 只保留 `timeoutMs` + 失败日志）

---

## Files to modify（全部新建）

根：`work/scripts/pi/pi-notification/`

| 文件 | 职责 | ≈行 |
|---|---|---|
| `package.json` | `type:module`、`keywords:[pi-package]`、`pi.extensions:["./extensions/index.ts"]`、`scripts.test:host`/`test:cli`、**无第三方依赖** | 20 |
| `extensions/index.ts` | 默认工厂：组装 + 注册 `session_start`/`agent_start`/`message_end`/`agent_settled`/`session_shutdown` | 110 |
| `src/types.ts` | §11 契约：`SignalEvent`/`RunOutcome`/`NotificationRequest`/`Notifier`/`NotifierFactory`/`NotifierRegistry`/`DeliveryResult`/`Deps{now,log}` | 140 |
| `src/lifecycle.ts` | run 累积器、sessionId 绑定、`message_end` 捕获、`agent_settled` → `RunOutcome` | 130 |
| `src/rules.ts` | 纯函数映射：completed→`info`/`run_completed`；failed→`error`/`run_failed`；aborted、unknown→`null` | 70 |
| `src/service.ts` | `submit()` 同步入队、异步 worker、去重、`AbortSignal.timeout`、`flush(ms)`、幂等 `dispose()`、有界队列 | 150 |
| `src/providers/registry.ts` | Factory + Registry；未注册 → Noop + 警告 | 40 |
| `src/providers/noop.ts` | Null Object | 20 |
| `src/providers/debug.ts` | S1 的"投递"= 经 `log.ts` 输出一行（S3 替换为 `terminal.ts`，接口不变） | 40 |
| `src/log.ts` | `sanitize()` + 脱敏 + 结构化日志 + `PI_NOTIFY_LOG_FILE` JSONL sink | 90 |
| `test/host-lifecycle.mjs` | **S1.5 回归脚本（SDK 离线）** | 260 |
| `test/cli-smoke.mjs` | 真实 `pi` 冒烟（离线、零 LLM） | 130 |
| `test/fixtures/probe-ext.ts` | 探针：假 provider + `/probe-cmd` + 事件打点（含实例 id / 单调时钟 / `isIdle`） | 90 |
| `test/fixtures/blocking-ext.ts` | 阻塞对照组：`agent_settled` 内 `await sleep(2000)` | 25 |
| `README.md`（插件内新文件） | 安装/启用/`pi -e` 用法 + **覆盖范围硬边界**（不覆盖纯 `/command` 任务与子会话，§18.5 修订 2）+ 隐私默认值 | 40 |

不建 `dist/`、`main`、`bin`、构建流程（Pi 直接 jiti 加载 TS）。

### 测试入口的 SDK 解析顺序（两个脚本共用，抽到 `test/sdk-path.mjs`）

1. `process.argv[2]` → 2. `process.env.PI_SDK`（文件或目录）→ 3. 定位 `pi` 可执行文件（`PI_BIN` 或 PATH 上的 `pi`/`pi.cmd`）→ 取其同目录 `node_modules/@earendil-works/pi-coding-agent/dist/index.js`（与 `pi` 自身使用的安装一致）→ 4. `npm root -g` 同路径 → 5. 明确报错并提示传参。

---

## Reuse（复用既有实现，不重复造）

| 复用 | 出处 | 用途 |
|---|---|---|
| 工厂/测试骨架 + `const sdk = process.argv[2] ?? ...` 约定 | `work/scripts/pi/pi-codex-official/test/host-lifecycle.mjs` | 测试驱动结构；`tmpdir` + `t.after` 清理 |
| 隔离配方（`PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` / `PI_OFFLINE=1` / `PI_SKIP_VERSION_CHECK=1`） | 同上 + 设计 §18.1（已实测零写入） | 不污染真实 `~/.pi/agent` |
| `SettingsManager.inMemory` / `SessionManager.inMemory(cwd)` / `DefaultResourceLoader({additionalExtensionPaths})` | 两个现有 `host-lifecycle.mjs` | 全内存态 |
| `createAssistantMessageEventStream` + `registerProvider({streamSimple})` 写法 | `O/examples/extensions/custom-provider-anthropic/index.ts:335-420` | 探针假 provider |
| 严格校验 + 错误信息风格；`sanitizeError()`；诊断日志落盘 | `pi-image-generation/src/model-config.ts`、`src/http.ts`、`src/diagnostics.ts` | `log.ts`；S5 的校验 |
| 原子写（临时文件 + `rename` + `0o600`） | `pi-video-generation/src/config.ts:58` | 仅记录为 S5 参照，S1 不实现 |
| 架构：薄工厂 + src 分层 + 实例闭包状态 + 显式清理 | 三插件共性（§2.2），**并补上三者都缺的 `session_shutdown` 清理**（§2.3 反模式 3） | 骨架结构 |

Pi 官方 API 只用：`pi.on` / `ctx.sessionManager.getSessionId()` / `ctx.isIdle()` / `getAgentDir()`（S5 起）。**不用** `pi.registerProvider`（那是模型服务商，§1.8）、不用 `pi.events`、不注册 `tool_call`/`input`。

---

## Steps

- [x] **S1-0** 建目录骨架 + `package.json`（无依赖）
- [x] **S1-1** `src/types.ts`：§11 契约落地；`Deps{now,log}` 便于注入 fake clock；`SignalEvent` 不含 `ctx`/`SessionManager` 引用
- [x] **S1-2** `src/log.ts`：`sanitize()`（OSC/`\x1b`/C0 剥离、换行归一、截断）+ 脱敏 + JSONL sink；附自带断言用例（如 `\x1b]777;notify;a\x07b` → `a b`）
- [x] **S1-3** `src/providers/{registry,noop,debug}.ts`
- [x] **S1-4** `src/service.ts`：`submit()` 同步入队；worker 并发 1、`AbortSignal.timeout(delivery.timeoutMs)`、`dedupeKey` Set、`flush(ms)`、幂等 `dispose()`；**任何路径都不向 hook 抛异常**
- [x] **S1-5** `src/lifecycle.ts` + `src/rules.ts`：runId 自增、`startedAt` 取注入 clock、settled 时校验 sessionId 与 `ctx.isIdle()`、产出 `RunOutcome`
- [x] **S1-6** `extensions/index.ts`：5 个 hook；`session_shutdown` 按 reason 分流（quit→短超时 flush；其余→abort+discard）；工厂内不 IO/不网络/不起定时器
- [x] **S1-7** `test/fixtures/{probe-ext,blocking-ext}.ts` + `test/sdk-path.mjs`
- [x] **S1-8** `test/host-lifecycle.mjs`（断言 A–F，见下）
- [x] **S1-9** `test/cli-smoke.mjs`（断言 G–H）
- [x] **S1-10** 插件内 `README.md`：覆盖范围、隐私、`pi -e` 用法、测试命令
- [x] **S1-11** 自检：跑反回退 grep（见 Verification）

---

## Verification

### 1. `MSYS_NO_PATHCONV=1 node test/host-lifecycle.mjs [sdkPath]`（SDK 离线回归）

全部离线、无 LLM、无网络、零写入真实 `~/.pi/agent`（临时 agentDir + `t.after` 清理）。
必须调用 `session.bindExtensions({ mode:"print", uiContext:<最小桩>, onError })`，否则 `session_start` 不触发。

| 段 | 断言 |
|---|---|
| **A 纯命令边界** | `await session.prompt("/probe-cmd")` 后：探针日志有 `CMD_HANDLER_ENTER`，**无** `agent_start`/`agent_end`/`agent_settled`；插件 JSONL **零**条投递记录 |
| **B 正常完成** | `setModel(fake)` 后 `await session.prompt("hi")`：恰好 **1** 条 `kind=run_completed`；`dedupeKey` 含 runId；再跑一次得到新 runId、仍各 1 条 |
| **C settled 不阻塞** | 探针（**先加载**）的 `settled_enter` → 下一次 `agent_start` 间隔 **< 250ms**；**对照组**：加装 `blocking-ext.ts` 后同一测量 **> 1000ms**（证明该测量确实能识别阻塞） |
| **D reload 不重复投递** | `await session.reload()`：恰好 1 次 `session_shutdown(reason=reload)` + 1 次 `session_start(reason=reload)`；reload 后一次 prompt 仍只产生 **1** 条记录（旧实例不再投递、新实例不叠加） |
| **E 退出无报错** | 收集到的扩展异常（`bindExtensions({onError})`）为 **0**；`session.dispose()` 后进程自然退出；临时目录内无残留（日志除外） |
| **F 失败分类（best-effort）** | 第二个假 provider 直接 push `{type:"error"}`（`errorMessage` 取非重试类）→ 1 条 `kind=run_failed` |

### 2. `MSYS_NO_PATHCONV=1 node test/cli-smoke.mjs [sdkPath]`（真实 `pi` 冒烟）

子进程 env 强制 `MSYS_NO_PATHCONV=1`、`PI_CODING_AGENT_DIR=<tmp>`、`PI_OFFLINE=1`、`PI_SKIP_VERSION_CHECK=1`；`PI_BIN` 覆盖，win32 用 `pi.cmd` + `shell:true`；`PI_SKIP_CLI=1` 可跳过。

| 段 | 断言 |
|---|---|
| **G 纯命令（零成本）** | `pi --no-session --approve -e <probe> -e <plugin> -p "/probe-cmd"`：exit 0；stderr 无 error；探针日志有 `CMD_HANDLER_ENTER` 且**无 agent 事件**；插件 JSONL 只有 `session_start`/`session_shutdown(quit)`，**零**投递记录（真实 CLI 侧证明覆盖边界） |
| **H 全链路完成** | `pi ... --no-tools --model probe-fake/fake-model -e <probe> -e <plugin> -p "只回复 OK"`：exit 0；stdout 含 `OK`；stderr 空；插件 JSONL 恰好 **1** 条 `run_completed` 记录（含 exit 路径的 quit flush） |

### 3. 反回退自检（人工/脚本化 grep）

- `pi.on("agent_end"` 在 `extensions/`、`src/` 中**必须为 0 次**
- `extensions/index.ts` 的 hook handler 体内**不得出现 `await`**（仅注册期与 shutdown 分流允许）
- `src/lifecycle.ts`、`src/rules.ts` 中**不得出现** `providers`/`terminal`/`webhook` 字样
- `git status`：只新增 `work/scripts/pi/pi-notification/**` 与 `plans/pi-notification-plugin-m1.md`；不触碰 `README.md`、`plans/archive/`、既有删除态文件

### 4. 人工一次性（真终端，属 §18.6 未测项，如实记录而非当作已验证）

TUI 内 `/reload` 一次 → 无重复注册、无报错；退出无报错。

---

## 风险与未覆盖（诚实声明）

- 本轮**不产生任何真实桌面通知**（debug 渠道只写日志）；OSC 777/99/toast 是 S3。
- `test/cli-smoke.mjs` 依赖 PATH 上的 `pi`（或 `PI_BIN`），比 SDK 测试脆；失败信息必须明确指向 `PI_BIN`/`PI_SKIP_CLI`。
- 假 provider 的 `stopReason:"error"`→failed 分类（段 F）依赖 Pi 的重试判定为非重试类；若实现时发现被重试，降级为 S2 的单测覆盖并在脚本中标注。
- `length`/`unknown`/工具失败/压缩失败/等待输入**不在**本轮断言范围（S2/S6/修订 1）。
- 子会话与后台 `async:true` 子任务**不在**覆盖范围，且不通过 Hook 实现（§18.5 修订 4）。
