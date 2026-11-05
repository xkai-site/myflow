# pi-image-generation 模型升级与 TUI 优化计划

## Context
- 目标：补充 GPT Image 2.6 两款模型，保留 2.5、旧 key、Wan、RPC 与历史记录兼容；改善终端向导与结果展示。
- 当前处于规划模式，仅阅读与研究，不修改源码、不安装依赖、不调用付费接口。
- 初始 Git 工作区干净。
- 当前 OpenAI 默认 key 为 `openai`，对应 `gpt-image-2`；2.5 两款已存在。拟只修改 provider 默认引用为 `openai-flare-26`，不改变旧 key 含义。
- 当前向导：入口菜单 → 提示词 → 任务 → 账户 → 模型 → 编辑参考图 → 尺寸 → 画质 → 加载 → 结果；单选项已自动跳过。

## Approach
### 模型与参数
- `models.jsonc` 继续作为唯一目录。Schema 增加可选非空 `description` 与可选 `complexity: ChoicePolicy`；旧配置缺少定位仍能加载，禁止未知字段的现有校验继续保留。定位禁止换行、控制字符和中点分隔符，不增加第二份模型能力表或按 ID 分支。

| key | 模型 ID | 配置中的定位文案 |
| --- | --- | --- |
| `openai-flare-26` | `gpt-image-2.6-flare` | 快速生成与日常迭代 |
| `openai-sunburst-26` | `gpt-image-2.6-sunburst` | 精细创作与精确编辑 |
| `openai-sunburst` | `gpt-image-2.5-sunburst` | 上代精细生成与编辑 |
| `openai-flare` | `gpt-image-2.5-flare` | 上代快速生成 |

- OpenAI `defaultModel` 改为 `openai-flare-26`；`openai → gpt-image-2`、2.5 两个 key 及 Wan 两个模型能力保持不变。旧 OpenAI 仅增加必要定位“兼容已有工作流”，不研究更早型号。
- 2.6 均支持生成/参考图编辑；尺寸默认 `auto`，保留正方形、横向、纵向预设；画质为 `auto/low/medium/high/xhigh/max`，默认 `auto`；复杂度为 `low/medium/high`，默认 `high`。
- `complexity` 从配置贯通类型、解析/校验、runtime metadata、传输到 OpenAI 请求；RPC 增加可选 `--complexity VALUE`/`--complexity=VALUE`。不支持该参数的模型拒绝显式设置，且不发送字段；只根据配置决定支持性，不硬编码模型 ID。2.5 与 Wan 不新增此字段。
- 2.6 官方提示指南明确支持自定义尺寸（边长 16 倍数、比例 1:3 至 3:1）；当前插件的总像素、最长边、5 张/50 MiB 等额外限制按本地兼容/安全策略保守保留并明确标注，不宣称是 2.6 官方能力上限。不把 Platform 的 16 张或 JSON URL 长度限制直接套入 Codex 通道；不扩展现有输入格式集合。未明确覆盖 2.6 的资料不能作为放宽限制的依据。

### TUI 与文案
- 复用宿主选择器、编辑器、主题和加载组件，不新增前端依赖。
- 向导改为：任务 → 提示词（支持预填）→ 账户（单账户跳过）→ 模型（单模型跳过）→ 编辑参考图（仅编辑）→ 参数菜单 → 执行 → 结果。删除入口“生成/编辑或账户设置”的重复菜单，设置仍由 `--settings` 进入，无账户时沿用设置引导。
- 参数菜单首项为“开始生成”，随后只列当前模型支持的尺寸、画质、复杂度及当前值；默认可直接执行，选择某参数才打开原生选择器，返回后保留已选值。参数选择中 Escape 返回参数菜单，主菜单/其他步骤 Escape 取消整次向导。单值参数显示当前值但无需再选择。
- 原生 `ctx.ui.select` 在 Pi 1.5.0 中使用 `Text` 自动换行而非截断，可直接显示 `模型名称 - 定位`；使用原生焦点、方向键、Enter、Escape，不新增自定义选择器。`SelectList` 虽有 value/label/description，但窄于 40 列时隐藏 description，本任务不使用它。
- 默认模型置于模型列表首项并标“默认”；展示选项与返回对象用本次生成的映射绑定，不解析名称/key/描述。重名选项才追加 key 消歧。保持 `openai` 等旧 key 可显式选择。
- 复用 `BorderedLoader` 的 `signal`、`onAbort`、`dispose`，文案显示生成/编辑与配置中的模型名称；保留一次完成保护。取消立即关闭加载并反馈，未结算请求仍受忙碌保护，避免快速重开造成重叠；取消后不发布迟到结果、不重复发送、不自动重试。
- TUI 结果由历史条目集中展示成功、保存路径、原图链接与可用预览；通知只做简短成功反馈，避免重复路径。RPC 保留现有 `Saved N image(s):` 机器可读通知与 URL 格式，不因中文化破坏已有消费者。宿主自带键位提示维持宿主语言，不修改宿主全局行为。
- 已确认：本轮涉及的向导、状态、结果、命令帮助统一中文；模型名、key、命令及参数值保留英文。底层错误保留必要原始信息，不引入国际化系统。
- 账户设置及已有秘密输入只调整用户文案、间距与分隔方式，不修改凭据读写、认证优先级或输入协议；移除秘密输入提示中的圆点分隔符。
- 全部自定义样式仅使用宿主 `accent/text/muted/dim/success/warning/error/mdLink/border` 语义色，不新增硬编码色。结果文本需在渲染/失效时重新取主题；图片读取/解码不放进每帧循环。

### 已完成的检查与限制
- 已读取模型、命令、runtime、OpenAI adapter、账户设置、秘密输入、README、模型/命令/SDK/宿主测试。未发现仓库内 AGENTS.md 或专用设计规范，遵循任务中的终端设计规则与安装 SDK 文档。
- 测试使用临时文件、mock fetch 或回环服务器，包含临时产物清理；规划期遵守只读约束不运行测试，批准后在改源码之前执行两条基线命令并记录结果。
- 已定位实际 SDK：Pi 1.5.0，Node v24.22.1；SDK 位于 `C:/Users/HP/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/`。
- 官方来源已核对：[2.6 Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst)、[2.6 Flare](https://developers.openai.com/api/docs/models/gpt-image-2.6-flare)、[2.5 Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)、[2.5 Flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare)、[生成指南](https://developers.openai.com/api/docs/guides/image-generation)、[2.6 提示指南](https://developers.openai.com/api/docs/guides/image-prompting)及指南链接的 Images generate/edit 参考。2.6 提示指南的专属参数表明确支持六档画质及三档复杂度，自定义尺寸规则位于该表后。
- [发布文章](https://openai.com/index/introducing-images-2-6/)直接抓取及 Markdown 尝试均为 403，仅搜索摘要可见；不冒充已阅读全文，不修改本机抓取设置。定位与参数以已读官方模型页和 2.6 专属指南为准。
- 当前 TUI 将整段命令参数作为提示词预填，RPC 才解析选项；保留此差异，不改变 RPC 附图被宿主命令分发忽略的已知边界。

## Files to modify
以下均相对于 `work/scripts/pi/pi-image-generation/`：
- `models.jsonc`、`src/model-config.ts`：模型、定位、默认值与最小 Schema。
- `src/types.ts`、`src/command.ts`、`src/runtime.ts`、`src/openai-codex-images.ts`：复杂度参数链路及帮助；不改认证及网络基础设施。
- `extensions/index.ts`：向导编排、忙碌/取消生命周期、结果发布。
- 新增 `src/tui-options.ts`：选项构建、默认排序、显示与对象映射、参数摘要；从入口局部移出选择辅助函数，不建立通用表单框架。
- 新增 `src/result-view.ts`：从入口移出已有结果 renderer，集中处理主题、成功文案、原图链接及预览兼容。
- `src/account-settings.ts`、`src/secret-input.ts`，必要时 `src/credentials.ts` 的状态文案：中文化，不改认证行为。
- `test/model-config.test.ts`、`test/command.test.ts`、`test/host-lifecycle.mjs`；新增 `test/tui-options.test.ts` 与宿主 TUI 测试模块，继续由 `npm run test:host` 执行。`test/sdk.mjs`/`test/sdk.test.mjs` 优先原样复用，不无故修改定位器。
- `README.md`：模型列表、选择建议、参数、默认策略、向导、RPC 格式和测试方式；不增加阶段日志。

## Reuse
- `src/model-config.ts`：`ChoicePolicy`、`sizeForTask`、配置校验与尺寸校验。
- `extensions/index.ts`：迁移并扩展 `selectItem` 单选项自动选择和 `selectPolicy` 默认排序；保留 `getAvailableProviders`、`publishOutcome` 的职责。
- `src/image-files.ts`：`parseReferenceImagePaths`、`loadInputImages`、校验、安全保存和路径限制保持原样复用。
- `src/preview-link.ts`：`formatImageLink` 的完整 URL、OSC 8、主题及无链接能力降级保持复用。
- `test/sdk.mjs` 与 `test/host-lifecycle.mjs`：真实 SDK/jiti 定位、隔离临时目录、禁外网及模拟传输。
- 宿主：`ctx.ui.select`、`ctx.ui.editor`、`ctx.ui.custom`、`BorderedLoader`、`Container`、`Text`、`Image`；`visibleWidth`/`stripTerminalSequences` 用于验证中英混排及窄终端，不用字符串长度估算列宽。

## Steps
- [x] 阅读指定源码、测试、设计约定与安装 SDK，确认 API 和交互事件路由。
- [x] 核实官方 2.6 与 2.5 定位、生成/编辑、画质、复杂度及已明确尺寸规则，记录来源与资料限制。
- [x] 审查测试脚本副作用，确认普通测试不调用付费 API。
- [x] 批准后重新检查 Git 状态，保护期间新增的未提交修改；运行现有单元与宿主测试并记录基线。
- [x] 添加模型、定位、默认引用及必要的最小参数链路。
- [x] 优化向导、稳定选择映射、默认值、加载与结果展示。
- [x] 补充模型、实际选择行为、键盘、窄终端、主题、历史记录及 RPC 回归测试。
- [x] 更新 README 与帮助，执行完整验证并审查 Git Diff。

## Verification
批准后在插件目录先跑基线，再在修改完成后实际执行 `npm test` 与 `npm run test:host`。不安装依赖，不调用真实生图接口，不运行本机付费/网络探测脚本。

- **模型与参数**：按 key 查模型而非数组切片；断言新旧模型 ID/定位/启用状态、OpenAI/Wan 默认、2.5 质量档位与 Wan 编辑尺寸保持不变。校验复杂度合法/非法/缺省/不支持及生成、编辑序列化。禁用默认引用应拒绝，禁用非默认模型应隐藏且显式请求拒绝，保留原测试重要断言。
- **实际选择**：Mock Context 驱动完整向导，捕获到达参数菜单的模型 key/请求参数；覆盖每个 2.6/2.5、修改描述、重名消歧、未知返回值、单/多模型与单/多账户。验证默认模型首项、每个参数修改后保留、单值跳过、无质量/复杂度不展示，以及预填提示词不丢失。
- **宿主键盘与布局**：通过同一 SDK 安装中的原生选择/编辑组件发送方向键、Enter、Escape，验证焦点和取消路径，而非只检查字符串。渲染宽度 24/40/80/120 列，检查中英混排及每行 `visibleWidth <= width`，选项不丢失；验证长路径与 OSC 8 换行。使用浅色/深色主题及失效后重渲染检查语义色，不新增全局主题行为。
- **执行生命周期**：阻塞 mock 请求验证重复调用被拦、取消触发 AbortSignal、仅完成一次、取消不发布/不重试、迟到成功忽略、失败通知脱敏、结束后解除忙碌；模拟等待多次渲染检查加载内容稳定，无假进度。
- **结果与历史**：保留原有保存、每图一个原图 URL、历史旧 metadata、reload、损坏/缺失图片、无图片/无链接能力、主题切换、RPC 无 ANSI/HTML 的断言；TUI 路径仅在持久条目出现一次，非 TUI 保留旧通知协议。
- **命令回归**：`/image`、`/image <prompt>`、`--help`、`--settings`、原有显式 key/尺寸/画质、RPC 生成、TUI 编辑、忙碌与取消；RPC 附图限制保持并写明，不新增能力。
- **人工检查**：若当前会话可用交互终端，只用取消前流程检查窄窗口/输入焦点/方向键与主题；否则明确报告人工 TUI 检查未执行，不把 mock 当成人工验证。
- **最终审查**：`git diff --check`、`git diff --stat` 与逐文件 Diff，确认只涉及本插件及本计划、无新增运行时依赖、无模型 ID 分支、无中点分隔文案、无削弱测试。完成报告列出模型/默认、最终文案、交互差异、文件、实测结果及资料/人工验证限制。
