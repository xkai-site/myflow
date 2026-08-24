# 模型配置

`models.json` 是可提交、可共享的模型清单。每个模型支持以下字段：

- `id`：上游模型 ID
- `name`：Pi 中显示的名称
- `reasoning`：是否支持推理
- `input`：输入类型，可填写 `text`、`image`
- `contextWindow`：上下文窗口
- `maxTokens`：最大输出 token 数
- `cost`：每百万 token 成本；ChatGPT 账号模式可保持为 `0`

编辑后执行 `/reload` 或重启 Pi 使配置生效。扩展加载时会检查必填字段和基本类型。
