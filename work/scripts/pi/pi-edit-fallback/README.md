# pi-edit-fallback

Pi 的 edit 错误恢复提示扩展。当原生 `edit` 因 `oldText` 匹配多处而失败时，扩展在原错误后附加恢复步骤，帮助 Agent 重新定位文本。扩展入口是 `extensions/index.ts`，通过一个同步 `tool_result` handler 处理结果。

## 安装与加载

扩展无运行时依赖，宿主直接加载 TypeScript。在本插件目录执行 PowerShell：

```powershell
pi install .
pi list
```

已有 Pi 会话执行 `/reload` 或重启。插件使用本地源码引用，后续加载依赖目录位置。它随 edit 错误自动生效，配置与命令均由原生工具继续提供。

也可在插件目录将单文件复制到用户扩展目录：

```powershell
$agentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE '.pi/agent' }
$extensionDir = Join-Path $agentDir "extensions"
New-Item -ItemType Directory -Force $extensionDir | Out-Null
Copy-Item -LiteralPath ./extensions/index.ts -Destination (Join-Path $extensionDir "pi-edit-fallback.ts") -Force
```

每次保留一种加载来源，更新单文件时重新复制。切换安装方式先移除原包声明或副本；`pi list` 展示包声明，手动副本需检查扩展目录。

### 旧名称迁移

旧名为 `pi-edit-fellback`。包安装使用 `pi remove` 和原安装路径卸载，项目级安装加 `--local`；单文件安装删除 agent 目录中的 `extensions/pi-edit-fellback.ts`。同时检查其它手动配置中的旧路径，再安装新目录并重载。仅重载保留旧安装声明。

宿主测试的已安装入口核对变量为 `PI_EDIT_FALLBACK_INSTALLED`。

## 输入与结果

输入满足以下条件时，`enhanceEditFailure` 返回增强结果：工具名为 `edit`、`isError` 为 true，且文本块包含多次匹配或非唯一性诊断。支持单项与批量 `edits[n]` 的原生错误，以及 `oldText must be unique`、`oldText matches multiple locations` 等诊断片段。

输出保留全部原内容块，在末尾追加独立英文文本块，并显式返回 `isError: true`、`details`、`usage`、`structuredContent`。任一文本块已有 `Edit recovery:` 时，返回原结果；每次判断只依赖本次输入。成功结果、其它工具结果和其它 edit 错误沿用原生处理。

恢复提示要求先重读相关文件，增加唯一上下文后重试；仍歧义时，用现有 bash 工具准备标准 unified diff，先执行 `git apply --check`，通过后再应用并核对结果。目标范围明确且无关改动得到保留时才应用补丁，后续编辑继续使用原生 edit。完整英文提示维护在入口文件的 `EDIT_RECOVERY` 常量。

提示由 Agent 阅读并决定后续动作。扩展自身只处理内存中的错误结果；文件修改、子进程与恢复验证由调用方执行。工具声明、System Prompt 和额外 Agent 轮次均不受扩展修改。供应商缓存命中率与真实模型遵循提示的情况尚未实测。

## 测试

在插件目录执行 PowerShell：

```powershell
npm test
npm run test:host
npm run typecheck
```

单元测试由 Node 直接运行，已在 Node.js 24.22.1 验证。宿主测试需要完整 Pi SDK、Git 和原生 bash 所需的 shell；`PI_SDK` 指向 SDK 的 `dist/index.js`。类型检查另需预先准备 TypeScript，`PI_TSC` 指向 `typescript/bin/tsc`。两项环境变量均可在 PowerShell 中通过 `$env:PI_SDK` / `$env:PI_TSC` 设置为实际绝对路径；`test/sdk.mjs` 也会尝试定位 Pi 托管安装及本插件可解析的 SDK。

宿主测试检查真实 edit 与 bash、结果元数据、幂等性、工具声明及 System Prompt，并在临时 agent 中运行 CLI install/list/remove 与 SDK reload。`PI_EDIT_FALLBACK_INSTALLED` 可指定已安装入口进行一致性核对；缺少个人副本时跳过这项可选核对，隔离安装测试照常执行。

准备好 SDK 与 TypeScript 后，可将本次离线结果写到独立报告路径：

```powershell
npm run test:offline -- --report test/results/offline-current.log
```

脚本复制源码到临时目录，使用空 HOME、agent、npm 配置与缓存，依次运行单元、宿主和类型检查。Node 网络 API 拦截器先自检，再要求测试期间网络尝试为零；这是应用层拦截。所需 SDK、传递依赖和编译器在离线阶段前准备。

原 Pi 1.4.0 / Node.js 24.22.1 / Windows x64 的隔离验证与 TypeScript 5.9.3 结果保存在本插件的[验证报告](test/results/VERIFICATION.md)和[原始日志](test/results/offline.log)。SDK reload 验证的是重载实现，交互式 TUI 与真实模型行为分别需要实际会话验证。

## 卸载

包安装在本插件目录执行 `pi remove .`，再重载或重启；其它源路径按原路径移除，项目级安装加 `--local`。本地源码保留。单文件安装删除 agent 目录中的 `extensions/pi-edit-fallback.ts`，再重载。扩展状态仅存于当前调用，无持久化清理项。

## 许可证

MIT，见 [LICENSE](LICENSE)。
