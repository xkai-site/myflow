# pi-video-generation

通过 Pi 的 `/video` 斜杠命令生成视频：文生视频（t2v）、单首帧图生视频（i2v）、参考图生视频（r2v）。

- **调用入口**是 Pi 命令，不是 Shell 命令；不触发 LLM 对话轮次。
- **视频 Provider**由插件独立配置，不复用 Pi coding-model Provider，也不向 `/model` 注册视频模型。
- **没有注册 LLM 工具**，Agent 不能直接 tool call；外部程序可通过下文 RPC `prompt` 分发命令。
- 当前仅支持 `dashscope` 协议，模板使用 Qwen Token Plan 的三个 HappyHorse 模型；模型权限、地域可用性、额度及价格须以服务商当前说明为准，未在此保证线上可用。

## 安装与首次调用

需要已安装 Pi，Node.js ≥22.19.0。在仓库根目录的终端执行（本地路径安装，不复制插件）：

```bash
pi install ./work/scripts/pi/pi-video-generation
pi list
```

随后在要保存视频的项目目录启动 `pi`；已有会话请重启或 `/reload`。在 **Pi 输入框**执行：

```text
/video config
```

首次没有活动配置时，依次输入独立的 **API Key**（遮蔽输入）和 **Base URL**，保存模板配置后返回。请从服务商工作空间获取两者；Base URL 填对应服务域名，例如 `https://workspace.cn-beijing.maas.aliyuncs.com`，不是 Pi 的 LLM 接口地址。插件固定访问该域名下 `/api/v1`，忽略 Base URL 中的路径、查询和片段。

确认费用后，在 Pi 输入框复制第一条生成命令：

```text
/video t2v --model happyhorse-1.1-t2v --param resolution=720P --param duration=5 -- 清晨海面，镜头缓慢推进
```

参数式调用**不再弹出确认框，直接提交**。也可输入 `/video`，按向导编辑提示词、选择任务/模型、输入图片路径、选择参数并确认；缺少配置时向导先完成 Key/Base URL 设置。

## 命令与输入

调用时 Pi 必须空闲；忙碌时插件只提示稍后重试，不排队。

| 命令 | 作用 |
| --- | --- |
| `/video` | TUI 生成向导；RPC 中只显示用法 |
| `/video t2v/i2v/r2v ...` | 三选一任务类型，参数式生成，见下面示例 |
| `/video --help` | 查看语法（也接受 `-h`、`help`） |
| `/video config` | TUI 配置管理；RPC 只通知活动文件路径 |
| `/video tasks` | 当前项目未完成记录；TUI 选择一项即恢复，RPC 只列出 |
| `/video resume <task-id>` | 恢复已记录任务的查询与下载，不重新提交 |

以下图片必须先存在于 Pi 所在机器；将示例文件名替换为自己的图片路径：

```text
/video i2v --model happyhorse-1.1-i2v --image "first frame.png" --param duration=5 -- 镜头缓慢拉远
/video r2v --model happyhorse-1.1-r2v --image person.png --image product.png -- [Image 1] 中的人物展示 [Image 2] 中的产品
```

| 输入 | 契约 |
| --- | --- |
| `t2v` / `i2v` / `r2v` | 放在生成命令首位；与 `--model` 一起筛选已配置模型 |
| `--model MODEL` | 模板 ID 为 `happyhorse-1.1-t2v`、`happyhorse-1.1-i2v`、`happyhorse-1.1-r2v`；省略后必须恰好匹配一个模型，否则报错；没有 `--provider` 参数 |
| `--image PATH` | 可重复，按顺序加载本地文件；相对路径基于 Pi 当前项目目录，含空格路径加引号；不接受远程图片 URL |
| `--param KEY=VALUE` | 可重复但键不能重复；未知键或非法值报错；未传时使用活动模型配置默认值 |
| `--` | 结束选项解析，后面全部是提示词；建议始终使用以免提示词被当成选项 |
| 提示词 | 必填，模板上限为 5000 个 UTF-16 码元；含源码识别的中日韩汉字时，整段上限降为 2500 |

选项也接受 `--model=MODEL`、`--image=PATH`、`--param=KEY=VALUE`。单/双引号用于保留空格；这些不是 Shell 参数展开。

### 模板参数与图片限制

下表是随包 [model.json](model.json) 的真实默认值；修改活动配置后以活动文件为准。向导会询问非隐藏参数，不会自动替你确认默认选项。

| `--param` 键 | 适用任务 | 允许值 | 未传时 |
| --- | --- | --- | --- |
| `resolution` | 全部 | `480P`、`720P`、`1080P`（区分大小写） | `1080P` |
| `ratio` | t2v、r2v | `16:9`、`9:16`、`1:1`、`4:3`、`3:4`、`4:5`、`5:4`、`9:21`、`21:9` | `16:9`；i2v 不接受此键 |
| `duration` | 全部 | 3–15 秒整数，步长 1 | `5` |
| `watermark` | 全部 | `true` / `false` | `false`；向导隐藏，命令仍可覆盖 |
| `seed` | 全部 | 0–2147483647 整数 | 不发送该参数，交给服务端；向导留空同义 |

所有输入图片只接受 JPEG、PNG、WebP，并校验文件签名、大小和尺寸，每张最多 **20971520 字节（20 MiB）**。

| 任务 | 图片数量与约束 |
| --- | --- |
| t2v | 0 张，不可传 `--image` |
| i2v | 恰好 1 张首帧图；宽、高均 ≥300px，宽/高在 0.4–2.5 之间 |
| r2v | 1–9 张参考图；每张短边 ≥400px；按输入顺序对应 `[Image 1]`、`[Image 2]` 等，可在提示词中引用 |

向导中图片路径每行一张，r2v 选图后可再编辑提示词。没有尾帧、多段视频或独立音频开关；服务返回的音轨随 MP4 保存。

## 活动配置

默认活动文件为 `~/.pi/agent/pi-video-generation/model.json`，自定义 Pi agent 目录时跟随该目录。包根目录的 `model.json` **只是无密钥初始模板**，不会覆盖已有活动文件；改模板不等于改运行配置。

`/video config` 可编辑 Provider/模型 JSON、替换 Key/Base URL、查看路径。JSON 编辑器用 `__PI_VIDEO_KEEP_EXISTING_API_KEY__` 代替现有 Key；保留占位值和 Provider ID 才会保留原密钥。校验失败不覆盖原文件。

无需重写完整 JSON：首次使用保留模板，设置 Key/Base URL 即可。无 TUI 时可将模板复制到活动路径，再在本机安全编辑这两个字段；插件不支持环境变量或 Shell 命令形式的 Key 引用。

| 配置字段 | 必要契约 / 模板值 |
| --- | --- |
| `version`、`providers`、`models` | `version: 1`，两个数组均不能为空 |
| Provider `id`、`name`、`adapter` | 模板为 `qwen-token-plan`、`Qwen Token Plan`、`dashscope`；只有此 adapter 可用 |
| Provider `apiKey`、`baseUrl` | 两者非空才视为已配置；远端必须 HTTPS，URL 不得含用户名/密码；仅本地兼容服务可用 `http://localhost` 或 `http://127.0.0.1` |
| Provider `pollIntervalMs` | 模板 `15000`；整数 1000–300000 毫秒 |
| Provider `taskTimeoutMs` | 模板 `900000`（15 分钟）；整数 30000–86400000 毫秒，限制本地轮询等待，不限制远端执行/费用 |
| Provider `maxOutputBytes` | 模板 `536870912`（512 MiB）；整数 1024–4294967296 字节，限制单次下载 |
| 模型 `id`、`name`、`provider`、`task` | `provider` 引用 Provider ID，`task` 为 t2v/i2v/r2v；多 Provider 同名模型可能导致命令匹配歧义 |
| 模型 `prompt`、`inputImages`、`parameters` | 必填能力定义，默认值见上表；参数类型为 `select` / `integer` / `boolean`，`hidden` 仅控制向导是否询问 |

API Key **明文保存**在活动文件中。插件尝试设置 POSIX 目录 `0700`、文件 `0600`，Windows 权限仍由账户/系统控制。不要提交、分享活动文件，或把 Key 写进命令与提示词。生成会将提示词和图片发送到配置域名，请先核实域名可信、图片使用授权及费用。

## 异步任务、取消与恢复

服务端异步生成，插件提交后轮询并下载；不是提交后立即返回一个后台工具结果。建议同一项目串行调用。

- TUI 生成/恢复期间按 Escape 停止本地等待；提交阶段可能仍需等待响应。仅当本地记录状态为 `PENDING` 时尝试远端取消，其他状态保留记录。**取消、超时、退出 Pi 均不保证远端停止或停止计费**。
- 超时、网络或下载失败后，先在原项目运行 `/video tasks`，再 `/video resume <task-id>`；恢复只查询原任务，使用当前活动配置，需保留原 Provider/模型及对应工作空间访问权限。
- 记录位于 `.pi/generated-videos/.tasks.json`，不含 Key、Base URL、输入图片或提示词。成功下载、确认远端取消，或查询得知 `FAILED`/`CANCELED` 后移除对应记录。
- 若服务已接单但记录保存失败，保留错误中的 task ID，在服务商控制台核查；没有本地记录不能用 `resume` 恢复。提交响应丢失时也可能已有远端任务，勿盲目重新生成以免重复计费。
- 结果 URL 可能过期，请尽快恢复下载；有效期以服务商为准，插件不保证 24 小时。`UNKNOWN`/expired 错误应到服务商核查，`resume` 不会重新生成失效结果。
- 配置缺失/模型不匹配：用 `/video config` 修正活动文件；输入校验失败：按上表修正路径、图片或参数；下载超限/目录错误：检查 `maxOutputBytes`、磁盘空间与写权限，输出目录不能是符号链接。

## 结果获取与 RPC

成功后 MP4 保存到 **Pi 当前项目的 `.pi/generated-videos/`**，唯一文件名包含时间、Provider、模型及随机后缀。插件校验 MP4 格式但不转码，不保证 H.264 编码。无自定义输出路径参数。

TUI 会话记录显示绝对路径与 **Open original video** 的 `file:///...` 链接。支持的终端可 Ctrl+单击由系统打开，否则复制 URL 手动打开；不自动启动播放器，也不在终端播放。移动/删除文件会使历史链接失效。会话元数据含生成提示词、参数及路径，不自动送入 LLM 上下文。

外部程序先完成活动配置，在目标项目启动 `pi --mode rpc`，向该进程 stdin 逐行发送 JSON（每行以 LF 结束）：

```json
{"id":"video-1","type":"prompt","message":"/video t2v --model happyhorse-1.1-t2v --param resolution=720P -- 清晨海面，镜头缓慢推进"}
```

- 用 `prompt` 分发扩展命令，不用 `steer`、`follow_up` 或 RPC `bash`；RPC `images` 附件不是本插件输入，仍须用 `--image` 指定 Pi 主机本地路径。
- 读取 stdout 的 `extension_ui_request`，其中 `method: "notify"`、`notifyType: "info"` 的成功消息含 `Saved video:` 路径及无终端转义的文件 URL；错误看 `notifyType: "error"`，忙碌等提示看 `warning`。通知不需要 `extension_ui_response`。
- `response` 的 `success: true` 只代表命令被接受/处理，不代表视频生成成功；不要等待 LLM 的 `agent_end` 或 tool result 作为完成依据。通知 ID 不是请求关联 ID，建议逐个请求并核对结果。
- RPC 不提供本插件专用取消命令，也未接入 RPC `abort` 的取消信号；不要把它当成 TUI Escape。远端任务与费用仍需自行核查。
- 返回的是 **Pi 主机上的本地路径/URL，不是视频字节或公网下载链接**；远程客户端需自行取回该文件。
