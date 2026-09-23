# pi-notification：通知设置（可发现性与操作效率优化）

## Context

`pi-notification` 功能完整，但配置入口分散（`/notify status|test|on|off|config|reload`）、
`/notify config` 是串行的规则向导（选规则 → confirm → 选等级 → 最终确认），用户看不到
“当前生效值”，也看不到“哪些是我固化过的默认值”。本轮只调整信息架构、布局与交互反馈，
把配置收敛为单一入口 + 分类 + 内联状态列表，并提供 Ctrl+S 固化用户级默认。

判定/投递核心（`lifecycle.ts` / `rules.ts` / `service.ts` / `providers/*`）**不改**。

## 已确认决策

1. Ctrl+S 保存**当前配置项**，不保存整份配置。
2. Enter 立即生效，**仅影响本对话**（跨 `/reload`、跨“退出后恢复同一对话”保留）；Ctrl+S 才跨对话持久化。
3. `/notify` 为唯一入口，不保留旧子命令兼容；原功能移入入口内部。
4. 开发阶段无需配置迁移。
5. 必须**单项持久化**（稀疏写入），不能沿用现有全量快照写盘。
6. 值层级只有三层：**出厂默认 → 用户级默认 → 本对话选择**。
7. 配置范围：全部非敏感标量（布尔/枚举/数值/时间）与集合字段；渠道仅启停与单选/多选；
   `options`（url/headers/密钥）仍只编辑 JSON。纯终端 TUI，不涉及浏览器与 DOM `preventDefault`。
8. **删除项目级配置层**（净删除）：`config.ts` 不再读 `<项目>/.pi/pi-notification/config.json`，
   `extensions/index.ts` 不再调用 `ctx.isProjectTrusted()`，README 删除该章节，I9–I11/J14 断言删除。
9. 数值/时间项：**预设候选值 + 末尾 `custom…`**，选中 `custom…` 进入内联输入框，走同一套校验。
10. 写盘失败时**保留本对话已生效的当前值**，只在状态行报错，不静默回滚。
11. 状态总览 / 发送测试 / 重新读取配置**折叠为 footer 按键**，根级不占列表行。

## 信息架构

```
/notify
└── 通知设置（唯一入口，TUI 组件；状态/测试/重读是 footer 按键，不占列表行）
    ├── 基础：      总开关、最低等级
    ├── 通知规则：  runCompleted / runFailed / runAborted / toolFailed / compactFailed / waitingForUser
    ├── 内容：      5 个布尔 + maxMessageChars
    ├── 静默与频率：quietHours（开关/起/止/等级例外）、coalesce（三个窗口）
    ├── 投递：      timeoutMs / maxRetries / concurrency / queueLimit / circuitBreakerFailures / shutdownFlushMs
    └── 渠道：      每个 provider：id/type（只读）+ enabled；options 提示“需编辑 JSON”
```

- 非 TUI（`print`/`json`/`rpc`）：`/notify` 只打印脱敏状态 + 用户配置文件路径 + “设置界面仅 TUI 可用”，
  不打开组件、不写盘、stdout 保持干净（沿用现有 stderr 回显约定）。
- `--no-notify` / `PI_NOTIFY_DISABLE=1` 保留：界面显示“被会话静默强制关闭”，不允许通过 UI 绕过，
  也不把它写成用户默认。

### 两级列表

1. **配置项列表**（父级）：一行一个配置项，内联展示当前值与用户级默认值，不必进入详情即可读到状态。
2. **候选项列表**（详情）：一行一个候选值，用标记位表达状态（见下）。

## 列表与标记规则

### 标记通道（互相独立，可共存）

| 通道 | 位置 | 含义 | 宽度 |
|---|---|---|---|
| 焦点 | 行首 | 当前焦点行 | 固定 2 列：`→ ` / `  ` |
| 当前值 | 紧接焦点列 | 该项是当前值 | 固定 2 列：`✓ ` / `  ` |
| 用户默认 | 行尾 | 该项是用户级默认值 | 固定后缀 ` · default` |

- 两列标记等宽（各 2 个终端显示列），未命中时填空格，`✓` 出现/消失不会横向抖动。
- 标记单元格内不插入 ANSI 颜色（避免宽度计算与主题差异），颜色只作用于值文本。
- `→ ` 与 `✓ ` 可同时出现在同一行，语义互不混淆。
- 允许一个 ` · default` 都没有（用户从未按过 Ctrl+S）。
- 集合字段（channels / kinds / exceptLevels）：可**多行同时带 `✓ `**；Enter 切换该候选是否属于集合。

示例（`minLevel`）：

```
→ ✓ info
    warning · default
    error
```

### 数值 / 时间 / 自定义输入

- 数值与时间项同样渲染为候选项列表，末行为 `custom…`：

```
   0 ms
→  1500 ms
✓  3000 ms
   10000 ms
   custom… · default 8000 ms
```

- 选中 `custom…` 后就地切换为**内联输入框**（不新开对话框）：
  - 复用同一组件的输入处理（`CURSOR_MARKER` + `decodeKittyPrintable` + `matchesKey`），参考
    `work/scripts/pi/pi-video-generation/src/config-ui.ts` 的 `promptSecret` 内联输入实现；
  - Enter 提交、Esc 取消并回到候选项列表；输入经现有校验函数（`checkPositiveInt` / HH:MM 正则），
    非法值就地报错、不写入当前值、不写入默认。
- 时间项（`quietHours.start` / `end`）预设为整点/半点候选，`custom…` 输入严格 `HH:MM`。

### 附加信息

值后的 `[附加信息]` 紧随值（渠道候选项显示 provider `type`，即 `id [type]`）：

```
✓ terminal [terminal]
  debug [debug] · default
```

### 溢出策略（固定顺序，先保右边）

1. 先保留两列标记与行尾 ` · default`（右对齐固定列，永不被截断）。
2. 值 + `[附加信息]` 占剩余宽度，超出用 `truncateToWidth(..., "…")` 截断。
3. 宽度不足（< 约 24 列）时依次降级：去掉 `[附加信息]` → 截断值文本 → 少于最小宽度时只显示焦点列 + 截断值。
4. 所有行按 `visibleWidth` 计算（中文/emoji 按显示宽度），不按 `String.length`。

### 配置项列表（父级）行格式

```
→ 基础 · 总开关              ✓ on        default on
  基础 · 最低等级            ✓ info      default warning
  内容 · 助手摘录            ✓ off       —（未保存）
  渠道 · hook               ✓ on        default off
```

- 两列右对齐：`当前值` 与 `default <用户默认>`；用户从未保存该项时显示 `—（未保存）`，
  **不把出厂回退值当作已保存的默认值**。

## 键盘与 Ctrl+S

| 按键 | 行为 |
|---|---|
| ↑ / ↓ | 移动焦点（配置项列表 / 候选项列表） |
| Enter | 父级：进入该配置项详情；候选项：设为当前值（本对话立即生效，列表保持打开）；集合：切换成员；动作项：执行 |
| Esc | 返回父级（恢复父级焦点与滚动位置）；根级关闭 |
| Ctrl+S | 将**焦点项**的当前值固化为用户级默认 |
| PageUp / PageDown | 长列表（含状态总览）翻页 |
| Ctrl+T / Ctrl+R / Ctrl+I | 测试通知 / 重读配置 / 状态总览（见 footer） |

- Ctrl+S 在父级与详情行为一致：都作用于焦点所在配置项的当前值。
- 触发后：` · default` 迁移到当前值所在行、原标记清除（仅目标项）。
- 同时给出**轻量确认**：组件内状态行显示 `已保存为默认 · <配置文件路径>`，停留至下一次按键；
  两项反馈缺一不可。
- Ctrl+S 是宿主已有上下文快捷键（模型/思考/会话列表用 `ctrl+s`），因此**只在组件持有输入时消费**，
  不调用 `pi.registerShortcut`，不注册全局快捷键；组件返回时不得把按键透传给编辑器。
- 纯 TUI 输入是字符串，由 `matchesKey(data, Key.ctrl("s"))` 判定并 `return`（不 return false/不转发），
  即“消费该按键”，不存在浏览器保存对话框问题。
- 键盘可达性：焦点行高亮 + `→ ` 标记双通道；列表滚动时焦点行始终可见；footer 常驻不随滚动消失。

### footer（常驻，不随列表滚动）

```
↑↓ move   Enter select   Esc back   Ctrl+S  save as default
Ctrl+T test   Ctrl+R reload   Ctrl+I status   Esc back
```

- 第二行同时承载三个折叠的原有功能（均为现有实现，不新增能力）：
  - `Ctrl+T` → 发送测试通知（复用 `service.submit({ bypassFilters: true })` 与现有静默提示文案）
  - `Ctrl+R` → 重新读取配置（复用现有 `reloadConfig(ctx, "notify_reload")`，不重载扩展）
  - `Ctrl+I` → 状态总览：只读分页视图，内容即现有 `formatStatus(deps)` 输出，↑↓/PageUp/PageDown 滚动，Esc 返回
- 状态行（footer 第三行，可被结果文案临时替换）：空闲显示
  `当前值仅本对话生效；Ctrl+S 固化到用户默认`；保存/选择/失败后就地替换为结果文案
  （成功=正常色，失败=warning/error 色，且原标记保持不变）。
- 失败处理（已确认）：写盘失败 → `· default` 不迁移、本对话当前值保留生效、状态行显示脱敏原因。
- 三个 Ctrl 键与 Ctrl+S 一样只在组件持有输入时消费，不注册全局快捷键。

## 值模型与持久化

三个概念严格区分：

| 概念 | 来源 | 可写 |
|---|---|---|
| 出厂默认 | `config.ts` 的 `defaultConfig()` | 否 |
| 用户级默认 | 用户配置文件里**显式保存过**的字段（稀疏，可能不存在） | 仅 Ctrl+S |
| 当前值 | 出厂默认 → 用户级默认 → 本对话覆盖，逐字段合并 | Enter 改本对话；Ctrl+S 改用户默认 |

### 本对话覆盖

- 内存：`overlay: Partial<ConfigPatch>`（字段路径 → 值）。
- 持久：`pi.appendEntry("notify-session-overlay", { sessionId, patch, at })`；
  `session_start` 时只用 **data.sessionId === 当前 sessionId** 的条目恢复，因此
  `/reload`、退出后 `/resume` 同一对话保留，`/new`、`/fork`（会复制分支条目）**不继承**。
- 应用时机：读盘得到 `loadConfig` 结果后叠加 overlay，再走现有 `adoptConfig` 原地赋值；
  改动 `providers` 时必须赋新的数组引用（`service.ts` 靠引用变化刷新渠道缓存，见下方复用）。

### 单项写盘

- 用户文件改为**稀疏用户默认**：只包含曾经被 Ctrl+S 保存的字段。
- 新增 `writeUserDefaultPatch(agentDir, path, value)`（名称待定）：读现有文件 → 校验单项 → 合并到已有 JSON →
  原子写（沿用现有临时文件 + `0o600` + `rename` 机制）→ 失败保留原文件与内存态。
- `mergeConfig` 需修正：`checkRules` 目前用 `defaultConfig().rules` 补规则缺省字段（`config.ts:checkRules`），
  与传入 base 无关；单项保存/三层合并会让同规则其它字段被出厂值覆盖，必须改为从 base 继承。
- 识别“用户级默认是否存在”：按**原始 JSON 里的路径存在性**判断，不靠与出厂默认比较。

## Files to modify

| 文件 | 改动 |
|---|---|
| `work/scripts/pi/pi-notification/src/settings.ts`（新增） | 配置项描述表：路径、分组、标签、类型（bool/enum/number/time/collection）、候选来源、get/set/比较，以及 overlay 与稀疏默认的合并工具 |
| `src/ui.ts` | 重写为设置浏览器组件：两级列表、标记通道、footer/状态行、键盘处理、Ctrl+S；保留 TUI 守卫 |
| `src/commands.ts` | `/notify` 单入口：TUI 打开组件并接收保存结果；非 TUI 打印状态与路径；删除子命令分发 |
| `src/config.ts` | 去掉项目级层（`ReadConfigOptions.cwd/configDirName/projectTrusted`、`projectConfigPath`、项目 `providers` 特例）；修正 `checkRules` 的 base 继承；稀疏读/写用户默认 |
| `extensions/index.ts` | overlay 状态 + `pi.appendEntry` 恢复；应用 overlay 后 `adoptConfig`；移除 `isProjectTrusted` 调用；命令描述更新 |
| `README.md` | 入口/分层/三种值/Ctrl+S/单项保存说明；删除项目级配置章节与旧命令表 |
| `test/host-lifecycle.mjs` | 删除项目级相关断言与辅助（I9–I11、J14、`projectConfigPath`/`writeProjectConfig`）；重写命令面断言（J1–J13）；新增 overlay 优先级、稀疏写盘、`/reload` 与 `/resume` 恢复、`/new`/`/fork` 不继承、项目配置文件被忽略 |
| `test/settings-ui.mjs`（新增） | 纯组件测试：渲染宽度/标记列不抖动/溢出降级/键盘导航/集合切换/Ctrl+S 标记迁移与状态行 |
| `test/cli-smoke.mjs` | I/M/N 改为单入口：非 TUI 打印状态与路径、且不再能用 `/notify off` 写盘（M 改为预置 `enabled:false` 文件后零投递）、stdout 干净 |
| `test/service-coalesce.mjs` | 适配 `loadConfig` 新签名（去掉 `projectTrusted`） |

## Reuse

- `src/config.ts`：`defaultConfig`、`mergeConfig` + 逐字段校验（`checkBoolean/checkLevel/checkPositiveInt/checkChannels`）、
  `writeUserConfig` 的临时文件 + `0o600` + 原子 `rename` + 失败清理、`degradedConfig` 降级策略。
- `src/commands.ts`：`formatStatus`（状态总览内容）、`configView`（隐藏渠道 options）、`report`（非 TUI 走 stderr）。
- `extensions/index.ts`：`adoptConfig` 原地赋值 + `reloadConfig` 热读、`guard()` 不向 hook 外抛、`--no-notify` 判定、
  已注册的 `session_start` / `session_info_changed` 等 hook（不改判定）。
- `src/service.ts`：渠道表靠 `config.providers` **数组引用**变化刷新并清缓存 —— overlay 变更后赋新数组即可，不改 service。
- Pi TUI/扩展 API：`ctx.ui.custom`（TUI 专用、RPC 返回 undefined → 必须 `ctx.mode === "tui"` 守卫）、
  `Container/Text/DynamicBorder/Spacer`、`matchesKey/Key`、`visibleWidth/truncateToWidth`、`CURSOR_MARKER`、
  `decodeKittyPrintable`、`tui.requestRender()`、`theme.fg/bold`；
  `pi.appendEntry` 持久会话态（参考 `examples/extensions/tools.ts` 的 appendEntry + session_start 恢复）。
- 同仓库兄弟包的既有实现（同框架、已验证）：`work/scripts/pi/pi-video-generation/src/config-ui.ts`
  （`ctx.ui.custom` + `truncateToWidth` + `CURSOR_MARKER` 内联输入 + `keybindings.matches`）、
  `work/scripts/pi/pi-image-generation/src/secret-input.ts`（同型输入）。

## Steps

- [x] 明确 UX 目标、标记语义、Ctrl+S 语义与作用范围。
- [x] 确认值层级收敛为三层、取消项目级配置层、纯 TUI 边界。
- [x] 确认删除项目级层、预设+`custom…` 输入、失败不回滚、动作折叠为 footer 键。
- [x] `src/settings.ts`：配置项描述表（含预设候选集）+ overlay 合并 + 稀疏默认读写工具。
- [x] `src/config.ts`：去项目层、修 `checkRules` base 继承、新增单项默认写盘（稀疏 + 原子）。
- [x] `src/ui.ts`：实现两级列表组件（渲染/标记/footer/键盘/Ctrl+S/预设+custom 内联输入/状态总览分页）。
- [x] `src/commands.ts` + `extensions/index.ts`：单入口接线、overlay 生命周期、apply 后刷新渠道缓存。
- [x] 更新 5 个测试脚本 + 新增组件测试；`README.md` 同步（删项目级章节、改命令表）。
- [x] 运行全量回归；人工在真实 TUI 里过一遍列表/键盘/Ctrl+S/三个 footer 按键。

## Verification

自动化（在 `work/scripts/pi/pi-notification` 下，Git Bash 必须带 `MSYS_NO_PATHCONV=1`）：

```bash
MSYS_NO_PATHCONV=1 npm test
MSYS_NO_PATHCONV=1 node test/settings-ui.mjs
PI_SKIP_CLI=1 node test/cli-smoke.mjs
```

- 组件渲染：`✓` 出现/消失时列不动；标记列宽恒为 2；`→ ` 与 `✓ ` 同行共存；无 ` · default` 的情况；
  中文/emoji 宽度；窄终端（20/40/80 列）溢出降级顺序；行尾 ` · default` 永不被截断。
- 键盘：↑↓ 移动、Enter 进入/选择、Esc 返回并恢复父级焦点、焦点行始终可见、footer 常驻、
  Ctrl+S 被消费（不产生后续输入副作用）。
- Ctrl+S：只写目标字段（其它字段不在文件里）；标记迁移 + 状态行确认同时发生；重复保存幂等；
  写盘失败不迁移标记、不谎报成功、不改内存态（沿用 J6/J7/J8 的真实失败注入）。
- 数值/时间项：预设候选选择生效；`custom…` 合法值写入、非法值（如 `25:00`）就地报错且不改变当前值/默认值。
- footer 折叠功能：`Ctrl+T` 产生 1 条真实投递（沿用 J2 断言）、`Ctrl+R` 重读且不重载扩展、`Ctrl+I` 状态总览可滚动且不产生副作用。
- 分层：出厂默认不变；用户默认来自稀疏文件；本对话覆盖 > 用户默认；`/reload` 与 `/resume` 保留 overlay；
  `/new`、`/fork` 不继承；`--no-notify`/`PI_NOTIFY_DISABLE=1` 强制关闭不可被 UI 覆盖且不写盘。
- 项目层删除：即使 `<项目>/.pi/pi-notification/config.json` 存在且项目已信任，也不再被读取
  （I9/I10 反向断言：两种信任状态下行为一致，且 `sources` 不出现项目路径）。
- 不回归：通知判定/去重/静默/合并/渠道投递全部原断言通过；`lifecycle.ts`/`rules.ts`/`service.ts` 无改动
  （M3 结构约束断言应继续通过）。
- 人工：真实 TUI 打开 `/notify`，过一遍分类 → 详情 → 选择 → Ctrl+S。通知是否真的显示仍需人工看一眼（`/notify` 内“发送测试通知”）。

## 实施结果与差异（2025 收尾）

- [x] 全量回归：`MSYS_NO_PATHCONV=1 npm test` 退出码 0，共 **128 条断言**（原 105 条）。
- [x] 新增 `test/settings-ui.mjs`（23 条：渲染/标记列/溢出/键盘/Ctrl+S/三层值/fork 不继承）。
- [x] `host-lifecycle.mjs` 重写命令面（J1–J14）并把 I9–I11 合并为「项目级层已删除」反向断言。
- [x] `cli-smoke.mjs` 的 I/M/N 改为单一入口，并新增「稀疏用户默认跨进程生效」。

与计划的差异：

1. footer 的状态总览键用 **Ctrl+O** 而不是 Ctrl+I：多数终端里 Ctrl+I 就是 Tab，无法与缩进键区分。
2. 新增 `src/patch.ts`（两处都要用同一套稀疏合并工具，抽出来避免循环依赖）。
3. 父级列表降级策略落定：标签至少留 14 列，剩余宽度先给 `✓ 当前值` 再给 `default X`；
   候选项列表则先留行尾 ` · default` 再截值（两端都有回归断言）。
4. `sessionId` 过滤抽成可测的纯函数 `restoreOverlayFromEntries()`，`/fork` 不继承因此有直接单测。
5. 数值项预设集沿用计划中的提议，未额外确认（改预设只动 `settings.ts` 一处）。

仍待人工（唯一无法自动化的部分）：

- 真实 TUI 里过一遍 `/notify`：列表排版、滚动、`Ctrl+S` 的 ` · default` 迁移与状态行提示、
  `Ctrl+T` 是否真的弹出通知、`Ctrl+O` 状态总览是否读得顺，以及三个 Ctrl 键是否与宿主全局绑定冲突。
  步骤写在 `README.md` 的「人工验证」。

不在本次范围、但需要同步的残留：

- `plans/pi-notification-handoff.md` 仍描述旧行为（`/notify status|off`、off 写整份快照），与本次改动不一致。
