# OpenAI 官方生图接口与客户端长任务形态研究报告

> 状态：研究完成。本文由后台研究子智能体（基于 web_search/web_fetch 抓取官方仓库与 SDK 源码）产出，供"生图插件脱离同步 RPC、提升长任务稳定性"的改造设计引用。
> 快照说明：Codex 仓库 main、openai-node main、openai/openai-openapi（spec v2.3.0）、openai-ruby（0.88.0）均按 2026-09-08/09 前后抓取；凡引用仓库的行文标注【官方源码】并给路径/URL。developers.openai.com 页面本次直连全部 403（Cloudflare 反爬），引用官方文档处标注"官方文档(URL)，本会话未能复取全文，内容依据先前调查记录与 SDK/规范交叉验证"。

## 1. 结论摘要

- 官方同时提供三种形态且都在文档/SDK 层面成文：① Images API 同步一次 JSON POST（`stream` 默认 false，仍为主默认）；② Responses API 走 SSE 事件流；③ Responses `background:true` 的"异步任务+GET 轮询"是官方为长任务设计的机制。
- 长任务的官方推荐语义存在于 Responses：SSE 事件含 `response.image_generation_call.in_progress / .generating / .partial_image / .completed`（支持渐进部分图），后台任务用 `background:true` + `GET /responses/{id}` 轮询 `status`（官方枚举含 `queued/in_progress/completed/failed/cancelled/incomplete`）。
- 官方公开 Images API（`/v1/images/generations|edits`，GPT image 模型）也新增 `stream:true` 事件流：`image_generation.partial_image` / `image_generation.completed` 与 `partial_images` 参数——官方把"部分图片渐进输出"明确做进了 Images 端点。
- Codex CLI（ChatGPT 订阅通道）目前仍走同步 JSON POST 到 `/backend-api/codex/images/generations|edits`，在 agent turn 内 await 阻塞；没有为生图启用异步化。
- ChatGPT 网页/移动端走的是 conversation 级 SSE + 消息状态（in_progress/finished_successfully）+ 图片 part 渐进出现；这部分**无官方文档**，仅社区逆向证据（见第 5 节）。

## 2. 官方生图接口盘点（同步性/异步性维度）

| 形态 | 端点/工具 | 官方依据（证据强度） | 要点 |
|---|---|---|---|
| 同步一次 JSON POST | `POST /v1/images/generations`、`POST /v1/images/edits` | 【官方源码】openai-node 生成客户端 images.ts：`stream` 默认 false、非流式返回 `ImagesResponse{data[].b64_json}`；GPT image 模型恒返回 base64。【官方文档】Image generation guide / generate|edit reference（URL 见第 7 节） | 默认官方形态；阻塞到完成为止才返回完整 JSON。官方 guide 记录"复杂生成可能约 2 分钟"。官方没有明示"同步长连接会被网关裁剪到 ~60s"的说法。 |
| SSE 流式（Images 端点内） | 同上端点 + `stream:true`（仅 GPT image 模型） | 【官方源码】images.ts 类型：`image_generation.partial_image`（含 b64_json、partial_image_index 0 基）与 `image_generation.completed`；`partial_images: 0..3`（0=单事件一次给全图，最终图可能早于计数到齐） | 官方在 Images API 层提供"渐进部分图"流式，能持续推送数据保活。 |
| SSE 流式（Responses 工具） | `POST /v1/responses` + `tools:[{type:"image_generation", ...}]` + `stream:true` | 【官方源码】openai-node responses.ts 事件类型：`response.image_generation_call.in_progress`→`.generating`→`.partial_image`（`partial_image_b64`、0 基 index）→`.completed`；非流式返回完整 Response（output 含图 item）。【官方文档】tools-image-generation guide（URL，本会话未复取） | 工具形态：顶层 model 为宿主模型，图像模型放工具配置；官方支持部分图与完整进度语义。 |
| 异步任务+轮询 | Responses `background:true` | 【官方源码】openai-node：create 参数含 `background?: boolean\|null`（JSDoc 链到 background guide）；`cancel` 仅对 background 创建的响应有效；`retrieve=GET /responses/{id}`、`DELETE`、`GET /responses/{id}/input_items` 均存在。【官方源码(镜像)】openai-ruby ResponseStatus 枚举：`completed/failed/in_progress/cancelled/queued/incomplete`。【官方文档】Background mode guide（URL；内容未复取，轮询间隔等细节未核实） | 官方为"超过单请求时限"的任务形态：先拿 response id，再轮询状态。**官方文档明示此机制要避免"HTTP 请求超时"级表述，但本报告未抓到 guide 原文，不臆造具体措辞。** |
| Batch 异步批处理 | `/v1/images/generations`、`/v1/images/edits`、`/v1/responses` 等均可作为 batch endpoint | 【官方源码(镜像)】openai-ruby BatchCreateParams::Endpoint 枚举列出 8 个端点含 images generations/edits 与 responses；【官方文档】Batch guide（URL） | Batch 支持图片端点本身（不承诺 GPT image 模型在所有编排里的细节）。 |

形态定位小结：同步 POST 是 Images API 的默认与最简用法；SSE 是 Responses 与 Images(新) 提供进度/部分图的推荐交互；后台任务+轮询是 Responses 对长任务/断连场景的官方解；Batch 是离线批量的另一档。

## 3. 官方 SDK 建立方式要点（openai-node）

- **images.generate / images.edit**：非流式返回 `ImagesResponse`；传 `stream:true` 返回 `Stream<ImageGenStreamEvent|ImageEditStreamEvent>`，逐事件消费 `partial_image`（预览/进度）与 `completed`（终图 b64）。`partial_images` 控制部分图数量（0–3）。GPT image 模型不支持 `response_format`（恒 base64）。【官方源码】images.ts
- **responses.create(stream:true)**：返回 SSE 事件流；对 image_generation 工具消费上述 4 类事件；不流式则 await 完整 Response（output 内含图片）。`responses.retrieve(id, {stream:true})` 也可重放流。【官方源码】responses.ts / api.md
- **超时/重试/Abort 默认行为**【官方源码 client.ts】：客户端默认 `timeout = 600000ms（10 分钟）`（DEFAULT_TIMEOUT），`maxRetries = 2`，指数退避（官方 commit 2bc14ce 引入 backoff）；超时会按默认重试从而总等待可更长；显式注明 **Node.js fetch 对"响应头"与"响应体静止"各施约 5 分钟独立超时**，客户端 timeout 设更长也无效，需自装 undici 并配置 Agent 的 `headersTimeout/bodyTimeout` 才能放宽；支持每请求 `timeout`/`signal`(AbortSignal)；连接错误文档中含 undici ProxyAgent 与 fetch 版本不匹配的专门诊断。→ 官方 SDK 的明确态度：同步长请求的"最后一公里"取决于底层 fetch/agent 层配置，官方给出的是 undici Agent 调法而非服务端保证。
- **Auth 分界**【官方源码/文档混合】：`api.openai.com` 平台 API（Images/Responses/Batch）用 API Key（或 workload identity）；ChatGPT 订阅 OAuth 只见于 Codex/ChatGPT 产品通道（chatgpt.com backend，授权由 codex-login 的 device-code/PKCE 完成），官方认证文档收敛到 developers.openai.com/codex/auth。SDK 未把 ChatGPT 订阅凭据接到 `/v1/images`。**不要把 Codex token 发往 api.openai.com**。

## 4. Codex CLI 客户端做法（重点）

路径按本次抓取的 codex main（2026-09-09 前快照）：

- **确认：同步 JSON POST，非流式**【官方源码】`codex-rs/codex-api/src/endpoint/images.rs`：`ImagesClient::generate/edit → post_image_request("images/generations"|"images/edits")`，`session.execute(POST, …, Some(json body))`，读回**完整响应体**后 `serde_json::from_slice` 解析 `data[].b64_json`（测试夹具显示完整响应含 background/output_format/quality/size/usage 与逐图 `generation_id`）；从响应头读取 `x-codex-imagegen-request-id`。无 SSE/轮询。
- **schema/字段**【官方源码】`codex-rs/codex-api/src/images.rs`：与插件一致（prompt/background/model/n 可选/quality/size），quality 枚举仍为 low/medium/high/auto，response 逐项含可选 `generation_id`。
- **请求头/模型**【官方源码】`ext/image-generation/src/backend.rs`：每次生成/编辑添加 `x-codex-image-turn-id: <turn_id>`，并按需 `originator` 头；`ext/image-generation/src/tool.rs`：固定 `IMAGE_MODEL="gpt-image-2"`，n 不发送，background/quality/size 默认 auto，编辑参考图 ≤5；`codex-rs/login/src/auth/default_client.rs`：默认进程级 `originator=codex_cli_rs`，User-Agent `codex_cli_rs/<版本>(OS…)`，默认头含 originator+UA，另可加 residency 头；`originator` 头仅在请求方与进程默认不同时才追加。
- **长请求处理/网络栈**：Codex 用**自建 Rust HTTP 栈**（codex_client 的 HttpTransport / ReqwestTransport + codex_http_client builder + codex_login 默认客户端），不是 openai-node/SDK。【官方源码】`codex-api/src/provider.rs`：请求默认 `Request.timeout: None`（无每请求超时）；provider 级 RetryConfig（max_attempts/base_delay/retry_429/retry_5xx/retry_transport）→ RetryPolicy，包裹 execute（含 image POST），另有 `stream_idle_timeout`（用于流式）；`session.rs` 显示 execute 全程套 telemetry+retry。**具体默认数值（如 max_attempts 初值、退避表）与"ChatGPT provider"构造处本次未核实到**；reqwest 默认无总超时、连接池 keep-alive 为 reqwest 默认。结论：Codex 对同步生图 POST 基本是"无显式超时+靠传输层"，官方服务端若 ~60s 裁连接，Codex 侧同样会断。
- **生图在 agent turn 中的语义**【官方源码】tool.rs：handler 先 emit ImageGenerationItem status=in_progress + `ImageGenerationBegin`，然后 `await backend.generate(...)` **阻塞直至 HTTP 完成**，再 emit completed/failed + `ImageGenerationEnd`；图片以 b64 保存为 artifact（executor 侧 32MB 上限）。即：进度事件只是"turn 级 UI 状态"，图片字节仍是单次 HTTP 长等待后一次性到达；**工具调用本身没有异步后台化**。
- **近期异步/后台化迹象**【官方源码·部分核实】：codex-rs 现含 app-server / app-server-protocol / backend-client / responses-api-proxy / cloud-tasks 等 crate，说明会话层有 SSE/后台产品面；但生图工具在本快照仍是同步 POST。Codex 会话级"异步任务"是否正式落地未核实到。

## 5. ChatGPT 网页端做法（证据强度诚实分级）

- 官方文档能确认的：**几乎没有**。chatgpt.com 的 backend-api（含 conversation 与 codex/images）无公开开发者文档；官方公开 API 教程只讲 api.openai.com。【官方文档缺位】
- 【社区推断/逆向】(chatgpt2api 项目 jshook 文档，可信度中——README 明确标注为上游逆向)：网页对话为 conversation 级 SSE：JSON Patch 式流（"v1"、`[DONE]`、带 `p/o/v/c` 的增量对象），消息对象 `message.status` 经历 `in_progress → finished_successfully`；文本经 `parts` patch 增量；图片生成为 `author.role=="tool"` + `metadata.async_task_type=="image_gen"` 的 multimodal_text 消息，其 parts 是指针（`file-service://…`/`sediment://…`），需再走文件下载接口取回；另有 moderation/title_generation/server_ste_metadata 等事件。即网页端是"长连接会话 + 消息状态 + 图片 part 渐进出现"，底层确实是 conversation 会话端点而非独立 images RPC。
- 与 Codex 后端的关系：同一 `chatgpt.com` 域与订阅 OAuth 家族；Codex 走 `/backend-api/codex/*`（独立 job 式 POST），网页走 `/backend-api/conversation` SSE。两者是否为同一图像作业服务的不同封装，**未证实**（仅能确认同域同订阅体系）。【社区推断】
- 对插件的影响：插件目前"复用 Codex 通道"与官方 Codex CLI 行为一致（同步 POST）；网页端那种 conversation SSE + 异步任务语义在公开层不可直接复用于脚本插件。

## 6. 三种形态对照表

| 维度 | 同步一次 JSON POST | SSE 流式（Images stream / Responses stream） | 异步任务+轮询（Responses background） |
|---|---|---|---|
| 官方有此形态？ | 有（Images API 默认；Codex 通道仅此形态） | 有（Images GPT 模型 stream / Responses image_generation 工具） | 有（Responses `background:true`；仅 background 可 cancel） |
| 文档依据 | 【官方文档】generate/edit reference、image guide；【官方源码】images.ts / codex endpoint/images.rs | 【官方源码】images.ts 事件类型、responses.ts ImageGenCall 事件 | 【官方源码】responses.ts 参数与 cancel JSDoc；ResponseStatus 枚举（ruby 镜像）；【官方文档】guides/background |
| 对分钟级长任务 | 客户端必须容忍数分钟无响应字节；官方 SDK 明示底层 Node fetch 另有 ~5min 头/体超时需自配 undici Agent；代理/网关层 ~60s 裁剪无官方说明 | 事件不断推送（含部分图），天然保活+有进度；中断后 Responses 可 `retrieve(id,{stream:true})` 重放（官方端点存在，重连语义细节未核实） | 不受单请求时长约束：POST 秒回 id → 轮询状态/取回；官方语义即为此设计；状态含 failed/cancelled 可恢复判断 |
| 需要客户端配合 | 调大/关闭本地超时、配 keep-alive、自行区分"哪一层断连"、无进度提示、断连后无恢复语义（响应丢失即任务丢失，需重试且会重复计费） | 事件解析、part 渐进渲染、断流重连与 resume 逻辑 | 存 id、轮询退避、处理 queued→in_progress→completed/failed/cancelled/incomplete、任务取消 |
| 官方是否建议用它规避长连接超时 | 无官方"同步会被裁剪"的明示；官方 SDK 只教如何放宽底层 fetch 限制 | Responses/Images 文档均提供流式以获进度（部分图能力官方实锤） | 后台模式官方意图就是"长任务 + 断连可恢复"（cancel 语义佐证），但 guide 原文细节未复取 |

## 7. 官方来源链接清单（按证据强度）

- **官方文档（developers.openai.com，本会话直连 403、未复取全文；引用为先前调查记录 + SDK/规范交叉）**：
  - Image generation guide：https://developers.openai.com/api/docs/guides/image-generation
  - Tools image generation（Responses 工具）：https://developers.openai.com/api/docs/guides/tools-image-generation
  - Images generate/edit reference：https://developers.openai.com/api/reference/resources/images/methods/generate 、https://developers.openai.com/api/reference/resources/images/methods/edit
  - Background mode guide、Batch guide、模型页 gpt-image-2 / 2.5-sunburst / 2.5-flare / gpt-image-1、Codex auth（developers.openai.com 下，具体 URL 未逐一复取）
- **官方源码（本次直接抓取）**：
  - openai/codex：codex-rs/codex-api/src/endpoint/images.rs、codex-rs/codex-api/src/images.rs、codex-rs/codex-api/src/provider.rs、codex-rs/codex-api/src/session.rs、codex-rs/ext/image-generation/src/tool.rs、codex-rs/ext/image-generation/src/backend.rs、codex-rs/login/src/auth/default_client.rs、docs/authentication.md
  - openai/openai-node：src/resources/images.ts、src/resources/responses/responses.ts、src/resources/responses/api.md、src/client.ts；commit 2bc14ce（retry 指数退避）
  - openai/openai-openapi：openapi.yaml（spec v2.3.0，仓库级官方 OpenAPI）
- **官方 SDK 生成的规范镜像（字段级证据）**：openai-ruby ResponseStatus、BatchCreateParams::Endpoint（rubydoc，生成于 2026-09-09）。
- **社区/逆向（明确非官方）**：ZyphrZero/chatgpt2api upstream-sse-conversation.md；open-swarm ASYNC_RESPONSES.md；community.openai.com 后台响应 404 讨论帖；kissapi.ai background mode 说明（仅佐证，未作为官方行为引用）。
- **未核实到**：Responses background guide 的轮询间隔/保留时长原文；ImageGen 工具在 Responses 内的完整 tool 输入 schema 细节；Codex provider 重试默认数值；Codex 会话级异步化是否有正式落地；ChatGPT 网页与 codex/images 后端是否同一作业服务。

## 8. 候选改造方向（仅选项与利弊，无实现）

- **方向 A：保留 ChatGPT 同步 POST 通道，加固传输层并做分层诊断**。做法思路：区分代理层（本机 7897）/Cloudflare/网关/官方服务谁在 ~60s 裁连接（可用官方 Codex CLI 对照 + 服务端空闲期抓包/日志），再针对性地调 keep-alive、连接空闲期、请求级超时，或让 fetch 走与官方 SDK 相同的 undici Agent（放宽 headersTimeout/bodyTimeout，官方 SDK 文档提供此调法）。利：改动小、与官方 Codex CLI 行为同构。弊：若裁剪发生在官方网关且无官方超时承诺，调大客户端无效；仍无进度、断连后无恢复语义、重试会重复耗额度（官方无幂等键）。解决不了"无进度/不可恢复"。
- **方向 B：转向"流式/渐进图片"形态（进度 + 保活）**。若走平台 API：Images API `stream:true`（partial_image 事件）或 Responses image_generation 工具流式均可拿到官方"部分图渐进"；若坚持订阅通道，则需要先探测 ChatGPT/Codex 侧是否存在可用的 SSE/事件通道（目前 Codex 图片工具无此形态，社区网页 conversation SSE 是另一产品面）——未证实存在，需验证。利：有进度、连接有数据保活（直接缓解"无响应字节被裁"）、官方支持部分图。弊：需要平台 Key（计费与订阅分离）或承担未公开通道的兼容风险。
- **方向 C：转向官方"异步任务+轮询"形态（可中断/可恢复）**。Responses `background:true` + 保存 response id + 轮询 + 需要时 `cancel`；这是官方为长任务设计、语义最完整的形态。利：POST 秒回、状态机明确（含 failed/cancelled）、不受单请求时长约束、官方建议方向。弊：官方 Responses 需要平台 API 凭据（订阅 OAuth 能否用此形态未见官方说明，很可能不能）；保留/存储时长与轮询频率细节需以官方 guide 为准（未复取全文）。
- **方向 D（短期组合，风险最低）**：维持 A 的同步通道作为主路径，但把"结果获取"与"任务意图"解耦为幂等友好的设计（每次请求带上并记录官方回显的关联 id，如 Codex 响应的 `x-codex-imagegen-request-id`、本地自生成 request id），失败后**人工确认后重试**（避免重复计费），并明确把"60s 断连=任务可能已成功"作为状态机分支处理。利：不动凭据体系、改动可控。弊：仍是轮询/重试的补丁，不是官方长任务形态；不能根治网关裁剪。

## 9. 结语

对"官方对长任务生图用什么形态"最准确的回答：公开 API 侧官方已备好 SSE（带部分图）与 background+轮询两种长任务形态，但都挂在 Platform API Key 生态；Codex CLI 复用 ChatGPT 订阅的通道目前仍是同步 POST；ChatGPT 网页则是另一套会话 SSE。若插件坚持现有订阅凭据，官方并没有提供一个"订阅级、可恢复、有进度"的公开形态——这是选择改造方向时的核心约束。
