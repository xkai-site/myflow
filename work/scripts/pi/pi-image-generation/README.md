# pi-image-generation

通过 Pi 的 `/image` 命令生成或编辑图片：TUI 使用原生向导，RPC 使用文本选项。插件只适配图片接口，不接管聊天模型、Agent 工具或 Pi 运行时。

官方资料定义上游协议，[models.jsonc](models.jsonc) 声明当前模型与参数，[src/](src/) 和 [test/](test/) 定义客户端实现与回归。清单中可选择不代表账户有权限；Platform API 文档也不保证 Codex 后端接受相同能力。

## 安装与加载

需要 **Pi ≥ 0.99.0、Node.js ≥ 22.19.0**。在本插件目录执行：

```powershell
npm install --ignore-scripts --legacy-peer-deps
pi install .
```

本地安装引用源码目录，请保留该路径。启动 Pi；已运行的 Pi 执行 `/reload`。
`sharp` 用于实验 Markup 输入解码，需要当前平台的原生可选包，安装时不要使用 `--omit=optional`；支持的预编译平台无需安装脚本。
完成认证后，在希望保存图片的项目中启动 Pi，输入 `/image 一只水彩橘猫`。

## 认证

### OpenAI Codex：复用 Pi 登录

需要 Pi 中已配置并认证的 **`openai-codex` provider**。宿主若没有此 provider，须先安装相应 provider 扩展。
在 Pi TUI 执行 `/login openai-codex`，由 Pi 完成原生 OAuth 登录；插件不自行登录、保存或刷新 token，每次请求重新向 provider 取凭据。

也可输入 `/image --settings` → OpenAI → 登录 / 重新认证。此入口只在主输入框预填 `/login openai-codex`，需按 Enter 执行；若有草稿，会先确认是否替换。它不会自动登录或把命令交给 LLM。登录完成后重新运行 `/image`，无需重载。

设置页可查看状态和凭据路径。Pi provider 凭据位于 `<getAgentDir()>/auth.json`，不是图片专用 Key 文件。
普通 `openai` 与 `openai-codex` 是不同账户配置；仅登录普通 OpenAI 或 Codex CLI 不会自动配置此账户。插件不读取 `~/.codex/auth.json`，不要手动复制 token。

请求使用 ChatGPT Codex 订阅后端 `https://chatgpt.com/backend-api/codex/images/generations` 或 `/images/edits`，**不是 OpenAI Platform API Key 接口**。模型支持、权益与额度由服务端决定。

### 千问：Token Plan CN Key

在 Pi TUI 输入 `/image --settings` → 千问，秘密输入并确认保存 Key，下一次请求生效。**仅支持 Token Plan CN，不支持普通百炼/DashScope 按量付费 Key。**

认证优先级：已保存图片专用 Key → Pi 启动环境中的 `PI_IMAGE_QWEN_API_KEY` → `qwen-token-plan-cn` provider。仅来源未配置时查下一项；读取损坏或认证失败不静默回退。

- 专用 Key 是用户级**明文**文件：`<getAgentDir()>/pi-image-generation/auth.json`，通常为 `~/.pi/agent/pi-image-generation/auth.json`，支持 `PI_CODING_AGENT_DIR`。Windows 依赖用户目录 ACL，不要提交或分享。
- 设置支持查看来源、替换及删除专用 Key；删除不影响 provider 凭据。保存只验证本地写入，不发送付费验证请求。
- 非 TUI 不能秘密输入：先在 TUI 保存，或通过安全启动环境注入；不要把 Key 放入命令、提示词或会话。
- 服务端点为 `https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`。

认证仅允许适配器支持的官方 HTTPS 端点，不支持自定义认证主机；认证请求和图片下载均不自动跟随重定向。

## 命令与 TUI

| 入口 | 行为 |
| --- | --- |
| TUI `/image` | 生成/编辑 → 提示词 → 账户 → 模型 → 参数 → 执行 |
| TUI `/image <prompt>` | 整段文本预填提示词，**不解析 RPC 选项** |
| `/image --settings` | 账户管理，仅支持 TUI |
| `/image --help`、`/image -h` | 用法、模型 key 与禁用状态 |
| RPC `/image …` | 直接解析参数并请求，不打开向导 |

单账户或单模型自动选择；模型列表展示名称与定位，账户默认模型排在首项。参数菜单默认选中开始执行，只展示模型支持的选项，修改后保留已选值。
Escape 在参数选择器中返回菜单，在其他步骤取消。透明背景不提供 JPEG，JPEG 不提供透明背景，不静默改写其他已选值。

TUI 编辑需在向导中填写本地参考图路径，每行一个，支持拖入、引号或 `@path`；相对路径基于 Pi 当前项目。第一张为原图，其余为参考图。

## RPC 参数与结果

```text
/image [model-key] [--size VALUE] [--quality VALUE] [--complexity VALUE] [--format VALUE] [--background VALUE] [--image PATH ...] [--markup PATH] [--] <prompt>
```

| 参数 | 当前行为 |
| --- | --- |
| `model-key` | 放在首词，使用下节的 key，不是上游 ID；仅一个图片账户配置有效时可省略，使用其 `defaultModel` |
| `--size` | 默认值、预设、自定义尺寸及生成/编辑差异查模型配置；OpenAI 用 `宽x高`，Wan 用 `宽*高` |
| `--quality` | OpenAI 按配置提供，默认 `auto`；Wan 拒绝 |
| `--complexity` | 仅两款 2.6 支持 `low`、`medium`、`high`，默认 `high`；控制布局规划，不是画质 |
| `--format` | 两款 2.5 和两款 2.6 支持 `png`（默认）、`jpeg`、`webp`；其他模型拒绝显式参数；实验格式见下节 |
| `--background` | 同上四款支持 `auto`（默认）、`opaque`、`transparent`；JPEG 与透明互斥 |
| `--image PATH` | 可重复，本地文件编辑，第一张为原图；不与附加图片混用 |
| `--markup PATH` | 仅显式启用 Markup 的编辑任务；独立透明 PNG，不计入参考图，不可重复 |
| `--` | 停止选项解析；提示词首词像模型 key 或选项时用于消歧 |

选项支持 `--name=value`。提示词必填，支持单/双引号，词间空白合并；单引号外反斜杠用于转义。Windows 路径用正斜杠或单引号。
即使提示词已经开始，后续选项仍会解析，除非先写 `--`。未知选项、不支持的参数、缺值或非法组合会报错，不自动回退。
**标准 RPC 图片附件不会自动用于编辑**：请显式传入本地 `--image`，否则仍按纯文本生成，可能消耗额度。

认证预先配置好后，在目标项目启动 `pi --mode rpc`，向该进程 stdin 发送一行 JSON（不是 shell 命令）：

```json
{"id":"image-1","type":"prompt","message":"/image openai-flare-26 --quality high --complexity medium -- 一只水彩橘猫"}
```

编辑可把 `message` 换成 `/image openai-flare-26 --image 'original.png' -- 修改背景`；千问可用 `/image wan --size 2K -- 一只水彩橘猫`。
等待上一操作完成再发送；忙碌时拒绝新请求，非 TUI 请求超时为 300 秒。按 LF 持续读取 stdout JSONL：

- `response.id` 对应请求；`success: true` 只表示命令被处理/接受，**不代表图片成功**。
- 结果来自 `type: "extension_ui_request"`、`method: "notify"`：`notifyType: "info"` 且消息以 `Saved N image(s):` 开头时，包含逐张绝对路径及完整 `file:///…` URL；错误为 `error`，忙碌等提示为 `warning`。
- 通知不需回复，其 `id` 不是 prompt 请求 ID；请串行消费。命令不运行 LLM，不等待 `agent_end` 或读取最后一条 assistant 文本取图。
- 文件位于 **Pi 所在机器**，`file:///` 不是公网下载地址，RPC 客户端须自行读取或传输。

## 模型与配置

唯一模型清单为插件根目录 [models.jsonc](models.jsonc)，修改后 `/reload`；不从 Codex 缓存或另一份用户/项目清单发现图片模型。
当前各模型均启用，OpenAI 默认 `openai-flare-26`，千问默认 `wan`。清单中的定位供选择参考，不保证服务端效果或可用性。

| key | 上游模型 ID | 定位 |
| --- | --- | --- |
| `openai-flare-26` | `gpt-image-2.6-flare` | 快速生成与日常迭代，OpenAI 默认 |
| `openai-sunburst-26` | `gpt-image-2.6-sunburst` | 精细创作与精确编辑 |
| `openai-flare` | `gpt-image-2.5-flare` | 上代快速生成 |
| `openai-sunburst` | `gpt-image-2.5-sunburst` | 上代精细生成与编辑 |
| `openai` | `gpt-image-2` | 兼容已有工作流，不随默认模型重映射 |
| `wan` | `wan2.7-image` | 基础生成与参考图编辑，千问默认 |
| `wan-pro` | `wan2.7-image-pro` | 4K 生成，编辑最高 2K |

参数、默认值及范围以配置和 `/image --help` 为准，不按模型名称推断。所有模型支持生成和参考图编辑，每次请求一张，无批量数量参数或多轮连续编辑。
参考图校验签名、MIME、数量及大小；OpenAI 的 JSON data URL 限制包含 MIME 前缀与 Base64 开销，不等于其他上传协议的文件上限，也不是 Codex 服务端实测上限。

维护配置时关注 `providers[].auth/defaultModel`、模型 `key/id/provider/enabled`、`tasks`、`prompt`、`inputImages`、`size.generate/edit` 及可选参数策略。
未配置的参数不展示，显式传入即拒绝；省略 `size.edit` 继承生成规则。禁用模型不进入向导或运行时，显式选择也拒绝；不要禁用仍被 `defaultModel` 引用的模型。
支持 JSONC 注释和尾逗号；未知字段、无效默认值、损坏或缺失配置会报错，不回退旧清单。不要填真实 Key、token 或任意主机，新协议字段仍需代码支持。

### 实验能力

默认只开放静态栅格输出与普通编辑。Codex 后端不一定已开放完全能力：

- **Markup**：实验性编辑，默认关闭。仅在已有配置的目标模型上显式设置 `nativeCapabilities.markup.enabled: true` 并重载；TUI 编辑参数可选图层，RPC 用 `--markup`。原图保持第一项，图层走独立字段，不混入参考图、不合成。图层必须是真实含透明像素的 PNG，原图与图层方向归一化后同尺寸，分别受字节/像素限制；二者分别编码为 PNG，不改变其余参考图顺序。
- **SVG**：实验性矢量输出，默认关闭。两款 2.6 按模型启用 `nativeCapabilities.svg.enabled` 后可用 `--format svg`，仅生成；经严格静态 XML 白名单校验，拒绝脚本、事件、外部资源等，按原字节保存，不自动修复危险 XML。
- **GIF**：实验性动画输出，默认关闭。两款 2.6 按模型启用 `nativeCapabilities.gif.enabled` 后可用 `--format gif`、`--frame-count`、`--frame-duration-ms`；默认/范围/尺寸查配置。仅生成，不支持透明背景；返回必须符合动画容器及请求参数约束。
- **Streaming**：仅有独立离线 SSE 协议适配器 [src/image-sse.ts](src/image-sse.ts)，不接生产认证、请求或 UI；配置禁止 `streaming.enabled: true`。partial 只用于内存回调，必须 completed 才返回最终图片。

实验能力不支持任意叠加：Markup 不与 GIF/SVG/流式混用，不开放 mask、prompt rewriter 或输出压缩参数。启用实验配置会允许真实请求，可能计费，不等于获得服务端授权或通过验收。SVG/GIF 仅显示文件信息及链接，终端不渲染 SVG、不播放动画。

## 文件与失败恢复

文件保存在 **Pi 当前项目** `.pi/generated-images/`

| 现象 | 恢复要点 |
| --- | --- |
| 无账户 / 401 | `/image --settings`，OpenAI 重新原生登录，千问更新 Key |
| 403 / 429 | 检查账户权限、模型、额度及限流，本地启用不等于上游授权 |
| 网络失败 / 超时 / 5xx | 按日志区分生成、编辑、下载及等待响应头/读取阶段；检查启动 Pi 的网络与代理，不关闭 TLS 验证 |
| 配置或输入错误 | 修复配置后重载，核对 key、模型参数、格式组合及参考图限制 |
| 格式不符 / 无 Alpha | 不保存、不自动重试；检查通道支持和上游结果，不能改后缀/MIME 修复 |
| 保存失败 | 检查项目权限、空间及 `.pi`/输出目录是否为符号链接，不立即重新生成 |
| 取消后仍忙碌 | 等待底层结算；永久挂起则退出，确认上游状态后再重启并决定是否重发 |

诊断在项目 `.pi/image-generation-logs/`：失败通知含 `error-<uuid>.json` 路径；`success-<uuid>.json` 只代表 HTTP 读取/解析成功，不保证落盘。日志不自动清理，分享前检查脱敏，绝不分享 auth.json。
修改启动环境后须重启 Pi，`/reload` 不重新继承 shell 环境。会话保存提示词、路径与元数据（非 Key/base64）；生成会将提示词与参考图发送给所选服务。请保护并按需排除图片、日志、会话和凭据的版本控制。

## 离线测试

在已准备依赖的插件目录执行：

```powershell
npm test
npm run test:host
```

普通测试只使用假凭据、Mock 或回环服务，不依赖登录状态、账户或真实 Codex 服务。覆盖配置/认证、请求映射、格式和文件安全、实验门禁、SSE、取消/忙碌/迟到响应，以及原生 TUI、历史链接与预览降级。
宿主测试需要完整的已安装 Pi SDK 及依赖；`test/sdk.mjs` 依次检查脚本位置参数、`PI_SDK`、本地可解析包、Pi 托管安装和 PATH，不下载 SDK。特殊安装可用 `$env:PI_SDK` 指定 `dist/index.js` 绝对路径或 file URL。

模型顺序兼容检查（若环境变量原已设置，执行后恢复原值）：

```powershell
$previousReverseModels = Get-Item Env:PI_IMAGE_TEST_REVERSE_MODELS -ErrorAction SilentlyContinue
try {
    $env:PI_IMAGE_TEST_REVERSE_MODELS = "1"
    npm test
    npm run test:host
} finally {
    if ($null -ne $previousReverseModels) {
        $env:PI_IMAGE_TEST_REVERSE_MODELS = $previousReverseModels.Value
    } else {
        Remove-Item Env:PI_IMAGE_TEST_REVERSE_MODELS -ErrorAction SilentlyContinue
    }
}
```

倒序仅作用于内存模型目录，不改生产清单。Windows 无文件 symlink 权限时宿主测试显式模拟 lstat 拒绝分支，目录 junction 仍真实测试。
`test/host-dispatcher-probe.mjs` 是独立、显式运行的回环 Dispatcher 诊断，参数见脚本头部，不在普通测试中运行。
任何在线验收都必须建立新的独立批次并取得新的明确授权，不能复用历史批准；离线通过不代表在线能力或人工效果验收通过。

## 官方资料与维护

- [OpenAI 图像生成指南](https://developers.openai.com/api/docs/guides/image-generation)
- [Images Generate Reference](https://developers.openai.com/api/reference/resources/images/methods/generate)
- [Images Edit Reference](https://developers.openai.com/api/reference/resources/images/methods/edit)
- [Codex 官方源码](https://github.com/openai/codex)：仅供研究实际请求结构，当前客户端实现不是后端永久规则。

模型能力、默认值与范围维护在 `models.jsonc`；客户端适配和安全边界维护在 `src/`、`extensions/`；回归维护在 `test/`；使用变化同步此 README。历史调查与执行过程交给 Git，禁止维护另一份协议或验收台账文档。

许可证：MIT，见 [LICENSE](LICENSE)。
