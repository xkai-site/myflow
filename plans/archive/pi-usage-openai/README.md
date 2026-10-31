# 用量查询插件职责与归档

当前插件为 [pi-usage-openai](../../../work/scripts/pi/pi-usage-openai/README.md)，提供 `/usage-openai` 命令。`extensions/codex-auth.ts` 只读 Codex 登录，`extensions/codex-usage.ts` 查询、解析和格式化用量，`extensions/index.ts` 负责命令与进度显示。

原 `pi-codex-official` 的对话 provider、模型缓存与 OAuth 注册已从该插件职责中移除。图片插件的 OpenAI 认证通过独立 `openai-codex` provider 配置。

凭据有效期、账号匹配、用量响应和命令注册的测试见[测试指南](../../../wiki/tech/pi-extension-testing.md)。原重构时的测试结果、安装核对与图片宿主失败保存在[历史验证记录](verification-history.md)。
