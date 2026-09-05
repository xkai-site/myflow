# pi-codex-official：职责收敛与模型自动同步修复方案

> 状态：实现完成；24 项单元测试、1 项实际 SDK 生命周期测试和 CLI 验证通过。交互终端 `/reload` 的人工 UI 验收尚未执行；没有真实模型请求或静态类型检查。启动 / `/reload` 同步；缓存异常不注册，无备用清单。

## Context

目标：插件只做 Codex 现有 ChatGPT OAuth 凭据的只读复用，以及 Pi 所需的最小模型注册适配。Codex 负责登录、凭据刷新和模型缓存；CC Switch 负责价格与用量展示。不增加独立登录、定价源、计费数据库或请求代理。

已确认现状：
- `extensions/codex-auth.ts` 已逐请求读取 live auth，不主动刷新或回写凭据。
- `extensions/index.ts` 在模块加载时读取静态 `config/models.json`，同时校验每个模型的四项 `cost`。
- `README.md` 将 CC Switch 写成必备依赖，并把模型说明转交给 `config/README.md`；需要改为一份自足的使用说明，明确 CC Switch 是可选的账号管理/统计工具，实际凭据入口是 Codex。
- 已有 `node:test` 认证测试和 `npm test` 入口，尚无模型解析/注册测试。
- 已核对 Pi 0.85.1 文档与 `dist/core/extensions/types.d.ts`：扩展注册的 `cost`、`maxTokens` 都是必填项；工厂内注册支持启动与 `--list-models`，无需 `session_start` 或新命令。注销动态 provider 会恢复 Pi 内置同名 provider，因此“不注册插件”不等于禁用 Pi 内置 Codex。
- 当前 Codex 缓存包含 8 项（6 项可见/API 可用）；提供 `context_window`、`input_modalities`、`supported_reasoning_levels`，不提供已确认的输出上限或价格。`max_context_window` 不是输出上限，`truncation_policy.limit` 也不是。缓存包含 Codex 专属提示与工具配置，不能整包注入 Pi。
- 工作区 `main` 已有此前的模型同步改动，以及范围外未跟踪目录；实施不重置或改写范围外内容。

## Approach

- 自动读取与 auth 相同 Codex 根目录下的 `models_cache.json`，不启动 Codex、不联网探测模型、不改写缓存。
- 已确认在启动及 `/reload` 时重新读取缓存，不引入文件监听、后台轮询或逐请求注册模型。
- **列表唯一来源是 Codex 缓存**。删除 `config/models.json` 及其专用说明；不增加覆盖表、备用列表、同步脚本或新配置开关。
- 缓存缺失、不可读、JSON/根结构损坏、候选模型关键字段无效、候选 ID 重复或过滤后为空时，在工厂内抛出可操作错误，校验完成前不调用 `registerProvider()`，不部分注册、不沿用插件旧快照。错误仅包含文件路径、条目索引/字段和修复建议，不回显原始 JSON 或底层 JSON 解析错误中的内容片段。
- **错误范围是本插件，不是 Pi 全局封禁**：Pi 会报告扩展加载错误并可继续运行，内置 `openai-codex` 仍可能可见；不注销、清空或拦截内置 provider，不修改 Pi auth/defaultModel。这是宿主行为，不是插件偷偷回退。README 明确提示加载失败后应先修复缓存再使用本插件。
- 移除用户需要维护的模型价格配置。不读取 CC Switch 数据库、不同步其价格、不把未知价格描述为免费。已确认 Pi 注册必须提供 `cost`：仅在适配层生成全零占位，并在 README 解释 Pi 金额不作为费用来源；响应 token 用量与 Pi 正常会话持久化不变。
- 保留既有认证校验、账号热切换和传输协议；不扩展认证职责。
- 主 `README.md` 覆盖安装、首次登录、模型来源与刷新时机、缓存异常、账号切换、凭据过期、价格/统计边界、测试与排错，无需阅读实现或另一个配置文档才能使用。

### 最小模型映射

| 注册内容 | 规则 |
| --- | --- |
| 模型候选 | 根 `models` 必须为数组；条目必须为对象；仅接受 `visibility == "list" && supported_in_api === true`；隐藏/API 不可用条目不参与注册字段校验，忽略未知附加字段 |
| `id` / `name` | `slug` 为非空字符串、候选中唯一；`display_name` 有有效字符串时使用，否则用 `slug`；保持缓存顺序，不另做排名 |
| `input` | 从 `input_modalities` 保留 Pi 支持的 `text` / `image` 并去重；字段缺失/类型错误或没有可支持输入时明确报错，不臆测图像能力 |
| `contextWindow` | 使用正安全整数 `context_window`；不扩张到 `max_context_window`，不重复套用 Codex 专属有效上下文百分比 |
| 推理 | 校验 `supported_reasoning_levels` 对象数组；已知 effort 映射到 Pi 同名等级，`none` 对应 `off`；未声明的等级显式置 `null`。保持已有 `minimal → low` 适配，但只在缓存支持 low、未声明 minimal 时使用。未知 effort（如 ultra）不映射成 max；声明非空但没有 Pi 可用等级则报错；空数组表示非推理模型 |
| `maxTokens` | 缓存当前没有该字段。从 Pi 公共 `getBuiltinModels("openai-codex")` 返回值中按**精确 ID**取得有效输出上限；新模型未被 Pi 收录时采用统一保守适配值 `16384`，不超过缓存上下文。这只是 Pi 必需元数据的补值，不是官方上限，也不是备用模型列表；README 明示其含义 |
| `compat` | 仅从 Pi 内置同 ID 模型摘取 `supportsOpenAIGrammarTools`、`supportsAdditionalTools`、`supportsToolSearch` 三个已用布尔标记；未知模型不启用这些可选优化，沿用 Pi 普通工具协议。不能把 Codex 的 `supports_search_tool` 或 `tool_mode` 直接当成 Pi 同名协议能力 |
| `cost` | 始终生成四项全零；不继承 Pi 内置费用/tiers，也不读取缓存价格或 CC Switch 定价 |

实现约束：`index.ts` 仅通过公共 `@earendil-works/pi-ai/providers/all` 读取内置模型数据，作为参数传给模型解析模块；不调用 `builtinProviders()` / `createProvider()`，不实例化第二套认证或流式运行时。解析模块仅使用 Node 内置模块和类型导入，测试可注入少量合成元数据，不依赖安装路径或真实模型名单。

### README 的最终目录要点

1. 一句话定位与职责表：Codex 现有凭据才是插件前提；CC Switch 是可选的账号管理与费用统计工具。
2. 前置条件、安装、首次 `/login`、`/model`、`pi list` 和 `pi --list-models`；注明核验版本。
3. `CODEX_HOME` / 默认目录、两个 auth 文件的不同职责；插件不直接写入凭据，但 Pi 会保存 OAuth 缓存，不能笼统宣称系统不保存 token。
4. 模型自动同步规则、过滤规则、必需元数据补值；正常使用不再编辑任何插件模型配置。
5. Codex 刷新缓存后 `/reload`；单独 `/model`、Pi `/login` 或 `pi update --models` 不保证刷新 Codex 缓存。缓存时效与账号归属由 Codex 负责，插件不进行 TTL/账号绑定推测。
6. 账号切换下一请求生效与模型列表需要 reload 的区别；过期凭据由 Codex 或 CC Switch 更新，插件不刷新。
7. Pi `$0` 是占位，token 统计仍保留；CC Switch 使用自己的定价表，缺价格仍可能显示零，金额是估算而不是订阅账单。插件不负责会话采集、workflow 持久化或额度查询。
8. 故障表：缓存缺失/损坏/空、旧模型、Pi 未收录新模型的补值、登录标记缺失、token 过期，以及插件加载失败但内置模型仍可见；修复后 reload。
9. 离线测试命令与安全注意事项。

## Files to modify

路径均相对 `work/scripts/pi/pi-codex-official/`：
- `extensions/index.ts`：接入模型解析结果，删除静态清单/价格校验职责，保持 provider 注册方式。
- `extensions/codex-models.ts`（拟新增）：小型、可独立测试的缓存解析及最小适配模块。
- `config/models.json`、`config/README.md`：实施阶段删除，说明并入主 README，不保留备用清单。
- `test/codex-models.test.ts`（新增）：缓存读取、过滤、字段映射、元数据补值、全零价格、失败与重复读取测试。
- `test/host-lifecycle.mjs`（新增）：真实宿主 SDK 启动/reload 回归测试；`npm run test:host`，可传已安装 SDK 入口 file URL，不增加依赖或修改真实配置。
- `test/codex-auth.test.ts`：补 Codex 路径一致性与显示/错误文案断言；保留原认证回归用例。
- `README.md`：更新为完整、自足的用户说明。
- `extensions/codex-auth.ts`：仅调整显示与错误文案，以 Codex 为主、CC Switch 为可选修复途径。模型缓存路径使用 `path.join(path.dirname(codexAuthFile()), "models_cache.json")`，无需新增路径抽象；不改认证校验和刷新策略。
- `package.json`：描述改为复用 Codex 本地 ChatGPT 凭据；按 Pi 包规范为宿主包声明 `peerDependencies: "*"`，不捆绑/安装另一份 Pi，不新增测试框架。保持 `pi.extensions` 明确指向唯一入口，辅助模块不被当成扩展加载。

Provider/OAuth 的显示名统一以“Codex 本地凭据”表达，不再暗示 CC Switch 必装；provider ID `openai-codex` 不变，不迁移登录缓存或模型默认值。

## Reuse

- `extensions/codex-auth.ts`：`codexAuthFile()` 的 `CODEX_HOME`/默认目录规则；`createLiveCodexOAuthConfig()` 的只读认证生命周期。
- `extensions/index.ts`：既有 `pi.registerProvider()` 兼容层注册方式、provider ID/API/base URL；既有字段检查经验，不引入第二份 pi-ai 运行时。
- `test/codex-auth.test.ts`：`node:test`、临时目录、临时合成数据与自动清理模式。
- `package.json`：已有 `node --test test/*.test.ts`，不新增测试框架。
- Pi 公共 `@earendil-works/pi-ai/providers/all` 的 `getBuiltinModels()`：仅补充缓存候选的输出上限和三项工具能力；不复制维护 Pi 元数据文件，不导入其私有 `dist` 路径。已核对宿主扩展加载器对此公共入口的 alias/virtualModules 支持。
- Pi 原有 `/reload` 生命周期：无需新 UI、错误后台服务或同步命令。实施发现 CLI 吞诊断、reload 留旧注册，分别采用脱敏 stderr + 抛错、reload shutdown 钩子注销本插件动态覆盖；后者仅恢复内置 provider，不禁用内置 provider。

## Steps

- [x] 确认同步时机和缓存异常策略：启动 / `/reload`；异常时报错、不注册，无列表回退。
- [x] 核对 Pi 官方文档、公开类型/API 与实际 Codex 缓存字段，确定最小字段映射、价格占位及无备用列表策略。
- [x] 将缓存读取与映射拆成一个小型可测试模块，接入 provider 注册。
- [x] 移除独立价格维护和不再需要的静态模型清单配置；保持认证逻辑及请求路径不变。
- [x] 补齐正常、过滤、无效字段、重复 ID、缓存缺失/损坏、元数据补值及重新读取测试；使用宿主 CLI/加载器验证注册与失败行为。
- [x] 更新主 README，消除“实时账号切换”等同于“实时模型列表更新”的歧义。
- [x] 执行自动测试和端到端验证，报告已验证结果及边界（CLI + 实际 SDK reload 已验；TUI 人工验收未执行）。

## Verification

- 单元测试全部使用合成缓存/凭据或临时文件，不使用真实 token，不访问网络，不依赖本机 CC Switch 数据库。
- 覆盖 `CODEX_HOME` 路径一致性、可见/API 可用模型过滤、字段映射、推理等级、上下文与输出上限分别处理。
- 验证模型新增/删除在约定刷新时机生效；不擅自改动 Pi 默认模型或当前会话选择。
- 覆盖缓存缺失、目录/不可读路径、错误 JSON、错误根结构、空候选、候选字段无效、重复 ID；断言错误包含路径与字段/原因、不包含测试用敏感标记或原始 JSON。
- 验证内置元数据只按同 ID 补值：不引入内置多余模型，不覆盖缓存上下文/输入/推理等级，不继承内置价格或 tiers；未知模型使用固定输出补值与普通工具能力。
- 覆盖推理等级精确映射、minimal/low、off/none、缺失等级、ultra/未知等级；覆盖正安全整数校验、非数字/非有限/零/负值及输入类型交集。
- 同一路径先写缓存 A，再改为 B 并重新调用读取函数，验证新增/删除与能力变化生效、无模块级模型快照；解析前后输入对象和源文件不被修改。
- 原认证测试继续通过，新增用例不使用真实凭据。测试均在实施阶段运行，不在计划阶段创建临时非 Markdown 文件。
- 在插件目录运行 `npm test`；随后 `git diff --check`。
- 使用隔离 `PI_CODING_AGENT_DIR` 与临时 `CODEX_HOME`，仅加载本插件，以无网络 CLI/SDK 检查注册：成功时用合成唯一 ID 验证候选替换；失败时确认扩展错误且没有本插件注册结果，而不是要求所有内置 Codex 模型消失。`--list-models` 可能受认证可用性过滤，需用临时合成 Pi 登录标记或 SDK 检查，不能把空列表直接当作成功。
- 在隔离交互会话执行真实 `/reload`，覆盖“有效 A → 有效 B → 损坏 → 修复”，确认新增/删除、错误展示、插件旧快照不残留及恢复；不修改真实 Codex/Pi/CC Switch 配置。如果只能验证启动、不能操作 TUI，必须明确报告 `/reload` 手动验收未完成。
- 按 README 从安装到排错走查，确保用户不读代码也能理解职责与操作。保持已有范围外改动不变；不自动提交、不发起消耗真实额度的测试请求。

## 实施发现与验证记录

- 24 项离线测试通过（原认证 8 项 + 路径/文字 2 项 + 模型 14 项）。
- 隔离临时 Pi/Codex 目录与合成登录标记，实际 `pi --list-models` 验证 A → B → 损坏 → 修复（独立启动）通过，未发送模型请求。
- 宿主 `--list-models` 不显示收集到的扩展加载错误，且失败时仍返回 0 并列出内置模型。为落实明确报错，入口在缓存错误时输出一条脱敏 stderr 诊断再抛出，不干预宿主退出码。首次验证发现诊断缺失，修正后复验通过。
- 同进程 SDK 验证发现 Pi reload 在新工厂失败时保留旧动态 provider（首次回归测试失败）。因此增加 `session_shutdown(reason=reload)` 清理本插件覆盖，恢复内置 provider；新工厂成功后才重注册。不禁用内置 provider，不改宿主代码。
- 已将该发现固化为 `test/host-lifecycle.mjs`，实际 Pi SDK 的 A → B → 损坏 → 修复 → 缺失通过，确认无旧插件模型列表、无定价继承、默认模型与合成凭据不变。未发送模型请求。
- 最终复验：`npm test` 24/24；`npm run test:host -- file:///D:/Nodejs/node_modules/@earendil-works/pi-coding-agent/dist/index.js` 1/1；`git diff --check` 通过（仅 Git LF/CRLF 提示）。
- 实际 Codex 缓存只读 CLI 验证：隔离 Pi 配置、合成 Pi 登录标记、离线模式下，注册列表精确等于缓存的 6 个可见/API 可用模型，缓存字节保持不变；未读取真实 auth 内容。
- README 已按最终行为走查，含安装/首次登录、字段来源与未知模型补值、价格占位、账号切换、错误恢复、测试命令，以及 CLI 退出码/内置 provider 边界。
- 剩余验收边界：真实终端手动输入 `/reload` 与 TUI 错误展示未执行；已用同进程实际 `AgentSession.reload()` 验证其底层流程。没有执行真实模型请求或完整静态类型检查。现有环境只发现 TypeScript 4.5.5，不为本次变更安装新工具。
- 未修改用户真实 Codex/Pi/CC Switch 配置，未安装依赖、未提交；范围外未跟踪目录保持不动。

## 用户已确认

1. 启动或 `/reload` 自动读取最新缓存，不做运行时热更新。
2. 缓存不存在、损坏或没有可用模型时明确报错，不注册插件 provider，不提供备用模型列表。

