# 通知合并与投递

`src/service.ts` 按等级、免打扰、去重与冷却筛选请求，合并同一运行的通知，再交给渠道。`src/providers/decorators.ts` 提供超时、重试、熔断与脱敏。

工具失败默认聚合到运行结果，immediate 模式按阈值提交；压缩失败与等待输入分别由 `src/rules.ts` 判断。默认参数与配置方法见 [插件 README](../../../work/scripts/pi/pi-notification/README.md)。

对应测试为 `service-coalesce.mjs`、`webhook-channel.mjs`、`lifecycle-state.mjs` 和 `host-lifecycle.mjs`。命令见 [插件测试说明](../../../work/scripts/pi/pi-notification/README.md#开发与测试)；原 M2 的验收与限制见 [历史验证摘录](verification-history.md)。
