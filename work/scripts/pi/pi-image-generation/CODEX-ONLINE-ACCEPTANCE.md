# Codex 高级图像能力：最小在线验收计划（待授权）

准备/代码核对日期：2026-11-05。代码基准：`4386eaa9c0d0f2d234fc184431547cfa0993166e`。

**在线测试待授权，尚未发起真实图片请求。** 本文不是可执行授权，不自动读取或刷新真实凭据。准备阶段只读取官方公开资料、制备合成样本、用假 JWT 离线构建请求和执行 Mock 回归。

## 1. 审批范围与请求硬上限

建议先批准 **M1（Markup）1 次**；也可明确批准 **M1 + S1（SVG）各 1 次，整轮最多 2 次**。允许只批准其中一项。未批准项不执行，不将空余次数用于其他模型、GIF、普通编辑对照或 SSE 探测。

- 账户：沿用操作者指定的当前 Pi `openai-codex` OAuth 登录。批准前确认使用哪个账户的非敏感名称；不输出账户 ID、Token、Cookie、认证头或凭据文件。多账户或来源无法确定时暂停询问，不能自行换账户。
- 执行：串行、无自动重试、无模型回退。批准两项时先 M1，成功后先让操作者检查编辑效果，再开始 S1；不会同时在途。
- 限额：M1 至多 1 次图片 POST，S1 至多 1 次图片 POST；**按尝试发送次数计数，不按成功次数计数**。超时/断连也消耗这次尝试，不补发。
- 授权有效范围：仅列出的模型、端点、参数和公开合成样本。参数、账户、模型或样本改变需重新确认，不因批准一个测试就探测其他能力。
- 生产配置：`models.jsonc` 不修改。只在一次性验收进程的内存配置副本中，针对批准的目标模型/能力 opt-in，完成即丢弃；不写回 `nativeCapabilities.*.enabled`。
- 正常 Pi OAuth 凭据解析/必要刷新仍复用现有逻辑，不修改登录入口或 Provider 注册。图片调用走本插件 `generateAndSave`、原 transport、实际校验和原子保存；不使用 Platform API 作为替代结果。
- 发送前用一次性 fetch 守卫核对已批准的精确 URL、POST、模型、参数、样本摘要和请求计数，拒绝其他图片请求及重定向；只观察响应状态和允许的请求 ID 头，不打印/序列化请求对象。保持原 busy/取消/reload 生命周期，不绕过尚未结算的任务。共用 JSON transport 当前先 arrayBuffer 再检查实际大小，**执行前的一次性 fetch 守卫还必须对实际响应流逐块计数、超过 48 MiB 即取消并报错**，不信任 Content-Length、不扩大限制、不改图片/协议数据，不把该准备要求冒称为生产 HTTP 已加固。验收操作应在 Pi 空闲时进行。
- 最长等待沿用现有非 TUI 300 秒超时；取消/超时后不能把“本地没收到”解释为“服务端没处理”。底层未结算时不进行下一次请求。

审批示例：

> 批准 M1，仅使用当前 Pi 的〔账户非敏感名称〕，最多 1 次，接受可能的图片额度/费用，不重试。

或：

> 批准 M1 与 S1，使用〔账户非敏感名称〕，各最多 1 次、总计最多 2 次，先检查 M1 效果，再执行 S1；接受可能的图片及 SVG 作者费用，失败停止。

## 2. M1：Markup-guided Editing（推荐首先执行）

| 项目 | 拟定内容 |
| --- | --- |
| 模型名称 / key | GPT Image 2.6 Flare / `openai-flare-26` |
| 模型 ID | `gpt-image-2.6-flare` |
| 目标 | 验证独立 `markup.image_url` 的接受、真实 PNG 编辑输出及标记区域效果 |
| 端点 | `POST https://chatgpt.com/backend-api/codex/images/edits` |
| 最大请求量 | **1 次**，`n: 1` |
| 参数 | `model` 如上，`size: "1024x1024"`、`quality: "low"`、`complexity: "low"`、`background: "opaque"`；只含一张 `images[0]` 和独立 `markup`；选择 PNG（插件沿用省略 `output_format` 的 PNG 默认序列化） |
| 禁止字段 | 不发 `mask`、`prompt_rewriter`、`stream`、`partial_images`、动画参数、作者配置或压缩参数 |
| 认证 | 现有 Pi OAuth，原 Codex 账户头，不显示其值 |

提示词（公开、非敏感）：

> Recolor only the circular object indicated by the red markup outline to solid green. Remove the red markup from the final image. Keep the other circular object, the white background, and the small corner marker unchanged. No text.

### 已离线准备的样本

两个独立 PNG 文件位于 `test/fixtures/`，均为 1024×1024、无 EXIF，使用真实 PNG 编码；没有用户图片、路径内容、姓名或业务素材。

- `codex-acceptance-original.png`：白底、两个相同灰色圆（圆心 320/704,512，半径 112）、左上黑色 32×32 定位块。8,290 字节。
  - SHA256：`db39e85282b51566923d08a099eb360b7a7b7da0126200fa0d650aab023f7e01`。
- `codex-acceptance-markup.png`：透明底，仅左圆外红色圆环（内/外半径 132/140）；未标记处 Alpha=0。5,629 字节。
  - SHA256：`344bce2e1fb0696295c2a049f4f4ea06b1ccde52fbf920afd5d8fe39367635c1`。

样本已通过真实像素、透明度、尺寸、归一化和独立请求构建的离线校验；发送前仍通过 Runtime 校验。请求不合成两个文件，不把图层作为 `images[1]`，不记录 data URL 或 Base64。

### 接受与成功分开判断

1. HTTP 是否成功；JSON 是否符合原 Codex 图片返回结构，实际格式是否 PNG。
2. 是否通过当前插件校验、原子保存和历史展示；不改变输出格式校验策略以争取成功。
3. 操作者人工检查：左圆是否变绿、右圆是否仍灰、红环是否消失、白底/定位块是否合理稳定。
4. 如果只是 HTTP 200 或返回了一张图，只能记录“端点接受/效果待人工检查”；若区域不符或疑似忽略字段，记录 **Codex 在线行为异常**，不标记正式可用。
5. 单样本符合预期仍不能完全排除猜中/忽略，不能替代对照实验或证明所有尺寸/模型均有效。本轮不额外发送普通编辑或交换标记层的付费对照。

**成本风险：** 一次编辑可能消耗图片额度、输入图片/文本和输出 token；`low` 不代表免费或额度只扣固定一格。HTTP 错误、超时或保存失败不保证零费用。Codex 账户计价/权益当前未确认，无法给出可信固定金额。

## 3. S1：SVG 原生生成（可选第二项）

| 项目 | 拟定内容 |
| --- | --- |
| 模型名称 / key / ID | GPT Image 2.6 Flare / `openai-flare-26` / `gpt-image-2.6-flare` |
| 目标 | 验证原生 SVG XML 返回、本地安全白名单与原文件保存 |
| 端点 | `POST https://chatgpt.com/backend-api/codex/images/generations` |
| 最大请求量 | **1 次**，`n: 1` |
| 参数 | `output_format: "svg"`、`size: "1024x1024"`、`quality: "low"`、`complexity: "low"`、`background: "opaque"` |
| 禁止字段 | 不发参考图、`markup`、`svg.model` / `svg.reasoning`、stream/partial、压缩、prompt rewriter 或动画参数 |

提示词（公开、非敏感）：

> Create a minimal flat vector icon of a green circle centered inside a dark square outline on a white background. Use only basic SVG paths or shapes with solid fills and strokes. No text, gradients, filters, CSS, embedded images, links, animation, scripts, or external resources.

验收步骤：HTTP/JSON → Base64 解码为 UTF-8 XML → **原样通过 `validateStaticSvg()`** → `.svg` 原子保存与安全历史链接。终端和浏览器都不自动渲染；操作者自行选择可信矢量工具打开，确认几何、颜色与编辑性。工具无法打开或本地白名单拒绝都记录实际结果，不改后缀冒充 SVG，也不扩大白名单掩盖问题。

如 XML 合法但超出本地白名单，归为 **Codex 在线行为异常（通道返回与本地兼容性不符）**，区分“服务器返回了 SVG”和“本插件完成用户功能”。只记录脱敏结构分类，不打印完整 XML；停止本轮，另行离线分析。危险内容拒绝绝不视为安全策略缺陷。

**成本风险：** 可能同时产生参考图渲染和 SVG 作者 token 费用，作者默认权限、选择权益和 Codex 计价未确认；省略作者配置不代表免费。一次请求 `n=1` 也不承诺只有一个收费步骤。若操作者不能接受这个不确定性，不批准 S1。

## 4. 整轮停止条件

任一已批准请求出现以下任意情况，**停止整轮，剩余次数不继续使用**：

- 任何非 2xx（包括 400、401、403、429、5xx）；不通过调整参数马上重发来探测权限。
- 网络超时、断开、取消、无法确定是否已产生费用或底层操作未结算。
- 非预期重定向、非 JSON、缺字段、结果数量/真实格式不符、疑似忽略参数。
- 本地安全/大小/保存校验失败，或用户要求停止。
- M1 人工效果检查不通过或无法判断。

不把一次失败当作永久不支持；不把一次成功推广至 Sunburst、2.5、其他尺寸/账户，也不默认启用任何生产能力。

## 5. GIF 与 Streaming 不在本轮建议授权范围

- GIF 排第三优先，后续单独审批。候选仍为同一个 2.6 Flare，原 `/images/generations`，`n=1`、`output_format: "gif"`、`frame_count: 2`、`frame_duration_ms: 200`、`size: "512x512"`，其他普通质量参数届时审批；不继承栅格最小像素政策、不合成帧。要另行核对真实帧数、时长、播放及容器校验。**本轮 M1/S1 授权不覆盖此请求。**
- Streaming 仅完成离线解析复核。没有真实 Codex SSE 契约，不发送额外图片请求探测，不改普通 JSON transport，不接入生产预览。后续需要独立协议验证方案及授权。

## 6. 脱敏证据与结果更新

每次批准后的尝试都在 `ADVANCED-CAPABILITIES.md` 增加独立记录，包括：

- 实验日期/时间、计划编号、模型 ID、端点、批准范围、非敏感参数与样本 SHA256。
- HTTP 状态（无响应写“未取得”，不能写 0/成功）、允许头中的 `x-codex-imagegen-request-id` / `x-request-id`（验收台账只保留 SHA256 摘要；缺失写缺失）。
- 响应 Content-Type、实际产物格式、结果数量、本地校验/保存结果、最终文件 SHA256（只对安全且保存成功的文件）。
- 用户可见功能及人工检查结果，未知费用/权限/尺寸等限制。
- 状态按 **Codex 在线成功 / Codex 在线拒绝 / Codex 在线行为异常 / 尚未验证** 记录；网络不确定不能伪装成拒绝或成功。HTTP 成功但人工待检明确标注，不能自动判成功。

不记录完整请求体、响应体、图片 Base64、Token/Cookie/账户 ID 或用户私有内容。不向仓库写会话提示词/私有路径或不安全产物；公开测试提示词只在本计划定义一次。安全文件只按插件现有保存规则落盘，人工打开由操作者决定。既有网络诊断继续遵守脱敏规则，但私有日志可能按原有逻辑保留清洗后的完整请求关联 ID，不承诺其天然只含摘要：必须放在验收私有目录、不直接分享或提交，对外台账只记录 ID 摘要。HTTP 解析成功日志不能代替图片验收结论。

**当前实际图片 POST 数量：0。M1 未执行，S1 未执行，GIF 未执行，Streaming 未执行。**
