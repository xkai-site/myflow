# pi-image-generation

Pi `/image` 图片生成与参考图编辑。命令不触发 LLM 轮次、不注册模型工具；结果保存在当前项目 `.pi/generated-images/`。

## 安装

在本插件目录运行：

```bash
npm install --ignore-scripts
```

然后在上一级目录安装本地扩展：

```bash
pi install ./pi-image-generation
```

已有本地目录安装无需重新安装扩展；本次新增运行时依赖，需先完成上面的 npm 安装，然后 `/reload`。请保留插件目录。

## 使用

- `/image`：选择生成/编辑或账户设置。
- `/image <prompt>`：直接进入生成向导。
- `/image --settings`：账户状态、保存/替换/删除千问 Key、查看文件位置。
- `/image --help`：当前模型 key 和用法。

生成向导只展示已启用、已配置账户下支持所选任务的模型。只有一个账户/模型时自动跳过对应选择；尺寸、质量默认值排在首项。编辑时每行填写或拖入一个参考图路径，支持相对路径、引号和 `@path`。Esc 取消，结果使用唯一文件名和原子落盘。

### 浏览器预览链接

生成成功后保留原有保存路径和终端图片预览，同时在 `.pi/generated-images/` 创建独立的 `gallery-<uuid>.html`，并显示其 `file:///...` 链接。TUI 仅在本次结果的第一张图片会话记录中显示一次图集链接，保存通知保留 `Saved` 和图片路径，不重复显示链接。链接使用主题链接色（`mdLink`）与下划线；检测到终端支持时，输出真正的 **OSC 8 超链接**，而不是只显示地址。RPC / 非 TUI 仍输出无控制码的完整 URL。

**不会自动打开浏览器**。Windows Terminal 中通常可 **Ctrl+点击** 链接，按系统 HTML 文件关联打开（通常是默认浏览器）；其他终端的点击方式以其设置为准。CMD / PowerShell 是 shell，能否点击取决于承载它们的终端窗口：传统 Windows 控制台不支持 OSC 8，即使文字有颜色也无法 Ctrl+点击。此时请在 Windows Terminal 中运行 CMD / PowerShell 和 Pi，或者复制完整链接到浏览器地址栏。完整 URL 始终保留，便于复制。

Pi 会自动检测终端能力（Windows Terminal 通常有 `WT_SESSION`）。如果使用支持 OSC 8 的终端但未被识别，可在启动 Pi **之前**设置 `PI_HYPERLINKS=1`：PowerShell 使用 `$env:PI_HYPERLINKS="1"`，CMD 使用 `set PI_HYPERLINKS=1`。这只能修正检测，不能让不支持链接的终端获得点击能力。

预览页采用深色、图片优先的简洁布局：单张图片尽量占满可视区域，多张图片在宽屏双列、窄屏单列展示，保持原始比例、不裁切。页面不展示文件名、模型信息或技术说明，只保留「查看原图」及多图序号；点击图片也可在新标签页打开原图。支持键盘操作、清晰的焦点提示和移动端安全区域。目前仍是每次请求一张，未新增批量生成参数。链接随第一张图片的会话记录保存，重新加载会话后仍可查看。

样式内嵌在每份 HTML 中，更新后新建的预览页使用新设计；已有历史图集不会自动改写。

页面不启动服务器、不上传图片、不引用远程资源，也不嵌入提示词、凭据或图片 base64。图片使用相对路径引用，移动时请保留 HTML 与图片的相对位置。每次使用独立文件名，不覆盖历史图集。预览页创建失败只会显示警告，不影响已经保存的图片。

非交互/RPC：

```text
/image openai --size auto --quality high a cat
/image wan --size 2K a cat
/image wan-pro --size 4K a cat
```

这些选择词是配置中的稳定模型 `key`，不是硬编码枚举。只有一个账户时可省略 key，采用该账户 `defaultModel`；多个账户须指定。提示词以选项或模型 key 开头时，用 `--` 隔开。非 TUI 不支持秘密输入，可提前在 TUI 保存 Key 或配置环境变量。**不要把 Key 放在命令参数、提示词或会话中。**

## 两种认证

### OpenAI：复用 Codex 登录

安装并启用同级 `pi-codex-official`，按其 README 准备 Codex 登录、模型缓存，并在 Pi `/login` 中选择 Codex 本地凭据。

每次图片请求通过 Pi `ModelRegistry.getProviderAuth("openai-codex")` 获取当前认证。生图插件不读取/复制 Codex OAuth 文件、不单独登录、不自行刷新 token。过期时用 Codex / CC Switch 更新登录后重试。

接口是 ChatGPT Codex 订阅后端，不是公开 OpenAI Platform API：

```text
https://chatgpt.com/backend-api/codex/images/generations
https://chatgpt.com/backend-api/codex/images/edits
```

上游协议、账号权益和额度由服务端决定；图片请求会消耗现有额度。

### 千问：Qwen Token Plan CN API Key

**仅支持当前 Token Plan CN，不支持普通百炼/DashScope 按量付费 Key。**

已有 `qwen-token-plan-cn` Provider 配置继续有效，无需重填。也可以在 `/image --settings` 选择千问，输入并确认保存图片专用 Key。输入不回显，保存后下一次请求即可使用，无需重启。

来源优先级：

1. 生图插件已保存的 Key。
2. `models.jsonc` 中声明的专用环境变量（默认 `PI_IMAGE_QWEN_API_KEY`）。
3. 已有 `qwen-token-plan-cn` Provider，包括其已有 API Key/环境变量配置。

只在来源未配置时查找下一项。读取失败、文件损坏或认证失败不会静默切换账户。独立 Key 不使用其他 Provider 的请求头，不修改千问对话账户。删除独立 Key 前会显示恢复后的来源；不会删除原 Provider 凭据。

独立 Key 存储于：

```text
<getAgentDir()>/pi-image-generation/auth.json
```

通常为 `~/.pi/agent/pi-image-generation/auth.json`，支持 `PI_CODING_AGENT_DIR`。这是**用户级凭据文件，不是第二份模型配置**，跨项目和重启复用。文件使用权限保护与加锁原子更新，拒绝符号链接路径；Windows 依赖用户目录 ACL。**本地凭据是明文，不是加密保险库；不要提交、复制或分享。** 保存仅证明本地写入成功，不会自动调用付费接口验证 Key。

固定 CN 同步图片接口：

```text
https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
```

认证只允许这两种官方服务主机，不支持自定义代理端点；认证请求和图片下载拒绝自动重定向。千问结果 URL 会立即下载，不依赖其长期有效。

## 唯一模型配置：models.jsonc

只编辑**本插件根目录的 `models.jsonc`**，然后 `/reload`。不读取 Codex 模型缓存、不生成用户目录副本、不从项目目录寻找另一份清单。必要注释使用简短英文。

| 字段 | 用途 |
| --- | --- |
| `version` | 当前为 `1` |
| `providers[].id/name` | 稳定账户标识和显示名；改 id 会改变独立凭据存储槽 |
| `adapter` | 现有协议：`openai-codex-images` / `ali-wan-images` |
| `auth` | `provider` 复用登录，或 `api-key` 保存/环境变量/旧 Provider 回退 |
| `defaultModel` | 该账户默认模型的稳定 key |
| `models[].key` | 命令选择词；升级时建议保持不变 |
| `enabled` | 可选布尔值，省略视为 true；false 不进生成菜单/运行时，显式命令在发送前拒绝；账户默认模型必须启用 |
| `id/name/provider` | 上游模型 ID、显示名、所属账户 |
| `tasks` | `generate` / `edit` |
| `prompt.maxChars` | 提示词字符上限 |
| `inputImages` | 参考图数量、单图字节数和 MIME 类型 |
| `size.generate` | 尺寸默认值、显示选项和自定义尺寸规则 |
| `size.edit` | 可选编辑专用规则，省略则继承 generate |
| `quality` | 可选质量默认值和选项；省略则隐藏质量菜单 |

尺寸规则 `custom` 支持 `separator`（`x` 或 `*`）、`minPixels/maxPixels`、可选 `maxSide`、`maxRatio`、`multipleOf`。预设使用 `{ "value": "2K", "label": "2K" }`，`default` 必须对应一个选项。Wan Pro 的 4K 生成/编辑差异由该文件声明。

保留原有 `gpt-image-2`、`wan2.7-image`、`wan2.7-image-pro` 的 key、参数、能力限制及账户默认值。以下新增定义保留，但**默认 `enabled: false`**，尚不能当作可用的 Codex 订阅模型：

| key | 模型 ID | 定位 |
| --- | --- | --- |
| `openai-sunburst` | `gpt-image-2.5-sunburst` | 精确编辑、细节优先 |
| `openai-flare` | `gpt-image-2.5-flare` | 快速日常生图 |

公开 API 文档中，两款 GPT Image 2.5 均支持生成/编辑，配置据此保留的质量为 `auto`（默认）、`low`、`medium`、`high`、`xhigh`、`max`；旧 GPT Image 2 仍只提供原有质量档位。尺寸沿用 `auto` 和三种预设，也支持符合规则的自定义尺寸：边长为 16 的倍数、最长边 3840、宽高比不超过 3:1、总像素 655,360–8,294,400。超过 2560×1440 的分辨率属于上游实验能力。提示词和参考图继续采用原有本地保守限制（32,000 字符、最多 5 张、单图 50 MiB），不扩大输入或传输上限。

依据 OpenAI 官方 [Sunburst 模型页](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)、[Flare 模型页](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare) 和[生图指南](https://developers.openai.com/api/docs/guides/image-generation)整理。**公开 API 模型存在 ≠ Codex OAuth 图片端点可用。** 此前直接将新模型加入可选菜单缺少后端兼容验证；已有 Flare 请求约 60 秒后 `UND_ERR_SOCKET / other side closed` 的报告。该错误不能单独证明模型不受支持，也不能归因于用户代理设置，因此先撤回未经验证的默认开放，而不是切换认证或自动重试。

`/reload` 后 OpenAI 使用原有 GPT Image 2；TUI 只有一个启用模型时自动跳过模型选择，RPC 可明确使用 `/image openai ...`。显式请求禁用的模型会在发送前报错，不会把模型 key 当提示词交给默认模型。`/image --help` 仍列出禁用状态，配置没有删除。

只有确认**当前认证后端**支持对应模型/参数后，才在 `models.jsonc` 将其 `enabled` 改为 `true` 并 `/reload`。该开关仅表示本地允许发送，不会验证或赋予后端权限；真实请求可能计费。`defaultModel` 只能指向启用模型。新模型或新质量档位的 mock 透传测试不构成真实可用性验证。

**配置不是万能协议适配器：**新的请求字段、接口协议或图片格式仍需代码支持；代码保留下载大小与文件系统安全限制。不要在配置中填写真实 Key、token、任意凭据路径或认证主机。

配置支持注释和尾逗号；缺失、语法错误、未知字段、重复属性/模型、无效引用或默认值会明确报错，不回退旧模型。修复后 `/reload`。配置损坏时帮助/设置入口仍可显示修复指引，其他插件不受影响。

## 安全与限制

- 每次一张，无水印；不支持 mask、图片集和多轮连续编辑。
- 校验图片 MIME、文件签名和大小；不覆盖已有文件，拒绝通过输出目录符号链接写入。
- 会话仅保存路径和非敏感元数据，不保存输入 Key 或图片 base64。
- 错误截断并清理实际请求 Key、Bearer 和大段 base64。
- 生图插件不会自动发现上游新模型；只有 `models.jsonc` 是模型来源。

## 排查 `fetch failed`

`fetch failed` 通常只是 Node 的外层异常，不能单凭它判断是 Key、模型还是网络问题。插件现在会保留嵌套 `cause` / `AggregateError` 中的错误码，并区分**生成请求、编辑请求、图片下载**以及**连接/发送、响应读取**两个阶段。收到响应时显示 HTTP 状态；即使返回 HTML 而不是 JSON，也不会丢失状态码。

请求或响应读取失败时，通知会给出简短原因、排查建议及日志相对路径：

```text
生成请求失败 · chatgpt.com · 连接/发送
未收到 HTTP 响应 · UND_ERR_CONNECT_TIMEOUT
connect timed out
请求超时：检查代理和网络；服务端可能已处理请求，请先确认额度或结果再重试。
诊断日志（当前项目）：.pi/image-generation-logs/error-<uuid>.json
```

日志位于**运行 `/image` 的当前项目**，不是插件安装目录。每次失败生成独立文件，包含时间、模型、目标主机、阶段、耗时、HTTP 状态、可用的请求 ID、最多 12 项原因链及 Node/平台版本。只保留主机，不记录完整服务路径或签名下载 URL；不主动记录请求头、请求体、提示词、图片内容、原始堆栈或环境变量。错误摘要会对已知凭据/提示词/图片数据、URL 和终端控制码进行脱敏。**分享前仍请检查日志，只提供该次错误文件，不要提供 auth.json。**

### 网络阶段时间线（成功与失败对照）

成功 HTTP 请求也会写入 `success-<uuid>.json`，失败仍是 `error-<uuid>.json`；主动取消仍不写日志。`outcome:success` 仅表示 HTTP 响应读取/JSON 解析成功，不保证后续图片保存成功。OpenAI 日志增加实际发送的 size、quality 和参考图数量（白名单），以及可用的 `imagegenRequestId`。

`network.events` 的 `elapsedMs` 从请求开始计时：
- `request-created`：Undici 创建请求。
- `socket-assigned-headers-sending`：已取得可用 socket，开始发送头；不是独立 DNS/TCP/TLS 握手计时。
- `request-body-sent`：客户端报告请求体已发送；不证明上游应用已接收/开始生成。
- `wire-response-headers` / `fetch-response-headers`：传输层 / fetch 取得响应头。
- `wire-response-complete` / `response-consumed`：响应传输 / 消费完成。
- `wire-request-error` / `request-failed` / `signal-aborted`：底层失败 / fetch或读取失败 / 信号取消或超时。

如果 body-sent 很早发生，随后约 60 秒失败且没有 response-headers，更支持“等待响应时连接关闭”，而不是请求体上传慢。不能仅凭该时间线区分本地代理和 OpenAI 网关；请按日志 `timestamp`（UTC 请求开始时间）与耗时对照代理日志。没有 body-sent 事件也不能单独证明未发送。`observation:fetch-only` 表示未捕获可关联的 Undici 事件（例如自定义 fetch），不应据此判断连接状态。

观察器只关联本次异步请求的 request 对象，不抓取其他会话请求，不保存 socket 地址、代理凭据、DNS/TLS 原始信息。不新增请求头、不替换 dispatcher、不修改超时或请求正文。每次结束解除订阅，最多记录 32 个事件。日志不自动清理；成功日志不会额外刷屏，请在同一目录按时间查看。

PowerShell 查看当前项目最新日志：

```powershell
Get-ChildItem .pi/image-generation-logs/error-*.json |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 |
  Get-Content
```

| 错误码 / 状态 | 优先检查 |
| --- | --- |
| `ENOTFOUND` / `EAI_AGAIN` | DNS、网络或代理的域名解析 |
| `ECONNREFUSED` | 代理是否运行、端口和防火墙 |
| `ECONNRESET` | 代理/网关断连、连接稳定性；注意是否已进入响应读取阶段 |
| `UND_ERR_SOCKET` / `other side closed` | 服务端或代理关闭连接；先核对日志中的模型及最近的请求改动，不能排除模型/请求兼容问题 |
| `UND_ERR_CONNECT_TIMEOUT` / `ETIMEDOUT` / `TimeoutError` | 网络路径、代理及请求耗时 |
| `CERT_*` / `SELF_SIGNED_CERT_IN_CHAIN` | 系统时间、代理证书和受信任 CA；不要关闭 TLS 校验 |
| HTTP `401` | 所选账户的登录或 Key |
| HTTP `403` | 账户权限、模型可用性、代理或网关限制 |
| HTTP `429` | 额度和限流 |
| HTTP `5xx` | 上游服务或网关状态 |

浏览器能打开网站不代表 Pi 的 Node 请求经过相同代理；检查**启动 Pi 的进程**及宿主代理配置，不要只看浏览器设置。修改启动环境后需要重启 Pi，`/reload` 不会重新继承 shell 环境。插件不会自行切换代理、账户或模型。

日志采用唯一文件名、原子写入和目录符号链接检查；Unix 文件权限为 `0600`，Windows 依赖用户/项目目录 ACL。日志写入失败会保留原始网络错误并提示检查目录权限/磁盘空间。成功请求和主动取消不生成错误日志，超时会记录；尚未进入网络请求的本地配置/校验错误仍使用原有提示。日志不会自动上传或清理，可手动删除旧日志；本仓库已忽略 `.pi/image-generation-logs/`，其他使用项目也建议加入 Git 忽略。

**不会自动重试。** 连接中断、超时或图片下载失败时，上游可能已经生成并计费，先确认结果/额度再决定是否重新生成。此次更新改善诊断，不代表已经修复实际网络故障。`/reload` 后的失败才会产生新日志，历史 `fetch failed` 无法补回底层原因。

## 验证

```bash
npm test
npm run test:host
```

`npm test` 使用 Node 内置框架、临时凭据、合成 JWT 和离线测试。宿主检查使用已安装 Pi 的 SDK/Jiti；全局安装无法自动解析时提供 SDK file URL：

```bash
npm run test:host -- file:///D:/Nodejs/node_modules/@earendil-works/pi-coding-agent/dist/index.js
```

宿主检查在**仅用于测试的显式启用配置**中覆盖全部五款模型生成/编辑的 mock 请求，同时验证默认禁用模型不注册、不进入 TUI 菜单、RPC/运行时在认证和 fetch 前拒绝；还覆盖命令/设置、扩展重新初始化，以及图集链接发布、会话渲染、OSC 8 目标与换行、主题更新、单张/多张结果的 TUI 链接去重、RPC/不支持终端的降级和预览失败降级。它**不等同于实际 TUI 操作或完整 AgentSession.reload 集成验证**。实际终端秘密输入、账户设置交互和真实生图应另行验收；真实请求会消耗额度，自动测试不会发送。

在本 Git 仓库还可运行旧版差分验证：

```bash
npm run test:baseline -- file:///D:/Nodejs/node_modules/@earendil-works/pi-coding-agent/dist/index.js
```

从插件最后一个可用提交 `4df3ccd805ef32616ccbc8ee635649b3be1f1e46`（HEAD `e08e3f9` 中该插件仍是此版本）读取代码到临时目录，并以相同合成认证/输入分别执行旧、新扩展。30 组生成/编辑、质量和官方基础 URL 场景比较 URL、方法、完整请求头、序列化请求体及认证解析次数，且检查适配器原有 `quality: auto` 默认值。保留的安全差异是禁止自动重定向；它不修改首个请求的头或正文。所有 fetch 均被 mock，不会回滚工作区、读取真实凭据或请求付费接口。此验证证明原模型请求契约保持一致，**不证明线上服务当前一定可用**。
