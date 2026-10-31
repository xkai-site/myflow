# 通知插件维护入口

使用与配置从 [插件 README](../../../work/scripts/pi/pi-notification/README.md) 开始，查调用关系读 [模块说明](../../../work/scripts/pi/pi-notification/docs/architecture.md)，查环境与执行命令读 [插件测试说明](../../../work/scripts/pi/pi-notification/README.md#开发与测试)。

TUI 使用 `/notify` 设置；RPC、print、JSON 模式展示状态。旧 `/notify on|off|status|config|reload` 子命令已由单一入口替代，配置重读使用界面动作或 `/reload`。

宿主测试使用临时 agent 与模拟模型，CLI 测试直接启动 SDK 的 bundle 入口，避免 Windows shell 拆分带空格的提示词。真实系统通知与邮件到箱分别依赖实际终端和邮箱。

历次自动化验收与当时未验证项保存在 [历史验证摘录](verification-history.md)；旧交接中的工作区状态、下一步和宿主路径仅属于当时会话。
