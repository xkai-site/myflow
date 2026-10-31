# 通知设置界面

`src/ui.ts` 渲染首页、提醒时机、接收方式和更多设置；`src/settings.ts` 的字段及分类表决定可见项。首页保留常用任务，详情、搜索、诊断与条件字段按当前页面展示。

当前界面与按键见 [插件 README](../../../work/scripts/pi/pi-notification/README.md)。`settings-ui.mjs` 检查渲染、选择、保存反馈与页面返回；宿主测试检查配置接入和模式差异。

已完成的阶段安排、执行检查点与中断恢复记录已从功能说明中移出，原验收结果保存在 [历史验证摘录](verification-history.md)。最新测试以 [插件测试说明](../../../work/scripts/pi/pi-notification/README.md#开发与测试) 中的入口运行。
