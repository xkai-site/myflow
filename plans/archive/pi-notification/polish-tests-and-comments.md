# pi-notification 收尾润色：注释英文化 + 边界测试补充

## Context

`work/scripts/pi/pi-notification` 是一个已完成、行为已被 6 套脚本验证的 Pi 插件（`private: true`）。它的**功能**没问题，问题是**可交付性**：

- 注释与代码强耦合于一批仓库里并不存在的文档（`设计 §10.2`、`UX 方案 §值模型`、`O/docs/session-format.md`、`O/dist/core/extensions/types.d.ts`、`examples/extensions/notify.ts`）。任何人拿到这份代码，看到 `（§18.5 修订 1）` 都无法判断依据是什么。
- 注释是中文长散文，大量复述代码与历史演进（"S1 只会…S3 会新增…"），违反了"解释为什么而非是什么"。
- 少数纯函数与降级路径没有直接测试，属于"容易被误用的公开接口"。

目标：注释成为唯一事实源（英文、简短、只讲为什么/约束/安全），测试覆盖到边界与异常路径，且**不改变任何公开行为**。

## 已确认的范围与约束（来自你的决定）

| 决定 | 内容 |
| --- | --- |
| 本次润色范围 | **仅 `pi-notification`**（codex / image / video 三个插件不动） |
| `§` 与文档引用 | 清除；中文**用例名**保留（它是输出，不是注释） |
| 已发现的明显缺陷 | 交给 subagent 处理（见 Part C） |
| 不引入新依赖 | 新测试全部用 `node:test` 之外的现有手写脚本风格 + Node 内置模块 |
| 不改变公开行为 | 注释改动必须做到可机检的"零非注释行改动" |

## 基线（本次规划实测）

- `MSYS_NO_PATHCONV=1 npm test` 全绿：`terminal-channel` / `service-coalesce` / `webhook-channel` / `settings-ui` / `host-lifecycle` / `cli-smoke` 六套。
- 工作区 git 干净；无 `tsconfig`、无 `typescript` 依赖、无类型检查步骤（测试靠 Node 原生脱类型运行，**类型错误不会被发现**）。
- 注释问题量化：

| 文件 | 总行 | 含中文的注释行 | `§` 处数 |
| --- | --- | --- | --- |
| `src/types.ts` | 349 | 66 | 12 |
| `src/config.ts` | 586 | 58 | 12 |
| `src/rules.ts` | 387 | 62 | 10 |
| `src/lifecycle.ts` | 306 | 40 | 8 |
| `src/providers/terminal.ts` | 243 | 38 | 7 |
| `src/service.ts` | 369 | 26 | 6 |
| `src/providers/webhook.ts` | 206 | 26 | 6 |
| `src/providers/decorators.ts` | 276 | 30 | 5 |
| `src/commands.ts` | 241 | 31 | 3 |
| `src/log.ts` | 212 | 29 | 2 |
| `src/providers/registry.ts` | 68 | 6 | 2 |
| `src/ui.ts` | 622 | 51 | 1 |
| `src/settings.ts` | 500 | 53 | 1 |
| `src/providers/noop.ts` | 18 | 3 | 1 |
| `extensions/index.ts` | 563 | 64 | 15 |
| `src/patch.ts` / `src/providers/debug.ts` | 62 / 45 | 10 / 8 | 0 |
| `test/*.mjs` + `test/fixtures/*` | 3 888 | 259 | 17 |

合计：`src` + `extensions` 601 行中文注释、108 处 `§`、40 处外部文档路径。

## 现有测试已覆盖的内容（用于避免重复）

已覆盖（不要重复写）：规则判定 A–F/H、工具失败 K1–K6、压缩失败 K4、等待输入 K5–K6、reload/去重 D、配置读盘与降级 I1–I9/Q、单一入口与三层值 J1–J14、设置界面 C1–C2/R1–R4/V1–V3、覆盖叠加 S1–S5、渠道终端选择与注入面、webhook HMAC/重定向/校验、装饰器 `withTimeout`/`withRetry`/`withCircuitBreaker`/`withRedaction`/`withReliability`、service 门槛/去重/队列/合并/冷却/超时。

直接引用计数为 0（真正的缺口）：

| 模块 | 未覆盖的导出 |
| --- | --- |
| `src/patch.ts` | `mergePatch`、`getPathValue`、`hasPath`（`setPatchPath` 仅经 UI 间接使用） |
| `src/providers/registry.ts` | `createRegistry`（四条降级路径均无直接断言） |
| `src/providers/noop.ts` / `debug.ts` | `createNoopNotifier`、`createDebugNotifier` |
| `src/settings.ts` | `isEmptyOverlay`、`overlayFromEntry`、`hasUserDefault`、`userDefaultValue`、`isCurrentValue`、`collectionValue`、`candidatesOf` |
| `src/config.ts` | `isDisabledByEnv`、`describeConfig`（字段级校验矩阵也只经宿主间接覆盖） |
| `src/log.ts` | `createLogger`（sink 行为）、`createSilentLogger`、`sanitizeError`；`redact`/`sanitize` 仅 P0 一条断言 |
| `src/lifecycle.ts` | 无直接单测：`isIdle=false`、会话不匹配、陈旧实例、隐式 run、`promptDepth` 边界、成本累计/复位、时钟回退 |
| `src/service.ts` | `discardPending`、`flush` 超预算路径、渠道缓存随配置引用刷新 |

## Approach

### Part A：注释改写（纯注释，零行为改动）

改写规则（每一条都落到 grep 可验证）：

1. 删除全部 `§` 与所有外部文档/文件引用（`O/docs/...`、`O/dist/...`、`examples/extensions/notify.ts`、`设计`、`UX 方案`、`详见…`）。
2. 中文注释 → 简短英文。保留：非直观"为什么"、隐藏约束、安全/并发/原子性考量、导出符号的一行 docstring。删除：复述代码、历史演进叙事（"S1/S3/S4 会…"）、纯分段横幅、"三个刻意的设计选择"这类散文式说明。
3. 中文**字符串**一律不动（用户可见文案、日志文案、`throw new Error("渠道已熔断…")`、测试用例名与 console 输出）——它们不是注释，改了就是改行为。
4. 必须存活的约束（逐条改写为 1–3 行英文，不丢信息）：只在 `agent_settled` 出口、handler 内零 `await`、`submit()` 同步且不抛、损坏配置降级为安全子集而非全关、去重先于过滤、数组整体替换/对象深合并、每次重试有自己的 deadline 且小于外层预算、退出路径短超时、脱敏是 provider 层最后一道出口、`custom` 永久排除、prompt 嵌套只发外层 span。

分批（每批独立提交式推进，便于审阅）：

| 批次 | 文件 | 规模 |
| --- | --- | --- |
| A1 | `src/types.ts`、`src/log.ts`、`src/patch.ts`、`src/providers/{noop,registry,debug}.ts` | ~127 行注释 |
| A2 | `src/rules.ts`、`src/lifecycle.ts`、`src/service.ts` | ~128 |
| A3 | `src/config.ts`、`src/settings.ts`、`src/ui.ts`、`src/commands.ts` | ~193 |
| A4 | `src/providers/{terminal,webhook,decorators}.ts`、`extensions/index.ts` | ~164 |
| A5 | `test/*.mjs`、`test/fixtures/*.ts`：删 `§` 与文档引用、注释英文化；用例名与输出保持中文 | ~259 |

### Part B：补充测试

沿用现有脚本风格（`step()` + `failures` 数组 + 非零退出），新增 4 个脚本，逐个接入 `package.json` 的 `test` 链与 `test:<name>`：

- **B1 `test/config-validation.mjs`**（`src/config.ts` 字段级矩阵，输入与 I1–I9 不重叠）
  - `mergeConfig`：`version` 不匹配；`rules` 未知规则名 → warning 且不生效；`rules` 非对象 → error；`coalesce`/`delivery`/`content` 各自越界值（0 与上限、负数、非整数、字符串数字）；`content.maxMessageChars` 19/2001；`quietHours` 非法格式（`8:00`、`24:00`、`08:60`）与非数组 `exceptLevels`；`providers` 重复 id、缺 `type`、`options` 非对象、`enabled` 非布尔；`waitingForUser.kinds` 含未知值 → error、含 `custom` → warning 且被过滤。
  - `degradedConfig()`：仅 `runFailed` 开启、`minLevel=error`、只挂 `terminal`。
  - `isDisabledByEnv`：`"1"` / `"true"` / `"TRUE"` / 未设置。
  - `describeConfig`：开启规则与渠道并集、空集合显示 `none`。
  - `readUserConfigRaw`：根为数组/字符串 → `ok:false`。
  - `writeUserDefault`：只写补丁该项且保留原文其它字段；原文件损坏 → 拒绝写入且不改动文件；非法值 → 拒绝；`writeUserConfig` 全量快照的原子性（失败后原文件不变、无 `.tmp` 残留）。

- **B2 `test/settings-patch.mjs`**（`src/patch.ts` + `src/settings.ts` 纯函数）
  - `mergePatch`：数组整体替换（不逐元素合并）；嵌套对象深合并；`null`/标量覆盖对象；返回对象不与入参共享引用（`structuredClone` 语义）；`base` 非对象 / `patch` 非对象。
  - `getPathValue`/`hasPath`：中间层缺失、中间层是标量/数组、`hasPath` 对继承属性为 `false`。
  - `isEmptyOverlay`、`overlayFromEntry`（非法条目 → `undefined`）、`hasUserDefault`/`userDefaultValue`（未保存项 → `false`/`undefined`）、`isCurrentValue`（三种 kind）、`collectionValue`、`candidatesOf`（枚举候选与 `custom…` 行）。

- **B3 `test/registry-log.mjs`**（渠道注册降级 + 日志与脱敏）
  - `createRegistry`：未注册 `type` → noop + `channel_degraded` 记录；工厂抛错 → 同上；`validate()` 返回原因 → 同上；`validate()` 抛错 → 同上；正常渠道透传 `id/type/format/dispose`。
  - `createNoopNotifier`：`validate()` 回显原因、`send()` 无副作用、`dispose()` 可重复。
  - `createDebugNotifier`：长文本按 `maxChars` 截断、换行归一、已 abort 的 signal → 抛错。
  - `log.ts` 缺口：`redact` 的 `ghp_`/`xox*`/JWT/40 位以上 token/家目录两种分隔符；`sanitize` 的非字符串输入、C1/`\u2028`/BOM/`\t` 处理、code point 截断边界（`maxChars=1`）；`sanitizeError` = 先脱敏后清洗且不超长；`createLogger`：未设 `PI_NOTIFY_LOG_FILE` 时不建文件、sink 写入失败（指向目录）不抛错且之后不再尝试、`PI_NOTIFY_DEBUG=1` 时写 stderr、`PI_NOTIFY_LOG_FILE` 生效时逐行 JSONL；`createSilentLogger` 零副作用。测试内改环境变量后必须复原。

- **B4 `test/lifecycle-state.mjs`**（状态机与投递服务边界，注入假时钟）
  - `createLifecycle`：`onSettled({isIdle:false})` → `null` 且记录 `not_idle`；会话不匹配 → `null`；`onShutdown` 后再 settle → `null` 且 `isStale()`；无 `agent_start` 时 `onAssistantMessage` 触发 `lifecycle_run_implicit`；无 run 直接 settle → runId 为 orphan 形态且 `status=unknown`；`ui_prompt_start` 多次后多余的 `ui_prompt_end` 不让深度变负；`custom` 不参与计数；`onShutdown` 复位计数；`onSessionStart` 复位累计成本；同一 run 内同名工具重复失败计数递增且 `accumulated` 顺序稳定；时钟回退时 `durationMs` 不为负。
  - `createService` 缺口：`discardPending()` 清队列、abort 在途、记录 `queue_discarded`；`flush(0)` 在仍有在途时给出超预算告警且不挂死；投递失败后 `snapshot()` 的 `failed`/`lastError`；配置 `providers` 数组被替换（同 id 换 type）后渠道缓存失效、工厂被重新调用。

- **B5 `package.json` + `README.md`**：`test` 链加入 4 个新脚本、各自加 `test:<name>`；README 的测试命令清单与条数同步更新。

**防重复纪律**：每个新用例在写之前先对照 `test/*.mjs` 里已有的同名断言；若某条已被覆盖（例如渠道切换、静默时段），改用未被覆盖的输入或直接删掉，并在批次说明里记一句"已有覆盖，未重复"。

### Part C：已发现缺陷（交由 subagent 处理，逐项单独列风险）

| 编号 | 位置 | 现象（已实测） | 处理 |
| --- | --- | --- | --- |
| D1 | `src/patch.ts` `mergePatch` | 补丁含 `__proto__` 键时，赋值会替换返回对象的**原型**（实测：`mergePatch({}, JSON.parse('{"__proto__":{"polluted":1}}'))` 的原型不再是 `Object.prototype`，`merged.polluted === 1`；嵌套对象同样被污染）。影响：用户配置文件或会话覆盖里的 `__proto__` 可让**非自有属性**参与 `mergeConfig` 的字段读取（绕过"用户没写过这个字段"的判断），且被污染的形态会进入内存配置 | 先写 B2 里的回归断言（修好前为 expected failure，注明原因）→ subagent 做最小修复：累积时跳过 `__proto__`/`constructor`/`prototype` 键，或改用以自有属性写入的累积对象 → 我复查 + 全套测试 |
| D2 | `pi-video-generation/src/adapters.ts` | `submitVideoTask`/`pollVideoTask`/`cancelVideoTask` 三个 `switch` 都没有 `default`，声明返回 `Promise<SubmittedTask>` 等非 `undefined` 类型，未知 adapter 时实际返回 `undefined`。当前 `ADAPTERS` 只有 `dashscope`，属防御性缺口而非活 bug；仓库无 tsconfig，类型层面也不会报错 | subagent 加 `default` 抛明确错误 + 视频插件自己的回归测试（不引入依赖，不改公开行为——只是把静默 `undefined` 变成可诊断失败） |

D1 与 D2 都由我给出**改动前/后对比 + 风险标注**，并在 Part D 的报告中单列（不混在注释批次里）。

### Part D：不做的事

- 不动 codex / image / video 三个插件的注释与测试（仅 D2 一处缺陷修复）。
- 不改任何中文用户可见文案、日志文案、测试用例名。
- 不加 `tsconfig`/类型检查依赖（无依赖前提下的类型检查无法离线完成；作为建议列在最后，不实施）。
- 不做与"测试 + 注释"无关的重构（例如不改 `service.ts` 的窗口表实现策略）。

## Files to modify

- 注释批次：`src/**.ts`（17 个文件）、`extensions/index.ts`、`test/**.mjs`、`test/fixtures/*.ts`
- 新增测试：`test/config-validation.mjs`、`test/settings-patch.mjs`、`test/registry-log.mjs`、`test/lifecycle-state.mjs`
- 配套：`package.json`（仅 `scripts`）、`README.md`（测试命令清单与条数）
- 缺陷修复：`src/patch.ts`（D1）、`pi-video-generation/src/adapters.ts` + 其新测试（D2）

## Steps

- [x] A1 注释批次 1：`types.ts` / `log.ts` / `patch.ts` / `providers/{noop,registry,debug}.ts`
- [x] A2 注释批次 2：`rules.ts` / `lifecycle.ts` / `service.ts`
- [x] A3 注释批次 3：`config.ts` / `settings.ts` / `ui.ts` / `commands.ts`
- [x] A4 注释批次 4：`providers/{terminal,webhook,decorators}.ts` / `extensions/index.ts`
- [x] A5 注释批次 5：`test/**.mjs` / `test/fixtures/*.ts`（保留中文用例名与输出）
- [x] B1 新增 `test/config-validation.mjs`
- [x] B2 新增 `test/settings-patch.mjs`（含 D1 的 expected-failure 断言）
- [x] B3 新增 `test/registry-log.mjs`
- [x] B4 新增 `test/lifecycle-state.mjs`
- [x] B5 `package.json` 与 `README.md` 同步
- [x] C1 派发 subagent 修 D1，复查 diff 与测试
- [x] C2 派发 subagent 修 D2，复查 diff 与视频插件测试
- [x] V1 跑全套测试并取证（见下）
- [x] V2 输出报告：新增测试清单、注释删除/改写清单、遗留问题与建议

每批完成后立即说明"改了什么、为什么"，并附前后对比；涉及 5 行以上的注释块，用 diff 呈现。

## Verification

1. `cd work/scripts/pi/pi-notification && MSYS_NO_PATHCONV=1 npm test` 全绿；报告每个脚本的通过条数与新增条数。
2. `grep -rn "§" src extensions test` → 0 命中；`grep -rnE "O/docs|O/dist|设计 |UX 方案|详见" src extensions test` → 0 命中。
3. **零行为改动机检**：`git diff -U0 -- src extensions test | grep '^[+-]' | grep -v '^[+-][+-]'` 的每一行都必须是注释行（`//`、`*`、`/*`）或其续行；出现任何代码行改动即视为失败并回退。
4. 依赖不变：`git diff --stat package.json` 只出现 `scripts` 相关行。
5. 缺陷修复单独验证：D1 的回归断言由 expected-failure 翻为 pass；D2 在视频插件跑 `npm test`（`output-preview.mjs`）与新增用例全绿。
6. Windows 注意：脚本需 `MSYS_NO_PATHCONV=1`（host-lifecycle 的既有硬约束）。

## Risks

| 风险 | 缓解 |
| --- | --- |
| 注释改写的 diff 很大，可能连带改动代码 | 第 3 条机检；每批单独跑测试 |
| 删注释时丢掉关键"为什么" | 上面列出 11 条必须存活的约束，逐条落到英文注释；批次说明里逐条确认 |
| 新测试与既有断言重复 | 写前对照已有 `step()` 清单；重复项删除并在批次说明注明 |
| D1 修复触及配置合并路径 | 最小修复（仅影响含 `__proto__` 的补丁）；加回归断言；跑全套确认无回退；在报告中单列行为变化与风险 |
| D2 修复触及另一个插件 | 不改变合法输入路径的行为；仅把不可达分支的静默 `undefined` 变为显式错误；在报告中单列 |
| 新增 4 个脚本拉长 `npm test` | 全部为纯函数/注入式测试，不启宿主、不出网；预计总增量 < 5s |

---

## 执行结果（收尾记录）

状态：**14/14 步完成**。四个插件测试全绿：`pi-notification`（10 套，165 步）、`pi-video-generation`（4 单测 + 1 渲染套）、`pi-image-generation`（31）、`pi-codex-official`（24）。

与计划的差异（均已单独列出并取证）：

- **发现了 3 个计划外的缺陷**：D3（`providers[].enabled` 非布尔被静默当作 true）、D4（`redact` 对 `Authorization: <scheme> <secret>` 与 Cookie 头漏掉凭据）、D5（`pi-video-generation` 的 `npm test` 在本仓库解析不到宿主 SDK，属既有缺陷）。三者与 D1、D2 一并修复。
- **subagent 通道不可用**：受控车道启动即失败（`pi-subagents` 解析不到 `@earendil-works/pi-coding-agent` peer，其自身目录下 peer 未安装）。经 owner 明确批准后改为父会话直接修复，仍按原约束执行（最小改动、逐条复查 diff、跑全套取证）。
- `expected failure` 机制随缺陷修复一并退役：D1/D3/D4 的断言已提升为普通断言（不保留"永远绿"的旁路）。

新增测试（4 个通知脚本 + 1 个视频脚本，共 42 步 + 4 测）：`test/config-validation.mjs`、`test/settings-patch.mjs`、`test/registry-log.mjs`、`test/lifecycle-state.mjs`、`pi-video-generation/test/adapters.test.ts`。

注释改造：中文注释行 601 → 0（src + extensions）、259 → 0（test，保留中文用例名与输出文案）；`§` 108 → 0；外部文档/文件引用 40 → 0。
