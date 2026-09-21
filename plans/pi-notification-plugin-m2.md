# Pi 消息通知插件 — 里程碑 2（S4 合并/冷却 + S6 工具失败/压缩失败/等待输入 + S7 Webhook）

> 状态：**已交付**（实现 + 76 条断言全绿；原文为里程碑 1 的规划，现**原地改写**为本里程碑规划，不新增规划文件）
> 权威设计：`plans/pi-notification-plugin-design.md` v1.2（§7 目录、§10.2 配置、§12 判定、§15 步骤、§17 渠道抽象、§18 实测修订）
> 里程碑 1（S1 骨架 + S1.5 回归 + S3 终端渠道 + S5 最小配置面）的规划与验收记录已固化在代码、
> `test/host-lifecycle.mjs`、`test/cli-smoke.mjs` 与 `plans/pi-notification-handoff.md` 里；本文件不再重复。
> 实现位置：`work/scripts/pi/pi-notification/`（**只在此目录下改动**；未碰仓库根 `README.md` 之外的既有文件、
> `plans/archive/`、工作区既有删除态文件）

---

## Context

里程碑 1 交付后，插件能用「`agent_settled` + `stopReason`」正确判定一次运行，并把结果投到终端。
但交接文档列出的三个**真实缺口**都还在，而且它们互相咬合：

1. **S4 可靠性**：没有任何合并/冷却 → 极短时间内的多次运行各发一条；`delivery.maxRetries` 是死字段。
2. **S6 覆盖面**：工具失败、压缩失败、等待用户输入这三类「用户真正需要知道」的时刻完全没覆盖。
3. **S7 异构渠道**：只有「进程内无依赖」的终端渠道 → §17.3 那条「新增渠道不改核心」的抽象**从未被检验过**。

m2 的目标就是一次把这三项做完，并且**用回归断言把抽象与语义钉死**，而不是只让代码看起来能跑。

---

## 决策（已锁定）

1. **m2 范围 = S4 + S6 + S7**。理由：S6 的 `immediate` 模式必须借助 S4 的窗口才能不刷屏；
   S7 是检验 S4 改动是否真的留在 service 层（而不是渗透进渠道）的第一个实验。三者不可拆。
2. **一个运行最多一条通知**：由 `rules.evaluateSettlement()` 取「结果通知 → 聚合工具失败」的第一个非空候选，
   再由 S4 的合并窗口兜底。工具失败名并入结果通知正文，而不是另发一条。
3. **`session_compact_failed` 立即投递**，不走 settled 出口：手工 `/compact` **没有 run 可 settle**，
   等 settled 就永远发不出去（对设计 §12.1 第 6 步的修订）。`aborted === true` 不发（用户自己取消）。
4. **`ui_prompt_*` 三条硬纪律**（§18.5 修订 1）：`custom` 永久排除（配置校验剔除 + rules 硬检查双重）；
   不靠 `start.kind === end.kind` 配对（嵌套无内层 span、`end.kind` 报外层），只做深度计数；
   `session_shutdown` 兜底复位。补充：**`custom` 也不参与深度计数**，否则 TUI 加载器会让状态一直显示“正在等你输入”。
5. **一个运行至多一条**的具体语义（S4）：`coalesce.windowMs` = 同一 `sessionId+runId` 内第一条开窗、
   窗口内该 run 的后续通知合并；`cooldownMs` = 同一 `kind` 两次入队的最小间隔。
   `toolFailed.mode = "immediate"` 用**更长的** `toolFailureWindowMs` 逐条下达（`NotificationRequest.coalesceWindowMs`）。
6. **可靠性关注点只实现一次**：`providers/decorators.ts` 提供 `withTimeout/withRetry/withCircuitBreaker/withRedaction`，
   组装顺序 `redaction(circuit(retry(timeout(inner))))`；每次尝试有自己的 deadline（否则重试在已 abort 的 signal 上立即失败）；
   参数用 thunk 读当前配置（`session_start` 会重新读盘）。
7. **测试策略**：新增两个**零依赖**脚本（`test/service-coalesce.mjs`、`test/webhook-channel.mjs`），
   宿主脚本新增 L/K/M 三段；S6 的工具失败靠 `PROBE_DELAY_MS` + 探针 `agent_start` 定位注入点（不靠 sleep 猜时机）；
   把断言 C 从单次采样改为**取 3 次最小值**（基线曾出现 265ms 的抖动假失败）。

---

## Approach

```
Pi 事件                           ├─ agent_settled ──────┐
  ├─ tool_execution_end ──────────┤                      │
  ├─ session_compact_failed ──────┤                      ├─► lifecycle（累积/簿记/唯一判定点）
  └─ ui_prompt_start/end ─────────┘                      │        │
                                                        │        ▼
                                   rules（纯函数，一个运行最多一条）│
                                                                 ▼
                    service（门槛 → 去重 → 合并窗口 → 冷却 → 有界队列 → 并发/超时）
                                                                 ▼
                       providers/decorators（超时/重试/熔断/脱敏，渠道无感）
                                                                 ▼
                    terminal.ts │ debug.ts │ webhook.ts（同一个 Notifier 接口）
```

依赖方向仍按 §17.3：`lifecycle`/`rules` 不 import `providers/*`、不出现渠道名；
`providers/*` 不 import `lifecycle`/`rules`/`config`。**这条约束被 M3 断言读源码检查**，不再是口头约定。

---

## Files

| 文件 | 改动 | 说明 |
|---|---|---|
| `src/types.ts` | 改 | `UIPromptKind`/`ToolFailureMode`/`ToolFailureEvent`、`SignalEvent` 扩到 8 种 kind、`coalesce`/`circuitBreakerFailures`/新规则配置、`NotificationRequest.coalesceWindowMs`、`submit(req, {bypassFilters})`、快照新增 `coalesced`/`cooled` |
| `src/config.ts` | 改 | 新规则（`toolFailed`/`compactFailed`/`waitingForUser`）校验、`coalesce`、`circuitBreakerFailures`、`custom` 从 `kinds` 剔除并告警、降级配置同步扩展 |
| `src/lifecycle.ts` | 改 | 工具失败按 `toolName` 去重累积 + `accumulated`、压缩失败标记、等待输入深度计数（不含 `custom`）、shutdown 复位 |
| `src/rules.ts` | 改 | `length` → warning；`evaluateToolFailure`（aggregate/immediate）、`evaluateCompactFailure`、`evaluateWaitingForUser`、`evaluateSettlement`（优先级合成） |
| `src/service.ts` | 改 | 合并窗口 + 冷却过滤（含 `bypassFilters`、统计、结构化记录、窗口表有界性） |
| `extensions/index.ts` | 改 | 新增 4 个 hook；webhook 注册；渠道统一包 `withReliability`；`adoptConfig` 同步新字段 |
| `src/commands.ts` | 改 | `status` 展示合并/冷却参数与计数、waiting 状态；`test` 走 `bypassFilters` |
| `src/providers/decorators.ts` | **新** | 超时/重试/熔断/脱敏（可独立使用，也可组合） |
| `src/providers/webhook.ts` | **新** | URL/`secretEnv` 校验、结构化 payload、HMAC 签名、不跟随重定向、响应体脱敏、日志丢弃 query |
| `test/service-coalesce.mjs` | **新** | 门槛/去重/合并/冷却/队列/超时（注入假时钟与假渠道） |
| `test/webhook-channel.mjs` | **新** | Webhook 校验/签名/错误处理 + 装饰器（回环 HTTP 服务；外部 fetch 一律失败） |
| `test/host-lifecycle.mjs` | 改 | 回环白名单、`userConfig` 预置、`emit()`/`promptWithToolFailures()`、断言 C 改 3 次最小值、新增 L0–L2 / K1–K6 / M1–M3 |
| `test/fixtures/probe-ext.ts` | 改 | `PROBE_DELAY_MS`（可控回包延迟）、`/probe-prompt`（走 Pi 真实 `withUIPrompt` 路径） |
| `test/cli-smoke.mjs` | 改 | 新增 L：`--no-notify` 真的静默 |
| `package.json` | 改 | 五套测试脚本；版本 0.2.0 |

---

## Steps

- [x] **M2-1** `types.ts`：扩契约（8 种 SignalKind、新规则配置、`coalesceWindowMs`、`bypassFilters`、新计数）
- [x] **M2-2** `config.ts`：新规则与 `coalesce` 校验；`custom` 从 `waitingForUser.kinds` 永久剔除（告警）；降级配置同步
- [x] **M2-3** `lifecycle.ts`：工具失败累积（同 run 同工具去重）、压缩失败、等待输入深度计数、shutdown 复位
- [x] **M2-4** `rules.ts`：`length`→warning、四个新求值器、`evaluateSettlement` 优先级
- [x] **M2-5** `service.ts`：合并窗口 + 冷却（含请求级窗口覆盖、`bypassFilters`、统计与留痕）
- [x] **M2-6** `providers/decorators.ts`：`withTimeout/withRetry/withCircuitBreaker/withRedaction/withReliability`
- [x] **M2-7** `providers/webhook.ts`：校验/payload/HMAC/错误处理/日志纪律
- [x] **M2-8** `extensions/index.ts`：4 个新 hook + webhook 注册 + 所有渠道包装饰器 + `adoptConfig` 扩字段
- [x] **M2-9** `commands.ts`：status 展示新参数/计数/waiting；test 绕过合并冷却
- [x] **M2-10** `test/service-coalesce.mjs`（10 条断言）
- [x] **M2-11** `test/webhook-channel.mjs`（13 条断言）
- [x] **M2-12** `test/host-lifecycle.mjs`：L0–L2 / K1–K6 / M1–M3 + 断言 C 去抖动
- [x] **M2-13** `test/cli-smoke.mjs`：断言 L
- [x] **M2-14** 插件 `README.md` 重写（能力/配置/渠道/断言表/未验证项）
- [x] **M2-15** 设计文档 §7 目录、§10.2 语义补充、§12.3/§12.4 落地记录、§15 状态、§17.3/§17.4 同步
- [x] **M2-16** 自检：全套回归 + 反回退检查（见 Verification）

---

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

### 4. 人工一次性（属 §18.6 未测项，如实记录而非当作已验证）

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

## 下一个里程碑（M3）

**M3 的可执行步骤、验收判据与人工验证清单写在 `plans/pi-notification-handoff.md` 的 §2**
（新会话入口，避免两处重复维护）。一句话版：

1. `quietHours` 静默时段（设计已定、代码 0 行）——在 service 过滤链里加时间窗口判定 + config 校验 + 单测；
2. S5 完整形态：`/notify on|off|config|reload` + 原子写（临时文件 `0o600` + `rename`，失败保留原文件）+ `ui.ts` 向导；
3. 真终端人工验证（`/notify test` 可见性、TUI 里的 `waitingForUser`、`/notify status` 排版）。

M3 之后为可选扩展（不在原始承诺内）：macOS 原生横幅 / Telegram-Discord-Slack / 成本与上下文占比 /
通知历史与状态行（完整清单见插件 `README.md` 的「当前能力与缺口」）。
