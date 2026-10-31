# pi-edit-fallback

轻量、无状态的 Pi TypeScript Extension：只增强原生 `edit` 的 **oldText 重复匹配 / 唯一性冲突**错误。

## 兼容性

已验证 **Pi 1.4.0 / Node.js 24.22.1 / Windows x64**；其它版本或平台尚未验证。沿用本仓库其它插件的 `package.json + extensions/index.ts` 组织形式。扩展本身无运行时依赖，无需编译或 `npm install`；开发测试的 SDK / TypeScript 前置条件见下文。

## 安装与加载

### 推荐：使用 `pi install`

在仓库根目录执行：

```bash
pi install ./work/scripts/pi/pi-edit-fallback
pi list
```

然后在 Pi 会话输入 **`/reload`**，或重启 Pi。没有新增命令或配置项。安装声明由 Pi 写入用户级 `settings.json`；本地包直接从解析后的源码目录加载，不复制源码，安装后不要移动或删除该目录。

### 可选：单文件手动安装

在插件目录执行 PowerShell：

```powershell
$agentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME '.pi\agent' }
$extensions = Join-Path $agentDir 'extensions'
New-Item -ItemType Directory -Force $extensions | Out-Null
Copy-Item .\extensions\index.ts (Join-Path $extensions 'pi-edit-fallback.ts') -Force
```

随后 `/reload` 或重启。更新时重新复制入口文件。

**两种安装方式不能混用。** 使用 `pi install` 前必须删除手动复制的入口；改用单文件前必须先 `pi remove <原安装路径>`。不要同时在 `settings.json` 的 `extensions` 字段、命令行 `-e` 或其它自动发现目录中重复加载同一扩展。`pi list` 只列出包声明，不列出手动复制的文件。

### 从旧名 `pi-edit-fellback` 迁移：先卸载，再安装

这是目录、包名、入口文件及测试环境变量的更名，**仅更新源码或执行 `/reload` 不会清除旧安装**。

1. 若以前用 `pi install` 安装：先在仓库根目录执行 `pi remove ./work/scripts/pi/pi-edit-fellback`。如果旧源在其它位置，传入 `pi list` 显示的原路径；项目级安装还需使用 `--local`。
2. 若以前手动复制：删除旧单文件（PowerShell）：

   ```powershell
   $agentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME '.pi\agent' }
   Remove-Item (Join-Path $agentDir 'extensions\pi-edit-fellback.ts') -ErrorAction SilentlyContinue
   ```

3. 检查并移除其它手动配置中的旧路径；若曾混用安装方式，需要分别清理，不能只执行其中一步。
4. 执行上方推荐的 `pi install ./work/scripts/pi/pi-edit-fallback`，然后 `/reload` 或重启。确认 `pi list` 中无旧路径，自动发现目录中无旧入口。

测试环境变量也改为 `PI_EDIT_FALLBACK_INSTALLED`，不再读取旧拼写。

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

### 前置条件与依赖准备

- 单元测试：已验证的 Node.js 24.22.1，可直接运行 TypeScript（类型导入会被擦除），不需要 SDK 或编译器。
- 宿主测试：**完整的 Pi 1.4.0 SDK 安装及其依赖**、Git 和原生 `bash` 工具可用的 shell。SDK 的 `dist/index.js`、相邻 Pi 包、声明文件和 `@types/node` 必须存在；仅复制一个 SDK 入口文件不够。
- `npm run typecheck`：除 SDK 及声明文件外，还需要 **TypeScript 5.9.3**。`PI_TSC` 指向现有 `typescript/bin/tsc`；或让脚本从 PATH / 本地包解析编译器。开启 `strict` / `noEmit`，`skipLibCheck` 仅跳过第三方声明内部检查。
- 默认先检查托管 Pi 安装的当前版本，再尝试本地 SDK 解析。非托管安装或隔离环境请显式设置 `PI_SDK`，指向 `@earendil-works/pi-coding-agent/dist/index.js`。

**Pi SDK、其传递依赖和 TypeScript 可能需要提前联网下载；离线测试不会自动下载依赖。** 以下 PowerShell 示例在联网准备阶段将开发依赖放到仓库外，不影响部署文件；若已有完整 SDK，可直接使用其路径，无需重复安装：

```powershell
$deps = Join-Path ([System.IO.Path]::GetTempPath()) 'pi-edit-fallback-dev-deps'
npm install --prefix $deps --ignore-scripts --no-audit --no-fund typescript@5.9.3 @earendil-works/pi-coding-agent@1.4.0
$env:PI_TSC = Join-Path $deps 'node_modules\typescript\bin\tsc'
$env:PI_SDK = Join-Path $deps 'node_modules\@earendil-works\pi-coding-agent\dist\index.js'
```

这一步需要网络（除非所有依赖已缓存）；不是安装扩展所需的步骤。其它 shell 设置相同环境变量即可。

### 执行

在插件目录执行：

```bash
npm test
npm run test:host
npm run typecheck
```

也可在**联网的开发环境**临时获取编译器：

```bash
npm exec --yes --package=typescript@5.9.3 -- node test/typecheck.mjs
```

该命令可能下载依赖，不能用来声称干净环境离线通过。

宿主测试可用 `PI_EDIT_FALLBACK_INSTALLED` 指向某个已安装入口，进行内容一致性检查；未指定且默认单文件不存在时会明确跳过该可选检查。无论该检查是否跳过，都会在临时 agent / 工作区中执行真实 CLI **install → list → SDK `session.reload()` → remove → list → SDK reload**，校验包声明、加载数量、卸载后恢复原生错误，以及保留源码。另行覆盖单文件自动发现，并在包安装前移除该副本，避免混用。

### 干净环境离线复测与记录

预先设置 `PI_SDK` 和 `PI_TSC` 后执行：

```bash
npm run test:offline -- --report test/results/offline.log
```

脚本在临时目录复制源码（不复制 `node_modules` 或历史结果），使用空 HOME、agent 目录、npm 配置和 npm 缓存，不继承个人凭据。SDK / 编译器是已准备好的外部前置依赖，而非在离线阶段安装。它依次执行上述三个 npm 命令，记录 Node、npm、Pi 和 TypeScript 版本、输出及退出码，失败时返回非零状态。

通过 `PI_OFFLINE=1`、npm offline 和继承到 Node 子进程的网络 API 拦截器禁用网络；先验证 fetch / TCP / HTTPS / DNS 拦截有效，再清零计数并要求测试期间网络尝试为 0。**这是应用层拦截，不是操作系统断网或容器网络沙箱**，不宣称限制任意非 Node 子进程的网络行为。

已完成的版本与通过记录见 [test/results/VERIFICATION.md](test/results/VERIFICATION.md)，完整输出见 [test/results/offline.log](test/results/offline.log)。覆盖 31 项单元测试、真实 Jiti / ExtensionRunner、原生 edit 与 bash 安全补丁、元数据和幂等性、工具 / Schema / System Prompt 不变，以及安装卸载生命周期。

宿主测试使用确定性响应，**未请求任何真实模型**。临时 Git 配置关闭 `core.autocrlf`，不改用户 Git 配置。补丁由测试显式发起，不是扩展自动执行。SDK `session.reload()` 与 TUI `/reload` 共用重载实现，但没有自动操作正在运行的 TUI；当前会话仍需手动重载。未实测真实模型是否始终遵循恢复提示。

## 卸载

推荐安装方式：在仓库根目录执行，然后 `/reload` 或重启：

```bash
pi remove ./work/scripts/pi/pi-edit-fallback
pi list
```

若安装时使用了其它路径，传入同一源路径；项目级安装使用 `--local`。卸载会移除包声明，不删除本地源码。

单文件安装方式（PowerShell）：

```powershell
$agentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME '.pi\agent' }
Remove-Item (Join-Path $agentDir 'extensions\pi-edit-fallback.ts')
```

随后 `/reload` 或重启。无需清理其它扩展状态；扩展不写持久化数据。
