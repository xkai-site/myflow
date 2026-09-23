# OpenAI 生图请求排查

## 后续：用户确认后的单次真实验证

- 用户回复 continue 后，执行一次真实插件 adapter 请求，使用当前 Codex 本地凭据、宿主 EnvHttpProxyAgent、gpt-image-2、auto 尺寸/质量、无参考图、简单红圆提示词。
- 结果：HTTP 429，`The usage limit has been reached`。完整运行 1792 ms，HTTP 阶段 1766 ms。调用次数严格为 1，没有重试，没有生成图片。
- 新日志：`.pi/image-generation-logs/error-5db73ba5-7b06-4923-b547-47f19cb39436.json`。摘要：`plans/openai-image-live-probe-result.json`。
- 这是当前账户/服务端使用上限的直接证据；无法仅从该消息区分周期额度、具体限额种类、恢复时间。不能反推此前 60 秒 socket close 的根因，也不证明额度恢复后必然可以生成。
- 官方 Codex CLI 0.153.4、image_generation=true。生成其 app-server TypeScript 协议到 OS 临时目录，没有找到直接生图方法；未启动官方 Agent 生图，以免无法严格保证单次 POST。官方客户端对照尚未完成。
- 达到使用上限后停止进一步真实请求。先通过官方账户界面确认额度/重置时间，恢复后再对照；不在限额状态下盲改模型、请求头或代理。
- 本轮新增显式 opt-in 的本机测试脚本 `test/live-probe.mjs`（需确认参数，绑定本机 SDK 路径），无生产代码或账户配置修改。凭据仅在进程内用于官方端点鉴权，不写入脚本/摘要/日志。该测试经过独立 Node 进程调用实际 adapter，不是当前 Pi TUI 内部抓包。

## 结论（此前离线阶段）

本轮未证明某个参数或插件改动是 `UND_ERR_SOCKET` 的根因，也未宣称修复。

- 用户指定日志对应 **gpt-image-2**，60143 ms 后在收到 HTTP 响应头之前断连。不是仅新增 2.5 模型失败；禁用 2.5 不能解决这个例子。
- 插件使用 **Codex ChatGPT OAuth 后端**，不是公开 API Key Images API。这个后端的 Images 路径与 JSON 格式有 OpenAI Codex 源码依据，不能因域名不是 api.openai.com 就判错。
- 原模型 30 组旧/新请求离线比较全部通过。公开文档也未显示当前默认生成参数非法。
- 优先调查真实 POST 的 Codex 后端/网关/代理连接中断；客户端请求头差异需要对照验证。约 60 秒只是线索，不能据此确定哪一层超时。

本轮仅更新排查文档和规划记录；保留所有原有代码、账户、模型启用配置。没有读取真实凭据，没有发送真实生图请求，没有重试。

## 1. 官方接口要求

已实际获取 OpenAI 官方指南、API reference、GPT Image 2、两个 2.5、1.5、1、1 Mini 模型页；不以搜索摘要替代接口证据。

| 模型 | Image API model | quality | 尺寸 |
| --- | --- | --- | --- |
| GPT Image 2 | gpt-image-2 | auto / low / medium / high | auto、标准尺寸、受约束的自定义尺寸 |
| GPT Image 2.5 Sunburst | gpt-image-2.5-sunburst | 上述 + xhigh / max | 同上 |
| GPT Image 2.5 Flare | gpt-image-2.5-flare | 上述 + xhigh / max | 同上 |
| GPT Image 1.5 / 1 / 1 Mini | 对应 gpt-image-1.5 / gpt-image-1 / gpt-image-1-mini | auto / low / medium / high | 1024x1024 / 1536x1024 / 1024x1536 / auto |

公开接口：

- `POST https://api.openai.com/v1/images/generations`：JSON 请求，直接设置图像模型。
- `POST https://api.openai.com/v1/images/edits`：当前 JSON reference 支持 `images: [{image_url: URL或data URL}]` / file_id；不能套用旧文档断言必须 multipart。
- 使用平台 API 凭据；Codex 登录 token 不能未经验证就移到公开 API。
- `n:1` 合法；`background:auto` 合法；不指定 `stream` 默认为 false，不强制 SSE。
- GPT Image 默认输出 PNG/base64，**不要补 `response_format:b64_json`**，这个参数不适用于 GPT Image。
- GPT Image 2 不应传 `input_fidelity`，目前插件没有传，符合要求。
- 2/2.5 自定义尺寸：边长为 16 的倍数，比例不超过 3:1，单边不超过 3840，像素 655360–8294400；超过 2560x1440 属实验性。
- Responses API 是另一套协议：顶层 model 是支持该工具的主模型，图像模型放在 `tools:[{type:"image_generation",model:...}]`；不能仅改 URL 并沿用 Images 请求体。
- 官方指南说明复杂生成可能耗时约两分钟，故长时间无输出不等于客户端应在 60 秒终止。

## 2. 当前插件发送什么

代码位置（相对 `work/scripts/pi/pi-image-generation/`）：

- `src/credentials.ts:63`：限定官方主机并规范化到 `/backend-api/codex`。
- `src/openai-codex-images.ts:39`：生成 URL、请求头和请求体。
- `src/http.ts:26`：交给全局 fetch；成功后读取 JSON，没有流式处理。

按当前默认配置构造的示意请求如下，**不是失败请求的抓包**；日志没有保存当时的 prompt/size/quality，无法重建这些原始值。

```http
POST https://chatgpt.com/backend-api/codex/images/generations
Authorization: Bearer <Codex OAuth access token>
chatgpt-account-id: <JWT 中的 account id>
originator: pi
User-Agent: pi-image-generation/0.1.0
Accept: application/json
Content-Type: application/json
```

```json
{
  "prompt": "<用户提示词>",
  "background": "auto",
  "model": "gpt-image-2",
  "n": 1,
  "quality": "auto",
  "size": "auto"
}
```

有参考图时改为 `/images/edits`，增加 `images:[{image_url:"data:<mime>;base64,<data>"}]`。2.5 复用此通道，仅替换模型/质量等字段。

## 3. 对照官方 Codex 源码

本轮读取的 upstream main：

- `codex-rs/codex-api/src/endpoint/images.rs`：同样 JSON POST `images/generations` / `images/edits`，解析 `data[].b64_json`，不是 Responses 工具协议。
- `codex-rs/codex-api/src/images.rs`：字段与插件一致；n 为可选值；quality 枚举仍只有 low/medium/high/auto。
- `codex-rs/ext/image-generation/src/tool.rs`：固定模型 `gpt-image-2`，background/quality/size 默认 auto，最多 5 张编辑参考图，n 不发送。
- `codex-rs/ext/image-generation/src/backend.rs`：生成和编辑请求都添加 `x-codex-image-turn-id`，并按客户端配置处理 originator。

实际差异与证据强度：

| 差异 | 判断 |
| --- | --- |
| 插件缺少 x-codex-image-turn-id | 确认存在的请求头差异；源码不能证明服务端强制要求它，不能认定就是断连根因 |
| 插件显式 n:1，官方工具省略 n | 公共 API 和 Codex schema 均允许 n；不是已证实错误 |
| originator/User-Agent 为插件身份 | 身份不同属实；不应未经证据伪装官方客户端来修复 |
| 插件可发送 2.5 和 xhigh/max | 公开 API 支持不等于当前 Codex OAuth 后端支持；官方工具仍固定 2，需独立验证 |
| 插件未保留 x-codex-imagegen-request-id | 确认的诊断缺口；收到响应时影响关联调查，但不导致本次无响应头的断连 |
| 插件不使用 SSE | 官方 Codex ImagesClient 也是完整 JSON，不能认定必须改流式 |

upstream main 是研究时读取的版本，可能继续变化；并非用户安装的 Codex 二进制版本，也不是线上服务行为的证明。

## 4. 日志和网络证据

指定日志 `.pi/image-generation-logs/error-4f3a23b9-202e-4690-be49-a754c6cf1399.json`：

- model: gpt-image-2
- operation: generate
- host: chatgpt.com
- elapsedMs: 60143
- TypeError(fetch failed) → SocketError(other side closed) / UND_ERR_SOCKET
- 未记录 HTTP status / request ID

这里 `phase:connect` 只说明 fetch 尚未返回响应头，**并不证明 TCP/TLS 没连接成功，也不证明服务器没收到请求**。不能把它直接解释成参数 400、鉴权 401、额度 429 或本地超时。

宿主检查：

- Node v22.23.1；HTTP(S)_PROXY 指向本地 HTTP 代理端口 7897。
- Pi `dist/core/http-dispatcher.js` 在全局安装 `EnvHttpProxyAgent` 和配套 fetch，`dist/main.js` 启动及加载设置后调用它。因此不能因插件没有自己的 ProxyAgent 就认定它绕过代理。
- 用户 `httpIdleTimeoutMs` 未配置，宿主默认 300000 ms。插件非 TUI 路径也是 300000 ms；TUI 使用取消信号。没有发现本插件配置的 60000 ms 截止时间。
- 另起 Node 进程使用同一宿主 dispatcher 初始化函数、现有代理环境做两次**无凭据 GET**：ChatGPT 图像路径 440 ms 返回 Cloudflare HTML 403；公开 `/v1/models` 565 ms 返回 JSON 401。
- 这些 GET 只证明当前网络可以收到 HTTP 响应，不能据此判断已登录 POST 的权限、Cloudflare 处理、生图耗时或账户后端支持。没有在当前运行中的 Pi 进程内抓取真实请求。

## 5. 离线验证

```bash
node work/scripts/pi/pi-image-generation/test/compare-baseline.mjs file:///D:/Nodejs/node_modules/@earendil-works/pi-coding-agent/dist/index.js
cd work/scripts/pi/pi-image-generation && npm test
```

- 与固定旧提交 `4df3ccd805ef32616ccbc8ee635649b3be1f1e46` 比较：30/30 场景通过，GPT Image 2 的 URL、method、headers、serialized body、默认 quality 与旧版一致。fetch 全部 mock，合成凭据。
- `redirect:error` 是已有安全差异，比较器单独断言。它不改变首次请求正文；若触发重定向通常会是重定向错误，不能拿它解释所有 socket close。
- 当前单元测试：29/31 通过。两个失败来自测试仍假定 2.5 `enabled:false`，而用户当前配置是 true：默认禁用断言失败，以及“Flare 不能作默认模型”的拒绝断言不再成立。未为通过测试回改用户配置；这些失败不是 GPT Image 2 网络断连的证据。

## 6. 下一步：受控验证，而非盲改参数

需要用户确认才进行会消耗额度的真实对照，且每项只发送一次、不自动重试：

1. 同账户、同代理，先确认官方 Codex 内置生图能否成功；记录客户端版本、耗时和错误，避免用 ChatGPT 网页成功代替 Codex 通道验证。
2. 若官方成功、插件失败：固定 GPT Image 2、同一短提示词、无参考图、auto 参数，优先比较官方请求头（包括 image-turn-id）与插件；每次只改一个差异。
3. 若官方也约 60 秒失败：优先查代理/网关日志和 Codex 服务状态，定位谁关闭连接；未经确认不切换代理、不增大所有超时、不禁用 TLS 校验。
4. 增补安全诊断时可记录客户端关联 ID、imagegen 响应 ID、白名单 size/quality/参考图数量、是否收到响应头。不要记录 Authorization、账户 ID、提示词、图片或代理凭据。
5. 如要改走公开 API，应新增独立 Images API adapter 和平台 API Key 账户，不应把 Codex token 直接发往 api.openai.com；公开 API 计费与订阅通道独立。

## 再次阅读新模型文档后的原因排序

- 新获取的官方 image-prompting 指南明确：Sunburst 优先质量、Flare 优先速度；延迟受提示词、参考图、尺寸和质量影响，auto 不等于低质量或低延迟。xhigh/max 应在延迟预算允许时使用。
- image-generation 指南说明复杂请求可能需要两分钟；generate reference 明确 stream 可选且默认 false。因此当前非流式不是格式错误，但若上游有约 60 秒无响应截止时间，长生成可能触发它。这个链路机制是优先排查假设，不是文档证实有固定 60 秒网关超时。
- 最新用户日志为 Sunburst 60929 ms socket close；先前 Image 2 也约 60 秒失败。因此模型耗时加链路关闭可解释跨模型现象；2.5 Codex 路由兼容性则是新增独立风险。
- 再次获取 Codex tool.rs 仍固定 gpt-image-2；公开 API 的 2.5 支持不能外推到 ChatGPT 订阅 Images 后端。没有证据断言后端一定拒绝 2.5。
- 429 使用上限是另一次真实请求的确定事实，不可当作 socket close 根因；内容审核/参数错误没有对应 HTTP 响应证据，优先级较低。
- 建议额度恢复后固定 Image 2 / low / 1024x1024 单次测量，同时采集安全网络阶段和代理日志；成功也只能增加长请求超时假设可信度，不能证明模型兼容或哪个节点关闭。未执行新生图请求或修改参数。
- 来源补充：https://developers.openai.com/api/docs/guides/image-prompting 。本轮搜索的 Codex 查询因 provider fetch failed 失败，改为直接获取已知官方源码 URL 成功。

## 官方来源

- [Image generation guide](https://developers.openai.com/api/docs/guides/image-generation)
- [Image generation tool](https://developers.openai.com/api/docs/guides/tools-image-generation)
- [Create image](https://developers.openai.com/api/reference/resources/images/methods/generate)
- [Create image edit](https://developers.openai.com/api/reference/resources/images/methods/edit)
- [API authentication overview](https://developers.openai.com/api/reference/overview)
- [GPT Image 2](https://developers.openai.com/api/docs/models/gpt-image-2)
- [Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst) / [Flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare)
- [Codex Images endpoint](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/images.rs)
- [Codex request schemas](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/images.rs)
- [Codex image tool](https://github.com/openai/codex/blob/main/codex-rs/ext/image-generation/src/tool.rs)
- [Codex image backend headers](https://github.com/openai/codex/blob/main/codex-rs/ext/image-generation/src/backend.rs)
