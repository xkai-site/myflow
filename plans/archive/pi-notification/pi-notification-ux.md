# 通知设置的保存范围

`src/settings.ts` 定义可编辑字段和会话覆盖，`src/patch.ts` 处理稀疏补丁，`src/config.ts` 负责用户文件写入。Enter 应用本对话值，Ctrl+S 保存当前项已生效值。

详情中的 a 清除当前项的会话覆盖，d 确认后恢复该项初始值。单项保存保留其它字段和未知配置；损坏文件保留原文并报告错误。完整按键与作用范围见 [插件 README](../../../work/scripts/pi/pi-notification/README.md)。

`settings-patch.mjs` 检查字段范围与持久化，`settings-ui.mjs` 检查键盘与反馈，`host-lifecycle.mjs` 检查会话恢复。运行入口见 [插件测试说明](../../../work/scripts/pi/pi-notification/README.md#开发与测试)，早期验收见 [历史验证摘录](verification-history.md)。
