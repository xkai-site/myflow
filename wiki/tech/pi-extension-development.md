# Pi 扩展开发手册

本文是 `myflow` 中开发 Pi 扩展的项目级入口，记录跨插件通用约定和查资料的路径；具体插件功能、配置和测试命令以各自 README 为准。Pi 的插件机制会随版本演进，本文不复制官方文档全文。

## 项目中的扩展

当前扩展位于 `work/scripts/pi/`，每个插件是独立目录。现有插件通过 `package.json` 的 `pi.extensions` 显式声明入口，入口通常是 `extensions/index.ts`；复杂实现放在 `src/` 或 `extensions/`，测试放在 `test/`。

- [pi-usage-openai](../../work/scripts/pi/pi-usage-openai/README.md)
- [pi-image-generation](../../work/scripts/pi/pi-image-generation/README.md)
- [pi-video-generation](../../work/scripts/pi/pi-video-generation/README.md)
- [pi-notification](../../work/scripts/pi/pi-notification/README.md)

## Pi 扩展机制速览

扩展是运行在 Pi 进程内的 TypeScript/JavaScript 模块。扩展默认导出工厂函数，Pi 将 `ExtensionAPI` 传入工厂；扩展通过该 API 注册命令、工具、事件处理器、provider、快捷键等能力。Pi 使用 `jiti` 加载本地 TS 扩展，无需单独编译。

选择机制时按需求区分：

| 需求 | 通常使用 |
| --- | --- |
| 增加 `/command` 供用户显式操作 | `pi.registerCommand()` |
| 增加模型可调用能力 | `pi.registerTool()` |
| 响应或调整 Pi 生命周期 | `pi.on(event, handler)` |
| 接入对话模型服务 | `pi.registerProvider()` |
| 在扩展间传递事件 | `pi.events` |

命令、工具、生命周期钩子和 provider 的语义不同，不要仅为方便而把显式命令实现成模型工具，或把非对话服务伪装成对话 provider。很多现有插件提供的是 `/image`、`/video` 等用户命令，并不注册 LLM 工具。

### 生命周期与资源

- 扩展工厂可能在没有会话的命令中加载；不要在工厂阶段启动长期进程、socket、watcher 或 timer。
- 会话级资源在 `session_start` 或实际需要时创建，在 `session_shutdown` 中释放。清理应幂等，兼顾取消、reload、会话替换和退出。
- `agent_end` 不一定代表一次运行最终结束；重试、压缩恢复或排队工作可能继续。需要最终边界时，应根据具体语义选择事件（例如 `agent_settled`），不要只凭事件名推断。
- handler 应处理并发、取消和缺失 UI 的情况；同一 assistant 消息中的多个工具调用可能并行运行。
- `ctx.ui` 的交互能力取决于运行模式。终端专属组件应检查模式；命令/业务逻辑应尽量不依赖 TUI，以兼容 RPC、JSON、print 等模式。

### 状态、配置和安全

先明确数据的作用范围：当前分支相关的工具状态、会话 transcript 外的持久条目、发给模型的消息，以及跨会话的外部数据，适合不同的存储方式。避免把凭据或大块敏感内容写入 session、日志、模型可见消息或仓库。

扩展和包代码在 Pi 进程内运行，拥有与 Pi 相同的操作系统权限。只加载可信代码；访问文件、网络、凭据、执行命令或写配置时，要校验输入、限制目标范围、避免泄露秘密，并在 README 说明数据流与风险。项目扩展/包的加载还受 project trust 影响。

## 开发与验证流程

1. **先定扩展边界。** 明确用户入口、是否需要模型调用、运行模式、状态持久化和外部副作用，再选择 command/tool/event/provider。
2. **查项目约定。** 阅读对应插件 README、`package.json`、入口文件、相关实现和测试；优先复用现有模式。
3. **查对应版本的官方资料。** 先看下方官方文档中与改动相关的部分；需要精确事件/API 类型时，以当前 Pi 包导出的类型声明为准。若文档与类型或实际运行不一致，做最小复现并补测试。
4. **实现和测试。** 为边界行为写可重复的单元/宿主测试；不要让需要真实账号、付费请求或公网服务的探测成为普通测试套件的必需步骤。
5. **验证并更新说明。** 运行该插件 README 中的测试命令；行为、安装、配置、权限或限制变化时，同步更新插件 README。改动通用 Pi 约定时再更新本文。

本地开发时可用 `pi -e <入口文件>` 临时加载扩展，不必先安装；目录作为 package 安装可用于验证包清单和依赖。项目中的具体安装方式、命令和路径以插件 README 为准，执行会产生费用或访问外部服务的测试前先确认影响。

## 包结构与依赖约定

本仓库插件采用独立 package 目录。新增或调整插件时：

- 在 `package.json` 的 `pi.extensions` 中声明入口；保持入口轻量，将可测试逻辑拆分到模块。
- 将运行时依赖放入 `dependencies`；使用 Pi 提供的包（例如 `@earendil-works/pi-coding-agent`）放入 `peerDependencies`，不要把 Pi 自身打包进扩展。
- 若依赖外部包，验证本地开发和 `pi install` 两种路径都能解析依赖。
- README 至少说明用途、要求、安装/加载方式、用户入口、配置与凭据、安全边界、测试命令及已知限制。
- `pi install <本地目录>` 是本地引用，不复制源码；移动或删除源码目录会使安装失效。用户级安装和项目级安装的信任及生效范围不同，按需求选择并在 README 写明。

## 官方资料与版本说明

优先级建议：**当前项目依赖中的类型声明/源码与可复现测试 → 对应版本的官方文档 → 外部文章或搜索结果**。网络搜索适合补充版本差异和未覆盖细节，不应成为项目事实的唯一依据。

主要入口：

- [Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)：API、事件、生命周期、UI、状态、错误处理。
- [Pi Packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)：包结构、安装、依赖和 `package.json` manifest。
- [Configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md)：扩展搜索路径及配置。
- [Settings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md)：资源路径和设置项。
- [Terminal UI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md)：自定义终端 UI 的组件与交互。
- [扩展类型声明](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts)：具体 API、上下文和事件类型。

核对记录：本手册初次编写时，本地可用的 Pi coding-agent 文档/API 版本为 **0.87.1**。这是编写时的参考版本，不表示所有插件都锁定或经过该版本运行测试：现有插件的 `peerDependencies` 使用 `*`，并未在仓库统一固定宿主版本。升级 Pi 或遇到行为差异时，应重新核对官方文档和类型，并用宿主测试确认；更新本手册时同步修订本段版本信息。
