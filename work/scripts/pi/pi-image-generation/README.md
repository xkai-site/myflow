# pi-image-generation

通过 Pi 的 **`/image` 斜杠命令**生成或编辑图片。用户在 TUI 操作，自动化通过 RPC 分发命令；命令直接处理图片请求，图片账户 provider 负责认证和请求。

## 安装与首次调用

前提：已安装 **Pi ≥ 0.99.0**，Node.js ≥ 22.19.0。在本插件目录执行：

```powershell
npm install --ignore-scripts --legacy-peer-deps
pi install .
```

本地安装引用源码目录，后续加载仍需保留此路径。启动 Pi；已运行的 Pi 执行 `/reload`。
新增 Markup 解码依赖 `sharp` 的当前平台原生可选包，请勿使用 `--omit=optional`。支持的预编译平台无需安装脚本；原生包只在显式启用 Markup 并执行该任务时加载。XML 校验使用纯 JS `saxes`。
本扩展通过 `createModels()` / `createProvider()` 创建插件局部的图片模型集合，使用 Codex / Token Plan CN 请求协议。Pi 的聊天模型与 Agent 工具分别由宿主管理。
完成下文任一种认证后，在要保存图片的项目目录启动 Pi，输入：

```text
/image 一只坐在窗边的橘猫，水彩风格
```

TUI 会打开向导：生成/编辑 → 提示词 → 账户 → 模型 → 参数 → 执行。编辑任务在选定模型后询问参考图路径。单个可选账户或模型自动选择，模型列表展示“名称 - 定位”，账户默认模型排在首项并标注“默认”。

参数菜单展示当前尺寸、画质，以及模型支持时的复杂度、输出格式和背景；默认选中“开始生成”或“开始编辑”，直接 Enter 即使用默认值。需要修改时选择对应参数，修改后返回菜单并保留已选值。透明背景时格式列表不提供 JPEG，JPEG 格式时背景列表不提供透明，两种选择顺序均不会静默改写其他已选值。Escape 在参数选项中返回菜单，在其他步骤取消本次操作。加载时可取消；加载界面立即关闭，实际执行仍需安全结算，不能重复提交。请求发送前的认证等待支持取消，即使认证 Promise 不响应也不会继续发送图片请求；已经发送的请求、响应读取和文件操作则保留忙碌保护，直到实际结算，`/reload` 也不能绕过此保护。

成功后会话条目显示保存路径、原图链接和可用时的预览，通知仅显示保存数量。界面使用 Pi 原生选择器、编辑器、主题颜色和键盘操作，支持中英混排及窄窗口自动换行。

## 认证：任选一种

### OpenAI：使用已配置的 Pi provider

OpenAI 图片生成需要 Pi 中已有且已认证的 `openai-codex` provider。Pi 1.5.0 已内置此 provider（可能显示为 **OpenAI Codex (legacy)**）及其 OAuth 登录流程，无需另装 provider 插件。其他宿主版本若未提供此 provider，需先安装相应 provider 扩展。当前项目已不再提供此前 `pi-codex-official` 的 provider 功能。

最短路径：Pi TUI 输入 `/image --settings` → 选择 OpenAI → **登录 / 重新认证**。插件返回主输入框并填入 `/login openai-codex`，按 Enter 后由 Pi 打开原生认证流程；已有未提交草稿时先确认是否替换。登录完成后重新运行 `/image`，无需重启或 `/reload`。也可直接执行 `/login openai-codex`。内置 `/login` 不支持通过扩展命令分发，因此此入口仅预填，不自动执行，也不会把登录命令交给 LLM。

OpenAI 设置页还可刷新账户状态、查看认证说明与凭据路径。Pi provider 的登录凭据保存在 `<getAgentDir()>/auth.json`，不是图片专用 Key 文件。**普通 `openai` 与 `openai-codex` 是不同账户配置**；仅登录普通 OpenAI 或 Codex CLI 不会自动配置此图片账户，插件不会直接读取 `~/.codex/auth.json`。不要手动复制 token。

本扩展每次通过 Pi 的 `openai-codex` provider 读取认证信息，不自行登录或刷新 token。登录、保存与刷新均由 Pi/provider 负责；认证失效时可从上述入口重新认证。
请求发送到 ChatGPT Codex 订阅后端 `https://chatgpt.com/backend-api/codex/images/generations` 或 `https://chatgpt.com/backend-api/codex/images/edits`，**不是 OpenAI Platform API Key 接口**；账号权益、模型支持和额度由服务端决定。

### 千问：Token Plan CN API Key

最短路径：Pi TUI 输入 `/image --settings` → 选择千问 → 输入并确认保存 Key。输入不回显，下一次请求生效，无需重启。**只支持 Token Plan CN，不支持普通百炼/DashScope 按量付费 Key。**

认证优先级：已保存的图片专用 Key → 启动 Pi 进程中的 `PI_IMAGE_QWEN_API_KEY` → 已配置的 `qwen-token-plan-cn` provider。已有该 provider 可直接复用，不必另存 Key。仅来源未配置时查下一项；读取损坏或认证失败不会静默回退。

- 非 TUI 不能秘密输入：先在 TUI 保存，或由安全的启动环境注入环境变量；不要将 Key 放入命令、提示词或会话。
- 专用 Key 是用户级**明文**文件：`<getAgentDir()>/pi-image-generation/auth.json`，通常为 `~/.pi/agent/pi-image-generation/auth.json`，支持 `PI_CODING_AGENT_DIR`。Windows 依赖用户目录 ACL；不要提交或分享。
- 设置中可查看来源、替换/删除专用 Key；删除不影响原 provider 凭据。保存只验证本地写入，不调用付费接口验证。
- 请求固定到 `https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`。

认证只允许上述官方 HTTPS 服务主机，不支持自定义认证端点；认证请求及图片下载不自动跟随重定向。

## 命令与输入

| 入口 | 行为 |
| --- | --- |
| TUI `/image` | 直接选择生成或编辑，进入向导 |
| TUI `/image <prompt>` | 以整段参数预填提示词，再进入向导；**不解析下列非交互选项** |
| `/image --settings` | 账户管理：OpenAI 原生登录命令入口、状态/路径查看，千问专用 Key 设置；仅 TUI 可操作 |
| `/image --help`、`/image -h` | 用法和全部模型 key（含禁用标记） |
| RPC `/image …` | 按下列语法直接请求，不打开生成向导 |

非交互完整文本语法：

```text
/image [model-key] [--size VALUE|--size=VALUE] [--quality VALUE|--quality=VALUE] [--complexity VALUE|--complexity=VALUE] [--format VALUE|--format=VALUE] [--background VALUE|--background=VALUE] [--image PATH ...] [--markup PATH] [--] <prompt>
```

| 参数 | 规则 |
| --- | --- |
| `model-key` | 必须是第一个词，使用下表的 key，**不是上游模型 ID 或 provider ID**；仅一个图片账户配置有效时可省略，使用该账户 `defaultModel` |
| `--size` | 省略用所选模型/任务默认尺寸；值及限制见下节 |
| `--quality` | OpenAI 支持，省略为 `auto`；Wan 不接受此参数 |
| `--complexity` | 仅 2.6 两款支持 `low`、`medium`、`high`，省略为 `high`；2.5、旧 `openai` 与 Wan 拒绝此参数 |
| `--format` | 2.6/2.5 两款分别支持 `png`（默认）、`jpeg`、`webp`；旧 `openai` 与 Wan 拒绝显式参数 |
| `--background` | 2.6/2.5 两款分别支持 `auto`（默认）、`opaque`、`transparent`；静态栅格透明仅可搭配 PNG/WebP，JPEG + 透明在认证/请求前拒绝；旧 `openai` 与 Wan 拒绝显式参数 |
| `--image PATH` | RPC 本地参考图路径，可重复；第一张为编辑原图，追加图片为参考。相对路径基于 Pi 当前项目，不与附加图片混用 |
| `--markup PATH` | 仅对应模型显式启用实验 Markup 的编辑任务；独立透明 PNG，不计入普通参考图，不可重复 |
| `--` | 停止解析后续选项；提示词首词像模型 key/选项时用它消歧，例如 `/image -- wan is a word`（仅一个账户时） |
| `<prompt>` | 必填，支持单/双引号；词间空白合并。单引号外的反斜杠用作转义，未闭合引号/转义会报错 |

即使提示词已开始，后面的 `--size` 等仍会被解析，除非先写 `--`。未知 `--选项` 会报错。`--format` 和 `--background` 缺值、重复或值不在当前模型配置中均报错；已有尺寸、画质、复杂度参数的语义不变。省略新参数保留自动背景和 PNG 输出。

参考图编辑通过 TUI 向导选择，每行输入一个参考图文件路径，可拖入、加引号或写 `@path`；相对路径以 Pi 当前项目为基准，至少一张。RPC 可显式传入 `--image PATH`，例如 `/image openai-flare-26 --image 'original.png' -- 修改背景`。Windows 路径使用正斜杠或单引号，避免命令转义吞掉反斜杠。

**标准 RPC 图片附件仍不会自动用于编辑。** 编辑须显式使用本地 `--image` 路径；没有该参数仍按纯文本生成，可能消耗额度。新增文本选项不改变 RPC 消息、通知和结果路径协议。

## 模型、默认值与配置

唯一清单是本插件根目录 [models.jsonc](models.jsonc)，修改后 `/reload`。不会从 Codex 缓存发现图片模型，也不读取项目内或用户目录的另一份模型清单。

**当前七个模型均已启用**（`enabled` 省略即 true）。OpenAI 默认模型为 **GPT Image 2.6 Flare**，对应 `providers[].defaultModel: "openai-flare-26"`；千问默认仍为 `wan`。本地清单表示可选择，账号权限与额度仍由服务端决定。

| key | 上游模型 ID | 模型定位 |
| --- | --- | --- |
| `openai-flare-26` | `gpt-image-2.6-flare` | 快速生成与日常迭代，OpenAI 默认 |
| `openai-sunburst-26` | `gpt-image-2.6-sunburst` | 精细创作与精确编辑 |
| `openai-sunburst` | `gpt-image-2.5-sunburst` | 上代精细生成与编辑 |
| `openai-flare` | `gpt-image-2.5-flare` | 上代快速生成 |
| `openai` | `gpt-image-2` | 兼容已有工作流 |
| `wan` | `wan2.7-image` | 基础生图与参考图编辑，千问默认 |
| `wan-pro` | `wan2.7-image-pro` | 4K 生图，编辑最高 2K |

日常生成、素材草稿和快速尝试优先选择 2.6 Flare；对布局、文字细节或修图准确度要求较高时选择 2.6 Sunburst。2.5 两款继续保留已有工作流，原 key 不变；显式选择 `openai` 仍请求 `gpt-image-2`，不会被替换为新模型。

| 模型 | 默认尺寸；预设 | 画质 | 复杂度 |
| --- | --- | --- | --- |
| GPT Image 2.6 两款 | `auto`；`1024x1024`、`1536x1024`、`1024x1536` | `auto`（默认）、`low`、`medium`、`high`、`xhigh`、`max` | `high`（默认）、`medium`、`low` |
| GPT Image 2.5 两款 | 同上 | 同上 | 不提供 |
| 旧 `openai` | 同上 | `auto`（默认）、`low`、`medium`、`high` | 不提供 |
| Wan | `2K`（默认）；`1K`、`2K` | 不提供 | 不提供 |
| Wan Pro | `2K`（默认）；生成 `1K`、`2K`、`4K`；编辑不含 `4K` | 不提供 | 不提供 |

复杂度控制模型在渲染前的布局规划，画质控制渲染细节。复杂构图可保留 `high`；简单局部编辑可对比较低复杂度。提高复杂度可能增加等待时间，也可能引入额外改动，不代表总能得到更好结果。参数依据 [2.6 官方提示指南](https://developers.openai.com/api/docs/guides/image-prompting)与[图像生成指南](https://developers.openai.com/api/docs/guides/image-generation)，不是从其他 API 或旧型号推断。

### 输出格式与背景

| 模型 | 输出格式 | 背景 |
| --- | --- | --- |
| GPT Image 2.6 Sunburst / Flare | PNG（默认）、JPEG、WebP | 自动（默认）、不透明、透明 |
| GPT Image 2.5 Sunburst / Flare | 同上 | 同上 |
| 旧 `openai` / Wan 两款 | 不提供新选项，保持原行为 | 不提供新选项，保持原行为 |

背景与格式采用独立的可选 ChoicePolicy：`outputFormat`、`background`。旧配置省略字段仍正常加载；选项值限定为上述枚举，默认值必须在选项内，JPEG + 透明不能作为默认组合。未配置的选项不展示，显式传入即拒绝，不根据模型名称判断能力，也不从 `inputImages.mimeTypes` 推断输出格式。Wan 适配器不接受这两个能力配置，不会发送 OpenAI 参数。

生成与编辑共用约束，分别映射到请求体 `background` 和 `output_format`。为保持原请求策略，自动背景仍发送 `background: "auto"`；PNG 使用服务端默认值，省略 `output_format`（包括显式选 PNG），JPEG/WebP 才发送该字段。未暴露 `output_compression`，使用服务端默认压缩策略。普通生成/编辑不做格式转换，也不会自动将 JPEG 改成 PNG 或把透明改成不透明；仅实验 Markup 的原图和图层为方向归一化分别编码为 PNG。

**能力依据与验证边界：** [生成接口](https://developers.openai.com/api/reference/resources/images/methods/generate)、[编辑接口](https://developers.openai.com/api/reference/resources/images/methods/edit)、[提示指南](https://developers.openai.com/api/docs/guides/image-prompting)和[生成指南](https://developers.openai.com/api/docs/guides/image-generation)确认参数语义；[2.6 Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst)与[2.6 Flare](https://developers.openai.com/api/docs/models/gpt-image-2.6-flare)支持两个图片端点，提示指南明确两款支持透明背景。2.5 的生成/编辑参考同样明确支持透明背景与 PNG/WebP。旧 `gpt-image-2` 的透明能力在文档中仍标为 preview，因此本轮不扩展其配置。

当前本地 Codex 适配器将 JSON 发往既有 `/images/generations` 和 `/images/edits`，由 Pi SDK 的 `ImagesOptions.metadata` 贯通配置参数，没有改 OAuth、Header、路由或 Provider。**新增参数尚未完成 Codex 通道及实际账户的完整在线验收**，Platform 文档不是 Codex 协议保证。能力清单仅允许上述四款尝试这些参数；服务端可能拒绝或忽略，忽略格式时会触发下文的格式不一致错误，不做隐式回退或重试。离线 Mock 仅证明本地序列化、校验与保存行为，不是在线生图验收。

所有模型支持生成和参考图编辑（调用入口限制见上节），每次请求一张，无批量数量参数、mask 或多轮连续编辑。**默认仍只开放静态栅格输出和普通编辑。** SVG、Markup、GIF 都是默认关闭的实验性实现；Streaming 仅有独立离线解析/响应适配器，不接入生产。Platform 和官方 SDK 已证实协议，不代表 Codex 在线支持已获确认。

### 高级能力：证据与默认关闭策略

完整调查、参数冲突、源码链接、输入安全缺口与验收记录见 [ADVANCED-CAPABILITIES.md](ADVANCED-CAPABILITIES.md)。必须区分 Platform API 文档、Codex 客户端可序列化和 Codex 服务端实际接受。经明确授权，2.6 Flare 已执行 Markup / SVG 各 1 次，累计 2 次后停止：Markup 返回 PNG 但尺寸不符，SVG HTTP 200 后校验失败、未保存产物；不记正式可用，也没有验证账户预览权益。

| 能力 | 当前状态 | 默认行为 |
| --- | --- | --- |
| SVG | 本地安全 XML/文件链路完成；2.6 Flare S1 HTTP 200，但后续协议/本地校验失败，无可交付 SVG | 两款 2.6 的 `svg.enabled: false`；不显示选项，不发送 SVG 请求 |
| GIF | 官方 Platform 2.6 支持生成；官方 Codex 客户端含 GIF 序列化，未验证服务端/账户接受 | 原实验实现不重写，两个 `gif.enabled` 均为 false |
| Markup | 本地独立 PNG/透明像素/方向链路完成；2.6 Flare M1 返回 PNG，左圆变绿，但请求 1024×1024、实际 1254×1254，人工验收未确认 | 2.5/2.6 两款各自 `markup.enabled: false`；不显示标记路径输入 |
| Streaming | Platform Images SSE 与官方 SDK 事件类型已证实；独立增量解析/响应适配器完成，Codex 未确认 | 不接生产、不显示入口、不发送流式字段；配置禁止 `streaming.enabled: true` |

**实验 Markup：** 操作者明确知情后，仅将目标模型 `nativeCapabilities.markup.enabled` 改为 `true` 并 `/reload`。TUI 编辑参数菜单可选一个标记 PNG 路径，不增加默认步骤；Escape 保留，留空移除。RPC 示例：

```text
/image openai-flare-26 --image 'original.jpg' --markup 'overlay.png' -- 修改标记区域，保持其余部分不变
```

原图保持第一项，图层走单独 `markup` 对象，绝不混成参考图或合成图。两张图片各不超过 16,777,216 像素，方向归一化后尺寸相同；图层必须有真实透明像素，8/16 位 Alpha 均校验。官方标记文件上限 50 MB，但 JSON data URL 最大 20,971,520 字符，因此本实现 PNG 原始上限为 15,728,622 字节，归一化后再检查。校验和像素解码在凭据解析/请求前完成；不支持 mask、prompt rewriter、SVG/GIF 输出或流式参数。原图与图层分别归一化为 PNG，不改变其他参考图顺序。

**实验 SVG：** 两款 2.6 各自的 `nativeCapabilities.svg.enabled` 默认为 false。人工启用后允许 `--format svg`，仅生成，`n=1`，不发送 `svg.model`，不支持编辑、Streaming、Partial Images、输出压缩或 prompt rewriter。

使用严格 UTF-8 与命名空间感知的 XML 解析器，再执行保守静态 SVG 白名单。拒绝 DTD/实体声明、脚本/事件、CSS/style、外部引用、嵌入图片、动画和外来命名空间；仅允许常用路径、形状、文本及受限局部渐变/裁剪。最大 2 MiB、10,000 个 XML 节点、64 层深度，并限制属性数量和长度。可能拒绝安全但白名单尚不支持的文档，不会用正则“修好”危险 XML。通过后按原字节原子保存 `.svg`，终端不执行、不渲染，只显示路径和原文件链接。用户手动打开，不自动启动浏览器。

**Streaming：** `src/image-sse.ts` 只接收已有的 SSE Response，用于离线适配验证，没有 fetch/认证或生产 UI 入口。支持多行 data、CRLF/CR/LF、跨块 UTF-8、错误/断流和取消；单事件 48 MiB、累计输入 192 MiB。部分图仅临时回调，必须收到 completed 才能返回最终图片；不把 partial 写入历史，也不把 Responses 事件或 `[DONE]` 当作 Images 完成协议。当前不允许启用生产流式开关。

所有实验启用都可能允许真实付费请求，不等于已确认当前 Codex 账户支持。常规测试保持离线。按 [Codex 最小在线验收计划](CODEX-ONLINE-ACCEPTANCE.md)，本轮经批准串行执行 M1/S1 各 1 次、无重试；M1 尺寸异常后，操作者另行明确指示继续 S1，不冒充人工效果验收通过。**累计 2/2，现已停止，全部生产开关仍为 false。** 不涉及 GIF 或 SSE 探测，任何新增请求都需重新授权。一次性守卫与执行器仅在 `test/`，未接入生产，也不属于 `npm test` 的真实 API 调用。

**实验 GIF，仅供明确知情的人工验证：** `models.jsonc` 的两款 2.6 模型分别有 `nativeCapabilities.gif`，其中 `enabled: false` 是默认值。仅操作者自行将目标模型改为 `true` 并 `/reload`，才允许选择 `GIF（实验性，Codex 未在线验证）` 或通过 RPC 请求。启用一个模型不影响另一个。启用会允许发送真实请求，可能消耗额度；修改配置不等于取得 GIF preview access 或完成线上验收。

GIF 仅生成，不接受参考图编辑。选择 GIF 后才显示动画帧数与每帧时长；数值输入 Escape 返回菜单、空 Enter 保留当前值。切回静态格式后不显示/发送动画字段。GIF 使用独立尺寸菜单，切换格式时保留各类格式的尺寸，不把静态高分辨率自动套入动画。

| 实验参数 | 当前策略 |
| --- | --- |
| `--format gif` | 仅目标模型显式启用后可用；仍使用原 Codex `/images/generations`，`n=1` |
| `--frame-count N` | 默认 9，保守范围 2～16；官方指南的 2～64 与 API 参考冲突，暂不扩大 |
| `--frame-duration-ms N` | 默认 200，整数 20～2000ms；服务端按 10ms 舍入，不在本地静默修改请求值 |
| `--size` | 默认 `auto`，本地保守白名单另含 `512x512`；没有确认模型像素预算，不支持任意尺寸，不套用静态栅格的最小像素要求 |
| 互斥 | 不支持透明背景、Markup、mask、stream/partial images、输出压缩或 prompt rewriter；动画参数只适用于 GIF |

上述两个动画参数支持空格/等号形式，缺值、重复、非整数、越界或不兼容组合在认证和请求前拒绝。其默认值和模型范围来自唯一目录，不新增账户页面或动画向导。

只有在操作者已知情启用并接受可能计费后，RPC 才能使用下面的文本（TUI 中命令选项仍只会预填提示词）：

```text
/image openai-flare-26 --format gif --frame-count 9 --frame-duration-ms 200 --size auto -- 一只小鸟抬起翅膀后回到起始姿态，固定镜头，平滑循环
```

GIF Base64 必须是实际 GIF87a/GIF89a、多帧、合理画布/调色板/数据块/终止结构；请求与返回的帧数、时长（容许官方舍入）和显式尺寸必须一致。错误 MIME、静态 PNG、单帧 GIF 或被忽略的参数不会被改后缀后保存，也不会自动重试。文件验证为有界的基本容器检查，不是完整 LZW/像素解码器；本地资源上限及保守拒绝范围见调查报告。

保存仍用原安全目录、临时文件与原子 rename，实际扩展名 `.gif`，MIME `image/gif`。历史条目可选增加 `kind: "animation"`，缺少新字段的历史仍能按 MIME 文字降级。动画走文件分支，不伪装为 Pi SDK 静态 ImageContent，不转 PNG。**终端不播放 GIF 动画**，只显示文件信息、路径和原文件链接；用户手动打开。没有浏览器或转码依赖。

常用命令：

```text
/image
/image 一张简洁的咖啡店海报
/image --settings
/image --help
```

RPC 的 `message` 示例（TUI 中整段参数只会预填提示词，不按这些选项解析）：

```text
/image openai-flare-26 --quality medium --complexity low -- 一只水彩橘猫
/image openai-sunburst-26 --size 1536x864 --quality high --complexity high -- 设计一张海报
/image openai-flare-26 --format png --background transparent -- 一枚透明背景的极简图标
/image openai-sunburst-26 --format=webp --background=transparent -- 一张透明背景的产品素材
/image openai-flare-26 --format jpeg --background opaque -- 阳光下的海边风景
/image openai-sunburst --quality xhigh -- 保留上代精细生成工作流
/image wan-pro --size 4K -- 一幅山水画
```

| 输入限制 | OpenAI 五款 | Wan 两款 |
| --- | --- | --- |
| 提示词长度 | 32,000 字符 | 5,000 字符 |
| 参考图 | 最多 16 张；每个 data URL 最多 20,971,520 字符（含前缀），当前格式的原始文件最多 15,728,622 字节，略小于 15 MiB | 最多 9 张，单图 20 MiB |
| 格式 | PNG / JPEG / WebP / BMP，校验 MIME 和文件签名 | 同左 |
| 自定义尺寸 | `宽x高`；边长 16 的倍数，最长边 3840，比例 ≤ 3，总像素 655,360–8,294,400 | `宽*高`；整数边长，比例 ≤ 8，总像素 589,824–4,194,304；仅 Pro 生成上限为 16,777,216 |

OpenAI 参考图数量和编码后长度按 [Platform JSON Images Edit 接口](https://developers.openai.com/api/reference/resources/images/methods/edit)配置：`images` 最多 16 项，`image_url` 最多 20,971,520 字符。插件将本地图片作为 Base64 data URL 发送，原始文件上限按 `floor((字符上限 - data URL 前缀长度) / 4) × 3` 推导；当前格式均为 15,728,622 字节。读取文件前检查原始大小，校验时再检查包含实际 MIME 前缀的完整 data URL 长度，不能把其他上传形式的 50 MB 限制套到 JSON 字段。这里是每张图的字段上限，不是整个请求体上限。

2.6 专属指南明确要求尺寸边长为 16 的倍数、比例在 1:3 至 3:1；[通用生成指南](https://developers.openai.com/api/docs/guides/image-generation)的 2/2.5 相关章节还明确了表中的最长边与总像素范围，并将超过 `2560x1440` 的分辨率标为实验性。2.6 专属段落未重新明确像素上限，因此暂沿用此范围，不声称它是已确认的 2.6 官方上限，也不推断模型支持无限尺寸。PNG / JPEG / WebP / BMP 是插件现有的格式校验范围，不代表此次逐一确认过 2.6 的输入格式能力。

插件的认证和请求仍走 Codex 后端；按 Platform 文档配置不保证 Codex 通道或具体账户接受同等大小的请求。这里未新增自动重试、拆分请求或其他上传协议；服务端拒绝时仍显示原始原因。Wan 的限制不变。

常用配置字段：`providers[].auth` 指定认证来源，`defaultModel` 指向该账户启用的模型 key；`models[].key/id/provider` 定义选择词、上游 ID 和所属账户；`description` 是可选的单行模型定位，直接显示在 TUI，不参与 key 解析；`nativeCapabilities` 是可选的高级能力实验政策，旧配置可省略，GIF/SVG/Markup 有按模型显式 opt-in 实现，默认关闭；Streaming 禁止设为 true。`codex` 固定为 `unverified`，不能通过配置自称已验证；`tasks`、`prompt`、`inputImages`、`size.generate/edit`、`quality`、`complexity`、`outputFormat`、`background` 定义限制及参数选项。`inputImages.maxBytes` 限制原始文件字节，新增的可选 `inputImages.maxDataUrlLength` 限制包含前缀的编码后长度，旧配置省略时不增加此项校验。省略 `size.edit` 继承生成规则；未配置 `quality` 或 `complexity` 时，不展示或发送对应参数。
将模型 `enabled` 设为 `false` 后，不进入向导/运行时，显式选择也会在发送前拒绝，不会当提示词交给默认模型。不要禁用仍被 `defaultModel` 引用的模型。
配置支持注释和尾逗号；缺失、未知字段或无效默认值会报错，不回退旧清单。修复后 `/reload`。不要填真实 Key、token、凭据路径或任意主机；新协议/字段仍需代码支持。

## RPC：首次生成与取回结果

认证预先配置好后，在目标项目启动 `pi --mode rpc`。向该进程 stdin 发送一行 JSON（不是在 shell 中执行 JSON）：

```json
{"id":"image-1","type":"prompt","message":"/image openai-flare-26 --size auto --quality high --complexity medium -- 一只水彩橘猫"}
```

千问可将 `message` 替换为 `/image wan --size 2K -- 一只水彩橘猫`，或 `/image wan-pro --size 4K -- 一只水彩橘猫`。等待上一操作完成再发送，忙碌时插件拒绝请求；非 TUI 请求超时为 300 秒。

持续按 LF 分隔读取 stdout JSONL：

- `response` 的 `id` 对应请求；`success: true` 只表示 prompt 被处理/接受，**不代表图片成功**，插件错误也可能伴随成功响应。
- 实际结果来自 `type: "extension_ui_request"`、`method: "notify"`：`notifyType: "info"` 且 `message` 以 `Saved N image(s):` 开头时，包含逐张绝对路径及无控制码的完整 `file:///…` URL；错误为 `notifyType: "error"`，忙碌等提示为 `warning`。
- 通知不需回复，其 `id` 不是 prompt 请求 ID；串行调用并消费通知。此命令不跑 LLM，不要等待 `agent_end` 或读取最后一条 assistant 文本来取图。

## 输出、安全与失败恢复

图片保存于 **Pi 当前项目** `.pi/generated-images/`，不是插件目录；文件名含时间、账户、模型和随机后缀，扩展名随实际图片格式。无自定义输出路径参数，单张输出上限 32 MiB（含实验 GIF 文件），实验 SVG 另限 2 MiB。不会自动打开图片或生成 HTML 页。
OpenAI `b64_json` 先经过现有 Base64、字节上限与文件签名校验，再依据实际字节确定 MIME，默认允许 PNG/JPEG/WebP；只有明确请求且启用相应实验功能时才接受通过容器验证的 GIF 或通过独立静态 XML 验证的 SVG。请求格式、响应 `output_format` 声明（如有）、逐图 `mime_type` 声明（如有）与真实格式分别校验。**任一不一致即报错，不保存本次图片、不自动重试**；例如请求 JPEG 实际返回 PNG，不会把 PNG 写入 `.jpg` 或伪造 MIME。整批响应校验通过后才进入保存。错误只包含已校验的格式名称，不包含 token、提示词或原始响应。Wan 维持原来的真实签名及 MIME 检查。

**透明度边界：** 透明来自真实 Alpha 信息，不是棋盘格图案、白底或扩展名。本轮增加轻量的 PNG IHDR/tRNS、WebP VP8X/VP8L/VP8 容器 Alpha 信息检查；透明请求若明确返回无 Alpha 通道则拒绝保存。这不是逐像素解码：有 Alpha 通道仍可能所有像素完全不透明，截断或无法判断的容器返回未知，不据此声称透明成功。新增 `sharp` 只用于实验 Markup 输入的真实像素/方向校验，不改变普通输出的这一检查策略；实际输出是否存在透明像素仍需用户在支持 Alpha 的图像工具中检查。测试样本的透明像素已在离线制备/复核时通过真实解码确认，但不能推广为服务端输出保证。

TUI 会话显示路径、原图链接及可用时的终端预览。预览继续将实际 MIME 交给 Pi 原生 Image 组件：iTerm2 可接收原格式，Kitty 对非 PNG 依赖宿主已有 transcoder，没有时使用原生文本降级并保留原图链接，不在插件内转换或改写保存文件。支持链接的终端可 Ctrl+点击，否则复制路径/URL 手动打开。历史视图先验证记录、生成目录、普通文件/非符号链接、大小和实际内容（SVG 静态 XML、GIF 动画容器、栅格原签名），再显示 URI/可点击链接；目录身份与文件描述符前后复核、有界读取用于防止基本目录替换及文件增长绕过。非法、危险、缺失、超大或不匹配的历史文件仅显示不可点击的路径与警告，不自动打开、不删除/修改文件。合法 SVG/GIF 保留原文件链接，但终端不渲染 SVG、不播放 GIF。**校验只证明检查时的文件内容符合限制，不能保证之后不被外部修改**；视图只读一次，不增加文件监听器。RPC 客户端需自行读取 Pi 所在机器上的文件，`file:///` 不是公网下载地址。

**请求会消耗额度/可能计费，插件不会自动重试。** 超时、断连、主动取消、下载或保存失败时，上游可能已经生成并计费；先检查本地结果、服务端额度/结果，再决定是否重发。插件不提供服务端任务查询或恢复下载命令。

| 现象 | 最短恢复路径 |
| --- | --- |
| 没有账户 / HTTP 401 | 打开 `/image --settings`；OpenAI 选择登录 / 重新认证，回车执行预填的 `/login openai-codex`；千问更新 Key，不盲目切换账户 |
| HTTP 403 / 429 | 核对账号权限、模型支持、额度和限流；本地启用不等于上游授权 |
| `fetch failed` / 超时 / 断连 / 5xx | 按通知区分生成、编辑、下载及发送/读取阶段，检查启动 Pi 的网络/代理环境；不能仅凭外层错误断定模型或 Key 无效 |
| 配置/输入校验失败 | 修复 models.jsonc 后 `/reload`；核对模型 key、尺寸、画质、复杂度、格式/背景组合及参考图限制 |
| 返回格式不一致 / 透明请求返回无 Alpha 通道 | 本次不保存、不自动重试。检查 Codex 通道及账户支持情况、服务端结果与额度，再决定是否手动重发；不能通过修改后缀或 MIME 修复 |
| 保存失败 | 检查项目目录权限、空间及 `.pi`/输出目录是否为符号链接，不要立即重新生成 |
| 取消后提示底层操作尚未结束 | 不重复提交，不通过 `/reload` 绕过。底层若恢复，会丢弃迟到结果并自动解除保护；若始终不结算，请退出 Pi 终止本地执行，确认服务端任务/额度状态后再重启并自行决定是否重发 |

网络诊断在项目 `.pi/image-generation-logs/`：失败通知给出 `error-<uuid>.json` 路径；也可能存在 `success-<uuid>.json`，它只表示 HTTP 读取/解析成功，不保证图片落盘。日志不自动清理，分享前检查脱敏结果，绝不分享 auth.json。修改启动环境后重启 Pi，`/reload` 不会重新继承 shell 环境；不要关闭 TLS 验证。
会话记录会保留提示词、图片路径和元数据（不是 Key 或图片 base64）；生成时提示词及参考图会发送给所选服务。请保护会话、图片、日志和凭据，按项目需要排除版本控制。

## 测试

在插件目录执行 PowerShell：

```powershell
npm test
npm run test:host
```

测试使用 Node.js ≥22.19.0，先在本插件目录执行 `npm ci --ignore-scripts` 准备锁文件声明的依赖。`npm test` 覆盖配置、命令、凭据、文件、网络诊断，以及 `test/sdk.test.mjs` 中的 SDK 定位回归；`test:host` 通过真实 SDK 和模拟上下文检查全部启用模型的生成/编辑、默认账户路由、参数传递、设置、取消、重复提交与迟到结果；还直接驱动原生选择器和编辑器的方向键、Enter、Escape、焦点，在 24/40/80/120 列检查中英混排、浅深主题、历史记录、原图链接与预览降级。测试不调用付费 API。新增覆盖所有格式/背景合法组合、双向依赖过滤、生成/编辑参数贯通、真实 PNG/JPEG/WebP 字节保存与历史重载、请求/声明/实际格式不符、无 Alpha 容器、大小/Base64/签名限制、各格式取消清理，以及 TUI 原生预览和降级。真实 2×2 样本在 `test/image-fixtures.mjs`，由 Pillow 离线编码，测试和运行时均不依赖 Pillow。高级能力新增 `test/native-capabilities.test.ts`、`test/native-host.mjs` 和真实双帧 `test/fixtures/native-two-frame.gif`（512×512，各 200ms，循环，已用 Pillow 11.2.1 离线解码复核）。它们覆盖默认关闭、按模型启用、帧参数、互斥、Codex JSON 请求与拒绝/忽略、GIF 结构/保存/取消、非 ImageContent 输出、历史缺新字段、终端不播放动画及原生数值输入；启用仅在测试内存中的配置进行，不改生产目录。SVG/Markup 覆盖实验成功链路与禁用/安全拒绝边界；Streaming 覆盖独立 SSE 解析/响应适配，不是生产网络/UI 已接入。`test/history-security-host.mjs` 还检查真实 OSC 8 目标及 file URI 的存在/不存在，覆盖 SVG/GIF 篡改、危险内容、大小、缺失、目录/链接替换、旧历史和静态预览；当前 Windows 文件 symlink 创建权限不足时显式模拟 lstat 拒绝分支，真实目录 junction 仍执行，环境限制在报告中披露。公开合成验收 PNG 位于 `test/fixtures/codex-acceptance-{original,markup}.png`，离线检查摘要、真实透明像素和独立原图，不发送线上请求。生命周期专项还覆盖认证永久挂起、请求/响应体永久挂起（隔离子进程）、跨 reload 忙碌保护、迟到成功/失败、再次提交及保存阶段取消回滚；宿主脚本使用 Node 测试运行器输出实际统计。可用 `PI_IMAGE_TEST_REVERSE_MODELS=1` 重跑单元测试与宿主测试，在内存中倒置模型目录以检查非排序断言，生产清单不会被改写。

宿主测试需要完整的 Pi SDK 及其依赖。`test/sdk.mjs` 按命令行第二个参数 → `PI_SDK` → 本插件可解析的包 → Pi 托管安装 → PATH 定位 SDK。参数可为 `dist/index.js` 的绝对路径或 `file://` URL；其它安装方式可用 PowerShell 的 `$env:PI_SDK` 指定实际入口。测试与辅助文件全部位于本插件的 `test/`，复制本插件目录后即可独立准备依赖并运行。

`test/host-dispatcher-probe.mjs` 和 `test/clash-https-probe.mjs` 是显式执行的本机网络排查脚本，所需参数见脚本头部；后者需要本机代理与证书工具。普通测试使用模拟响应或回环服务，线上账号权限、额度、服务可用性及人工 TUI 体验由实际环境另行验证。

## 许可证

MIT，见 [LICENSE](LICENSE)。
