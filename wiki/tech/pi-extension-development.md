# Pi 扩展开发

本仓库集中存放五个可独立使用和维护的插件，目录为 `work/scripts/pi/<插件名>/`。每个目录包含自己的源码、配置、依赖声明、测试、测试辅助、README 和许可证，可单独复制并准备依赖后运行。各插件通过 `package.json` 的 `pi.extensions` 声明 `extensions/index.ts`。

本页提供开发导航，各插件 README 维护完整的安装、配置与测试说明；[测试索引](pi-extension-testing.md)链接到各自入口。小型辅助代码由使用它的插件自行维护，修改与版本验证均以单个插件为范围。

## 实现入口

| 插件 | 用户入口 | 实现位置 |
| --- | --- | --- |
| [pi-usage-openai](../../work/scripts/pi/pi-usage-openai/README.md) | `/usage-openai` | `extensions/index.ts` 注册命令，`codex-auth.ts` 读取登录，`codex-usage.ts` 查询与格式化 |
| [pi-image-generation](../../work/scripts/pi/pi-image-generation/README.md) | `/image` | `models.jsonc` 定义模型，`src/credentials.ts` 解析认证，`src/runtime.ts` 生成并保存 |
| [pi-video-generation](../../work/scripts/pi/pi-video-generation/README.md) | `/video` | `src/command.ts` 解析输入，`src/submission.ts` 与适配器处理任务，`src/task-store.ts` 保存恢复记录 |
| [pi-notification](../../work/scripts/pi/pi-notification/README.md) | `/notify` 与生命周期事件 | `src/runtime.ts` 组织状态、通知和消息 API；插件内的[模块说明](../../work/scripts/pi/pi-notification/docs/architecture.md)列出调用关系 |
| [pi-edit-fallback](../../work/scripts/pi/pi-edit-fallback/README.md) | `tool_result` | `extensions/index.ts` 增强 edit 的非唯一匹配错误 |

图片、视频和用量插件注册用户命令；编辑恢复处理工具结果；通知处理公开生命周期事件并提供设置命令。新增功能按实际调用者选择 `registerCommand`、`registerTool`、`on` 或 `registerProvider`。图片与视频模型由插件管理，和聊天 provider 的职责分别由各自实现确定。

## 配置与资源

扩展由宿主加载 TypeScript 入口。入口负责注册，复杂逻辑在 `src/` 或 `extensions/` 模块中维护。运行时依赖写入 `dependencies`，宿主提供的 Pi 包写入 `peerDependencies`。

会话级资源在 `session_start` 或实际调用时创建，在 `session_shutdown` 中收尾。通知插件通过 `agent_settled` 判定最终结果；其退出等待受 `shutdownFlushMs` 限制。用户界面按 `ctx.mode` 处理 TUI、RPC、print 和 JSON 的差异。

配置说明应标明文件位置、生效时机、默认值、会话与用户级保存范围。凭据说明应标明读取来源、发送目标、存储形式及失败结果；日志记录实际需要的脱敏诊断。项目级扩展的加载遵循宿主的项目信任设置。

## 修改与验证

先阅读目标插件的 README、清单、入口及实际调用模块，再在该插件目录运行相关测试。修改用户入口、配置、权限或输出时同步修改该插件说明。依赖与测试辅助由该插件目录提供，包安装使用本地源码引用，后续加载依赖该目录的位置。

| 插件 | 当前宿主声明 |
| --- | --- |
| pi-image-generation | `@earendil-works/pi-coding-agent >=0.99.0` |
| pi-notification | `@earendil-works/pi-coding-agent >=1.1.0` |
| pi-usage-openai、pi-edit-fallback | `@earendil-works/pi-coding-agent *` |
| pi-video-generation | `@earendil-works/pi-coding-agent *`、`@earendil-works/pi-tui *` |

这些声明来自各包清单，最低版本与实际验证版本分别记录。本次 Pi 1.4.0 的运行范围见[整理记录](../../work/tasks/clearwiki-2026-10-31/README.md)。升级时用目标安装中的类型声明、实现和宿主测试核对相关接口。

## 外部资料

以下链接用于查阅 Pi 接口；具体行为以使用版本的实现和测试为依据。

- [扩展 API 与事件](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [包清单与安装](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [配置](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md)与[设置](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md)
- [终端 UI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md)
