# 高级图像能力：官方协议、本地实现与 Codex 验证边界

日期：2026-11-05。最初功能基线：`9c77a5fb27a469e42c8c7ae61b45a2c9b0312381`；本次安全收尾基准为 `4386eaa9c0d0f2d234fc184431547cfa0993166e`。第 2～8 节保留此前本地实现及测试记录，本次安全修复、增量审查、当前回归及按模型在线台账见第 9～12 节。

**本轮没有调用真实图片接口，没有验证账户权益，没有自动重试、提交或推送。** 所有新增请求测试都是离线 Mock。GIF、SVG、Markup 的生产配置均默认关闭；Streaming 只有独立离线适配器，配置禁止开启生产流式功能。

## 1. P0 结论纠正与证据分层

SVG、Markup-guided Editing、Streaming 都已有明确的 **OpenAI Platform Images API 官方协议和官方 SDK 类型**。不能再将“部分官方页面抓取失败”写成这些能力缺乏官方协议，或用它阻塞本地安全实现、协议构建和离线测试。

上轮报告其实已经成功读取生成指南和 Generate/Edit Reference，但仅交付 GIF，未实现其余成功路径。本轮补充固定版本 SDK 证据、确认 Markup 像素上限，并实现可离线验证的成功路径。上轮公告页面 HTTP 403 仅是抓取结果，**从来不是能力不支持的证据**。本轮下表中的指南、Reference、模型页、两份 SDK 源码均读取成功，无需第三方猜测。

必须分别记录：

1. **Platform 官方协议已证实**：公开 Images Generate/Edit 参数、约束及返回事件。
2. **官方 SDK 类型已包含**：序列化/流式类型证明客户端协议覆盖，不是任何服务器通道的成功记录。
3. **官方 Codex 客户端存在请求结构**：单独核对 Rust 客户端及工具，不能用 Platform SDK 的字段代替这份证据。
4. **Codex 后端实际接受**：需要明确授权后，对原 Codex 端点验证字段和真实响应；客户端可序列化不等于后端接受。
5. **当前账户具有权限**：账户、模型、实验权益分别验证；一个账户成功不能推广到其他账户。
6. **本插件实际完成用户功能**：安全校验/保存/历史及人工可见效果都成立，不能用 HTTP 200 代替。

本次四项均没有第 4～6 项的在线成功证据。

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

## 7. 上一轮功能实现的测试记录（历史）

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

## 8. 本地实现四状态与上线条件

| 能力 | 官方协议已证实 | 本地实现完成 | 离线测试通过 | Codex 在线验证通过 |
| --- | --- | --- | --- | --- |
| Markup | 是，Platform 与 SDK；JSON 结构由 Reference 明确 | 是，实验输入/像素/方向/构建/编辑链路 | **是**，单元/宿主及模型倒序 | **否，未执行** |
| SVG | 是，Platform 与 SDK | 是，实验生成/安全静态 XML/文件链路 | **是**，单元/宿主及模型倒序 | **否，未执行** |
| Streaming | 是，Platform Images SSE 与 SDK 事件类型 | **仅独立解析与响应适配完成**，生产网络/UI 未接入 | **是**，解析/响应适配范围，非生产流式验收 | **否，未执行** |
| GIF | 是，Platform 与官方 Codex 序列化，帧数有冲突 | 是，保留原实验实现 | **是**，原用例及模型倒序继续通过 | **否，未执行** |

正式上线前必须由操作者明确授权潜在计费、账户和最小请求范围，再验证原 Codex 通道，留存脱敏请求/响应、request ID、真实文件及拒绝/忽略行为。Markup 还应人工确认区域编辑效果；SVG 要确认实际输出与保守白名单的兼容性、作者默认权限和费用；GIF 要确认 preview access、尺寸预算和真实多帧结果；Streaming 要先证实真实 SSE 协议再接生产预览。配置 opt-in 不是线上验收，也不能把 `codex` 改成 verified 来自证。

## 9. 本次安全收尾：历史文件链接

发现并修复：此前 `src/result-view.ts` 在任何文件检查之前添加原文件链接。危险/损坏/已删除的 SVG/GIF 历史仍然存在打开入口，单看“预览不可用”警告不足以拦截。

现在的顺序：

1. 检查记录结构：必需的原有字段、数值及可选 kind；不要求旧记录包含 kind。捕获字段快照，后续修改调用方对象不能重定向已经校验的链接；路径/模型文字转义终端控制字符，不能注入自己的 OSC 8。
2. 绝对路径、规范化后的项目 `.pi/generated-images/` 布局及 MIME/扩展名/kind 一致性检查。路径来自历史记录持久化的绝对项目位置，不根据当前进程 cwd 猜测或重定向为另一个同名文件。
3. 对该项目根、`.pi`、`generated-images` 使用 `lstat` 确认普通目录且非符号链接/junction，检查 realpath 位于该项目规范化目录；项目上级的系统路径别名可以存在，但检查前后规范化根必须一致。
4. 目标用 `lstat` 确认为普通文件、非符号链接；检查大小（SVG 2 MiB，其余 32 MiB）和 realpath。
5. 只读打开文件；支持的平台使用 `O_NOFOLLOW` / `O_NONBLOCK`。比较 lstat 与文件描述符 fstat 的设备/inode、大小、mtime/ctime；Windows 不能只依赖 O_NOFOLLOW。
6. 使用描述符有界读取，最多初始大小 + 1 字节；文件增长/收缩即失败，不能在 stat 后无界 readFile。SVG 必须通过 `validateStaticSvg()`，GIF 必须通过 `validateAnimatedGif()`；栅格维持原文件签名/MIME 检查，不增加 JPEG/WebP 解码或修改生成格式策略。
7. 再核对描述符、路径身份、大小/时间及目录身份/realpath，随后关闭描述符。只有成功返回才添加文件 URI / OSC 8 链接。
8. 任何失败仅保留不可点击路径与“当前历史文件无法安全预览”警告。不会生成打开 URI、不自动打开程序、不渲染 SVG、不播放 GIF、不删除/修改/覆盖文件。合法静态图像仍用 Pi 原生预览，终端能力降级不影响已验证的文件链接。

**时间边界：文件校验只能证明检查时读取到的内容符合限制，不能保证文件之后不会再被外部修改。** 目录/文件身份复核降低常见替换竞态风险，不是原子文件系统沙箱，也不声称消除了全部 TOCTOU。视图仍按原设计只读一次；无常驻 watcher、无 render/invalidate 时反复读取、无结果视图架构重建。手动点击链接时应用读取的是届时的路径，不是一个不可变快照；高风险文件应由操作者重新检查。

新增 `test/history-security-host.mjs`，使用真实 Pi `getOsc8LinkAtColumn` 检查链接目标、原始 OSC 8 和可复制 file URI 的存在/不存在；不只检查警告文字。覆盖安全/不安全/被篡改/超大 SVG、脚本/外部实体/资源、正常/损坏/超大/丢失 GIF、目录、元数据错误、路径逃逸、控制码、旧 kind-free 历史、静态 PNG、文件与目录替换及增长后的描述符关闭。深浅主题、24/40/80/120 列、无图/Kitty/iTerm2、链接支持/不支持均覆盖相应安全路径。

Windows 环境限制：真实文件符号链接创建返回 **EPERM**。这两个目标（SVG/GIF）的 lstat 拒绝分支使用明确的文件系统 API 模拟，并断言模拟确实被消费；**不能声称在当前环境实际创建了文件 symlink**。项目根、`.pi`、输出目录的 junction 均实际创建并执行拒绝验证。文件/目录替换和增长使用真实文件操作及确定性时序注入，不靠概率竞争。测试未申请提权，也没有默默跳过用例。

## 10. 本次高级能力增量审查与官方 Codex 复核

### 本地代码

| 范围 | 核对结果 / 发现 |
| --- | --- |
| `markup.ts` | 真实透明像素（含 16 位）、两图 EXIF 归一化、单页/像素/数据 URL 上限、独立规范化对象及参考图顺序均有实现/测试；Runtime 认证前验证；取消后关闭文件并在原生解码完成后丢弃结果。没有发现需要重写的新增实际缺陷。原生 Sharp 工作不能瞬时中断，期间保留原忙碌保护，不把取消当作底层已结束。 |
| `svg.ts` | 严格 SAX XML、命名空间、DTD/实体/脚本/资源白名单及大小/节点/深度预算继续成立；原字节保存、SDK 静态分支拒绝、原子保存/取消回滚存在。实际问题在历史链接顺序，已按第 9 节修复，不扩大 SVG 白名单。 |
| `gif.ts` | 原生兄弟参数、帧数/持续时间/尺寸、结构验证、保存和默认关闭策略不变；不播放/合成。未发现新增请求或生命周期缺陷。已知只是有界容器检查，不是完整 LZW/像素验证；不能把离线容器通过当作真实播放已验收。 |
| `image-sse.ts` | 检查 Generate/Edit 事件、任意字节分块/CRLF/UTF-8、索引递增及范围、48/192 MiB 预算、错误/完成顺序与取消。只有 completed 返回最终结果；无文件写入、认证/fetch 或生产入口。未发现本轮需要修改的实际缺陷，未为了风格统一重写。 |
| transport / runtime | 独立 markup 字段、第一参考图、SVG/GIF 原文件分支，禁用/不支持参数在认证/HTTP 前拒绝；普通 JSON transport、JPEG/WebP 生成/编辑格式校验完全不动。 |
| config / TUI / 保存 | 依然来自唯一 `models.jsonc`，默认 false 不变，Streaming true 被拒绝；只在明确 opt-in 对应任务显示选项；安全目录、原子保存/回滚及跨 reload 锁回归保留。 |
| 文档 | README 曾残留“SVG/Markup/Streaming 只测试隔离拒绝”旧描述，与实际成功路径测试不符，本次纠正；不把 SSE 独立适配器写成生产集成。 |

本轮没有修改上述高级请求/校验模块以“争取在线成功”，也没有修改普通输出格式策略。生产代码变更集中在 `result-view.ts`，其余为相关测试、公开验收样本和文档。

另记录一个**基准已有的 P2 资源边界局限**：共用 `http.ts:readJsonResponse()` 在无可信 Content-Length 时先 `response.arrayBuffer()`，再检查实际字节数；48 MiB 是解析/接收后拒绝上限，不是流式读取时的内存硬上限。此路径本轮未改写，不能把独立 SSE 或历史读取的有界性推广到普通 JSON transport。在线验收发送前需在一次性 fetch 守卫中增加按实际响应流计数的 48 MiB 边界，超限取消并停止；正式共用 transport 的有界读取加固留待独立范围处理，不通过本轮修改普通格式策略来掩盖。

### 当前官方 Codex 客户端

重新读取用户指定官方指南与 Generate/Edit Reference；读取 main 后再固定至 **`86ac0916597244a2e67a197822a5483924660ff1`**（2026-11-05 检查），三份来源均成功读取：

- [codex-api/src/images.rs](https://github.com/openai/codex/blob/86ac0916597244a2e67a197822a5483924660ff1/codex-rs/codex-api/src/images.rs)
- [codex-api/src/endpoint/images.rs](https://github.com/openai/codex/blob/86ac0916597244a2e67a197822a5483924660ff1/codex-rs/codex-api/src/endpoint/images.rs)
- [ext/image-generation/src/tool.rs](https://github.com/openai/codex/blob/86ac0916597244a2e67a197822a5483924660ff1/codex-rs/ext/image-generation/src/tool.rs)

实际请求结构结论：

- Generate/Edit 请求有 prompt、output、background、model、n、quality、size，Edit 另有 images。`ImageOutput::Gif(GifOptions)` 使用 serde flatten，序列化为 `output_format` 与 `frame_count` / `frame_duration_ms` 兄弟字段，2～16 帧、20～2000ms。注释说 edit 接受 GIF 不能推翻 Platform 指南的 GIF 禁止编辑；本插件继续只允许生成。
- `ImagesClient` 使用原 `images/generations` / `images/edits`，读取完整响应并 `serde_json::from_slice`；提取 `x-codex-imagegen-request-id`。没有这条客户端路径的 Images SSE 成功证据。
- 工具使用 `gpt-image-2` 常量、`quality:auto`、`size:auto`、最多 5 张参考图，GIF 另有会话 flag，工具参数禁止未知字段。此工具不是本插件 2.6 两模型的在线验证，也不是对本插件沿用的 Platform 16 张 JSON 限制的新后端证明；不据此擅改现有模型或输入范围。
- 所检查的官方 Rust 请求和工具类型**没有独立 markup、SVG 输出/作者配置或 stream/partial 字段**。Platform 的明确协议支持和官方 SDK 类型仍然成立；Rust 客户端没有这些字段只能记录为客户端覆盖不足，不能推导后端一定拒绝，也不能推导其支持。

| 能力 | Platform 官方协议 | 该固定版本官方 Codex 请求结构 | 后端接受 / 当前账户权限 / 插件真实成功 |
| --- | --- | --- | --- |
| Markup | 已确认 | 未出现独立字段 | **三项均尚未验证** |
| SVG | 已确认 | 未出现对应 output/作者结构 | **三项均尚未验证** |
| GIF | 已确认，帧数资料冲突保守取交集 | 已确认兄弟字段 | **三项均尚未验证** |
| Streaming | 已确认 Images SSE | 所查图片链路是完整 JSON，无对应字段 | **三项均尚未验证** |

## 11. 本次离线回归记录

环境：Windows `win32/x64`；Node.js `v24.22.1`；Pi SDK `1.5.0`；Sharp `0.35.5`、libvips `8.18.7` 已实际加载。未新增依赖。

| 阶段 | 命令 | 总数 | 通过 | 失败 | 退出码 |
| --- | --- | --- | --- | --- | --- |
| 修改前基线 | `npm test` | 100 | 100 | 0 | 0 |
| 修改前基线 | `npm run test:host` | 43 | 43 | 0 | 0 |
| 最终正序 | `npm test` | 101 | 101 | 0 | 0 |
| 最终正序 | `npm run test:host` | 52 | 52 | 0 | 0 |
| 最终模型倒序 | `PI_IMAGE_TEST_REVERSE_MODELS=1 npm test` | 101 | 101 | 0 | 0 |
| 最终模型倒序 | `PI_IMAGE_TEST_REVERSE_MODELS=1 npm run test:host` | 52 | 52 | 0 | 0 |

最终四条命令全部实际执行，取消/跳过项均为 0。`git diff --check` 通过，退出码 0；另检查新增文本文件没有尾随空白。配置、OAuth/凭据、原 JSON HTTP、Provider 注册、高级传输/校验模块和依赖清单均通过相对基准的 unchanged 检查。没有提交或推送。

开发期首轮宿主 52 项中 48 通过、4 失败、退出 1（包括父测试）：文件 symlink 创建权限不足、jiti 已绑定的 fs 导出使竞态注入未生效；已明确记录环境限制并修正测试注入/独立观察，未放宽生产校验。修复后开发期宿主 52/52，退出 0。

## 12. 按模型在线验收台账与正式启用判断

**在线测试待授权，尚未发起真实图片请求。** 当前真实图片 POST 为 **0**。完整的 M1/S1 请求参数、公开提示词、样本摘要、费用风险、硬上限与停止条件见 [CODEX-ONLINE-ACCEPTANCE.md](CODEX-ONLINE-ACCEPTANCE.md)。

状态词：**官方协议已确认、本地实现完成、离线测试通过、Codex 在线成功、Codex 在线拒绝、Codex 在线行为异常、尚未验证**。前三项是不同维度，不替代在线结论。Streaming 的“本地实现”仅指独立解析/适配器，不包括正式网络/UI。

下表每行均单独对应一个模型/能力；G = `https://chatgpt.com/backend-api/codex/images/generations`，E = `https://chatgpt.com/backend-api/codex/images/edits`。以下各行的执行证据字段目前全部为：**实验日期：未执行；实际发送参数：无；HTTP 状态：未取得；服务端请求 ID（脱敏后）：无；实际返回类型：无；本地保存与校验：未执行线上产物校验；用户可见在线功能：未完成；账户权限与费用：未验证。** 2026-11-05 是准备/审查日期，不伪填为实验日期。

| 能力 | 模型 ID | 端点 | 官方 / 本地 / 离线状态 | 在线状态 / 拟定输入参数 | 未确认的限制 |
| --- | --- | --- | --- | --- | --- |
| Markup | `gpt-image-2.5-flare` | E | 官方协议已确认 / 本地实现完成 / 离线测试通过 | 尚未验证；无本轮请求计划 | 字段接受、实际区域效果、权限/像素预算 |
| Markup | `gpt-image-2.5-sunburst` | E | 同上 | 尚未验证；无本轮请求计划 | 同上，不能从 Flare 推广 |
| Markup | `gpt-image-2.6-flare` | E | 同上 | 尚未验证；M1 候选：n=1、1024x1024、low quality/complexity、opaque、PNG、独立图层；未发送 | 字段是否被忽略、真实效果、权益/费用 |
| Markup | `gpt-image-2.6-sunburst` | E | 同上 | 尚未验证；无本轮请求计划 | 模型独立的接受/效果/额度限制 |
| SVG | `gpt-image-2.6-flare` | G | 官方协议已确认 / 本地实现完成 / 离线测试通过 | 尚未验证；S1 候选：n=1、output_format=svg、1024x1024、low quality/complexity、opaque、不发作者配置；未发送 | 默认作者权限/费用、真实 XML 与白名单兼容性、矢量工具可用性 |
| SVG | `gpt-image-2.6-sunburst` | G | 同上 | 尚未验证；无本轮请求计划 | 模型独立的返回/作者/费用限制 |
| GIF | `gpt-image-2.6-flare` | G | 官方协议已确认 / 本地实现完成 / 离线测试通过 | 尚未验证；不在 M1/S1 范围，未发送 | preview access、尺寸/帧预算、真实播放；本地不是完整 LZW 解码 |
| GIF | `gpt-image-2.6-sunburst` | G | 同上 | 尚未验证；不在 M1/S1 范围，未发送 | 同上，不能从 Flare 推广 |
| Streaming | `gpt-image-2.6-flare` | G / E（仅候选） | 官方协议已确认 / 本地实现完成（独立适配器范围）/ 离线测试通过 | 尚未验证；无线上请求计划 | Codex SSE 请求/事件/完成/错误/取消契约、账户权益/费用 |
| Streaming | `gpt-image-2.6-sunburst` | G / E（仅候选） | 同上 | 尚未验证；无线上请求计划 | 同上，另需生产 transport/UI 实现和验收 |

首次批准后才填写实际实验日期、精确参数、HTTP、请求 ID 摘要、真实类型与本地保存/效果结果；保留逐次记录，不覆盖掉失败。HTTP 拒绝记“Codex 在线拒绝”，协议/类型/本地兼容/效果问题记“Codex 在线行为异常”；超时/断连无法确定接受/费用时保留不确定性，不虚报拒绝或成功。单次成功也不自动调整配置。

正式上线判断：**Markup、SVG、GIF 均未具备已验证的正式上线条件**，缺少真实 Codex/账户及用户效果证据；默认开关全部保持 false。**Streaming 仍需独立协议验证，且生产网络与预览尚未实现。** 本次仅安全收尾与验收准备，没有新增能力或开放实验功能。
