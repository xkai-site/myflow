# pi-notification

Pi 扩展：**在一次 agent 运行真正结束时**（而不是每次底层 run 结束时）产生一条**终端、Webhook 或邮件通知**，可配置、可关闭。

设计方案与全部实测依据：`plans/pi-notification-plugin-design.md`（v1.2，§17 渠道抽象、§18 实测修订）。
交接与后续计划：`plans/pi-notification-handoff.md`、`plans/pi-notification-plugin-m2.md`。

> 当前进度：**MVP + S4 + S6 + S7 + M3-1/M3-2 + M4 + UX-1 已完成** —— 新增 `quietHours` 静默时段、
> **S5 完整配置面**（原子写盘）、**M4 内容字段**（会话名 / 成本本次+累计 / 上下文占比 / assistant 摘录）、
> **UX-1 通知设置**（单一入口 + 分类列表 + 内联当前值/用户默认 + Ctrl+S 单项固化）。
> 尚未做：macOS 原生横幅（`osascript`）、Gmail OAuth/API、Telegram/Discord/Slack 专用 provider、通知历史
> （详见下方「当前能力与缺口」与 `plans/pi-notification-handoff.md` §2）。

---

## 为什么不是 `agent_end`

官方文档明确：`agent_end` 之后 Pi 还可能**自动重试**、**自动压缩后重试**、或继续处理**排队消息**。
一次 provider 失败在实测中产生了 **4 条 `agent_end`**，但只有 **1 条 `agent_settled`**。
更糟的是 `agent_settled` 本身**也不等于成功**——用户按 Esc 会被 settle、provider 报错也会 settle。
所以判定必须“出口用 `agent_settled`，语义用最后一次 assistant 的 `stopReason`”：

| 最后 stopReason | 判定 | 默认是否通知 |
|---|---|---|
| `stop` / `toolUse` | completed | ✅ info |
| `length` | completed（**输出被截断**） | ✅ 强制 `warning`，标题写明截断 |
| `error` | failed | ✅ error |
| `aborted` | aborted | ❌ 默认关（人就在终端旁） |
| 拿不到（`pending` / `deferred` / 无 assistant） | unknown | ❌ 默认关（宁可少发不误报） |

**一次运行最多一条通知**：同一「逻辑运行」（`sessionId + runId`）内的多条事件会被合并窗口吸收；
同一 `kind` 的两次通知之间有冷却窗口。工具失败的名字并入结果通知正文，而不是另发一条。

---

## 安装

推荐装在**用户级**（`~/.pi/agent/extensions/`）而不是项目级：项目级 `.pi/extensions` 在未信任的项目里
**静默不加载**，且恒晚于 CLI 扩展加载。

```bash
# 推荐：装到用户级（写 ~/.pi/agent/settings.json 的 packages，**不复制文件**，改代码即生效）
pi install /abs/path/to/work/scripts/pi/pi-notification
# Windows/Git Bash 示例：
#   pi install "D:\XuKai\Project\myflow\work\scripts\pi\pi-notification"
pi list                     # 确认已登记
pi remove <同一个路径>       # 卸载（只删登记，不删你的代码）

# 临时试用：只对本次运行生效，不动任何配置
pi -e work/scripts/pi/pi-notification/extensions/index.ts
```

装完确认一下：TUI 里跑 `/notify`，应看到「通知设置」首页（分类导航，不平铺全部字段），底部常驻 `Ctrl+S 保存为默认`。
想直接确认开关状态就按 `Ctrl+O` 看状态与诊断里的 `pi-notification: 开启/关闭`。
`PI_NOTIFY_LOG_FILE` 可临时打开诊断记录（能直接看到 `plugin_session_start` 的 `enabled`/`providers`/`degraded`）。

本插件使用 Nodemailer（MIT-0）实现 SMTP 邮件发送；HTTP Webhook 用 Node 内置 `fetch`。也不注册模型 provider、不注册
`tool_call` / `input` / `session_before_*`。

---

## 配置

### 三层值（只有这三层）

| 层级 | 位置 | 谁能改 |
|---|---|---|
| 出厂默认 | 代码内置（`defaultConfig()`） | 不可改 |
| **用户级默认** | `~/.pi/agent/pi-notification/config.json` | 只有设置界面里的 **Ctrl+S** |
| **本对话选择** | 会话文件里的 `notify-session-overlay` 条目 | 设置界面里 Enter |

生效值 = 出厂默认 → 用户级默认 → 本对话选择（逐字段覆盖）。

**没有项目级配置**（UX-1 删除）：`<项目>/.pi/pi-notification/config.json` 即使存在也不会被读。
需要“这个项目少打扰”就 Ctrl+S 固化用户默认，或在会话里临时改（只对本对话有效）。

两份容易混淆的口径：

- **用户级默认文件是稀疏的**：只包含 Ctrl+S 固化过的字段，没碰过的字段永远跟随出厂默认
  （旧版本会把整份快照写进去，把当时的默认值钉死；现在不会）。
- **本对话选择不落用户文件**：Enter 改的值写进会话条目（`pi.appendEntry`），`/reload`、
  退出后 `/resume` 恢复同一对话时仍在；`/new`、`/fork` 出来的新对话**不继承**
  （fork 会复制旧条目，插件按条目里的 `sessionId` 过滤）。

`--no-notify` / `PI_NOTIFY_DISABLE=1` 是**会话级强制静默**：界面会把它作为“额外限制”显示（不冒充用户默认关闭），
不允许把总开关打开，也不会把“强制关闭”写成用户默认。

下面这块是**出厂默认的完整形状**（也是降级/校验的基准）。你的用户文件不需要长这样——
它只会包含被 Ctrl+S 固化过的字段（例：只按过一次 Ctrl+S 在「运行完成 · 开关」上，文件就是
`{"rules":{"runCompleted":{"enabled":false}}}`）。想手工改就编辑 JSON，删掉某个字段就等于回到出厂默认。

完整可配字段（含默认值）：

```jsonc
{
  "version": 1,
  "enabled": true,                       // 总开关
  "minLevel": "info",                    // "info" | "warning" | "error"

  "rules": {
    "runCompleted":  { "enabled": true,  "level": "info",    "channels": ["terminal"] },
    "runFailed":     { "enabled": true,  "level": "error",   "channels": ["terminal"] },
    "runAborted":    { "enabled": false, "level": "info",    "channels": ["terminal"] },

    // 工具失败：aggregate（默认）= 并入本次运行的结果通知；
    //            immediate = 某工具失败达到 threshold 时立刻提醒（长任务里没人盯着终端）
    "toolFailed":    { "enabled": true,  "level": "warning", "channels": ["terminal"],
                       "mode": "aggregate", "threshold": 1 },

    "compactFailed": { "enabled": true,  "level": "error",   "channels": ["terminal"] },

    // 等待用户输入：与 runCompleted 高度重叠，默认关闭；`custom` 永久排除（见下）
    "waitingForUser":{ "enabled": false, "level": "info",    "channels": ["terminal"],
                       "kinds": ["select", "confirm", "input", "editor"] }
  },

  // 合并/冷却（0 = 关闭该项过滤）
  "coalesce": {
    "windowMs": 1500,             // 同一「逻辑运行」内只放行一条通知
    "toolFailureWindowMs": 10000, // immediate 模式下把并行失败聚合成一条的窗口
    "cooldownMs": 3000            // 同一 kind 两次通知的最小间隔
  },

  // 本地时间，左闭右开；跨午夜；相同端点表示全天
  "quietHours": { "enabled": false, "start": "23:00", "end": "08:00", "exceptLevels": ["error"] },

  "content": {
    "includeDuration": true,           // 时长
    "includeToolFailureNames": true,   // 工具失败名（关掉只给数量）
    "includeSessionLabel": true,     // 标题窗口标识：会话名（/name）→ 未命名时用项目目录名
    "includeCost": true,               // 成本（本次+累计）与上下文占比
    "includeAssistantExcerpt": false,   // **默认关**：assistant 回复前 10 字，可能带出文件内容/密钥
    "maxMessageChars": 300
  },

  "delivery": {
    "timeoutMs": 30000,           // 单次投递的总预算（超时算失败）
    "maxRetries": 1,              // 额外重试次数（指数退避；每次尝试有自己的 deadline）
    "concurrency": 1,          // 同时处理的通知数
    "channelConcurrency": 4,   // 同一通知最多并行投递的渠道数（1..8）
    "queueLimit": 50,
    "circuitBreakerFailures": 3   // 连续失败多少次后熔断该渠道（30s 后放行一次探测）
  },

  "providers": [
    { "id": "terminal", "type": "terminal", "enabled": true, "options": {} },
    { "id": "email", "type": "email", "enabled": false,
      "options": { "transport": { "type": "smtp", "profile": "qq" }, "from": "", "to": [], "subjectPrefix": "[Pi]" } },
    { "id": "hook", "type": "webhook", "enabled": false,
      "options": {
        "url": "https://example.invalid/hook",   // 只允许 http/https，且不得内嵌凭据
        "secretEnv": "PI_NOTIFY_WEBHOOK_SECRET", // **只存环境变量名**，不存明文
        "headers": {}                            // 可选附加请求头
      } }
  ],

  "shutdownFlushMs": 200          // quit 时允许等待收尾投递的预算
}
```

### 只想每次运行都收到通知？

把两个过滤关掉即可（`coalesce` 里两个 0）。默认值是为了防刷屏：
用户连点两次、或一次输入触发了多次运行，默认只会收到一条。

### 静默时段

`quietHours` 默认关闭。启用后按**本地时间**判定 `[start,end)`：`23:00–08:00` 跨午夜，
23:00 起静默、08:00 起恢复；`start === end` 表示全天。时间必须严格为两位 `HH:MM`，
范围 `00:00–23:59`；`exceptLevels` 是去重后的等级数组（默认 `error`，可设 `[]`）。
顺序：总开关/等级门槛 → 去重 → **静默时段** → 合并/冷却 → 入队。静默不会推进合并/冷却窗口，
会留下 `quiet_hours_drop` 诊断记录；已入队/在途的通知不会因进入静默时段被撤回。
`Ctrl+O` 的状态与诊断页显示时段是否当前生效；底部 `Ctrl+T` 自检绕过静默并提示，但仍受总开关和等级门槛约束。静默时段关闭时，界面把时间与例外收起为可展开的一行。

### 设置界面（`/notify` 是唯一入口）

```
/notify            # 打开通知设置（非 TUI 只打印状态与配置路径，不写盘）

↑↓ 移动焦点 · Enter 打开/选择 · Space 快速切换 · Esc 返回上一级 · ? 字段详情
底部按焦点类型常驻可用键；Ctrl+S 保存为默认 保留 Ctrl+T 自检 · Ctrl+R 重读 · Ctrl+O 状态与诊断
```

首页固定基础字段和分类入口，不平铺全部字段；分类行带一行摘要：

```
通知设置

  启用通知               开启
  通知门槛               所有等级
→ 通知规则               4 类已开启 ›
  通知内容               耗时、会话名等 ›
  免打扰                 未开启 ›
  通知渠道               1 个已启用 ›
  高级设置               频率限制与投递 ›
  发送测试通知
  状态与诊断 ›
  搜索设置
```

- **导航**：Enter 打开分类/规则/字段，Esc 返回上一级并恢复父级焦点与滚动位置；首页 Esc 关闭。
  状态页、自定义输入页、字段详情 `?` 都从同一导航栈返回原入口，不一律回首页。
- **通知规则**分类里每个事件一行（`启用 · 严重程度 · 渠道`），进入后是该事件的开关、严重程度、渠道
  与事件专属参数（工具失败的策略/阈值、等待输入的类型）；**规则关闭也能进入配置**，页面写明“启用后生效”。
- **Space 快速切换**：布尔字段就地开关；集合/复杂字段改为打开候选列表；分类、动作、信息行不响应 Space。
- **免打扰关闭时收起**时间与例外，只留一个可展开行（“静默时间与例外 · 启用后生效”），字段仍可达；
  启用后时间与例外直接平铺。
- **工具失败聚合窗口**（`coalesce.toolFailureWindowMs`）只在 `immediate` 模式下出现：
  `aggregate` 模式它不产生任何效果，就不展示；它两模式都用于 fallback 判断的 **阈值不随模式隐藏**。
- **状态与诊断**是可翻页页面，首行是可见动作“重新读取配置”（等价 Ctrl+R），其余为只读状态文本。
- 显示全部中文化（`开启/关闭`、`所有等级/警告及错误/仅错误`、`并入结果/立即提醒`、时长用秒/毫秒），
  但配置键、枚举值和单位仍是原文，界面只改展示。
- 行首 `→ ` 是焦点通道，紧接的 `✓ ` 是候选项的当前值通道：两者独立，可同行共存。
- 值列紧邻名称；窄屏先省略摘要/来源，再截断标签，字段详情 `?` 里保留完整信息。
- 列表里没有统一勾号，也没有重复的“未保存”；未保存过只在字段详情里写成“用户默认：未设置（跟随内置默认）”。
- 候选项行尾 ` · 默认` 是用户级默认通道；一个都没有说明还没按过 Ctrl+S。
- 布尔字段是 `开启`/`关闭` 两个候选项；集合字段（渠道、等待类型、静默例外等级）可多行同时带 `✓ `。
- 数值/时间字段＝预设候选 + 末尾 `自定义…`（选中后就地输入、写明单位与范围，走同一套校验，非法值不写入）。
- 渠道只能开关；`options`（URL / `secretEnv` / headers）仍然只编辑 JSON，界面从不显示也不写凭据。

**反馈文案**：每次 Enter/Ctrl+S 都会写明**配置项名称、当前值、作用范围**与失败结果。

```
Enter：  已应用（仅本对话）「通知规则 · 运行完成 · 开关」= 关闭；Ctrl+S 可设为以后默认
Ctrl+S： 已保存为默认「通知规则 · 运行完成 · 开关」= 关闭（作用范围：以后默认；<用户文件路径>）
失败：   保存失败「基础 · 启用通知」：用户文件未改动（…）
```

**Ctrl+S 的语义**：把**该字段已经生效的值**固化为用户级默认——不是光标悬停但尚未选中的候选值；
分类、规则、动作、信息、状态页和自定义输入页都不会触发保存（自定义输入要先 Enter 应用，再保存）。
触发后 ` · 默认` 迁到当前值那一行，同时状态行给出上面那次确认；写盘失败则标记不迁、当前值仍生效、状态行报错。

**可解释状态**：首页/状态页直接说明送达前提——总开关与等级门槛、免打扰是否生效、
渠道启用数（0 时显示“无启用渠道”，状态页写明“没有启用的渠道，通知不会到达任何地方”）；
**“规则开启”只表示通过筛选，不代表一定送达**。

**渠道保存隔离**：`providers` 是数组字段，写盘时整体替换，所以 Ctrl+S 一个渠道开关时，补丁会
**从原始用户文件重建整份数组**，只改目标渠道的 `enabled`；其他渠道的本对话选择、`options`、未知字段
与顺序都原样保留（不会把“本对话临时关掉另一个渠道”固化进去，也不会把出厂 `options` 冻结到用户文件）。
只存在于出厂默认里的渠道会补一条最小条目（`id`/`type`/`enabled`）。仅保存邮箱字段产生的 email-only 稀疏列表在加载时仍继承内置本机渠道；若只要邮件通知，请显式关闭 `terminal`，不要通过省略它来关闭。

**强制静默是额外限制**：`--no-notify` / `PI_NOTIFY_DISABLE=1` 生效时，界面在列表下方常驻一行
“额外限制：强制静默（原因）—— 会话级限制，覆盖开关，不代表你的默认被关闭”，
字段详情里同样写明；它不会把总开关显示成“用户默认关闭”，也不允许把总开关打开或写成用户默认。

- **搜索**：首页“搜索设置”或 `/` 打开，按中文名称、分组、内部配置 ID、渠道 ID 与输入提示筛选。
  结果携带路径，能定位到高级或已收起的字段（含当前不生效的字段）；打开只定位与预配置，
  **不会为了定位自动开启功能**，不生效的字段在列表与 `?` 详情里注明“尚未生效”及原因。
- **通知预览**在“通知内容”分类里：用固定示例数据生成正文示意，标注“示例（不会发送）”，
  不读真实对话、不外发、不提交 service；实际能否送达另行说明。
- **恢复（仅单项）**在字段详情 `?` 的动作区：`a`“沿用以后默认”只清除此项本对话覆盖；
  `d`“恢复此项内置默认”进确认页（展示字段、当前值与恢复后的值，**默认焦点是取消**），
  确认后同时清除此项用户默认与本对话覆盖。不提供分类/全局恢复。
- **恢复的隔离与安全**：删除只影响目标项，删空祖先对象但不删旁支；渠道按 provider ID 只删 `enabled`，
  保留定义/`options`/未知字段/其他渠道。写盘失败不提前清除会话值；损坏的用户文件拒绝覆盖；
  取消确认零写入；重复恢复幂等。若恢复总开关的内置默认是开启但当前被强制静默，
  明确“默认已恢复，当前仍强制静默”，不绕过启动限制。
- **空 overlay 不复活**：清空最后一项时仍会持久一个空快照，“已清空”因此是一个可恢复的状态；
  `/reload`、退出后 `/resume` 不会把旧覆盖重新变回；`/fork`、`/new` 的新会话本来就不继承（按 sessionId 过滤）。
- **状态与诊断**分开表达：配置阻止（降级）、当前是否静默、自检的“已提交”、以及实际投递统计；
  “已提交”不等于“已送达”，状态页直接说明送达前提。

### 写盘与热重读

写盘只发生在 Ctrl+S：按“原文件 + 本次补丁”合并出**稀疏**结果 → `mergeConfig` 严格校验 →
独占创建同目录临时文件（`0o600`）→ 关闭后原子 `rename`。失败保留原文件、内存态不回滚，临时文件尽力清理。
拒绝写入损坏的用户文件（否则会把安全降级结果固化成用户默认）。
Windows 的 POSIX mode 不代表 ACL 隔离，测试仅验证创建/替换不报错。
`Ctrl+R` 只重新读盘/校验并更新配置与渠道缓存，不重建扩展/生命周期；坏配置仍按下节降级。

### 通知正文里有什么

通知按“状态 → 项目/会话”组织标题，正文优先给异常与成本，再给耗时和上下文；正文整串仍受 `maxMessageChars` 限制。例：

```
标题：任务完成（含工具失败） · 重构登录
正文：结果含工具失败 1 次：bash · 本次成本 $0.0123 · 当前会话已知累计 $0.0456 · 用时 42.3s · 上下文 42%
```

标题会优先显示 `/name` 设置的会话名，否则显示项目目录名；通知不会暴露 session ID。多个窗口若在同一项目下运行，建议分别用 `/name 前端修复`、`/name 后端测试` 命名，便于识别来源。成本严格取 Pi 上报的 `usage.cost.total`：运行时没上报会明确显示“未上报”，不会误显示成免费；运行时明确报 `$0` 时会显示 `$0.0000`。累计口径仅覆盖当前扩展实例；只有窗口内每条 assistant 消息都上报成本时才显示累计值，缺一条就标为“未上报”，避免把部分金额冒充总额。重载后重新累计。

失败时标题为「任务未完成」，正文以「失败原因：」引出已脱敏错误；达到输出长度时标题为「输出已截断」，正文说明已达长度上限并建议检查末尾、决定是否继续。邮件与本机通知复用同一标题/正文（邮件主题额外带前缀）；默认不附 AI 回复摘录，避免把文件内容或敏感信息发出。

标题人类可读标识的取值顺序是 **会话名（`/name`）→ 项目目录名（`ctx.cwd` 的 basename）→ 两者都无则省略**；不附加内部 session ID。

| 字段 | 默认 | 语义 |
|---|---|---|
| `includeDuration` | 开 | 本次运行时长 |
| `includeToolFailureNames` | 开 | 失败工具名；关掉只给“工具失败 N 次” |
| `includeSessionLabel` | 开 | 标题附人类可读窗口标识：会话名优先，未命名时回退项目目录名；关闭后仍不显示 session ID |
| `includeCost` | 开 | `本次成本 <本次>` + `当前会话已知累计 <已上报累计>`；未上报时明确标注；另加 `上下文 <占比>%` |
| `includeAssistantExcerpt` | **关** | assistant 最终回复的**前 10 个字**（先清洗、再截断；真截断时标 `…`） |

五条边界（都是刻意的）：

1. **成本不猜**：Pi 没有上报 `usage.cost.total` 时明确显示“未上报”；明确上报为 0 才显示 `$0.0000`。上下文比例仍只有拿到 `model.contextWindow` 才展示，低于 1% 不显示。
2. **累计成本是“本实例内存”口径**：同一会话内跨多次运行累加，`/reload` 或换会话后归零
   （不读 `SessionManager`，不让会话内容进到判定层）。本次与累计相同时只显示一次，避免重复同一个数字。
3. **上下文占比低于 1% 不显示**（“上下文 0%”是噪声）；占比来自 `ctx.getContextUsage()` 与 `ctx.model.contextWindow`。
4. **摘录默认关闭且先清洗再截断**：assistant 回复可能包含文件内容、密钥或伪造通知的转义序列，
   开启后它会被 `sanitize()` 整段删除转义序列并压缩空白，再取前 10 个字。想最保守就保持关闭。
5. **截断只在真的截断时才动它**：超长时去掉被切在末尾的悬空标点并补 `…`
   （`已修复登录 bug，改` → `已修复登录 bug…`）；**没超过 10 个字就原样呈现**，
   不会把模型自己写的完整句号改成截断标记。

> 原本的 `content.includePromptExcerpt`（用户输入摘录）**已删除**：它被校验但无人读取，属于“设了也没效果”的
> 假开关。需要“这是哪个任务”用 `includeSessionLabel`，需要“这事办完没有”用 `includeAssistantExcerpt`，
> 两者都不外传用户输入原文。注意窗口标识（会话名或**项目目录名**）会随标题发到所有已配渠道，
> 包括 Webhook——不想让人类可读窗口名外传就关掉 `includeSessionLabel`。通知标题/正文不显示 session ID；Webhook 结构化载荷仍按既有契约包含完整 `sessionId`/`runId` 字段。

### 配置写错会怎样（重要）

**不会静默全关。** 解析失败或字段非法时，插件降级为安全子集：
**只发失败通知（`run_failed` / error 门槛 / `terminal` 渠道 / 静默时段关闭）**，并在状态总览（`Ctrl+O`）与诊断日志里写明原因。
理由：用户写错一个逗号就再也收不到失败通知，是这个插件最糟糕的失败模式。

### 环境变量

| 变量 | 作用 |
|---|---|
| `PI_NOTIFY_DISABLE=1` | 整个插件的会话级静默（不改配置文件） |
| `PI_NOTIFY_CHANNEL=off` | 只静默**本地通知**渠道（`auto`/`osc777`/`osc99`/`toast`/`off`） |
| `PI_NOTIFY_WEBHOOK_SECRET=<值>` | webhook 签名密钥（**值只在这里**，配置里只出现变量名） |
| `PI_NOTIFY_LOG_FILE=<path>` | 打开 JSONL 诊断记录（测试与排障用；不设置则零开销） |
| `PI_NOTIFY_DEBUG=1` | 把人类可读日志镜像到 stderr |

---

## 命令

**只有一个入口**（旧子命令已删除，写 `/notify xxx` 只会得到一句指路）：

| 入口 | 作用 |
|---|---|
| `/notify`（TUI） | 打开通知设置：首页 → 分类/规则 → 字段候选；Enter 改本对话，Space 切换，Ctrl+S 固化用户默认 |
| `/notify`（非 TUI） | 打印状态总览 + 用户默认文件路径 + 当前生效值（渠道 options 隐藏）；**不打开组件、不写盘** |

界面内的折叠动作（原先是独立子命令）：

| 按键 | 作用 |
|---|---|
| `↑↓ / PageUp / PageDown` | 移动焦点/翻页；Esc 逐级返回并恢复父级焦点 |
| `Enter` | 打开分类/规则/字段，或在候选列表里选中（集合字段为切换成员） |
| `Space` | 快速切换：布尔字段就地开关，复杂字段打开候选；分类/动作/信息行不响应 |
| `?` | 只读字段详情，逐层展示本对话/用户默认/内置默认与来源，并含 `a`/`d` 恢复动作 |
| `/` | 打开搜索（同首页“搜索设置”）；输入筛选，Enter 打开结果，Esc 返回 |
| `a`（字段详情） | 沿用以后默认：只清除此项本对话覆盖 |
| `d`（字段详情） | 恢复此项内置默认：确认后同时清除用户默认与本对话覆盖（默认焦点为取消） |
| `Ctrl+S` | 把该字段已生效的值固化为用户级默认（单项稀疏写盘，渠道开关不带动其他渠道） |
| `Ctrl+T` | 立即走一遍完整投递链路（自检）。**绕过静默时段/合并/冷却**（仍受总开关/等级门槛/去重约束）；静默期间提示 |
| `Ctrl+R` | 重新读盘并校验，不触发扩展重载 |
| `Ctrl+O` | 状态与诊断页：首行是可见动作“重新读取配置”，其余只读展示开关、生效规则/渠道、合并/冷却参数、静默时段及当前是否生效、配置来源、终端机制、投递统计、送达前提、上次成功/错误、是否正在等你输入、配置错误与告警 |

非 TUI（print/json）的 `/notify` 通过 **stderr** 回显，stdout 保持干净；RPC 下 `custom()` 不可用，
所以 RPC 也只走非 TUI 分支（不弹组件、不写盘）。

CLI 开关：`--no-notify` 让本会话不发通知（不改配置文件）。

---

## 通知走哪条路

| 渠道类型 | 机制 | 触发条件 / 说明 |
|---|---|---|
| `terminal` | **OSC 99** | `KITTY_WINDOW_ID` 或 `TERM_PROGRAM=kitty` |
| `terminal` | **OSC 777** | 其它有 TTY 的环境（默认） |
| `terminal` | **Windows toast** | `platform === "win32"`（Windows Terminal 不渲染 OSC 777） |
| `webhook` | **HTTP POST** | 需要 `url`；有 `secretEnv` 时对**实际发送的字节**做 HMAC-SHA256 签名 |
| `email` | QQ SMTP/TLS | 渠道默认关闭；需配置发件人、多个收件人、环境变量授权码，并在每条通知规则中单独勾选 |

本地三种机制按上表自动选择，也可用 `PI_NOTIFY_CHANNEL` 强制。
**能不能真的看见，取决于终端模拟器**（设计 §13 第 18 项：没有终端焦点 API）。
macOS 只走 OSC 777，因此 Apple Terminal 不会显示；原生横幅（`osascript`）未实现。

### QQ 邮箱 / 邮件传输

`/notify → 通知渠道 → 邮箱` 开启邮箱并配置 QQ 发件地址、收件人（逗号分隔，支持其他邮箱服务商）和主题前缀。Enter/Space 只对本对话生效，Ctrl+S 可把各项保存为以后默认。邮箱渠道默认关闭；启用后仍需到「通知规则」逐类勾选 `email`，默认规则不会自动增加邮件。要让正常 AI 回复同时触发本机和邮箱通知，请将「运行完成 → 渠道」设为 `terminal` + `email`，并分别 Ctrl+S 保存邮箱开关和规则渠道。邮箱测试只验证邮件链路，不会替你启用正常事件路由。正常邮件的标题/正文复用本机通知内容（邮件标题额外带主题前缀），不会默认发送完整 AI 回复。

1. 在 QQ 邮箱网页设置中开启 SMTP 服务并生成**授权码**（不是 QQ 登录密码）；预置服务器为 `smtp.qq.com:465`、TLS。
2. 在邮箱页选择「设置 / 更换授权码（遮蔽输入）」，在 Pi 的隐藏输入中输入刚生成的授权码；授权码写入当前 Windows 用户的**凭据管理器**，不写进配置文件、会话或日志。可以随时移除凭据；Pi 状态页只显示存储来源/是否配置，不显示内容。旧的 `PI_NOTIFY_QQ_SMTP_AUTH_CODE` 仍受支持为低优先级回退；凭据管理器中已保存的值优先。建议从 Pi 启动器或秘密管理器注入旧环境变量，不把它写入项目文件。
3. `/notify → 通知渠道 → 邮箱 → 发送邮箱测试` 只向配置的收件人发固定文本；测试前需启用邮箱并填好发件、收件地址和授权码。缺少任一前提时界面会指出具体原因；“已提交”或 SMTP 接受均不保证最终进入收件箱，需检查收件箱/垃圾邮件以及 `Ctrl+O` 状态统计。邮箱页的蓝色「QQ 邮箱网页版设置 ↗」链接通过 Pi 的默认浏览器打开官方登录页（`https://mail.qq.com/`）；登录后进入「设置 → 帐户」开启 SMTP 并生成授权码。

邮件 sender 通过独立 `MailSender` 接口与邮件通知 provider 解耦。当前只实现 `smtp/qq`；后续可加 Gmail SMTP OAuth 或 Gmail API sender，本期不包含 Gmail。每个收件人分别发送，避免暴露收件列表；服务商可能限制发送频率，失败重试无法在连接中断时保证严格 exactly-once。

### Webhook 细节

请求形态（`POST`，`content-type: application/json; charset=utf-8`）：

```json
{
  "source": "pi-notification",
  "version": 1,
  "event": "run_failed",
  "level": "error",
  "title": "任务未完成",
  "body": "失败原因：provider error · 用时 1.2s · 工具失败 1 次：bash",
  "dedupeKey": "<sessionId>:<runId>:run_failed",
  "sessionId": "…", "runId": "…", "durationMs": 1200, "at": 1700000000000
}
```

- 附加请求头：`X-Pi-Notify-Event: <kind>`，以及（有密钥时）`X-Pi-Notify-Signature: sha256=<hex>`；
  接收方用同一个 secret 对**原始 body** 重算 HMAC 即可验证。
- **配置里只出现环境变量名**；密钥缺失时该渠道判定为不可用并降级为 noop（不会静默发到错地方）。
- **不跟随重定向**（`redirect: "error"`），避免把签名/载荷带到另一个主机；URL 不得内嵌用户名/密码。
- 响应非 2xx 即失败（错误信息带状态码与**脱敏后**的响应体片段）；日志里只记录 `origin + pathname`，
  **丢弃 query**（query 常被用来传 token）。
- 只发结构化元数据：不含用户输入原文、不含完整回复。

### TTY 纪律（重要）

**写 `stdout` 的机制（OSC 777 / OSC 99）必须先确认 `stdout` 是 TTY。**
`pi -p`、`--mode json`、输出被重定向都属于这种情况：stdout 是调用方读走的数据，
往里塞 OSC 序列会直接破坏输出。此时本地渠道降级为 noop，并在诊断日志里留一条
`channel_degraded`（说明原因），而不是静默消失、也不会报错。

`auto` 在非 TTY 下一律不发（避免脚本化运行意外弹系统通知）；
但 **`PI_NOTIFY_CHANNEL=toast` 是显式指定，不受 TTY 限制**——toast 写的是操作系统通知，不碰 stdout。

---

## 通知的触发时刻

| hook | 时机 | 产出 |
|---|---|---|
| `agent_settled` | **唯一**完成出口 | `run_completed` / `run_failed` / `run_aborted`，或（当结果不通知时）聚合的 `tool_failed` |
| `tool_execution_end` | 某次工具执行失败 | `mode: aggregate`：只累积；`mode: immediate`：达到 threshold 立刻发 `tool_failed` |
| `session_compact_failed` | 压缩失败（含手工 `/compact`） | `compact_failed`（error）；`aborted: true` 不发（用户自己取消的） |
| `ui_prompt_start` | Pi 开始等待用户（`select`/`confirm`/`input`/`editor`） | `waiting_for_user`（默认关闭）；**`custom` 永久排除** |
| `ui_prompt_end` / `session_shutdown` | 不再等待 | 复位等待状态（强杀时可能收不到 `end`，所以 shutdown 也兜底复位） |
| `session_info_changed` | `/name` 或恢复会话时 | 刷新正文里的会话名标识（**只读**；日志只记“有没有名字”，不记名字本身） |

两个刻意的取舍，都有实测依据（设计 §18.5 修订 1）：

1. **`custom` 永久排除**：TUI 下 `custom()` 常被当作纯进度加载器，RPC 下它根本没有 UI 却仍会触发 span，
   与“用户在输入”无关。即使把它写进 `kinds` 也不生效（会给出告警）。
2. **不靠 `kind` 配对 start/end**：嵌套 prompt **不会**产生内层 span，`ui_prompt_end.kind` 报的是**外层**，
   所以只做“开始 +1 / 结束 −1”的簿记。

---

## 当前能力与缺口

**能做**：判定 completed/failed/aborted/unknown（含 `length` → warning）→ 规则映射等级与渠道 →
门槛/去重/**静默时段/合并窗口/冷却** → 入队 → 在独立任务里并发投递（终端/系统通知、Webhook、QQ SMTP 邮件）→
内置超时/重试/熔断/脱敏；工具失败聚合、压缩失败、等待输入；
正文内容字段（会话名 / 成本本次+累计 / 上下文占比 / assistant 摘录）；
用户级默认读盘（含降级、**无项目级层**）；设置界面的单项稀疏原子写盘；
`/notify` 单一入口 + 折叠动作（Ctrl+S/T/R/O）；`--no-notify`；
`reload` 后旧实例失效、不重复投递；quit 时在 200ms 预算内尽力投递。

**还没做**：

- ❌ macOS 原生横幅（`osascript`）
- ❌ Telegram / Discord / Slack 等专用渠道（Webhook 已是它们的通用底座）
- ❌ 通知历史与状态行（`pi.appendEntry` + `registerEntryRenderer`、`ctx.ui.setStatus`；设计列为可选）
- ❌ 子任务通知（前台 `subagent` 可用 `tool_execution_end` 观察；后台 `async:true` 的完成
  发生在 detached runner 进程里，父进程看不到——设计 §18.5 修订 4 裁定 MVP 不做）
- ❌ 累计成本的跨实例口径（当前是内存累计，`/reload` 后归零；若要持久化得先定语义与清理策略）
- ❌ 通知历史面板（状态总览是只读文本，不带历史；设计列为可选）

### 覆盖范围的硬边界（实测结论，不是猜测）

1. **纯 `/command` 型业务任务不在覆盖范围。** 扩展命令在 `input` 之前分发并直接返回，
   **不进入 agent 生命周期 → 不产生 `agent_settled`**。图片/视频生成这类任务因此无法被通知，
   也**不能**靠重名注册劫持（重名会变成 `:1`/`:2` 并存）。已用真实 CLI 固化为回归断言。
2. **子会话与后台子任务不在覆盖范围。** 见上。
3. **一次用户输入可能产生多次运行。** 例如把带空格的 prompt 交给 shell（`cmd.exe`）传递时被拆成
   多个位置参数，Pi 会**真的**当作多条用户消息、跑多次运行——这时收到多条通知是**正确**的。
   用 `pi -p "..."` 时确保引号被正确传递。

---

## 安全

- 所有对外文案都经过同一处 `sanitize()`：**整段删除** OSC/CSI/DCS 等转义序列（含载荷）、剥离
  C0/C1 与双向文本覆盖字符、归一换行、按 `maxMessageChars` 截断；渲染前再确保载荷里不可能出现
  能提前终止序列或夹带新序列的字节。官方 `examples/extensions/notify.ts` 直接内插未清洗字符串，本插件不复刻。
- **Windows toast 不存在脚本注入面**：官方示例把 title/body 直接插值进 PowerShell 脚本
  （还把 title 当 AUMID 用）；本实现的脚本是**静态常量、零插值**，载荷以 **base64 放进环境变量**传入，
  再用 DOM `CreateTextNode` 写入，既不做字符串拼 XML 也不做字符串拼脚本。
- **Webhook 渠道**：密钥只以环境变量名引用；HMAC 签名；不跟随重定向；URL 不得内嵌凭据；
  非 2xx 的响应体片段先脱敏再进日志；日志丢弃 URL query。
- 渠道出口统一套一层 `withRedaction()`：任何异常文本出 provider 层之前都会被脱敏。
- 错误信息脱敏：`Bearer …`、`apiKey=`/`token=`/`secret=`、`sk-`/`ghp_`/`xox*` 前缀、JWT、
  40+ 位随机串、家目录路径。
- **默认不外传用户输入或完整回复**；密钥只以环境变量名引用。

---

## 开发与测试

```bash
cd work/scripts/pi/pi-notification

MSYS_NO_PATHCONV=1 npm test                        # 全部回归（含离线邮箱 sender/provider 测试）
MSYS_NO_PATHCONV=1 node test/config-validation.mjs  # 配置校验矩阵：字段边界/降级/稀疏与原子写盘（不需要 SDK，13 步）
MSYS_NO_PATHCONV=1 node test/settings-patch.mjs     # 稀疏补丁与配置项助手：合并/删除语义、overlay、用户默认、渠道补丁（不需要 SDK，17 步）
MSYS_NO_PATHCONV=1 node test/registry-log.mjs       # 渠道注册降级 + 脱敏/清洗/日志 sink（不需要 SDK，9 步）
MSYS_NO_PATHCONV=1 node test/lifecycle-state.mjs    # 状态机结构性丢弃与投递服务边界（注入假时钟，13 步）
MSYS_NO_PATHCONV=1 node test/terminal-channel.mjs   # 终端渠道：选择/渲染/注入面/TTY 纪律（不需要 SDK，10 步）
MSYS_NO_PATHCONV=1 node test/service-coalesce.mjs   # 投递服务：门槛/去重/静默/合并/冷却/队列/超时（注入假时钟，22 步）
MSYS_NO_PATHCONV=1 node test/webhook-channel.mjs    # Webhook + 装饰器（回环 HTTP 服务，不出网）
MSYS_NO_PATHCONV=1 node test/email-channel.mjs      # 邮箱 sender/provider（注入假 SMTP，不接公网/不需真实授权码）
MSYS_NO_PATHCONV=1 node test/settings-ui.mjs        # 设置界面纯组件：首页/导航/搜索/预览/恢复/条件展示/全页渲染扫描（50 步）
MSYS_NO_PATHCONV=1 node test/host-lifecycle.mjs     # 真实宿主会话：判定/去重/阻塞/配置/单一入口与三层值/导航/恢复（54 步）
MSYS_NO_PATHCONV=1 node test/cli-smoke.mjs          # 真实 pi 进程（G–N，10 步）
PI_SKIP_CLI=1 node test/cli-smoke.mjs               # 只想跑纯 SDK 时跳过
```

前四个脚本只依赖纯函数与 Node 内置模块（不加载宿主、不出网、不写真实用户目录），可以单独秒级跑完；
`host-lifecycle.mjs` 与 `cli-smoke.mjs` 会真的启动会话/进程，是完整验收的主要部分。

Git Bash 下 **务必带 `MSYS_NO_PATHCONV=1`**：MSYS 会把 `/probe-cmd` 这类参数改写成
`C:/Program Files/Git/probe-cmd`，命令会静默退化成普通 prompt 并真的调用一次模型（费钱且结论错）。
所有脚本都会给子进程强制带上这个变量。`settings-ui.mjs` 会用 jiti + alias 解析
`@earendil-works/pi-tui`（组件要在裸 node 下直接驱动，而 plugin 目录本身没有 `node_modules`）。

**测试不会弹出真实系统通知**：`host-lifecycle` 把终端机制钉成 `osc777` 并从转发副本里剔除通知序列；
`cli-smoke` 的 stdout 是管道，按 TTY 纪律本来就不发；其余脚本用注入的假 IO 或假渠道。
网络陷阱：除 `127.0.0.1`（Webhook 端到端断言用）之外的任何 `fetch` 都会让回归失败。

### 人工验证（唯一无法自动化的部分）

通知到底有没有显示在你的终端/通知中心，需要你自己看一眼——用界面里的 `Ctrl+T` 自检：

```bash
pi -e work/scripts/pi/pi-notification/extensions/index.ts
# 然后在会话里：
/notify           # 打开设置
#   Ctrl+T        # 立即发一条自检通知
#   Ctrl+O        # 状态与诊断：机制、统计、送达前提、上次错误
#   ↑↓ Enter Esc  # 浏览分类、改本对话的值
#   Ctrl+S        # 把当前值固化为用户默认（底部会看到 ` · 默认` 迁移）
```

Windows 上如果 `auto` 没选中预期机制，可以用 `PI_NOTIFY_CHANNEL=toast` 强制。

人工验收记录（M3-3 / UX-1 已由维护者跑过，通过）：
- `Ctrl+T` 的本地通知显示、`Ctrl+O` 状态与诊断排版、首页/分类导航与 `Ctrl+S` 反馈、Space 切换手感。
- `waitingForUser` 打开后，真实 `confirm` 流程的等待提醒与复位。

M4 之后建议顺手看一眼（不必单独一轮）：正文里会话名、成本与上下文占比是否合口味；
拿不准就把 `content.includeCost` / `content.includeSessionLabel` 关掉，两者都是纯元数据。

### 回归断言覆盖什么（211 条）

| 组 | 内容 |
|---|---|
| 终端渠道（10） | 机制选择表与 `PI_NOTIFY_CHANNEL` 覆盖、OSC 渲染字节、10 组恶意载荷注入面、toast 静态脚本与 base64 载荷、非 TTY 零字节、toast 失败冒泡、abort 不写字节、截断不切代理对 |
| 投递服务（22） | 原 10 项不变；新增静默跨午夜 23:00/23:30/07:59/08:00/12:00、等级例外、关闭时放行、同日与全天、自检绕过且不推进窗口、两个非法时间的读盘降级、等级数组校验/去重 |
| Webhook + 装饰器（13） | URL/`secretEnv`/headers 校验、载荷字段形状、真实 POST + HMAC 可复算、无密钥不签名、非 2xx 报错且脱敏、不跟随重定向、abort、重试与退避、熔断开/半开/关闭、单次 deadline、出口脱敏、`validate/format/dispose` 透传 |
| 判定与去重（A–F, H, 对照） | 纯命令不产生生命周期、一次运行 1 条投递且真的写出 1 条通知、settled→下一次 run < 250ms（取 3 次最小值，**带阻塞对照组**）、reload 后不叠加、失败判定、非 TTY 跳过留痕、不改写配置文件 |
| 配置（I1–I9） | 默认值、`enabled=false`、`minLevel` 门槛、规则开关、**损坏配置降级且失败通知仍发得出**、非法字段值、渠道切换、未定义渠道、**项目级层已删除**（文件存在且项目被信任也不读） |
| 设置组件（N/SE/PR/RS/RA/R/K/D/C/I/V/F/S/X，50 条） | 首页固定字段与分类摘要、邮箱子页与测试动作、分类/规则/字段导航栈与 Esc 逐级返回、状态/输入/帮助/搜索返回原入口并保留父级焦点、条件收起（免打扰/规则关闭/immediate 专用窗口）、Space 切换与 footer 按焦点给键、窄屏菜单标签优先且 footer 含 Ctrl+S、**全页面 20/24/30/40/80 列渲染扫描（无 `undefined`/`[object`/`null` 占位且不超宽）**、搜索覆盖全字段并标注未生效、纯本地预览零投递、`a`/`d` 单项恢复与确认页默认取消、恢复失败不改盘且不提前清会话值、字段行内联当前值（中文）、标记列固定占位、Ctrl+S 标记迁移与状态行确认、稀疏单项落盘、Ctrl+S 只写已生效值、集合多选与整数组保存、数值/时间自定义输入校验、强制静默作额外限制、overlay 优先级与 base 继承、fork 不继承 |
| 单一入口与三层值（J1–J14） | 非 TUI 只打印状态/路径且不写盘不投递、旧子命令只给指路、TUI 打开组件且 Esc 不改盘、Enter 只改本对话且立即生效（反馈写明字段名/值/范围）、覆盖跨 `/reload` 保留、**清空最后一项后 `/reload` 不复活旧值**、Ctrl+S 单项稀疏写盘（两项并存，确认写明字段名/值/以后默认）、Ctrl+R/Ctrl+O/Ctrl+T 折叠动作等价、状态页可见重读动作、无启用渠道时解释送达前提、恢复总开关默认时如实说明仍强制静默、写盘失败报错并写明字段名、**渠道保存隔离**、强制静默不可绕过、非 TUI/RPC 守卫与凭据隐藏 |
| 合并/冷却（L0–L2） | 默认参数符合设计、默认配置下 1.5s 内两次运行只发一条（并留 `cooldown_drop`）、`cooldownMs=0` 后恢复每条 |
| 工具失败/压缩失败/等待输入（K1–K6） | 聚合进结果通知、结果不通知时单独发、immediate 立刻发且并行失败被合并、压缩失败 error（用户取消不发）、真 `select` 触发等待通知、`custom` 排除、`end`/reload 复位等待 |
| 正文内容字段（R1–R5） | 新字段默认值与更名、已删 no-op 字段不复活（且旧配置不因此降级）+ 新字段类型错仍降级、标题窗口标识的项目名回退/会话名优先/可关闭人类可读名/日志不记名字、摘录默认关闭 + 10 字截断 + `…` 标记 + 悬空标点去除 + 恰好 10 字不补标记 + 换行归一 + 转义序列整段删除（注入面）、成本本次与跨 run 累计 + 关闭后与占比一起消失、上下文占比 42% 显示且 <1% 不显示 |
| Webhook 端到端（M1–M3） | 真实 POST + HMAC、日志不出现 query/密钥、非法配置降级为 noop 且不发、`§17.3` 反回退（lifecycle/rules 无渠道名、service 不认识 webhook、未注册 `agent_end`） |
| 真实 CLI（G–N） | `/notify` 在真实进程里可派发、退出干净、stdout 未被污染、非 TUI 不写盘；旧子命令只给指路且不改写用户文件；**稀疏用户默认跨进程生效**（预置单项 `runCompleted.enabled=false` 后新进程零投递，未保存字段仍跟随出厂默认） |

断言 C 的对照组是关键：没有它，“不阻塞”只是一个看起来通过的观察。
断言 M3 是**结构约束**的可执行版本：`lifecycle.ts` / `rules.ts` 里出现渠道名、或 `service.ts` 出现
`webhook`，测试就会失败——这正是 §17.3 那条“新增渠道不改核心”的验收标准。

---

## 架构与不变量

```
extensions/index.ts   薄接线：注册 + 形状转换 + 配置装配；注册 /notify 与 --no-notify
   │                 本对话覆盖（overlay）也在这里：session_start 恢复、Enter 落 pi.appendEntry
   ├─ patch.ts        稀疏补丁工具：路径读写 / 深合并（三层值的公共底座）
   ├─ settings.ts     配置项描述表（分组/类型/候选/预设）+ overlay 合并与恢复
   ├─ config.ts       出厂默认 / 用户级默认读盘 / 逐字段校验 / 降级 / 单项稀疏原子写盘
   ├─ lifecycle.ts    运行状态机、工具失败与等待输入的簿记；唯一完成判定点；陈旧实例丢弃
   │    └─ rules.ts   纯函数：RunOutcome / 工具失败 / 压缩失败 / 等待 → NotificationRequest | null
   │         │        （不认识任何渠道名；一个运行最多一条由 evaluateSettlement 保证）
   │         └─ service.ts  同步入队 → 异步投递；门槛/去重/静默/合并窗口/冷却/超时/有界队列/统计
   │              └─ providers/{registry,decorators,noop,terminal,debug,webhook}.ts
   │                   同一个 Notifier 接口；decorators 统一提供超时/重试/熔断/脱敏
   ├─ commands.ts     唯一入口 /notify：TUI 开组件、非 TUI 打印状态；把界面写请求接到真实配置与落盘
   │    └─ ui.ts       设置浏览器组件：首页/分类/规则导航栈 / 标记列 / footer / 键盘 / Ctrl+S / 状态与诊断
   └─ log.ts          控制字符清洗 / 脱敏 / 可选 JSONL 诊断
```

UX-1 没有碰判定与投递核心：`lifecycle.ts` / `rules.ts` / `service.ts` 一字未改，
新加的 `patch.ts` / `settings.ts` 是纯数据层，`ui.ts` 只做渲染与按键。

新增一个渠道的成本：**新增 1 个 provider 文件 + registry 注册 1 行 + 配置加 1 条**，
`lifecycle.ts` / `rules.ts` / `service.ts` 的改动为 0 —— S7 的 Webhook 就是这条规则的实测：
`lifecycle.ts` / `rules.ts` / `service.ts` 一个字都没改，只加了 `providers/webhook.ts` 与
`providers/decorators.ts`，并把渠道包进可靠性装饰器。

不可违反的 6 条（都来自实测，不是风格偏好）：

1. 完成判定只认 `agent_settled`，**不注册 `agent_end`**。
2. `agent_settled` 的 handler **只入队后立即返回**（handler 体内零 `await`）——它会被 await，
   在里面做网络投递会直接拖慢用户的下一次输入（实测 +2027ms）。
3. 其余通知型 hook（`tool_execution_end`、`ui_prompt_*`、`session_compact_failed`）同样只入队，不 await。
4. `session_shutdown` 内的收尾投递必须带**短超时**（默认 200ms），并兜底复位等待状态。
5. 旧实例在 `session_shutdown` 之后不得再产生任何结论（reload 会重建实例）。
6. 投递前一律清洗控制字符；**写 stdout 的渠道必须先确认 stdout 是 TTY**。

---

## 未验证 / 已知不确定（如实记录）

以下项**没有**被实测覆盖，不要当成已解决：

- **三种本地机制是否真的在对应终端里显示**：Windows toast 已确认（生产代码路径实发成功、开发者肉眼确认）；
  OSC 777 / OSC 99 **未在真实终端上肉眼确认**（本开发环境无 TTY、非 kitty）。
- OSC 99 的 kitty 协议实现（两段 `d=0`/`d=1`）未在 kitty 上实测。
- **Webhook 只与本机回环服务对过端到端**（HMAC 由测试自己按同一算法复算）：真实第三方端点
  （Slack/Discord/Telegram）的字段容忍度、代理、TLS、429/5xx 重试节奏都**未验证**。
- **熔断/重试只在单测里用假渠道验证**，未在真实网络抖动下观察过阈值是否合适（默认 3 次 / 1 次重试 / 30s）。
- `ui_prompt_*` 的 `input` / `editor` 两个 kind 未单独实测（实现上按白名单同等处理，
  `confirm`/`select` 已用真触发验证）。
- 进程在 prompt 未闭合时被强杀：`session_shutdown` 兜底复位已实现并断言（reload 路径），
  但“强杀（SIGKILL）”本身无法在测试里复现。
- TUI 下 Ctrl+C/SIGINT、`ctx.ui.notify` 可见性。
- TUI 内真实 `/reload` 的交互路径（本轮的 reload 断言走 SDK 的 `session.reload()`，语义相同但入口不同）。
- `session_shutdown` 的 `reason = "new" | "resume" | "fork"` 语义（需要交互流程）。
- 设置界面在**真实 TUI** 里的排版与手感（列宽、滚动、`Ctrl+S` 的 ` · 默认` 迁移是否好读）：
  自动化用无头组件 + UI 桩覆盖了渲染与按键分支，但真终端里的观感需要人眼确认。
- **M3 新增**：静默时段跨午夜的行为已用固定本地时间单测覆盖，但**跨午夜的真实挂机切换**（23:59→00:00）
  未在长时间运行中观察；系统时钟跳变、睡眠唤醒等场景也未验证。
- **M3 新增**：`0o600` 在 Windows 上只验证了“创建/替换不报错”（POSIX mode 位不代表 ACL 隔离）；
  仅非 Windows 平台断言了 `mode & 0o777 === 0o600`。
- **UX-1 新增**：`Ctrl+R`（重读）、`Ctrl+O`（状态总览）、`Ctrl+T`（自检）在真终端里是否与宿主全局绑定冲突：
  组件只在持有输入时消费这些键，但**真实按键路由**未在 TUI 里逐个手验（自动化用桩键位覆盖）。
- **UX-1 新增**：`Ctrl+S` 与宿主同名快捷键（模型/思考保存）的交互只做了“组件内消费”的设计约束，
  未在真实 TUI 里连按验证。
- **M4 新增**：成本/上下文占比只与**假 provider** 对过（它按测试旋钮汇报 `usage.cost.total`）；
  真实 provider 是否都提供 `usage.cost.total`、数值是否含缓存读写、与 Pi 自带 `/session` 统计是否一致**未验证**。
  这也是“拿不到就不写”的其中一个原因。
- **M4 新增**：`includeAssistantExcerpt` 只验证了截断/清洗/注入面；不同 provider 是否都会在
  `message_end` 携带 assistant 文本、多轮（带工具调用）时“最后一条非空文本”是否总是用户想看的那句，未用真实 provider 验证。
- 后台子任务是否在 runner 进程内二次加载本扩展（S0 源码预测会，未实测）。
- 无 `tsc`（仓库不允许装依赖），所以类型**未经编译器校验**；运行时加载已在 SDK 与真实 CLI 两侧验证。
