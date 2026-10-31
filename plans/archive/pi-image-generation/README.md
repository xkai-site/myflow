# 图片插件配置与调查索引

当前使用说明见[插件 README](../../../work/scripts/pi/pi-image-generation/README.md)，执行环境与测试命令见[测试指南](../../../wiki/tech/pi-extension-testing.md)。

- [模型配置与认证实现](image-generation-model-config.md)，以及[原配置改造验证记录](model-config-verification.md)。
- [生图请求调查](openai-image-request-investigation.md)与[客户端长任务研究报告](openai-image-async-client-research.md)：保留原始内容，结论对应报告中的版本、账号及证据范围。
- 原始 JSON 结果：[单次真实探测](openai-image-live-probe-result.json)、[HTTPS 代理探测](clash-https-probe-result.json)、[Dispatcher 直连](host-dispatcher-direct-result.json)、[Dispatcher 隧道](host-dispatcher-tunnel-result.json)。

调查中的 `plans/*.json` 与 `test/live-probe.mjs` 是当时位置；结果现位于本目录，真实探测脚本已不在当前源码中。报告中的外部接口结论本次未重新联网核验，自动回归使用模拟响应与本机服务。
