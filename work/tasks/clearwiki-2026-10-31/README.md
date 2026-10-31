# 测试与文档整理记录

按 [ClearWiki](../../skills/ClearWiki.md) 整理五个 Pi 插件的说明、测试入口和归档。基于提交 `02ad9791eb051d790005b3255dab0fb6f5b64881` 的工作区，执行日期为 2026-10-31。原有未跟踪文件 `work/skills/ClearWiki.md` 保持原样。

## 文件处理

| 范围 | 处理 |
| --- | --- |
| 根 README、[开发手册](../../../wiki/tech/pi-extension-development.md) | 统一功能、开发、测试与历史记录入口；按包清单修正宿主版本声明 |
| [测试指南](../../../wiki/tech/pi-extension-testing.md) | 集中维护 PowerShell 命令、依赖、专项脚本、SDK 设置与覆盖边界 |
| 五个插件 README | 核对入口与配置，精简重复说明；补图片测试入口，修正视频的 Git Bash 示例和用量测试的执行目录 |
| 编辑恢复 README | 以输入、输出、安装、测试和卸载组织；完整恢复提示仍由源码常量维护 |
| [通知模块说明](../../../wiki/tech/pi-notification-architecture.md) | 根据当前入口、runtime、配置与渠道代码说明调用关系 |
| [归档目录](../../../plans/archive/README.md) | 已完成计划改为功能导航，去掉执行步骤、检查点、过期目录与重复配置描述 |
| 历史验证 | 将图片配置、通知、用量改造中的验证段落另存为历史报告，保留当时命令、结果和限制 |
| 测试代码 | 通知 `kiss-contract.mjs` 更名为 `routing-contract.mjs`，删除未使用的临时目录；结构检查改为检查实际导入；视频拆出 `test:unit` / `test:host` |
| SDK 测试辅助 | SDK 定位与回归现分别维护在[图片插件](../../scripts/pi/pi-image-generation/test/sdk.mjs)和[视频插件](../../scripts/pi/pi-video-generation/test/sdk.mjs)，各插件自行测试与维护 |
| 图片清单注释 | 修正“等待启用”的旧注释，说明当前已启用且权限取决于账号；模型值保持原样 |

`test:kiss` 保留为通知路由测试的兼容别名。默认 `npm test` 仍执行各包原有的全部专项。

## 关键事实与依据

| 结论 | 源码或配置依据 |
| --- | --- |
| 图片 ≥0.99.0、通知 ≥1.1.0，其余 coding-agent 声明为 `*` | 各插件 `package.json` 的 `peerDependencies`，与本次运行版本分别表达 |
| 图片只有一份模型清单，局部模型集合与认证分别处理 | `pi-image-generation/src/model-config.ts` 的 `readImageConfig`、`src/runtime.ts` 的 `createRuntimeImagesModels` / `generateAndSave`、`src/credentials.ts` 的 `resolveImageAuth` |
| 当前五模型均启用；本地配置不能证明账号可调用 | `pi-image-generation/models.jsonc` 的 `enabled` 值、`assertModelEnabled` 与传输调用；自动测试使用模拟响应 |
| 视频配置模板、活动配置与恢复任务分开 | `pi-video-generation/model.json`、`src/config.ts`、`src/task-store.ts`；结果渲染测试位于 `test/output-preview.mjs` |
| 通知状态分别供通知规则与消息 API 使用 | `pi-notification/src/runtime.ts` 的 `createRuntime`、`src/lifecycle.ts`、`src/messages.ts`；`enabled` 与 `api.enabled` 分别控制输出 |
| 统一接收与显式规则保留不同语义 | `pi-notification/src/rules.ts` 的 `resolveChannels`、`src/settings.ts` 的 `applyOverlay` / `settingUserFilePatch`，以及 `routing-contract.mjs` |
| 用量插件只读 Codex 登录 | `pi-usage-openai/extensions/codex-auth.ts` 的 `readCodexUsageCredential`、`extensions/index.ts` 的命令注册 |
| 编辑恢复只增强歧义错误并保留元数据 | `pi-edit-fallback/extensions/index.ts` 的 `enhanceEditFailure` / `EDIT_RECOVERY` |

表内插件路径相对于 `work/scripts/pi/`。文档中的默认值、输入限制与保存范围由对应实现核对；本次未重新检索外部产品文档。

## 本次验证

环境：Windows x64、Node.js 24.22.1、npm 11.19.1，宿主使用已安装的 Pi 1.4.0。插件测试分进程并行执行；通知包内部按清单顺序执行。宿主命令设置 `PI_SDK` 指向该版本的 `dist/index.js`，使用模拟模型、临时 agent/工作区及本机服务。

| 执行命令（在对应插件目录） | 结果与原始输出 |
| --- | --- |
| 用量 `npm run test` | 19 项通过：[日志](results/pi-usage-openai.log) |
| 图片 `npm run test` | 31 项通过：[日志](results/pi-image-generation.log) |
| 图片 `npm run test:host` | SDK 模拟生成/编辑、设置、诊断与结果渲染通过：[日志](results/pi-image-generation-host.log) |
| 视频 `npm run test` | 12 项单元与输出渲染通过：[日志](results/pi-video-generation.log)；自动定位托管 SDK 的[宿主复测](results/pi-video-generation-host.log)通过 |
| 通知 `npm run test` | 路由、配置、渠道、API、UI、宿主与 CLI 全部通过：[日志](results/pi-notification.log)；UI 26 项 |
| 编辑恢复 `npm run test` | 31 项通过：[日志](results/pi-edit-fallback.log) |
| 编辑恢复 `npm run test:host` | 原生 edit/bash、结果元数据、隔离安装/重载/卸载通过：[日志](results/pi-edit-fallback-host.log)；个人单文件核对按脚本明确跳过 |
| 仓库根 `node --test work/scripts/pi/test-support/sdk.test.mjs` | SDK 定位回归通过：[日志](results/sdk-resolution.log) |

测试均退出 0。首次图片宿主复测暴露仅 ESM 导出的包无法用 `require.resolve` 定位，修正后通过；[首次失败日志](results/pi-image-generation-host-attempt-1.log)保留。Node 测试子进程曾被沙箱以 `spawn EPERM` 阻止，获执行许可后在沙箱外完成上述测试。

文档检查脚本为 [`verify.mjs`](verify.mjs)。在仓库根运行 `node work/tasks/clearwiki-2026-10-31/verify.mjs`，检查 Markdown 编码、围栏、相对链接、包清单与测试脚本路径，并对照 Git HEAD 验证原材料和历史段落的保留情况；结果、全部文件清单和源码 SHA-256 写入 [document-check.json](results/document-check.json)。已检查 32 份 Markdown、125 个本地链接、五个包清单及 28 处测试脚本引用，原始材料与历史段落核对通过，`git diff --check` 通过。链接锚点及外部 URL 未作联网验证。

## 保留材料与验证限制

四份图片探测 JSON、两份图片调查报告、通知原调研与运行记录、编辑恢复原验证报告与离线日志均保留原文。拆出的历史验证段落也与整理前内容逐段核对；其中旧路径、版本、日期及计数按历史来源解释。文件清单见文档检查结果。

本次未请求真实模型、用量或生成服务，未验证真实通知显示与邮件到箱，未重跑编辑恢复的完整离线隔离流程和 TypeScript 检查。旧报告中的类型检查通过记录仅对应原报告的文件指纹。通知等其它插件仍无类型检查脚本；运行时回归不能替代类型检查。

外部图片接口、账号权限、原调查中的断连原因及研究报告中未取得的官方页面，均未在本次重新验证。通知原调研的产品动机仍是用户假设，原记录中的人工验收结论不扩展为本次验证。

## 共享测试目录调整

后续按目录职责将原 `work/scripts/pi/test-support/sdk.mjs` 移到 `work/tests/pi/support/sdk.mjs`，对应回归移到 `work/tests/pi/sdk.test.mjs`。图片、视频宿主测试的导入和当前测试指南随之更新。上表的原执行命令与原报告保留当时路径。

调整后的复测命令为仓库根 `node --test work/tests/pi/sdk.test.mjs`，以及图片、视频各自的 `npm run test:host`，三项均通过。[SDK 回归](results/relocation-sdk.log)、[图片宿主](results/relocation-image.log)和[视频宿主](results/relocation-video.log)的输出另存；原始测试日志和 `document-check.json` 保留。调整后文档、入口及源码指纹可通过 `node work/tasks/clearwiki-2026-10-31/verify.mjs work/tasks/clearwiki-2026-10-31/results/relocation-check.json` 重新核对。

## 插件独立性调整

后续确认每个插件均需独立使用、维护并可单独开源。前述共享测试目录方案已撤回，`work/tests/pi/` 移除；图片、视频各自保留 `test/sdk.mjs` 与 `test/sdk.test.mjs`，由本插件的 npm 测试命令运行。

五个插件均附自身的 MIT 许可证，README 从本插件目录描述安装、依赖与测试。通知的完整架构说明放入本插件 `docs/architecture.md`；根 README 和 wiki 提供导航。前面的目录迁移过程、命令与日志作为历史记录保留。

独立性验证将图片、视频插件分别复制到仓库外的新临时目录，包含本插件已安装的 npm 依赖，使用现有 Pi SDK 作为宿主。副本通过本插件的相对导入加载全部测试与辅助代码：图片 `npm run test` 32 项及 `npm run test:host` 均通过（[日志](results/independent-image.log)）；视频 `npm run test` 的 13 项单元及宿主测试均通过（[日志](results/independent-video.log)）。本轮没有重新下载依赖，依赖获取过程不属于这次验证范围。

五个插件的相对源码导入与文档链接均位于各自目录，独立许可证与仓库 MIT 原文一致；检查记录见 [independent-check.json](results/independent-check.json)。本轮其它三个插件的变更为文档与许可证，未重复执行它们的测试。`git diff --check` 通过。
