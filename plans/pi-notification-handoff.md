# pi-notification 工作交接（当前状态 / 下一步）

> 用途：**新对话做后续开发时先读这一份**，不必重读 1100 行设计文档。
> 权威设计：`plans/pi-notification-plugin-design.md`（v1.2）。
> 用户面向文档：`work/scripts/pi/pi-notification/README.md`（含 40 条断言表与"未验证项"清单）。
> 代码：`work/scripts/pi/pi-notification/`（实现 2165 行 + 测试 1609 行，零第三方依赖）。
> 分支/工作区：`D:/XuKai/Project/myflow`，`work/scripts/pi/pi-notification/` 为未跟踪新目录。

---

## 1. 已完成（MVP 收尾）

| 阶段 | 内容 | 证据 |
|---|---|---|
| S1 骨架 | `types` / `lifecycle` / `rules`（纯函数）/ `service` / `providers/{registry,noop,debug}` | 40 条断言全绿 |
| S1.5 回归 | `test/host-lifecycle.mjs`（A–K）、`test/cli-smoke.mjs`（G–K）、`test/terminal-channel.mjs` | `npm test` → 0 失败 |
| S3 终端渠道 | `providers/terminal.ts`：OSC 777 / OSC 99 / Windows toast + 平台探测 + 注入面加固 | Windows toast 已由开发者肉眼确认收到 |
| S5 最小配置面 | `config.ts`：默认值 / 用户级+项目级读盘 / 严格校验 / **降级而非静默全关**；`commands.ts`：`/notify status|test`；`--no-notify` | I1–I11、J1–J4、CLI I/J/K |

`/notify test` 与 `/notify status` 可用；Windows toast 走**生产代码路径**实发成功。

## 2. 尚未做（按建议顺序）

| 顺序 | 内容 | 关键约束/依据 | 规模估计 |
|---|---|---|---|
| 1 | **S4 可靠性：冷却/合并** | 设计 §10.2 `coalesce.{windowMs:1500, cooldownMs:3000}`、§12.1 第 5 步（service 负责"门槛与过滤"）、§13 第 1/2/4 项 | 小（service.ts + config 校验 + ~4 条断言） |
| 2 | **S6 工具失败 / 压缩失败 / 等待输入** | §12.3（聚合成一条，去重键 `sessionId+toolName`）、§12.4 + §18.5 修订 1（**`ui_prompt_*` 必须白名单 select/confirm/input/editor，永久排除 `custom`**；嵌套 prompt 不产生内层 span 且 `kind` 报的是外层；`session_shutdown` 必须兜底重置 waiting）、§18.4 第 3 项 | 中（新增 `tool_execution_end`、`session_compact_failed`、`ui_prompt_*` 3 个 hook + 事件累积器） |
| 3 | **S7 Webhook**（检验 §17.3 抽象的第一次真正测试） | §17.4 差异表（`validate` 校验 URL + **只存 secret 的环境变量名**）、§13 第 2/16 项（超时、脱敏） | 中（新增 `providers/webhook.ts` + `decorators.ts`；**`lifecycle`/`rules`/`service` 的 diff 必须为 0**） |
| 4 | 配置写盘 + 向导（`/notify on|off|config`） | §10.3 原子写：先校验 → 临时文件 `0o600` → `rename` → 失败保留原文件 | 中 |
| 5 | macOS 原生横幅（`osascript`） | §17.1 备注；当前 darwin 只走 OSC 777（Apple Terminal 不显示） | 小 |

**明确不做**（设计已裁定，别顺手加）：Chain of Responsibility、Abstract Factory、事件总线做渠道通信、持久化 outbox、exactly-once、`input` handler（§18.5 修订 6）、重名注册劫持、`pi.registerProvider`（那是模型服务商）。

## 3. 不能回退的 5 条硬约束（都有实测依据，改前先看 §18.4）

1. 完成判定只认 `agent_settled`，**不注册 `agent_end`**（一次 provider 失败实测 4 条 `agent_end` / 1 条 settled）。
2. `agent_settled` handler **只入队后立即返回**，**handler 体内零 `await`**（实测：内 await 2000ms → 下一次 run 推迟 2027ms）。
3. `session_shutdown` 内投递带短超时（现 `shutdownFlushMs=200`）。
4. 旧实例在 `session_shutdown` 之后不得再产生任何结论（`reload` 会重建实例）。
5. 投递前一律清洗控制字符；**写 stdout 的渠道必须先确认 `stdout.isTTY`**。

## 4. 实施期新增的 4 条实测发现（设计文档里没有，务必保留）

1. **`sanitize()` 是整段删除转义序列（含载荷）**，不是只删控制字符。
   `sanitize("\x1b]777;notify;a\x07b")` ⇒ `"b"`（不是 `"a b"`）。
   理由：只删 `\x1b`/`\x07` 会把 `]777;notify;a` 留成可见正文，等于给伪造通知提供素材。
2. **TTY 纪律**：OSC 必须先确认 `stdout.isTTY`，否则会污染 `pi -p` / `--mode json` 的输出。
   唯一例外：显式 `PI_NOTIFY_CHANNEL=toast`（toast 不碰 stdout）。
3. **Shell 会把带空格的 prompt 拆成多条用户消息**（`spawn(..., {shell:true})` → cmd.exe）。
   Pi 会**真的**跑多次运行、产生多条通知。测试因此改为直接 `node <pi>/dist/bundle/cli.js`（与 `pi` 壳脚本等价、无 shell）；README 已把这条写成用户可见的边界。
4. **SDK 下不调 `session.bindExtensions({...})` 则 `session_start` 完全不触发**（`agent-session.js:2333` 的 `hasBindings` 守卫）。
   同时 `getAgentDir()` 是**动态**读 `PI_CODING_AGENT_DIR` → 测试可以按 host 隔离用户级配置。

## 5. 回归测试的使用方式（改任何代码后必跑）

```bash
cd work/scripts/pi/pi-notification
MSYS_NO_PATHCONV=1 npm test        # 三条脚本，40 条断言，全离线、零 LLM、不弹真通知
```

`MSYS_NO_PATHCONV=1` 是硬约束（否则 `/probe-cmd` 被改写成 Windows 路径 → 命令静默退化成 prompt 并真调模型）。

三条脚本的分工（新增断言时放对位置）：
- `test/terminal-channel.mjs`：不需要 SDK，纯函数与注入 IO（渠道选择/渲染字节/注入面/TTY 纪律）
- `test/host-lifecycle.mjs`：真实宿主会话（判定/去重/阻塞/reload/配置/命令）；**每个 host 独立 agentDir + 独立日志文件**（跨 host 共享游标曾导致 3 条假失败）
- `test/cli-smoke.mjs`：真实 `pi` 进程（含"stdout 不得被转义序列污染"）

测试纪律：`agent_settled` 只入队 → 投递是异步的 → 读日志前必须等落地（`host.drain()`）。

## 6. 环境注意

- **本机是 Windows + Git Bash**，标准输出是管道 ⇒ `selectTerminalChannel` 在测试里会返回 `none`；
  `host-lifecycle` 因此强制 `isTTY=true` 并用 `PI_NOTIFY_CHANNEL=osc777` **钉住机制，避免自动化弹真通知**，
  同时把通知序列从转发副本里剔除，防止打到开发者终端。
- 仓库**不允许安装依赖**，也**没有 `tsc`** ⇒ 类型未经编译器校验（README 已如实记录）。
- 不要修改仓库根 `README.md`、`plans/archive/`，也不要动工作区里既有的删除态文件。

## 7. 待用户确认的小事

1. 仓库根 `README.md` 的插件清单**尚未加入 pi-notification**（那份文件当前处于 modified 状态，改动不是本次产生的）。要不要加一行？
2. `plans/pi-notification-plugin-m1.md` 是里程碑 1 的计划，现已过期（只描述了 S1）。建议下次进入 plan mode 时**改写为里程碑 2 计划**（S4 或 S6），而不是新增文件。
3. 设计文档里的 `providers/*` 命名与当前实现一致（`terminal`/`debug`），S7 新增 `webhook` 后需同步 §7 目录结构与 §17.4 差异表。
