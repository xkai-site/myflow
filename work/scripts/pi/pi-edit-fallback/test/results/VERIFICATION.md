# pi-edit-fallback 验证记录

## 环境与执行

- 时间：2026-10-31T02:20:59.218Z（UTC，取自测试进程）。
- 基于提交：`02889eccfc700cbb8418af3fa66c4713a9b9787c`，验证的是更名及修复后的工作区。
- 系统：Windows x64（`win32/x64`）。
- Pi：**1.4.0**（完整的预安装 SDK 及其依赖）。
- Node.js：**24.22.1**。
- npm：**11.19.1**。
- TypeScript：**5.9.3**（先在仓库外准备，离线阶段用 `PI_TSC` 指定）。
- Git 和 Pi 原生 bash 工具所需的 shell 已存在。

在插件目录、设置好 `PI_SDK` 和 `PI_TSC` 后执行：

```bash
npm run test:offline -- --report test/results/offline.log
```

完整输出：[offline.log](offline.log)。日志中的 `<clean-room>` 和 `<pi-sdk>` 是对实际绝对目录的脱敏替换。

## 结果

| 命令 | 结果 |
|---|---|
| `npm test` | 退出码 0；31 项通过，0 失败，0 跳过 |
| `npm run test:host` | 退出码 0；真实 SDK、原生 edit / bash 及包生命周期断言通过 |
| `npm run typecheck` | 退出码 0；TypeScript 5.9.3，Pi 1.4.0 API，strict / noEmit |
| 总体验证命令 | 退出码 0 |
| 网络拦截自检 | fetch、TCP、HTTPS、DNS 四项均被拦截；随后清零计数 |
| 正式测试网络尝试 | 0；包括 npm 和 CLI 的 Node 子进程 |

宿主生命周期使用独立临时 agent 与工作区，并按以下顺序执行：

1. `pi list` 确认初始没有包。
2. 真实 CLI `pi install <临时源码目录>`；验证 `settings.json` 恰有一个包声明。
3. `pi list` 确认包存在；不存在单文件副本。
4. SDK 从包 manifest 加载，断言实际入口路径就是测试源码、加载数量为 1。
5. 真实原生工具验证后执行 `session.reload()`：运行时更新，扩展仍为 1 个，恢复提示不叠加。
6. 真实 CLI `pi remove <同一目录>`；断言包声明变为空，`pi list` 无包。
7. 再执行 SDK reload：扩展数量为 0；相同歧义编辑失败不再附加恢复提示；源码仍存在。

另行验证单文件自动发现，随后先删除该副本再进行包安装。干净环境中没有个人单文件安装，因此日志里的个人入口一致性检查明确标记为 `SKIP`；**包安装、加载、重载和卸载均实际执行，没有跳过**。

## 隔离与边界

- 测试源码复制到新临时目录，不带项目 `node_modules` 或历史结果。
- HOME / USERPROFILE、agent、session、npm 配置与缓存均使用空临时目录；不继承个人凭据或配置。
- SDK / SDK 传递依赖及 TypeScript 是已准备好的外部前置依赖；不把“零依赖环境”与“离线执行”混为一谈。
- 设置 Pi offline、npm offline，预加载 Node 网络 API 拦截器并传递给 Node 子进程；被调用后即记录并抛错，即使调用方吞掉错误也会导致最终校验失败。
- 这是应用层网络拦截，**不是操作系统断网、VM 或容器网络隔离**，不宣称限制任意非 Node 子进程的网络行为。
- 无真实模型请求。重载验证使用 TUI `/reload` 共用的 SDK 实现，未自动操作交互式 TUI。
- 临时 Git 配置不改个人 Git 配置，临时目录执行后清理。

## 本机迁移（与隔离测试分开）

同日另行完成用户级安装迁移：旧 `pi-edit-fellback.ts` 在自动发现目录外临时备份后删除，再执行推荐的 `pi install ./work/scripts/pi/pi-edit-fallback`。检查确认旧包声明及旧入口均不存在，新包恰有一份声明，也没有新名单文件副本。其它包声明保留。**正在运行的 Pi 会话仍需 `/reload` 或重启后生效。**

## 被验证文件的 SHA-256

路径相对于插件目录，用于将记录关联到本次实际运行的源码（文档和结果日志不包含在内）：

```text
3331af637e3c3d9d5d341d1294e361b6bf38b11a571aab5b20e84703fda80301  extensions/index.ts
a46d5c0195f1d0b1389eb8ca649237a6d989c45bd65ba63b6b947f337cb53e9c  package.json
59c4561f10924fbaa09ba177af878e7c3e782773b58aae98e98b0cf33197d445  test/host.mjs
e43a0e93cbf079099adcf3733eddbca3b42f5d98446055aae7b5669d51baf8f9  test/offline.mjs
4f20d0b79b2b0d5d0e827589ac464e16c0acd0292b25c1ff413e7374d14a87a0  test/offline-guard.cjs
d134d88f9043bdac0b34c2ed66cf7f6ff38b8bf61f8af1cea19e22b6d8dbbd9a  test/recovery.test.ts
e83d453269b9be1c38ec3c532716b681101235e76352d3c76c0b2b1d27b50acc  test/sdk.mjs
3e08dbfe05f3ba8eab6748acab1d7ba4b2a6e458f636685c88a0eddf29a548cc  test/typecheck.mjs
```
