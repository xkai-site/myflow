# 图片模型配置与认证

当前图片模型由插件根目录 [models.jsonc](../../../work/scripts/pi/pi-image-generation/models.jsonc) 定义，`src/model-config.ts` 读取并校验；每次重载读取同一文件。模型 key、上游 ID、任务、尺寸、质量和输入限制由配置提供。

`src/credentials.ts` 的 `resolveImageAuth` 按保存的图片 Key → 专用环境变量 → 已有千问 provider 解析千问认证；OpenAI 通过已认证的 `openai-codex` provider 获取凭据。该 provider 由独立安装负责。

`src/runtime.ts` 在插件局部创建图片模型集合，按选定适配器生成，再由 `src/image-files.ts` 校验并保存输出。TUI 编辑接收本地参考图，标准 RPC `/image` 为文本生成入口。

配置字段、认证端点、密钥明文保存与输入限制见[插件 README](../../../work/scripts/pi/pi-image-generation/README.md)。配置和认证专项、宿主模拟生成/编辑见[测试指南](../../../wiki/tech/pi-extension-testing.md)。

原三模型配置改造的执行结果保存在[历史验证记录](model-config-verification.md)，模型清单与本次运行范围分别以当前配置和整理报告为准。
