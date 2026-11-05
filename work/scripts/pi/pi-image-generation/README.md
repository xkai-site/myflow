# pi-image-generation

通过 Pi 的 **`/image` 斜杠命令**生成或编辑图片。用户在 TUI 操作，自动化通过 RPC 分发命令；命令直接处理图片请求，图片账户 provider 负责认证和请求。

## 安装与首次调用

前提：已安装 **Pi ≥ 0.99.0**，Node.js ≥ 22.19.0。在本插件目录执行：

```powershell
npm install --ignore-scripts
pi install .
```

本地安装引用源码目录，后续加载仍需保留此路径。启动 Pi；已运行的 Pi 执行 `/reload`。
本扩展通过 `createModels()` / `createProvider()` 创建插件局部的图片模型集合，使用 Codex / Token Plan CN 请求协议。Pi 的聊天模型与 Agent 工具分别由宿主管理。
完成下文任一种认证后，在要保存图片的项目目录启动 Pi，输入：

```text
/image 一只坐在窗边的橘猫，水彩风格
```

TUI 会打开向导：生成/编辑 → 提示词 → 账户 → 模型 → 参数 → 执行。编辑任务在选定模型后询问参考图路径。单个可选账户或模型自动选择，模型列表展示“名称 - 定位”，账户默认模型排在首项并标注“默认”。

参数菜单展示当前尺寸、画质，以及模型支持时的复杂度；默认选中“开始生成”或“开始编辑”，直接 Enter 即使用默认值。需要修改时选择对应参数，修改后返回菜单并保留已选值。Escape 在参数选项中返回菜单，在其他步骤取消本次操作。加载时可取消；加载界面立即关闭，实际执行仍需安全结算，不能重复提交。请求发送前的认证等待支持取消，即使认证 Promise 不响应也不会继续发送图片请求；已经发送的请求、响应读取和文件操作则保留忙碌保护，直到实际结算，`/reload` 也不能绕过此保护。

成功后会话条目显示保存路径、原图链接和可用时的预览，通知仅显示保存数量。界面使用 Pi 原生选择器、编辑器、主题颜色和键盘操作，支持中英混排及窄窗口自动换行。

## 认证：任选一种

### OpenAI：使用已配置的 Pi provider

OpenAI 图片生成需要 Pi 中已有且已认证的 `openai-codex` provider。此图片扩展和 `pi-usage-openai` 都不会注册该对话 provider、执行 OAuth 登录或刷新 token；请由独立 provider/插件负责安装和认证。当前项目已不再提供此前 `pi-codex-official` 的 provider 功能。

本扩展每次通过 Pi 的 `openai-codex` provider 读取认证信息，不自行登录或刷新 token。过期时通过提供该 provider 的扩展/Codex 流程更新登录。
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
| `/image --settings` | 账户管理，秘密输入仅 TUI 可用 |
| `/image --help`、`/image -h` | 用法和全部模型 key（含禁用标记） |
| RPC `/image …` | 按下列语法直接请求，不打开生成向导 |

非交互完整文本语法：

```text
/image [model-key] [--size VALUE|--size=VALUE] [--quality VALUE|--quality=VALUE] [--complexity VALUE|--complexity=VALUE] [--] <prompt>
```

| 参数 | 规则 |
| --- | --- |
| `model-key` | 必须是第一个词，使用下表的 key，**不是上游模型 ID 或 provider ID**；仅一个图片账户配置有效时可省略，使用该账户 `defaultModel` |
| `--size` | 省略用所选模型/任务默认尺寸；值及限制见下节 |
| `--quality` | OpenAI 支持，省略为 `auto`；Wan 不接受此参数 |
| `--complexity` | 仅 2.6 两款支持 `low`、`medium`、`high`，省略为 `high`；2.5、旧 `openai` 与 Wan 拒绝此参数 |
| `--` | 停止解析后续选项；提示词首词像模型 key/选项时用它消歧，例如 `/image -- wan is a word`（仅一个账户时） |
| `<prompt>` | 必填，支持单/双引号；词间空白合并。单引号外的反斜杠用作转义，未闭合引号/转义会报错 |

即使提示词已开始，后面的 `--size` 等仍会被解析，除非先写 `--`。未知 `--选项` 会报错。

参考图编辑通过 TUI 向导选择，每行输入一个参考图文件路径，可拖入、加引号或写 `@path`；相对路径以 Pi 当前项目为基准，至少一张。命令文本解析器只处理上表列出的生成参数。

**标准 RPC `/image` 目前仅支持生成；编辑请用 TUI。** RPC `images` 附件会被忽略，不会进入编辑，仍可能按纯文本生成并消耗额度。

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

所有模型支持生成和参考图编辑（调用入口限制见上节），每次请求一张，无批量数量参数、mask 或多轮连续编辑。本插件不提供 SVG、GIF、markup-guided editing 或流式部分图片输出。

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

常用配置字段：`providers[].auth` 指定认证来源，`defaultModel` 指向该账户启用的模型 key；`models[].key/id/provider` 定义选择词、上游 ID 和所属账户；`description` 是可选的单行模型定位，直接显示在 TUI，不参与 key 解析；`tasks`、`prompt`、`inputImages`、`size.generate/edit`、`quality`、`complexity` 定义限制及参数选项。`inputImages.maxBytes` 限制原始文件字节，新增的可选 `inputImages.maxDataUrlLength` 限制包含前缀的编码后长度，旧配置省略时不增加此项校验。省略 `size.edit` 继承生成规则；未配置 `quality` 或 `complexity` 时，不展示或发送对应参数。
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

图片保存于 **Pi 当前项目** `.pi/generated-images/`，不是插件目录；文件名含时间、账户、模型和随机后缀，扩展名随实际图片格式。无自定义输出参数，单张输出上限 32 MiB。不会自动打开图片或生成 HTML 页。
TUI 会话显示路径、原图链接及可用时的终端预览。支持链接的终端可 Ctrl+点击，否则复制路径/URL 手动打开；文件移动或删除后链接失效。RPC 客户端需自行读取 Pi 所在机器上的文件，`file:///` 不是公网下载地址。

**请求会消耗额度/可能计费，插件不会自动重试。** 超时、断连、主动取消、下载或保存失败时，上游可能已经生成并计费；先检查本地结果、服务端额度/结果，再决定是否重发。插件不提供服务端任务查询或恢复下载命令。

| 现象 | 最短恢复路径 |
| --- | --- |
| 没有账户 / HTTP 401 | 检查 `/image --settings` 的来源；更新 Codex 登录或千问 Key，不盲目切换账户 |
| HTTP 403 / 429 | 核对账号权限、模型支持、额度和限流；本地启用不等于上游授权 |
| `fetch failed` / 超时 / 断连 / 5xx | 按通知区分生成、编辑、下载及发送/读取阶段，检查启动 Pi 的网络/代理环境；不能仅凭外层错误断定模型或 Key 无效 |
| 配置/输入校验失败 | 修复 models.jsonc 后 `/reload`；核对模型 key、尺寸、画质、复杂度及参考图限制 |
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

测试使用 Node.js ≥22.19.0，先在本插件目录执行 `npm ci --ignore-scripts` 准备锁文件声明的依赖。`npm test` 覆盖配置、命令、凭据、文件、网络诊断，以及 `test/sdk.test.mjs` 中的 SDK 定位回归；`test:host` 通过真实 SDK 和模拟上下文检查全部启用模型的生成/编辑、默认账户路由、参数传递、设置、取消、重复提交与迟到结果；还直接驱动原生选择器和编辑器的方向键、Enter、Escape、焦点，在 24/40/80/120 列检查中英混排、浅深主题、历史记录、原图链接与预览降级。测试不调用付费 API。生命周期专项还覆盖认证永久挂起、请求/响应体永久挂起（隔离子进程）、跨 reload 忙碌保护、迟到成功/失败、再次提交及保存阶段取消回滚；宿主脚本使用 Node 测试运行器输出实际统计。可用 `PI_IMAGE_TEST_REVERSE_MODELS=1` 重跑单元测试与宿主测试，在内存中倒置模型目录以检查非排序断言，生产清单不会被改写。

宿主测试需要完整的 Pi SDK 及其依赖。`test/sdk.mjs` 按命令行第二个参数 → `PI_SDK` → 本插件可解析的包 → Pi 托管安装 → PATH 定位 SDK。参数可为 `dist/index.js` 的绝对路径或 `file://` URL；其它安装方式可用 PowerShell 的 `$env:PI_SDK` 指定实际入口。测试与辅助文件全部位于本插件的 `test/`，复制本插件目录后即可独立准备依赖并运行。

`test/host-dispatcher-probe.mjs` 和 `test/clash-https-probe.mjs` 是显式执行的本机网络排查脚本，所需参数见脚本头部；后者需要本机代理与证书工具。普通测试使用模拟响应或回环服务，线上账号权限、额度、服务可用性及人工 TUI 体验由实际环境另行验证。

## 许可证

MIT，见 [LICENSE](LICENSE)。
