# pi-video-generation

为 Pi 提供 `/video` 视频生成命令，不触发 LLM 对话轮次，也不注册模型工具。

支持三类任务：

- 文生视频（t2v）
- 图生视频（i2v）：固定一张首帧图
- 参考图生视频（r2v）：一张或多张参考图

首个协议适配器为 DashScope/Qwen Token Plan，默认模型模板包含：

- `happyhorse-1.1-t2v`
- `happyhorse-1.1-i2v`
- `happyhorse-1.1-r2v`

## 安装

在扩展目录的上一级执行：

```bash
pi install ./pi-video-generation
pi list
```

修改扩展源码后重启 Pi，或执行 `/reload`。

## 首次配置

执行：

```text
/video
```

没有可用配置时，扩展先要求：

1. API Key：使用遮蔽输入，不在终端显示。
2. Base URL：例如工作空间对应的地域域名。

保存后继续视频生成向导。配置由扩展独立管理，不复用 Pi 的 coding-model Provider。

活动配置位于：

```text
~/.pi/agent/pi-video-generation/model.json
```

如果设置了 Pi 自定义 agent 目录，则配置跟随该目录。扩展包根目录的 `model.json` 是无密钥初始模板，不是运行时配置。

API Key 以明文写入用户级活动配置。扩展在 POSIX 系统尝试使用目录 `0700`、文件 `0600`；Windows 文件权限仍受账户、磁盘和系统策略控制。不要提交或分享活动配置。

## 使用

交互模式：

```text
/video
```

流程：

1. 编辑提示词。
2. 选择文生视频、图生视频或参考图生视频。
3. 选择配置中支持该任务的模型。
4. 图生视频输入一张图片；参考图生视频每行输入一张图片。
5. 按模型配置选择分辨率、比例、时长等参数。
6. 确认并生成。

参考图按输入顺序映射为 `[Image 1]`、`[Image 2]` 等。选图后可以再次编辑提示词。

输出写入当前项目：

```text
.pi/generated-videos/
```

首版每次保存一个 H.264 MP4。模型生成的音轨随 MP4 保存；扩展不提供独立音频开关、首尾帧或多段视频流程，也不在终端内播放视频。

### 非交互/RPC

```text
/video t2v --model happyhorse-1.1-t2v --param resolution=720P --param duration=5 提示词
/video i2v --model happyhorse-1.1-i2v --image first.png --param duration=5 提示词
/video r2v --model happyhorse-1.1-r2v --image person.png --image product.png 提示词
```

使用 `/video --help` 查看语法。非交互模式缺少配置时只返回配置路径和操作提示，不弹出 TUI。

## 配置管理

执行：

```text
/video config
```

可执行：

- 编辑 Provider 和模型 JSON。
- 设置或替换 Provider API Key。
- 设置或替换 Provider Base URL。
- 查看活动配置路径。

JSON 编辑器不会回显已有 API Key，而是显示：

```text
__PI_VIDEO_KEEP_EXISTING_API_KEY__
```

保留该值会继续使用原密钥。新增 Provider 时先将 `apiKey` 留空，保存后再通过遮蔽输入设置密钥。配置校验失败时不会覆盖原文件。

### 配置结构

```json
{
  "version": 1,
  "providers": [
    {
      "id": "qwen-token-plan",
      "name": "Qwen Token Plan",
      "adapter": "dashscope",
      "baseUrl": "https://workspace.cn-beijing.maas.aliyuncs.com",
      "apiKey": "sk-...",
      "pollIntervalMs": 15000,
      "taskTimeoutMs": 900000,
      "maxOutputBytes": 536870912
    }
  ],
  "models": [
    {
      "id": "happyhorse-1.1-t2v",
      "name": "HappyHorse 1.1 Text to Video",
      "provider": "qwen-token-plan",
      "task": "t2v",
      "prompt": { "maxChars": 5000, "maxCjkChars": 2500 },
      "inputImages": {
        "minimum": 0,
        "maximum": 0,
        "maxBytes": 20971520,
        "mimeTypes": ["image/jpeg", "image/png", "image/webp"]
      },
      "parameters": [
        {
          "key": "resolution",
          "label": "Resolution",
          "type": "select",
          "values": ["480P", "720P", "1080P"],
          "default": "1080P"
        }
      ]
    }
  ]
}
```

参数定义支持：

- `select`：列表选择。
- `integer`：有界整数，可设置 `step`、`default` 和 `optional`。
- `boolean`：布尔选择。
- `hidden: true`：不询问用户，直接使用默认值。

模型能力、图片数量/尺寸限制和参数选项来自配置，不在通用向导中枚举模型名称。

## 跨厂商适配边界

`model.json` 负责 Provider、模型能力和参数；TypeScript adapter 负责厂商 HTTP 协议。首版只实现 `dashscope`。

接入可灵、Seedance、MiniMax 时：

1. 新增对应 adapter，处理提交、查询、取消和结果解析。
2. 在配置 schema 的 adapter 联合类型和调度器中注册。
3. 在 `model.json` 添加 Provider 和模型能力。

通用提示词、选图、参数向导、任务恢复和视频落盘流程不需要绑定具体模型。

非本机 Base URL 必须使用 HTTPS；`http://localhost` 和回环地址仅用于本地兼容服务。

## 取消和恢复

DashScope 是异步任务：提交后轮询任务状态，结果 URL 只保留约 24 小时。

按 Escape 时：

1. 立即停止本地等待。
2. 尝试取消远端任务。
3. DashScope 只能取消仍为 `PENDING` 的任务。
4. 如果任务已是 `RUNNING`，它仍可能继续并产生费用；本地保留任务记录。

查看未完成任务：

```text
/video tasks
```

恢复原任务的轮询和下载：

```text
/video resume <task-id>
```

恢复操作只查询原任务，绝不重新提交生成请求。任务记录位于当前项目：

```text
.pi/generated-videos/.tasks.json
```

记录不包含 API Key、Base URL、输入图片或提示词。成功下载或确认远端取消后删除对应记录。

## 输入与输出安全

- 输入图只接受 JPEG、PNG、WebP，并校验文件签名、尺寸、比例和大小。
- HappyHorse i2v：恰好一张图，最大 20 MB，宽高至少 300px，比例 1:2.5–2.5:1。
- HappyHorse r2v：1–9 张图，每张最大 20 MB，短边至少 400px。
- 结果 URL 必须为 HTTPS。
- 下载时限制响应大小并校验 MP4 `ftyp` 文件签名。
- 使用唯一文件名、临时文件和原子重命名。
- 拒绝通过符号链接写入项目输出目录。
- 错误信息会清理 Bearer token、API Key、data URL 和大段 base64。

## 验证

真实验证三个 HappyHorse 模型会消耗现有 Qwen Token Plan 额度，应在明确确认后执行。
