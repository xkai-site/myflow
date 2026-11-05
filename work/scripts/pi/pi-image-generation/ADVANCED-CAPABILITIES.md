# 高级图像能力：官方协议、本地实现与 Codex 验证边界

日期：2026-11-05。最初代码基线：`9c77a5fb27a469e42c8c7ae61b45a2c9b0312381`；本轮在已有实验 GIF 工作区上继续实现。

**本轮没有调用真实图片接口，没有验证账户权益，没有自动重试、提交或推送。** 所有新增请求测试都是离线 Mock。GIF、SVG、Markup 的生产配置均默认关闭；Streaming 只有独立离线适配器，配置禁止开启生产流式功能。

## 1. P0 结论纠正与证据分层

SVG、Markup-guided Editing、Streaming 都已有明确的 **OpenAI Platform Images API 官方协议和官方 SDK 类型**。不能再将“部分官方页面抓取失败”写成这些能力缺乏官方协议，或用它阻塞本地安全实现、协议构建和离线测试。

上轮报告其实已经成功读取生成指南和 Generate/Edit Reference，但仅交付 GIF，未实现其余成功路径。本轮补充固定版本 SDK 证据、确认 Markup 像素上限，并实现可离线验证的成功路径。上轮公告页面 HTTP 403 仅是抓取结果，**从来不是能力不支持的证据**。本轮下表中的指南、Reference、模型页、两份 SDK 源码均读取成功，无需第三方猜测。

必须分别记录：

1. **Platform 官方协议已证实**：公开 Images Generate/Edit 参数、约束及返回事件。
2. **官方 SDK 类型已包含**：序列化/流式类型证明客户端协议覆盖，不是任何服务器通道的成功记录。
3. **Codex 在线接受已证实**：需要明确授权后，用真实账户和原 Codex 端点验证。本轮四项均没有此证据。

本次检索范围内未发现 `pi-image-generation-official-capabilities-2026-11-05.md`，因此直接核对以下官方资料。

### 已读取的官方来源

| 来源 | 内容与边界 |
| --- | --- |
| [Image generation](https://developers.openai.com/api/docs/guides/image-generation) | Markup 2.5/2.6、SVG、GIF、Images SSE，Markup 16,777,216 像素及 50 MB 文件限制 |
| [Images Generate](https://developers.openai.com/api/reference/resources/images/methods/generate) | `output_format: svg`、`n=1`、可选作者权限、`stream` / `partial_images`、返回体 |
| [Images Edit](https://developers.openai.com/api/reference/resources/images/methods/edit) | JSON `images` 和独立 `markup`，`image_url` 最大 20,971,520 字符，Images Edit SSE 示例 |
| [Sunburst 2.6](https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst) / [Flare 2.6](https://developers.openai.com/api/docs/models/gpt-image-2.6-flare) | 模型及 Images Generate/Edit 能力，不意味着 Codex 账户接受 |
| [TypeScript SDK images.ts](https://github.com/openai/openai-node/blob/2d5b81c729b6d0b4f7da453026aaca6dedb2fb7e/src/resources/images.ts) | 固定 HEAD `2d5b81c729b6d0b4f7da453026aaca6dedb2fb7e`；Markup 上传字段、SVG 作者类型、Generate/Edit completed/partial 类型 |
| [Python SDK images.py](https://github.com/openai/openai-python/blob/ea5d1606f441d80dca1e9e7f99b74581f41408f8/src/openai/resources/images.py) | 固定 HEAD `ea5d1606f441d80dca1e9e7f99b74581f41408f8`；Markup/SVG 参数及流式重载类型 |
| [Codex 请求类型](https://github.com/openai/codex/blob/2be3dd3ff3afe74205ed341e1eec2ed8f298ee48/codex-rs/codex-api/src/images.rs) / [ImagesClient](https://github.com/openai/codex/blob/2be3dd3ff3afe74205ed341e1eec2ed8f298ee48/codex-rs/codex-api/src/endpoint/images.rs) | 上轮固定版本证据：GIF 可序列化及原图片路由；该版本完整 JSON 读取，没有 SVG/Markup/SSE 字段，不等于后端拒绝或接受这些字段 |

**SDK 的具体差异：** 当前 TypeScript 的 `markup?: Uploadable` 和 Python 的文件类型对应 SDK multipart 编辑接口。JSON 的 `images` 与 `markup: {image_url | file_id}` 结构由官方 Edit Reference/指南证实；不能声称这两份 SDK 的 multipart 类型本身证明其支持相同 JSON 对象。此插件继续构建原有 Codex JSON 请求，不引入 OpenAI SDK 或迁移到 Platform API。

## 2. Markup-guided Editing

### 官方协议已证实

- 支持相应 GPT Image 2.5/2.6 模型，Platform `POST /v1/images/edits`。
- JSON 原图仍是 `images[0]`，额外 `images` 是普通参考图。标记层是独立 `markup` 对象，恰好指定 `image_url` 或 `file_id` 之一。
- 真实透明 PNG，方向归一化后与第一张图同宽高；**两张各最多 16,777,216 像素**。透明通道存在不等于存在透明像素。
- 标记文件 50 MB；JSON `markup.image_url` 最大 20,971,520 字符，包含前缀和 Base64。仅本地 PNG data URL 的实现按更严格的 **15,728,622 原始字节**限制读取，归一化后的输出再次校验。
- 不与 `mask`、`prompt_rewriter` 同用，不把图层合成到原图。
- Edit Reference 的 Markup 段落仍简写 Supports GPT Image 2.5；指南明确补充 2.6。这是官方页面覆盖差异，不是否定 2.6 的证据。

### 本地实现

- `models.jsonc` 给 2.5/2.6 两款分别配置 `nativeCapabilities.markup.enabled: false`。旧配置没有字段仍兼容，未给旧 `openai` 或 Wan 添加该能力。
- `src/markup.ts` 使用 `sharp` / libvips 真实解码，像素预算在解码入口约束。检查真实 PNG、格式、大小、单页/非动画、EXIF 方向、匹配尺寸、实际 Alpha 样本；16 位 Alpha 保留精度，65534/65535 不会误判成完全不透明。
- 第一张图片和图层分别方向归一化为 PNG，删除方向元数据；不合成，不重排参考图。其余参考图保留顺序及字节。
- 真实 APNG 双帧样本验证拒绝动画输入；205 字节，Pillow 一次性制备并实际解码，测试/运行时不依赖 Pillow。
- 同时校验原始输入和归一化后 JSON 字段大小。PNG/JPEG/WebP 等是否可解码由受限解码器决定；普通编辑仍保留原有 BMP 路径，Markup 模式可能拒绝当前 libvips 不支持的输入编码。
- 同步请求构建器要求经过真实像素校验的、身份绑定且冻结的输入对象，不能用调用者提供的 `validated: true` 跳过验证，也不能在验证后修改图层。
- Runtime 在凭据解析之前读取、验证和归一化。独立适配器调用也必须在 JWT/HTTP 前完成校验。拒绝冲突字段和被忽略的本地路径参数。
- TUI 仅在显式启用的编辑任务参数中增加一个可选“标记 PNG”路径；默认直接开始，不多加步骤。Escape 保留，留空移除。不提供绘图器。
- RPC 增加可重复 `--image PATH` 和单个 `--markup PATH`，不修改 RPC JSON 通知协议。路径是用户明确选择的 Pi 机器本地文件；不尝试把 RPC 图片附件当参考图。附加图片与本地路径不能混用。
- 完整编辑结果沿用原 MIME、保存及历史行为。不走 SDK 的静态 metadata 丢弃图层路径，而是使用局部独立传输分支。

### Codex 边界

仍发送到 `https://chatgpt.com/backend-api/codex/images/edits`，只是显式 opt-in 后增加独立 JSON `markup`。**字段接受、账户权限、实际编辑效果、尺寸预算及拒绝/忽略行为均未在线验证。** 错误不回退为合成图或普通参考图请求。

## 3. SVG 原生生成

### 官方协议已证实

- Platform `POST /v1/images/generations`，`output_format: "svg"`、`n: 1`。
- `data[0].b64_json` 解码得到 UTF-8 SVG XML。不是栅格图，不可伪造 PNG 签名或扩展名。
- 不支持编辑、streaming、partial images、输出压缩、prompt rewriter。
- 可选 `svg.model` 需要额外 SVG 作者选择权限；本实现**不发送任何 `svg` 作者子配置**。
- 质量/复杂度控制参考图，不能据此假设作者模型的推理权限。

### 本地实现与安全策略

- 两款 2.6 独立 `nativeCapabilities.svg.enabled: false`，只允许生成任务显式 opt-in。
- `src/svg.ts` 使用命名空间感知的 **saxes 严格 XML 解析器**，UTF-8 fatal 解码，XML 1.0。正则仅用于解析器产生的属性值语法，不承担 XML 解析/净化。
- 拒绝 DTD、实体声明、外部实体、处理指令、未知实体、CDATA、脚本、事件属性、CSS/style、href/use、image、foreignObject、动画、过滤器、mask、外来/重绑命名空间。
- 保守静态白名单允许常用路径/形状、文本、分组、根 defs 中的局部渐变和非递归 clipPath。限制本地引用目标类型，禁止 clip 定义继承裁剪引用造成递归。禁止外部 URL、data URL 和嵌入栅格。
- 文件最大 **2 MiB**，最多 **10,000 个 XML 节点**（元素、文本、注释及声明）、深度 **64**，每元素最多 **48 个属性**；普通属性值 2,048 字符，路径/点列表 256,000 字符。
- **采用拒绝而非静默剥离策略**：完全通过白名单才保存原 XML 字节。可能拒绝一些安全但本地不支持的 SVG，例如带 CSS、复杂滤镜、嵌套 viewport 或某些单位的文档。这是本地安全边界，不声称支持完整 SVG 标准。
- `decodeGeneratedArtifact` 使用独立 SVG 路径；栅格输入/SDK decoder 不接受 SVG。响应格式、实际 XML、MIME 和单个结果均校验。
- 继续使用安全目录、临时文件、原子 rename 和取消回滚。`.svg`、`image/svg+xml`，历史可选 `kind: "vector"`，旧记录不要求新字段。
- 终端**永远不直接执行或渲染 SVG**。重新加载历史时也先验证文件，再仅显示路径、原文件链接和文字说明。不会自动启动浏览器或转 PNG。

### Codex 边界

显式 opt-in 后仍发送原 Codex `/images/generations`，`n=1`，不额外指定作者。**尚无 Codex 实际成功记录或账户权限证据。** XML 安全通过不代表模型语义正确，也不代表未来修改后的文件仍安全。

## 4. Streaming Partial Images

### 官方协议已证实

- Platform Images Generate/Edit 支持 `stream: true`、`partial_images: 0..3`，SSE。
- 生成事件：`image_generation.partial_image` / `image_generation.completed`。
- 编辑事件：`image_edit.partial_image` / `image_edit.completed`。
- Base64 在 `b64_json`，partial 带 `partial_image_index`。可能提前完成，不保证收到请求数量的部分图。
- 这不是 Responses 的 `response.image_generation_call.partial_image` 协议，也不假设 `[DONE]` 是 Images 的完成标记。
- 不与 SVG/GIF 组合。partial 可能增加 token 费用，不进行自动付费验证。

### 独立离线实现

- `src/image-sse.ts` 的 `parseSse` / `readImageSse` 接收已经取得的 Response，**没有 fetch、认证、生产 Runtime 分支或 TUI 流式开关**。
- 增量 UTF-8、LF/CRLF/CR、跨块分隔符、任意字节拆分、多行 data、注释及字段重置。
- 单事件默认最多 **48 MiB**，累计输入最多 **192 MiB**，测试可调低但不能扩大上限。未终止行也计入限制；每事件最多 100,000 条 data 行，固定分片缓冲避免一字节网络块导致字符串反复扫描；仅保留当前事件、一个最终结果及最多三次有界预览回调，不收集完整事件历史。以上是协议字节预算，不是宣称 JS 堆只占相同字节数。
- 严格检查事件类型/模式/顺序、Base64 与真实栅格格式、partial 索引、错误事件、重复完成、断流、UTF-8 损坏和未完成事件。未知事件保守拒绝，待通道确认后才能调整。
- `onPartial` 仅交给调用者临时预览，不写文件或历史；只有 completed 才返回最终 `ImageTransportResult`。缺失 completed 即失败，不把最后一张 partial 当成最终图。
- AbortSignal 取消待处理读取，释放 reader，取消后不处理同块内的迟到 completed 或 partial。
- 原 `http.ts` 的 JSON/诊断模式完全不变；生产请求注入 stream/partial 字段仍拒绝。配置明确拒绝 `streaming.enabled: true`。
- 宿主离线测试验证 parser → 仅 completed 保存/发布的适配边界；并未将该流程接到生产网络或现有 loader，不声称已经实现生产流式 UI。

### 上线前必须补齐

需要授权后确认原 Codex 端点能返回 `text/event-stream`，请求头、事件字段、错误/结束、账户权益、费用和取消语义。届时才设计真实临时预览与生产 transport，复用现有忙碌锁和 reload 保护。当前独立解析器不能被称为 Codex Streaming 已可用。

## 5. 保留原生 GIF

没有重写 `src/gif.ts`，没有改变默认 false、请求字段、尺寸政策、帧数或时长。仅将共用文件分支同时用于 SVG/Markup，不进行格式统一重构。

- 原 Codex `/images/generations`，`output_format: gif`、兄弟字段 `frame_count`、`frame_duration_ms`、`n=1`。
- 指南 2～64 帧与 Reference/Codex 类型 2～16 帧冲突，继续保守 **2～16**；默认 9 帧，200ms，范围 **20～2000ms**。舍入容差 5ms。
- 本地尺寸白名单仍 `auto` / `512x512`，不继承静态最小像素限制，不放开自定义尺寸。真实 Codex GIF 尺寸预算及 preview access 未确认。
- 只生成，不支持编辑、Markup、streaming、partial、透明背景、压缩或 prompt rewriter。不合成帧、不转换 PNG、不冒充 SDK ImageContent。
- 请求格式、MIME、结果数量、真实帧数、延迟和显式尺寸不匹配则失败，不保存、不重试。
- 原子保存、取消回滚、`.gif`、`image/gif`、可选 `kind: animation` 和历史兼容均保留。终端仅文字/路径/原文件链接，不播放。
- 原有有界容器验证不是完整 LZW/像素解码器：最大 32 MiB，画布 16,777,216 像素，累计帧矩形 67,108,864 像素，最多 16 帧。
- 真实双帧离线 fixture 仍是 512×512、各 200ms、无限循环、1857 字节，SHA256 `386f595a7ab6cc1e08faa68a34483915a6c2e90d5ca722a935e97578313c19ab`；不是线上模型输出。

## 6. 依赖、安全与兼容性

现有直接依赖只有 `jsonc-parser` 和 `proper-lockfile`，不具备 XML 或像素解码能力；不依赖宿主偶然存在的传递包。自写 XML 正则净化器或仅检测 PNG Alpha 通道都不能满足要求，因此新增并锁定：

- `saxes@6.0.0`：纯 JS 严格 SAX XML 解析，另有 `xmlchars` 传递依赖；本地白名单负责主动内容/资源策略。
- `sharp@0.35.5`：libvips 原生像素解码、方向及 PNG 编码；**仅启用 Markup 操作时动态加载**。没有把 SVG 送入 sharp/libvips 渲染。需要当前操作系统/架构的可选原生包，不能 `--omit=optional`；跨平台部署须实际安装验证。8/16 位 Alpha 均真实检查。

`npm audit` 默认镜像返回 404 `NOT_IMPLEMENTED`，不是“无漏洞”的结果；随后显式使用 `https://registry.npmjs.org` 执行审计成功，退出码 0，报告已知漏洞 0。这不等于解码器/XML 库不存在未知漏洞，部署仍需跟进安全更新。

未修改 OAuth、凭据来源/刷新、Provider 注册、`extensions/index.ts`、`src/http.ts`、原忙碌锁、300 秒 RPC 超时或 `/reload` 生命周期。没有迁移 Platform API，没有新登录方式。

PNG/JPEG/WebP、透明背景、Quality、Complexity、2.5/2.6 配置、Wan 普通生成/编辑均继续回归。已有静态输出透明背景检查仍只是容器 Alpha 检查，不因为新增 sharp 而冒称其已逐像素验证；真实透明像素校验专用于 Markup 输入。

上轮附带的生命周期测试轮询稳定性修复和 32 MiB 历史预览文件上限继续保留，不扩大此次修改范围。

## 7. 测试执行记录

Windows，Node.js `v24.22.1`，本机 Pi SDK `1.5.0`。自动测试不调用真实图片服务。

| 阶段 | 命令 | 结果 | 退出码 |
| --- | --- | --- | --- |
| 本轮修改前基线 | `npm test` | 74/74 通过 | 0 |
| 本轮修改前基线 | `npm run test:host` | 35/35 通过 | 0 |
| 最终正序 | `npm test` | 100/100 通过 | 0 |
| 最终正序 | `npm run test:host` | 43/43 通过 | 0 |
| 最终模型倒序 | `PI_IMAGE_TEST_REVERSE_MODELS=1 npm test` | 100/100 通过 | 0 |
| 最终模型倒序 | `PI_IMAGE_TEST_REVERSE_MODELS=1 npm run test:host` | 43/43 通过 | 0 |
| 依赖审计 | `npm audit --omit=dev --registry=https://registry.npmjs.org` | 已知漏洞 0 | 0 |

开发中的单元运行曾有 72/74（退出 1，旧“SVG 全拒绝”断言及新增 2.5 Markup 配置假设需更新）、95/98（退出 1，SSE fixture 比较误含 extension 字段）的失败；相应测试已修正后重新运行。上述最终四条命令均实际执行、无跳过项，不用写入测试文件代替执行。

新增测试覆盖：Markup 真 PNG、透明/不透明 Alpha、调色板、16 位 Alpha、EXIF 方向、像素/文件/data URL 限制、独立字段与参考图顺序、不可伪造的构建器校验、TUI/RPC、SVG 安全 XML、危险内容和预算、原子保存/取消、SSE 分块/异常/提前完成/资源限制/取消、真实 SDK 拒绝文件型输出、历史降级和深浅主题 24/40/80/120 列。宿主测试的 opt-in 使用临时模块副本，**不会临时改写生产 models.jsonc**。

修正了上轮关键负向用例中 `assert.fail()` 可能被 `assert.rejects()`/命令处理器吞成“预期失败”的问题：改为单独认证/HTTP 计数并断言为 0，或明确匹配能力/输入校验错误。测试通过不再单独依赖一个会被捕获的断言异常。

## 8. 四状态与上线条件

| 能力 | 官方协议已证实 | 本地实现完成 | 离线测试通过 | Codex 在线验证通过 |
| --- | --- | --- | --- | --- |
| Markup | 是，Platform 与 SDK；JSON 结构由 Reference 明确 | 是，实验输入/像素/方向/构建/编辑链路 | **是**，单元/宿主及模型倒序 | **否，未执行** |
| SVG | 是，Platform 与 SDK | 是，实验生成/安全静态 XML/文件链路 | **是**，单元/宿主及模型倒序 | **否，未执行** |
| Streaming | 是，Platform Images SSE 与 SDK 事件类型 | **仅独立解析与响应适配完成**，生产网络/UI 未接入 | **是**，解析/响应适配范围，非生产流式验收 | **否，未执行** |
| GIF | 是，Platform 与官方 Codex 序列化，帧数有冲突 | 是，保留原实验实现 | **是**，原用例及模型倒序继续通过 | **否，未执行** |

正式上线前必须由操作者明确授权潜在计费、账户和最小请求范围，再验证原 Codex 通道，留存脱敏请求/响应、request ID、真实文件及拒绝/忽略行为。Markup 还应人工确认区域编辑效果；SVG 要确认实际输出与保守白名单的兼容性、作者默认权限和费用；GIF 要确认 preview access、尺寸预算和真实多帧结果；Streaming 要先证实真实 SSE 协议再接生产预览。配置 opt-in 不是线上验收，也不能把 `codex` 改成 verified 来自证。
