# 用量查询改造的历史验证记录

以下段落从原重构计划原样保留。宿主测试失败与安装核对均为当时记录；本次整理的结果见[整理记录](../../../work/tasks/clearwiki-2026-10-31/README.md)。

## Verification

- 单元测试覆盖用量响应解析、异常字段、格式化、超时/HTTP/无效 JSON 与错误安全性；测试不得请求真实账号或泄露 token。
- 对 `pi-usage-openai` 执行完整测试；对图片生成受影响的认证/配置测试执行回归。
- 静态检查：新插件不含 `registerProvider`、模型缓存加载及旧插件目录导入；全仓搜索确认非归档文件无旧目录引用。
- Pi 验证：`pi list` 显示安装了新目录且没有旧插件；扩展注册测试确认只注册 `/usage-openai`、不注册 provider。未实际调用 `/usage-openai`，因此没有发起真实用量接口请求。
- 验证结果：`pi-usage-openai` 19/19 测试通过；`pi-image-generation` 31/31 测试通过；package JSON 与入口清单有效。
- 附加检查：`pi-image-generation` 的 `npm run test:host` 未能启动，当前环境解析 Pi package 的导出入口失败（`ERR_PACKAGE_PATH_NOT_EXPORTED`）；两个 package 的单元测试均通过。


