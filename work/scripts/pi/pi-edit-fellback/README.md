# pi-edit-fellback

轻量、无状态的 Pi TypeScript Extension：只增强原生 `edit` 的 **oldText 重复匹配 / 唯一性冲突**错误。名称按要求保留 `fellback` 拼写。

已在 **Pi 1.4.0 / Node.js 24.22.1 / Windows** 验证。沿用本目录其它插件的 `package.json + extensions/index.ts` 组织形式；部署只需入口这一个文件，无运行时依赖，无需编译或 `npm install`。

## 安装与加载

本机已安装到用户级自动发现目录：

```text
C:\Users\HP\.pi\agent\extensions\pi-edit-fellback.ts
```

源码：

```text
D:\XuKai\Project\myflow\work\scripts\pi\pi-edit-fellback\extensions\index.ts
```

在当前 Pi 会话输入 **`/reload`**，或重启 Pi。没有新增命令或配置项，也没有修改用户 `settings.json`。

手动安装 / 更新（在插件目录执行 PowerShell）：

```powershell
$agentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME '.pi\agent' }
$extensions = Join-Path $agentDir 'extensions'
New-Item -ItemType Directory -Force $extensions | Out-Null
Copy-Item .\extensions\index.ts (Join-Path $extensions 'pi-edit-fellback.ts') -Force
```

也可以按其它本地插件的方式执行 `pi install <此插件的绝对目录>`，由 `package.json` 的 `pi.extensions` 指定入口。**两种安装方式选一种，不要与上述单文件安装同时使用。** 当前采用单文件安装，不需要执行 `pi install`。

## 行为与边界

只注册一个同步的 `tool_result` handler，同时满足以下条件才返回增强结果：

1. `event.toolName === "edit"`；
2. `event.isError === true`；
3. 文本块含重复匹配或非唯一性诊断。正则覆盖原生单项 `Found N occurrences of the text ...`、批量 `Found N occurrences of edits[n] ...`、`oldText must be unique`、`oldText matches multiple locations` 等片段，不依赖完整错误字符串或路径。

成功结果和非 `edit` 结果在读取 `content` 前立即返回 `undefined`。其它 `edit` 错误保持原样，包括未找到文本、空 `oldText`、文件不存在、权限、重叠编辑和取消等。

匹配后，原始内容块完全保留，只在末尾增加一个英文文本块。原有文本和非文本块对象均不修改，显式保持 `isError: true`，保留 `details`、`usage` 和 `structuredContent`。Pi 1.4.0 在替换 `content` 时会删除未显式返回的 `structuredContent`，本扩展已处理这一 API 细节；其它事件字段由 Pi 的链式合并机制保持。

任何文本块已有 `Edit recovery:` 标记时不再追加，不需要跨调用状态，也不会阻止后续独立失败获得提示。

恢复提示：

```text
Edit recovery:
1. Re-read the relevant file section.
2. Retry edit with sufficient unique context.
3. If ambiguity remains, use the existing bash tool
   to apply a contextual unified diff patch.
4. Validate the patch before applying it.
5. Verify the resulting changes.
6. Do not overwrite the entire file or modify
   unrelated code.

Patch safety: Use standard unified diff, not custom apply_patch format.
Run git apply --check before git apply; apply only on success, otherwise
re-read and re-locate (never force). Preserve unrelated changes; inspect
the target and diff. Stop and explain if the target is unclear.
Use native edit for subsequent edits.
```

扩展仅提供错误后的恢复指引，**不会替 Agent 执行或强制执行恢复策略**。无法明确定位时应停止并解释，而不是猜测位置、强制打补丁或覆盖整个文件。原生 `edit` 和 `bash` 始终保留，之后的编辑继续优先使用原生 `edit`。

### 性能与缓存

- 不覆盖工具、不注册工具、不改变工具 Schema，不调用 `setActiveTools()`。
- 不修改 System Prompt、不注册 `before_agent_start`、不发送额外消息或创建额外 Agent Turn。
- 无文件 I/O、子进程、计时器、后台任务、额外模型调用或运行时依赖。
- 无跨调用状态；只有符合条件的失败增加恢复提示 Token。
- 对比测试确认工具声明和 System Prompt 不变；未实测供应商侧 Prompt Cache 命中率。

## 测试

在插件目录执行：

```bash
npm test
npm run test:host
npm exec --yes --package=typescript@5.9.3 -- node test/typecheck.mjs
```

类型检查工具仅用于开发，按需使用 npm 缓存中的 TypeScript，不装入部署文件。也可设置 `PI_TSC` 为现有 `typescript/bin/tsc` 的绝对路径，再运行 `npm run typecheck`。检查开启 `strict` / `noEmit`，使用当前安装的 Pi 声明；`skipLibCheck` 只跳过第三方声明内部的检查。

测试默认读取托管 Pi 的当前版本；非托管安装可用 `PI_SDK` 指定 `pi-coding-agent/dist/index.js`。宿主测试可用 `PI_EDIT_FELLBACK_INSTALLED` 指定已安装入口，未安装时明确跳过该文件一致性检查，改用源码做自动发现测试。

本机测试结果：

| 检查 | 结果 |
|---|---|
| 31 项单元测试 | 全部通过 |
| TypeScript 5.9.3 对 Pi 1.4.0 API 的严格类型检查 | 通过 |
| 已安装入口与源码一致、自动发现、真实 Jiti 加载 | 通过 |
| 原生 edit 成功、单项 / 批量重复匹配失败 | 通过 |
| 增加唯一上下文后重试 edit | 通过，只修改目标位置 |
| 原生未找到文本、文件缺失、空 oldText、重叠错误 | 通过，与未增强的原生诊断完全一致 |
| 防止重复追加、保留错误状态、图片和元数据 | 单元测试及真实 ExtensionRunner 均通过 |
| 工具列表、工具 Schema、System Prompt 不变 | 与无扩展的 SDK 会话对比通过 |
| SDK `session.reload()`（TUI `/reload` 使用的重载实现） | 通过，新实例不叠加 |
| 原生 bash 执行标准 diff 的 check → apply → diff 验证 | 通过，保留已有无关修改；校验失败不应用 |
| Patch 后继续原生 edit、无额外模型 turn | 通过 |
| 外部网络请求、扩展运行异常 | 均为 0 |

宿主测试使用隔离临时工作区、临时 agent 目录和确定性响应，真实运行 Pi SDK 与原生工具，**未请求任何真实模型**。临时 Git 配置关闭 `core.autocrlf`，不改用户 Git 配置。补丁由测试显式发起，不是扩展自动执行。没有实测真实模型是否始终遵循恢复提示，也没有操作当前正在运行的 TUI 输入 `/reload`；当前会话仍需手动重载。

## 卸载

当前是单文件安装，PowerShell 执行：

```powershell
Remove-Item "$HOME\.pi\agent\extensions\pi-edit-fellback.ts"
```

若使用自定义 `PI_CODING_AGENT_DIR`，删除其 `extensions/pi-edit-fellback.ts`。随后在 Pi 中执行 `/reload` 或重启即可。源码目录可保留；未写入其它扩展配置或持久化状态。

若改用过 `pi install <路径>`，请使用 `pi remove <同一路径>` 卸载对应包声明。
