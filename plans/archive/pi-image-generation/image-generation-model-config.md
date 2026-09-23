# 生图插件：单一模型配置与双认证模式

## Context
- 目标：将生图模型 ID、显示名、默认值、能力限制和菜单选项集中在一个用户可维护的配置文件，常规模型升级不再修改多处代码。
- OpenAI Codex 继续复用 `pi-codex-official` 提供的 `openai-codex` 认证，不实现独立 OAuth 登录或 token 刷新。
- 千问仅支持 Qwen Token Plan CN：在 `/image` 账户设置中填写并保存 API Key，后续直接使用；保留已有 Provider 凭据复用。不扩展普通百炼/DashScope 按量付费接口。
- 当前仅规划，未修改代码或运行生图请求。

## Approach
- 将提供方、模型和认证来源分离：提供方描述协议及认证方式，模型引用提供方并声明能力。
- 单一模型配置作为菜单、默认模型、命令解析与参数校验的数据来源；不维护第二份模型清单。
- 两类认证：复用 Pi Provider 登录；独立 API Key。模型配置只引用凭据来源，不存放真实密钥。
- 同一协议内的模型 ID、名称、尺寸、质量、参考图限制变更只需更新配置；新的网络协议仍需代码适配。
- 已确认：插件内只维护一个 `models.jsonc`，必要注释使用简短英文；修改后 `/reload` 生效。
- 已确认：`/image` 提供账户设置，千问 Key 填写保存后持续使用；兼容已有 `qwen-token-plan-cn` 凭据，无需重填。

### 单一模型配置
- 唯一路径：`work/scripts/pi/pi-image-generation/models.jsonc`，按扩展文件位置解析，不按当前项目目录查找；不生成模板副本、用户级模型副本或自动发现清单。
- 结构为 `version`、`providers`、`models`；模型使用稳定 `key` 区别于上游 `id`，升级上游 ID 不影响默认选择或旧命令。
- Provider 字段：`id`、`name`、`adapter`、`auth`、`defaultModel`。`adapter` 仅允许现有 `openai-codex-images` / `ali-wan-images`。
- `auth.type` 支持 `provider` 和 `api-key`：OpenAI 为 `{ type: "provider", providerId: "openai-codex" }`；千问为 `{ type: "api-key", env: "PI_IMAGE_QWEN_API_KEY", fallbackProviderId: "qwen-token-plan-cn" }`。凭据存储槽由稳定 Provider ID 决定，不允许配置任意凭据文件路径。
- Model 字段：`key`、`id`、`name`、`provider`、`tasks`（生成/编辑）、`prompt.maxChars`、`inputImages`（数量、单图字节上限、MIME 类型）、`size`（默认值、带显示名的选项、自定义尺寸规则）、可选 `quality`（默认值及选项）。尺寸规则包括分隔符、像素范围、长边上限、宽高比及步长；生成/编辑可声明不同尺寸规则，使 Wan Pro 的 4K 限制无需硬编码。
- 初始三个稳定 key 保留 `openai`、`wan`、`wan-pro`；默认模型、参数及能力迁移现有值，不顺便升级模型。配置决定菜单顺序；质量字段缺失则隐藏质量菜单且拒绝 `--quality`。
- 用正式 JSONC 解析器 `jsonc-parser` 支持注释和尾逗号，不用正则剥注释或执行配置。运行时严格校验版本、未知字段、重复属性/ID/key、关联引用、默认值及范围；仅支持代码能识别的 MIME/参数，不猜测能力。
- 启动与 `/reload` 读取并校验整份配置；一次请求使用同一配置快照。缺失或损坏时 `/image` 给出文件位置、行列或字段路径和修复提示，不静默回退旧清单，不影响其他插件。仍保留设置/帮助入口；修复后 `/reload` 恢复。
- 仅已有协议内的名称、ID、选项与能力变化承诺只改配置；新协议/新请求字段/新文件格式仍需代码适配。输出下载大小和文件系统防护属于代码级安全策略，不混入模型清单。

### 认证与账户设置
- OpenAI 每次请求通过当前 `ctx.modelRegistry.getProviderAuth("openai-codex")` 解析；不保存、复制 OAuth，不启动 Codex、不新建 OAuth 流程或自行刷新 token。设置仅展示状态及既有插件的登录/刷新指引。
- 千问优先级：独立已保存 Key → 专用环境变量 `PI_IMAGE_QWEN_API_KEY` → 已有 `qwen-token-plan-cn` Provider。传统 `QWEN_TOKEN_PLAN_CN_API_KEY` 仍交由原 Provider 解析，避免复制一套解析逻辑。只在来源未配置时向下查找；凭据文件损坏、读取失败或已配置来源认证失败时明确报错，不偷偷换账号。
- 独立 Key 存于 `getAgentDir()/pi-image-generation/auth.json`：用户级凭据数据，不是第二个模型配置。保存后立即生效，跨项目/重启可用；每次请求重新读取，不影响千问对话账户。保存操作不发送生图测试请求，不把“已保存”说成“远端验证成功”。
- 独立 Key 使用固定 CN 官方端点；复用 Provider 时凭据、请求头和端点作为同一来源处理，不能将独立 Key 与其他来源的请求头混合。只允许本次两种官方服务端点；模型文件不得把 OAuth 或 Key 重定向到任意主机，认证请求禁用自动重定向。
- 复用视频插件的秘密输入实现方式，在生图插件内做最小适配；只显示 `[secret entered]`，不回显字符，不把输入放进普通编辑器、会话、剪贴板输出或日志。支持粘贴、退格、取消，限制输入长度并拒绝无效控制字符；取消不修改已有凭据。
- 凭据持久化使用受限目录/文件权限、符号链接检查、`proper-lockfile` 的有界文件锁、锁内重读、唯一临时文件与原子替换；失败保留旧文件、清理本次临时文件，删除只作用于独立 Key。Windows 依赖用户目录 ACL，文档明确本地存储并非加密保险库。

### 用户交互与兼容
- 空参数 `/image` 显示 `Generate / edit image` 与 `Account settings`，默认选生成；`/image --settings` 直接打开设置，`/image <prompt>` 保留直接进入生成流程。
- 没有可用账户时引导进入设置，而非只显示错误退出；账户设置显示来源与配置状态，千问支持添加/替换 Key、确认后删除独立 Key；删除前提示将恢复环境变量/已有 Provider 或变为未配置，绝不删除既有 Provider 凭据。
- 生成只列有凭据的 Provider 下、支持所选任务的模型；一个账户自动跳过账户选择，一个模型自动跳过模型选择。尺寸/质量预选配置默认值，菜单显示名称但按稳定 key/value 处理。
- 非交互/RPC 保留 `/image openai|wan|wan-pro ...`，这些词成为配置中的模型 key；新增模型可同样通过 key 调用，无需增加代码枚举。只有一个可用账户时采用其配置默认模型；多个账户未指定模型时给出明确选择提示。
- `--settings` 不接受 Key 命令行参数；非 TUI 模式不弹秘密输入，提示在 TUI 保存或设置环境变量。已有会话条目及图片路径保持可读，不迁移历史记录。
- 保持每次一张、无水印、可取消及原子落盘；不注册 LLM 工具，不触发对话轮次。

## Files to modify
基准目录：`work/scripts/pi/pi-image-generation/`。
- 新增 `models.jsonc`：唯一模型清单，必要注释使用简短英文。
- 新增 `src/model-config.ts`：JSONC 读取、结构校验和查询。
- 新增 `src/credentials.ts`、`src/account-settings.ts`：认证来源选择、独立 Key 持久化和账户设置。
- 新增 `src/secret-input.ts`：仅在 TUI 内掩码输入 Key，不进入主编辑器或会话。
- `extensions/index.ts`：模型注册、可用账户判断、菜单和认证接入。
- `src/command.ts`：替换硬编码模型映射、默认值和参数限制。
- `src/types.ts`：解除固定模型 ID 联合类型与提供方/模型耦合。
- `src/image-files.ts`：输入图片能力改为接收所选模型配置，保留文件签名和输出路径保护。
- `src/openai-codex-images.ts`、`src/ali-wan-images.ts`、`src/http.ts`：清除剩余模型默认值硬编码，适配来源一致性、端点/重定向限制及实际密钥脱敏；保留原协议结构。
- `package.json`、新增 `package-lock.json`：显式声明 `jsonc-parser`、`proper-lockfile` 运行时依赖及测试命令，不依赖 Pi 未公开的传递依赖路径。
- 新增 `test/*.test.ts`：配置、命令、认证、秘密输入、传输与生命周期离线测试。
- `README.md`：配置字段、双模式认证、存储位置、迁移及模型升级边界；纠正“自动刷新”描述。
- 不修改 `pi-codex-official` 或 `pi-video-generation`，不引入对同级插件源码的运行时导入。

## Reuse
- `extensions/index.ts` 的 `ctx.modelRegistry.getProviderAuth()`：现有 Provider 认证解析，OpenAI 保持逐请求解析。
- `getAvailableProviders()` / `selectProvider()` / `selectImageSize()`：保留交互流程，数据来源改为配置。
- `createRuntimeImagesModels()`、`generateAndSave()`：继续复用现有模型运行时和生成落盘链路。
- `src/command.ts` 的解析、尺寸处理逻辑：保留可复用校验，仅将模型策略转为配置数据。
- `src/openai-codex-images.ts`、`src/ali-wan-images.ts`：保留两种现有协议适配器。
- `src/http.ts` 的 `sanitizeError()`：继续用于错误脱敏，借鉴 `../pi-video-generation/src/http.ts` 的显式 secrets 替换，覆盖无 `sk-` 前缀的 Key。
- `../pi-video-generation/src/config-ui.ts` 的 `promptSecret()`：已有不回显输入、Kitty 键盘与 bracketed paste 模式，适配至本插件并补齐分片粘贴/取消测试，不重新设计整套 TUI。
- `../pi-video-generation/src/config.ts` 的字段路径校验与受限权限/原子写入模式；仅复用适用模式，不沿用将 Key 和模型放在同一文件的设计。

## Findings / Progress
- 已阅读两个插件 README，以及生图插件的命令解析、类型、模型注册和主要交互/认证代码。
- 目前 OpenAI 和千问都从 ModelRegistry 取凭据；千问尚无生图插件内独立填写 Key 的入口。
- `openai`、`wan`、`wan-pro` 当前混合了账户与模型选择概念，需要分离。
- 菜单尺寸、质量及模型能力散落于 `extensions/index.ts` 和 `src/command.ts`。
- `src/image-files.ts` 另有 OpenAI 50 MB / Wan 20 MB 输入限制及 MIME 校验；输入能力需要同样配置驱动，输出安全上限保留代码级保护。
- 当前包没有测试脚本或测试目录，需新增离线测试入口。
- 已核验：原生 Provider auth 协议存在 secret 提示类型，但扩展公共上下文没有直接调用宿主登录/保存的入口。
- 用户已确认本次仅支持 Token Plan CN，同步图片协议不变。
- 新发现同级视频插件已有秘密输入和配置校验/原子保存模式，可以做局部适配；秘密输入在 `config-ui.ts` 内，非独立文件。
- 当前生图插件未声明 JSONC 解析器；实施时显式新增依赖，规划阶段未安装任何依赖。
- 已完整查阅 Pi README、extensions.md、custom-provider.md、tui.md、providers.md、sdk.md，并核对认证示例和安装版本类型定义。
- ModelRegistry 公开接口仅提供认证解析/状态，没有扩展可直接调用的保存或登录方法；`AuthStorage` 未从 SDK 根入口导出，不依赖私有深层导入或强转访问 runtime。
- 原生 `LoginDialogComponent` 会回显输入内容，`ctx.ui.input()` 未提供密码掩码选项，不能直接作为 Key 输入界面。需以 `ctx.ui.custom()` 实现小型掩码输入组件，复用 TUI 容器/文本/键盘能力。
- 独立凭据文件和来源优先级已纳入上方 Approach；不访问或修改宿主私有 runtime，不改变另两个插件职责。
- 工作区已有与本任务无关的未跟踪目录，计划不触碰。

## Steps
- [x] 确认单一 JSONC、填写保存 Key、兼容既有千问凭据。
- [x] 确认只支持 Token Plan CN。
- [x] 检查图片校验、传输实现、测试现状、可复用代码及 Pi SDK 文档。
- [x] 定义配置结构、严格校验、加载时机、凭据策略与错误提示。
- [x] 审核批准后添加配置、解析/校验模块与显式依赖，先以现有参数编写回归测试。
- [x] 将模型选择、注册、默认值、命令及输入能力校验改为配置驱动，移除生产代码中的固定模型 ID。
- [x] 实现双认证解析、秘密输入及账户设置，补充凭据读写和端点安全约束。
- [x] 完成离线集成测试、文档与静态硬编码检查；明确记录未执行的真实网络验证。

## Verification
- 在插件目录运行新增 `npm test`（Node 内置测试框架）；使用临时目录、合成 Key/JWT、stub ModelRegistry/UI 和 mock fetch，不读取真实凭据、不请求真实生图。
- 配置：覆盖 JSONC 注释/尾逗号、缺失、损坏、重复属性及 ID/key、未知字段、无效默认/引用/范围、不支持的 adapter；错误只包含位置和原因，不回显原始配置或密钥。
- 核心验收：测试仅改配置的模型 ID/名称/尺寸/质量/参考图限制，菜单、默认值、请求 model 和校验同步变化；再添加一个同协议模型，无需改 TypeScript。
- 生命周期：配置 A → B → 损坏 → 修复，验证 reload 不残留旧模型且其他插件不受影响；首次设置、保存立即可用、重启/跨项目复用、删除与取消均覆盖。
- 认证：仅 OpenAI、仅独立千问 Key、仅旧千问 Provider、两者同时、环境变量和已有 Provider 并存；验证来源优先级及认证失败不降级。模拟 OpenAI 两次请求间账号变化，确保重新解析而非缓存旧 token。
- 安全：保存失败保留旧 Key；并发保存/删除不破坏文件；损坏文件不覆盖；符号链接拒绝；POSIX 权限及 Windows 路径验证；输入渲染、分片粘贴、错误文本、会话和配置中不出现合成密钥。
- 传输：mock 文生图/编辑、默认参数、Wan Pro 4K 仅生成、非官方认证主机/跨主机重定向拒绝、来源 headers 不混用；取消、MIME/签名校验、唯一文件名和原子落盘回归。
- 静态检查：生产代码不再包含 `gpt-image-2` / `wan2.7-image` 等具体模型判断，不保留第二份清单；测试夹具和 README 示例允许出现模型名。
- 手动 TUI 验收：`/image`、`/image --settings`、Key 保存/替换/删除/取消、来源提示及配置修改后 `/reload`；秘密输入不出现在主编辑器或终端回显中。API Key 保存本身不消耗额度。
- 真实生图另需用户明确授权，不作为自动测试的一部分；若未授权，在交付中注明未做线上验证。

## 已确认的用户偏好
1. `/image` 提供账户设置，千问 Key 保存后直接复用。
2. 兼容已有 `qwen-token-plan-cn` 凭据，不要求重填。
3. 仅一个 `models.jsonc`；不写中文注释，必要说明使用简单英文。
4. 本次千问只支持当前 Token Plan CN。

## Scope
- 所有业务需求已确认，提交计划审核后才实施。
- 不增加生图模型、不接普通百炼、不引入任意代理/自定义认证主机、不重构视频插件、不修改已有用户凭据。
- 规划阶段仅修改本 Markdown；计划已批准，进入实施。

## Execution log
- Step 5: 添加单一 models.jsonc、严格 JSONC 校验、尺寸策略及显式依赖。`npm install --ignore-scripts --no-audit --no-fund` 完成；`npm test` 5/5 通过，未访问真实凭据或生图服务。
- Step 6: 命令、菜单、默认值、输入图片限制已统一读取配置，运行时生成链路提取到 src/runtime.ts 便于测试。`npm test` 8/8 通过；生产代码具体模型 ID 搜索无匹配。
- Step 7: 完成双认证、独立凭据存储、账户设置及不回显输入；测试覆盖来源优先级、损坏拒绝、并发更新及 OpenAI 逐请求读取。
- Step 8: `npm test` 14/14 通过；`npm run test:host -- file:///D:/Nodejs/node_modules/@earendil-works/pi-coding-agent/dist/index.js` 通过，覆盖三模型共 6 个 mock 生成/编辑请求、运行时注册、命令/设置及重新初始化。git diff --check 无错误；生产 src/extensions 内具体模型 ID 搜索无匹配（rg 退出码 1 表示无匹配）。README 已更新。
- 宿主测试首次因 ESM-only Pi AI 无 require 导出失败，改用测试专用的已安装 SDK 相对路径加载后通过；生产代码不使用该路径。
- 验证边界：未进行实际 TUI/终端秘密输入人工验收，未运行完整 AgentSession.reload 集成流程、POSIX 权限或所有符号链接故障场景，也未做 TypeScript 全量类型检查。配置 A/B/损坏/修复有离线测试；宿主测试仅验证重新实例化而非完整 /reload。
- 未读取真实凭据、未发送真实生图请求、未消耗生图额度、未提交 Git；其他两个插件及既有无关目录未修改。
