# pi-image-generation

Pi 图片生成与参考图编辑扩展，入口是 **`/image` 斜杠命令**，不触发 LLM 轮次。
它不注册 LLM 工具，Agent **不能直接 tool call**；图片账户 provider 只用于认证和图片请求，不是 `/model` 中的对话模型选择。自动化使用下文 RPC，不要把 `/image` 当作 bash 命令。

## 安装与首次调用

前提：已安装 Pi，Node.js ≥ 22.19.0。在本插件目录执行：

```bash
npm install --ignore-scripts
cd ..
pi install ./pi-image-generation
```

本地安装直接引用目录，请勿移动或删除。启动 Pi；已运行的 Pi 执行 `/reload`。
完成下文任一种认证后，在要保存图片的项目目录启动 Pi，输入：

```text
/image 一只坐在窗边的橘猫，水彩风格
```

TUI 会打开向导：确认提示词 → 生成/编辑 → 账户 → 模型 → 尺寸 → 质量（若支持）。单个可选账户/模型自动跳过选择，默认尺寸/质量排在首项。成功后按 `Saved` 通知中的路径取图。

## 认证：任选一种

### OpenAI：复用 Codex ChatGPT OAuth

1. 准备 Codex 的 ChatGPT 登录（尚未登录时运行 `codex login`），启动一次 `codex` 让其加载模型缓存；无需发测试请求。
2. 在上级 `pi` 目录执行 `pi install ./pi-codex-official`，回到 Pi `/reload`。
3. Pi `/login` 选择 **OpenAI Codex (Codex 本地凭据)**。已有有效登录标记无需重复操作。

Codex 目录须有有效 `auth.json` 和 `models_cache.json`，默认 `~/.codex/`，可用 `CODEX_HOME` 指定。详细前置条件见 [pi-codex-official](../pi-codex-official/README.md)。不要手写缓存，也不要把文件内容发到会话。

本扩展每次通过 Pi 的 `openai-codex` provider 取当前认证，不自行登录或刷新 token。过期时用 Codex / CC Switch 更新登录。
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
| TUI `/image` | 选择生成/编辑或账户设置 |
| TUI `/image <prompt>` | 以整段参数预填提示词，再进入向导；**不解析下列非交互选项** |
| `/image --settings` | 账户管理，秘密输入仅 TUI 可用 |
| `/image --help`、`/image -h` | 用法和全部模型 key（含禁用标记） |
| RPC `/image …` | 按下列语法直接请求，不打开生成向导 |

非交互完整文本语法：

```text
/image [model-key] [--size VALUE|--size=VALUE] [--quality VALUE|--quality=VALUE] [--] <prompt>
```

| 参数 | 规则 |
| --- | --- |
| `model-key` | 必须是第一个词，使用下表的 key，**不是上游模型 ID 或 provider ID**；仅一个图片账户配置有效时可省略，使用该账户 `defaultModel` |
| `--size` | 省略用所选模型/任务默认尺寸；值及限制见下节 |
| `--quality` | OpenAI 支持，省略为 `auto`；Wan 不接受此参数 |
| `--` | 停止解析后续选项；提示词首词像模型 key/选项时用它消歧，例如 `/image -- wan is a word`（仅一个账户时） |
| `<prompt>` | 必填，支持单/双引号；词间空白合并。单引号外的反斜杠用作转义，未闭合引号/转义会报错 |

即使提示词已开始，后面的 `--size` 等仍会被解析，除非先写 `--`。未知 `--选项` 会报错。

**参考图编辑边界：没有 `--image`、`--input`、`--edit`、mask 或参考图路径参数。**
TUI 向导选择编辑后，每行输入一个参考图文件路径，可拖入、加引号或写 `@path`；相对路径以 Pi 当前项目为基准，至少一张。不是在 `/image` 文本后追加路径。

**标准 RPC `/image` 目前仅支持生成；编辑请用 TUI。** RPC `images` 附件会被忽略，不会进入编辑，仍可能按纯文本生成并消耗额度。

## 模型、默认值与配置

唯一清单是本插件根目录 [models.jsonc](models.jsonc)，修改后 `/reload`。不会从 Codex 缓存发现图片模型，也不读取项目内或用户目录的另一份模型清单。

**当前文件的五个模型均已启用**（`enabled` 省略即 true；Sunburst/Flare 显式为 true）。**Sunburst/Flare 已由使用者验证可通过当前 Codex 后端及账号调用**，分别使用 `openai-sunburst`、`openai-flare` 选择；其他账号的权限与额度以服务端为准。

| key | 上游模型 ID | 账户 / 默认模型 | 默认尺寸；预设 | 质量 |
| --- | --- | --- | --- | --- |
| `openai` | `gpt-image-2` | OpenAI 默认 | `auto`；`auto`、`1024x1024`、`1536x1024`、`1024x1536` | `auto`、`low`、`medium`、`high` |
| `openai-sunburst` | `gpt-image-2.5-sunburst` | OpenAI | 同上 | 上述档位 + `xhigh`、`max` |
| `openai-flare` | `gpt-image-2.5-flare` | OpenAI | 同上 | 上述档位 + `xhigh`、`max` |
| `wan` | `wan2.7-image` | 千问默认 | `2K`；`1K`、`2K` | 不支持 |
| `wan-pro` | `wan2.7-image-pro` | 千问 | `2K`；生成 `1K`、`2K`、`4K`；编辑不含 `4K` | 不支持 |

所有模型支持生成和参考图编辑（调用入口限制见上节），每次请求一张，无批量数量参数、mask 或多轮连续编辑。

| 本地输入限制 | OpenAI 三款 | Wan 两款 |
| --- | --- | --- |
| 提示词长度 | 32,000 字符 | 5,000 字符 |
| 参考图 | 最多 5 张，单图 50 MiB | 最多 9 张，单图 20 MiB |
| 格式 | PNG / JPEG / WebP / BMP，校验 MIME 和文件签名 | 同左 |
| 自定义尺寸 | `宽x高`；边长 16 的倍数，最长边 3840，比例 ≤ 3，总像素 655,360–8,294,400 | `宽*高`；整数边长，比例 ≤ 8，总像素 589,824–4,194,304；仅 Pro 生成上限为 16,777,216 |

常用配置字段：`providers[].auth` 指定认证来源，`defaultModel` 指向该账户启用的模型 key；`models[].key/id/provider` 定义选择词、上游 ID 和所属账户；`tasks`、`prompt`、`inputImages`、`size.generate/edit`、`quality` 定义上述限制。省略 `size.edit` 继承生成规则。
将模型 `enabled` 设为 `false` 后，不进入向导/运行时，显式选择也会在发送前拒绝，不会当提示词交给默认模型。不要禁用仍被 `defaultModel` 引用的模型。
配置支持注释和尾逗号；缺失、未知字段或无效默认值会报错，不回退旧清单。修复后 `/reload`。不要填真实 Key、token、凭据路径或任意主机；新协议/字段仍需代码支持。

## RPC：首次生成与取回结果

认证预先配置好后，在目标项目启动 `pi --mode rpc`。向该进程 stdin 发送一行 JSON（不是在 shell 中执行 JSON）：

```json
{"id":"image-1","type":"prompt","message":"/image openai --size auto --quality high -- 一只水彩橘猫"}
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
| 配置/输入校验失败 | 修复 models.jsonc 后 `/reload`；核对模型 key、尺寸、质量及参考图限制 |
| 保存失败 | 检查项目目录权限、空间及 `.pi`/输出目录是否为符号链接，不要立即重新生成 |

网络诊断在项目 `.pi/image-generation-logs/`：失败通知给出 `error-<uuid>.json` 路径；也可能存在 `success-<uuid>.json`，它只表示 HTTP 读取/解析成功，不保证图片落盘。日志不自动清理，分享前检查脱敏结果，绝不分享 auth.json。修改启动环境后重启 Pi，`/reload` 不会重新继承 shell 环境；不要关闭 TLS 验证。
会话记录会保留提示词、图片路径和元数据（不是 Key 或图片 base64）；生成时提示词及参考图会发送给所选服务。请保护会话、图片、日志和凭据，按项目需要排除版本控制。
