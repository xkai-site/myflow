# 通知测试与注释维护

按功能选测试：配置校验用 `config-validation.mjs`，保存与恢复用 `settings-patch.mjs`，日志与注册用 `registry-log.mjs`，运行判定用 `lifecycle-state.mjs`。渠道、UI、宿主与 CLI 的完整列表见 [测试指南](../../../wiki/tech/pi-extension-testing.md)。

源码注释解释当前调用、状态或边界；功能行为由实现和测试确认。旧版代码行数、注释语言统计与当时的测试计数保存在 [历史验证摘录](verification-history.md)。

原整理发现的配置键过滤、错误脱敏和未知视频适配器处理，分别可在 `src/patch.ts`、`src/log.ts` 及视频插件 `src/adapters.ts` 对照。
