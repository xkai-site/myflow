# pi-image-generation

为 Pi 提供 `/image` 命令，直接生成或编辑图片，不触发 LLM 对话轮次，也不向模型注册工具。

支持：

- OpenAI `gpt-image-2`：复用现有 `pi-codex-official` ChatGPT/Codex OAuth。
- Qwen Token Plan CN：复用 Pi 中现有 `qwen-token-plan-cn` 凭据，支持 `wan2.7-image` 和 `wan2.7-image-pro`。

生成结果写入当前项目：

```text
.pi/generated-images/
```

## 前置条件

### OpenAI

安装并登录本地扩展：

```text
D:/XuKai/Project/myflow/work/scripts/pi/pi-codex-official
```

`/image` 通过 Pi 的 `ModelRegistry` 获取 `openai-codex` 当前 OAuth 凭据，沿用其自动刷新和凭据缓存，不读取或复制 OAuth 文件。

ChatGPT Plus 包含 Codex 非网页端图片生成与编辑权益。图片生成计入 Codex 通用额度，平均比普通消息快消耗约 3–5 倍。

本扩展调用 OpenAI 开源 Codex 客户端使用的订阅后端：

```text
https://chatgpt.com/backend-api/codex/images/generations
https://chatgpt.com/backend-api/codex/images/edits
```

这些接口不是公开 OpenAI Platform API。Plus 权益已由官方文档确认，但第三方直接调用该协议的稳定性没有公开承诺，上游变更可能导致扩展需要同步更新。

### Qwen Token Plan CN

先在 Pi 中配置 `qwen-token-plan-cn`。扩展复用该 Provider 的凭据和区域，不新增或保存 API Key。

调用同步图片接口：

```text
https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
```

ALI 返回的图片 URL 仅短期有效，扩展会立即下载并原子写入项目目录。

## 安装

```bash
pi install D:/XuKai/Project/myflow/work/scripts/pi/pi-image-generation
pi list
```

修改后重启 Pi，或执行：

```text
/reload
```

## 使用

在交互模式中只需执行：

```text
/image
```

扩展会依次引导：

1. 检测已经配置凭据的图片账户；不会展示不可用的 Provider。
2. 填写或编辑提示词。
3. 选择“生成新图片”或“使用参考图编辑”。
4. 选择可用模型；只有 OpenAI 时会自动选中，只有 Ali 时只显示 Wan/Wan Pro。
5. 选择尺寸；OpenAI 还会选择质量。
6. 确认后生成图片。

尺寸和质量均通过列表选择，不需要手写 `--size`、`--quality` 或模型名称。选择 Automatic/2K 即采用原默认值。

`/image --help` 可查看交互说明。非交互和 RPC 模式支持显式 Provider 参数；仅配置一个账户时也可省略 Provider，其中 Ali 默认使用 `wan2.7-image`。

默认值：

- OpenAI：自动尺寸、自动质量。
- Wan/Wan Pro：2K。
- 每次一张 PNG。
- 不添加水印，不启用图片集，不覆盖已有文件。

### 图片编辑

执行 `/image`，填写提示词后选择“使用参考图编辑”。在文件输入界面中，每行粘贴或拖入一个图片路径；相对路径按当前项目解析。路径可使用 `@path`，也可带引号。

第一版仅支持普通参考图编辑：

- OpenAI 最多 5 张参考图。
- Wan 最多 9 张参考图。
- 暂不支持 mask、`bbox_list`、图片集模式和多轮连续编辑。

## 取消

生成时显示可取消加载界面。按 Escape 会中止请求或结果下载，且不会保留临时文件或半成品。

## 安全策略

- 不保存、打印或复制 OAuth token/API Key。
- 不把图片 base64 写入会话历史，只保存落盘路径和非敏感元数据。
- 校验输入/输出图片 MIME、文件签名和大小。
- 只接受 HTTPS 的 ALI 结果 URL。
- 使用唯一文件名、临时文件和原子重命名。
- 拒绝通过符号链接写入 `.pi/generated-images/`。
- 服务端错误会截断并清理 token、data URL 和大段 base64。

## 验证说明

如需通过真实请求验证扩展，OpenAI 和 ALI 的文生图、图片编辑请求都会消耗现有额度。
