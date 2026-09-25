# `pi-usage-openai` 重构计划（草案）

## Context

将 `work/scripts/pi/pi-codex-official` 收敛为只查询 OpenAI/Codex 用量的 Pi 扩展，改名为 `pi-usage-openai`，验证后安装。当前 `/usage-openai` 的请求、解析和格式化逻辑集中在 `extensions/codex-usage.ts`，命令注册在 `extensions/index.ts`；同入口还注册 `openai-codex` provider，依赖 Codex 模型缓存与 OAuth 配置。用户已确认保留命令 `/usage-openai`，且不要求迁移后继续支持图片生成插件的 Codex OAuth 认证。

## Approach

- 以用量查询为唯一产品能力，迁移并复用现有 `fetchCodexUsage`、`parseCodexUsage`、`formatCodexUsage`、`readLiveCodexCredential` 能力与测试；新入口只注册用量斜杠命令，不注册对话 provider、不加载 Codex 模型缓存。
- 新目录/package 名为 `work/scripts/pi/pi-usage-openai` / `pi-usage-openai`；更新根目录及开发手册的插件索引，保留历史归档作为历史记录。
- 因不要求保留图片生成插件的 Codex OAuth 支持，移除其对旧插件源码的直接导入和“安装 pi-codex-official”指引；明确该重构不再提供 Codex provider，图片生成的 OpenAI 账户是否仍可用取决于其他 provider 配置。
- 完成测试与静态检查后，再按用户确认执行本地 Pi 安装；安装目标为新目录，核对 Pi 包列表与 `/usage-openai` 命令。安装前检查并处理旧插件残留安装项，避免同 provider/命令重复注册。

## Files to modify

- `work/scripts/pi/pi-codex-official/` → 重构并重命名为 `work/scripts/pi/pi-usage-openai/`；保留用量命令、用量模块及必要的凭据读取能力，删除 provider/model-cache/OAuth 注册及其专属测试/文档。
- `README.md`、`wiki/tech/pi-extension-development.md`：插件名称、链接与插件目录清单。
- `work/scripts/pi/pi-image-generation/README.md`、`src/credentials.ts`、`src/account-settings.ts`、`test/live-probe.mjs`：移除旧插件安装/源码依赖和误导性说明；不为 Codex 图片认证补做替代实现。
- `plans/archive/`：除非决定需要维护归档索引，否则仅保留旧计划作为历史材料，不纳入运行代码清理。

## Reuse

- `work/scripts/pi/pi-codex-official/extensions/codex-usage.ts`：超时/HTTP 错误处理、响应解析、隐私安全格式化逻辑。
- `work/scripts/pi/pi-codex-official/extensions/codex-auth.ts`：当前用量命令所用的 `readLiveCodexCredential()`；需从 OAuth provider 实现中分离或抽出最小只读凭据读取代码，避免新包保留无关认证/provider 注册功能。
- `work/scripts/pi/pi-codex-official/test/codex-usage.test.ts`：迁移复用的解析、格式化、fetch 测试。
- `work/scripts/pi/pi-codex-official/extensions/index.ts`：用量命令 UI/错误提示/进度 widget 实现参考；新入口应移除其余 provider 注册与 reload hook。

## Steps

- [x] 确认保留 `/usage-openai` 命令名。
- [x] 确认不要求保留图片生成插件的 Codex OAuth 支持；新插件不注册 `openai-codex` provider。
- [x] 创建并验证 `pi-usage-openai` package：只注册 `/usage-openai`，保留安全的只读凭据读取及用量实现/测试，移除 provider、模型缓存、OAuth provider 注册及其余 Codex 插件功能。
- [x] 更新引用、文档、测试及图片生成插件中的旧插件依赖/认证说明；全仓搜索旧包名/旧目录依赖，区分历史归档与仍生效引用。
- [x] 运行新插件测试及受影响的图片生成测试/静态检查，核对 package manifest 与入口。
- [x] 在确认安装时机后安装新目录；核对 Pi 安装列表及命令可用性，并确认不存在旧插件重复注册。

## Verification

- 单元测试覆盖用量响应解析、异常字段、格式化、超时/HTTP/无效 JSON 与错误安全性；测试不得请求真实账号或泄露 token。
- 对 `pi-usage-openai` 执行完整测试；对图片生成受影响的认证/配置测试执行回归。
- 静态检查：新插件不含 `registerProvider`、模型缓存加载及旧插件目录导入；全仓搜索确认非归档文件无旧目录引用。
- Pi 验证：`pi list` 显示安装了新目录且没有旧插件；扩展注册测试确认只注册 `/usage-openai`、不注册 provider。未实际调用 `/usage-openai`，因此没有发起真实用量接口请求。
- 验证结果：`pi-usage-openai` 19/19 测试通过；`pi-image-generation` 31/31 测试通过；package JSON 与入口清单有效。
- 附加检查：`pi-image-generation` 的 `npm run test:host` 未能启动，当前环境解析 Pi package 的导出入口失败（`ERR_PACKAGE_PATH_NOT_EXPORTED`）；两个 package 的单元测试均通过。

## 已确认决策

- 新插件继续使用 `/usage-openai`。
- 不要求图片生成插件在移除旧 provider 后继续通过 Codex OAuth 工作；本次不实现替代认证，不把 `openai-codex` provider 功能带入用量插件。
