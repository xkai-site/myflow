/**
 * 通知设置界面的**纯组件回归**（不依赖真实宿主、不写真实用户目录）。
 *
 * 覆盖 UX 方案里那些「看着对但很容易做错」的点：
 *   R  渲染：父级行内联展示当前值/用户默认、标记列固定占位不抖动、行尾 ` · default` 永不被截断
 *   K  键盘：↑↓ 移动、Enter 进入/选择、Esc 返回并恢复父级焦点、Ctrl+S 被消费
 *   D  Ctrl+S：标记迁移 + 状态行动作反馈同时发生，且只写这一项（稀疏）
 *   C  集合字段：Enter 切换成员，可多行同时带 `✓ `；保存写整个数组
 *   I  数值/时间：预设候选 + `custom…` 输入框，非法值就地报错且不改变任何状态
 *   V  常驻与折叠：footer 恒显 `Ctrl+S  save as default`；Ctrl+T/R/O 三个折叠动作可用
 *
 * Git Bash 下与其它脚本一样带 `MSYS_NO_PATHCONV=1`：
 *   MSYS_NO_PATHCONV=1 node test/settings-ui.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { resolvePiPackageEntry, resolveSdkEntry } from "./sdk-path.mjs";

// ui.ts 依赖 @earendil-works/pi-tui（在 pi/SDK 加载器里能解析，裸 node 不能），
// 所以用与 pi-image-generation 相同的 jiti + alias 方式加载源码。
const sdkEntry = resolveSdkEntry();
const { createJiti } = createRequire(sdkEntry)("jiti");
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  fsCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": sdkEntry,
    "@earendil-works/pi-ai": resolvePiPackageEntry("@earendil-works/pi-ai", { sdkEntry }),
    "@earendil-works/pi-tui": resolvePiPackageEntry("@earendil-works/pi-tui", { sdkEntry }),
  },
});
const tui = await jiti.import("@earendil-works/pi-tui");
const configModule = await jiti.import("../src/config.ts");
const settings = await jiti.import("../src/settings.ts");
const ui = await jiti.import("../src/ui.ts");

// ---------------------------------------------------------------------------
// 按键（真实终端字节；`matchesKey` 的第二个参数才是按键标识）
// ---------------------------------------------------------------------------

const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  escape: "\x1b",
  backspace: "\x7f",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  ctrlS: "\x13",
  ctrlT: "\x14",
  ctrlR: "\x12",
  ctrlO: "\x0f",
};

// ---------------------------------------------------------------------------
// 测试脚手架
// ---------------------------------------------------------------------------

let passed = 0;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-notify-ui-"));
process.env.PI_CODING_AGENT_DIR = TMP;

async function step(name, run) {
  try {
    await run();
    passed += 1;
    console.log(`\x1b[32m✓\x1b[0m ${name}`);
  } catch (error) {
    console.error(`\x1b[31m✗\x1b[0m ${name}\n  ${error?.stack ?? error}`);
    process.exitCode = 1;
    throw error;
  }
}

const agentDir = path.join(TMP, "agent");
fs.mkdirSync(agentDir, { recursive: true });

/** 每个用例一份干净的用户目录 + 一个组件实例（host 用真实的 config/settings 函数实现）。 */
function makeHarness() {
  fs.rmSync(path.join(agentDir, "pi-notification"), { recursive: true, force: true });
  let overlay = settings.emptyOverlay();
  const calls = { set: [], save: [], test: 0, reload: 0, status: 0 };
  const effective = () => {
    const loaded = configModule.loadConfig({ agentDir });
    const applied = settings.applyOverlay(loaded.config, overlay);
    return applied.config;
  };
  const host = {
    config: effective,
    userRaw: () => {
      const raw = configModule.readUserConfigRaw(agentDir);
      return raw.ok ? raw.raw : undefined;
    },
    setValue(item, value) {
      calls.set.push({ id: item.id, value });
      const patch = item.patch(value);
      if (patch.kind === "providers") overlay.providers[patch.id] = patch.value;
      else overlay.patch = settings.setPatchPath(overlay.patch, patch.path, patch.value);
      return { ok: true, message: "已选择（仅本对话）" };
    },
    saveDefault(item, value) {
      calls.save.push({ id: item.id, value });
      const patch = item.patch(value);
      const configPatch = patch.kind === "providers"
        ? { providers: effective().providers.map((provider) => (provider.id === patch.id ? { ...provider, enabled: patch.value } : { ...provider })) }
        : settings.setPatchPath({}, patch.path, patch.value);
      const result = configModule.writeUserDefault(agentDir, configPatch);
      return result.ok
        ? { ok: true, message: "已保存为默认" }
        : { ok: false, message: `保存失败：${result.problems.map((problem) => problem.path).join(",")}` };
    },
    test() {
      calls.test += 1;
      return { ok: true, message: "已提交自检通知" };
    },
    reload() {
      calls.reload += 1;
      return { ok: true, message: "已重新读取配置" };
    },
    statusLines() {
      calls.status += 1;
      return ["pi-notification: 开启", "  终端机制: toast", ...Array.from({ length: 20 }, (_, index) => `  行 ${index + 1}`)];
    },
  };
  const keybindings = {
    matches(data, id) {
      const map = {
        "tui.select.up": "up",
        "tui.select.down": "down",
        "tui.select.confirm": "enter",
        "tui.select.cancel": "escape",
        "tui.select.pageUp": "pageUp",
        "tui.select.pageDown": "pageDown",
      };
      return map[id] ? tui.matchesKey(data, map[id]) : false;
    },
  };
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  let finished;
  const component = new ui.NotifySettingsComponent({
    theme,
    keybindings,
    host,
    requestRender() {},
    done(summary) { finished = summary; },
  });
  return {
    component,
    host,
    calls,
    overlay: () => overlay,
    get finished() { return finished; },
    render(width = 80) { return component.render(width); },
    press(data) { component.handleInput(data); },
    state() { return component.debugState(); },
    userFile() {
      const raw = configModule.readUserConfigRaw(agentDir);
      return raw.ok ? raw.raw : undefined;
    },
  };
}

/** 焦点行（含 `→ `）。 */
const focusRow = (lines) => lines.find((line) => line.startsWith("→ ")) ?? "";
/** 某文本所在行。 */
const rowWith = (lines, needle) => lines.find((line) => line.includes(needle));
/** 文本在行内的显示列（0-based）。 */
const columnOf = (line, needle) => tui.visibleWidth(line.slice(0, line.indexOf(needle)));

// ---------------------------------------------------------------------------
// R：渲染与标记列
// ---------------------------------------------------------------------------

await step("R1 父级列表：每行内联展示当前值，未保存的用户默认显示为「未保存」", () => {
  const harness = makeHarness();
  const lines = harness.render(80);
  const row = rowWith(lines, "基础 · 最低等级");
  assert.ok(row, "缺少「基础 · 最低等级」行");
  assert.match(row, /✓ info/, "父级行未内联展示当前值");
  assert.match(row, /— 未保存/, "从未保存过的项不该显示默认值");
  assert.ok(lines.every((line) => !line.includes(" · default")), "无用户默认时不该出现 default 标记");
});

await step("R2 标记列固定占位：`✓` 出现/消失都不改变值文本的起始列", () => {
  const harness = makeHarness();
  harness.press(KEY.down); // → 基础 · 最低等级
  harness.press(KEY.enter);
  const lines = harness.render(80);
  const current = rowWith(lines, "✓ info");
  const other = lines.find((line) => /^\s{2}warning\b/.test(line) || line.includes("  warning"));
  assert.ok(current && other, `候选项行缺失:\n${lines.slice(0, 8).join("\n")}`);
  assert.equal(columnOf(current, "info"), 4, "带 ✓ 的行值文本应从第 5 列开始");
  assert.equal(columnOf(other, "warning"), 4, "不带 ✓ 的行值文本也必须从第 5 列开始");
});

await step("R3 焦点通道与当前值通道独立：同一行可同时出现 `→ ` 与 `✓ `", () => {
  const harness = makeHarness();
  harness.press(KEY.down);
  harness.press(KEY.enter);
  const focus = focusRow(harness.render(80));
  assert.equal(focus.slice(0, 4), "→ ✓ ", `焦点行应同时带两个标记，实际: ${JSON.stringify(focus.slice(0, 6))}`);
});

await step("R4 溢出策略：父级行宽度不够时先截值不动标记；候选项的 ` · default` 永不被截断", () => {
  const harness = makeHarness();
  const item = settings.buildSettingItems(harness.host.config()).find((candidate) => candidate.id === "minLevel");
  assert.equal(harness.host.saveDefault(item, "warning").ok, true);

  // 宽终端：两列完整（直接 saveDefault 后，当前值也随用户默认一起变成 warning）
  const wide = rowWith(harness.render(60), "最低等级");
  assert.match(wide, /✓ warning/, `宽终端丢了当前值: ${JSON.stringify(wide)}`);
  assert.match(wide, /default warning/, `宽终端丢了 default 标记: ${JSON.stringify(wide)}`);

  // 中等宽度（40）：标签必须完整（先保「认得出是哪一项」），default 列此时让位
  const medium = rowWith(harness.render(40), "最低等级");
  assert.ok(medium, "40 列下标签被截断了");
  assert.match(medium, /✓ warning/, "current 值列应保留");

  // 窄终端（20）：降级为只显示当前值列（标签可能被截断，所以按行号取），且绝不超宽
  const narrow = harness.render(20);
  assert.ok(narrow.every((line) => tui.visibleWidth(line) <= 20), "渲染行超过了给定宽度");
  const narrowRow = narrow[3]; // 第 2 个数据行 = 基础 · 最低等级
  assert.match(narrowRow, /✓ /, `窄终端至少应保留当前值标记: ${JSON.stringify(narrowRow)}`);
  assert.ok(!narrowRow.includes(" · default") || tui.visibleWidth(narrowRow) <= 20);

  // 候选项行：宽度先分配给标记与尾标，` · default` 永不被截断
  const candidateLines = harness.render(32);
  harness.press(KEY.down);
  harness.press(KEY.enter);
  const detail = harness.render(32);
  assert.ok(
    detail.some((line) => line.includes("· default")),
    `候选项行在 32 列下应保留 default 尾标:\n${detail.slice(0, 8).join("\n")}`,
  );
  assert.ok(detail.every((line) => tui.visibleWidth(line) <= 32), "候选项行超宽");
  assert.equal(candidateLines.length, detail.length, "行数应稳定（footer 常驻）");
});

// ---------------------------------------------------------------------------
// K：键盘与焦点
// ---------------------------------------------------------------------------

await step("K1 ↑↓ 移动焦点；Enter 进入详情；Esc 返回后父级焦点不变", () => {
  const harness = makeHarness();
  assert.match(focusRow(harness.render(80)), /基础 · 总开关/);
  harness.press(KEY.down);
  harness.press(KEY.down);
  assert.match(focusRow(harness.render(80)), /通知规则 · 运行完成 · 开关/);
  harness.press(KEY.up);
  assert.match(focusRow(harness.render(80)), /基础 · 最低等级/);
  harness.press(KEY.enter);
  assert.equal(harness.state().view.kind, "detail");
  harness.press(KEY.escape);
  assert.equal(harness.state().view.kind, "list");
  assert.match(focusRow(harness.render(80)), /基础 · 最低等级/, "返回父级后焦点应保持在原项");
});

await step("K2 进入详情时焦点落在「当前值」那一行", () => {
  const harness = makeHarness();
  harness.press(KEY.down);
  harness.press(KEY.enter);
  const focus = focusRow(harness.render(80));
  assert.equal(focus.slice(2, 4), "✓ ", `详情焦点应在当前值行: ${JSON.stringify(focus.slice(0, 8))}`);
});

await step("K3 长列表滚动：焦点行始终在可视窗口内，位置提示走独立一行", () => {
  const harness = makeHarness();
  for (let index = 0; index < 20; index += 1) harness.press(KEY.down);
  const lines = harness.render(80);
  const focus = focusRow(lines);
  assert.ok(focus.length > 0, "焦点行不见了");
  assert.match(focus, /等待输入 · 等级/, `焦点应已移到列表下部: ${focus}`);
  const body = lines.slice(2, 14);
  assert.equal(body.length, 12, "列表可视化行数应固定");
  assert.match(lines[14], /\d+–\d+\/43/, `位置提示应在 hint 行: ${JSON.stringify(lines[14])}`);
  const focusIndex = body.findIndex((line) => line.startsWith("→ "));
  assert.ok(focusIndex >= 6, `滚动后焦点应位于窗口下半部，实际第 ${focusIndex} 行`);
  assert.ok(lines.every((line) => tui.visibleWidth(line) <= 80), "渲染行超宽");
});

// ---------------------------------------------------------------------------
// D：Ctrl+S
// ---------------------------------------------------------------------------

await step("D1 Ctrl+S：标记迁移到当前值行 + 状态行给出确认（两者都要有）", () => {
  const harness = makeHarness();
  harness.press(KEY.down);
  harness.press(KEY.enter); // 最低等级详情，焦点在 info（当前值）
  harness.press(KEY.ctrlS); // 先把 info 固化为用户默认
  const seeded = harness.render(80);
  assert.match(rowWith(seeded, "info"), /· default/, "第一次 Ctrl+S 应把 default 打到 info 行");
  assert.match(harness.state().message.text, /已保存为默认/);

  harness.press(KEY.down); // → warning
  harness.press(KEY.enter); // 当前值 = warning（仅本对话）
  harness.press(KEY.ctrlS); // 固化为用户默认
  const after = harness.render(80);
  const warningRow = rowWith(after, "warning");
  assert.match(warningRow, /✓ warning/, "当前值标记应在 warning 行");
  assert.match(warningRow, /· default/, "Ctrl+S 后 default 标记应迁移到 warning 行");
  const infoRow = rowWith(after, "info");
  assert.ok(!/· default/.test(infoRow ?? ""), `info 行的旧 default 标记未清除: ${JSON.stringify(infoRow)}`);
  assert.match(harness.state().message.text, /已保存为默认/, "标记迁移之外还要有轻量确认");
});

await step("D2 Ctrl+S 只写这一项（稀疏），其它字段不落进用户文件", () => {
  const harness = makeHarness();
  const item = settings.buildSettingItems(harness.host.config()).find((candidate) => candidate.id === "content.includeCost");
  harness.host.saveDefault(item, false);
  const raw = harness.userFile();
  assert.deepEqual(raw, { content: { includeCost: false } }, `用户文件应只含被保存的字段: ${JSON.stringify(raw)}`);
  // 再保存另一项：两项都在，且其余字段仍不出现
  const second = settings.buildSettingItems(harness.host.config()).find((candidate) => candidate.id === "coalesce.windowMs");
  harness.host.saveDefault(second, 0);
  assert.deepEqual(harness.userFile(), { content: { includeCost: false }, coalesce: { windowMs: 0 } });
});

await step("D3 保存失败：不迁移标记、当前值仍生效、状态行报错", () => {
  const harness = makeHarness();
  fs.mkdirSync(path.dirname(configModule.userConfigPath(agentDir)), { recursive: true });
  fs.writeFileSync(configModule.userConfigPath(agentDir), "{ 坏掉的 JSON");
  const item = settings.buildSettingItems(configModule.defaultConfig()).find((candidate) => candidate.id === "minLevel");
  const result = harness.host.saveDefault(item, "warning");
  assert.equal(result.ok, false);
  harness.press(KEY.ctrlS);
  assert.equal(harness.state().message.tone, "error");
  const lines = harness.render(80);
  assert.ok(lines.every((line) => !line.includes(" · default")), "失败时不该出现 default 标记");
  assert.match(rowWith(lines, "最低等级"), /✓ error/, "损坏配置时应显示降级后的生效值");
  assert.equal(fs.readFileSync(configModule.userConfigPath(agentDir), "utf8"), "{ 坏掉的 JSON", "失败时不得改写原文件");
  fs.rmSync(configModule.userConfigPath(agentDir), { force: true });
});

// ---------------------------------------------------------------------------
// C：集合字段
// ---------------------------------------------------------------------------

await step("C1 集合字段可多行同时带 `✓ `，Enter 切换成员", () => {
  const harness = makeHarness();
  const items = settings.buildSettingItems(harness.host.config());
  const index = items.findIndex((item) => item.id === "quietHours.exceptLevels");
  for (let step = 0; step < index; step += 1) harness.press(KEY.down);
  harness.press(KEY.enter);
  // 详情初始焦点落在「当前值」那一行（error），向上移到 warning 再加进去
  harness.press(KEY.up);
  harness.press(KEY.enter);
  const lines = harness.render(80);
  const checked = lines.filter((line) => line.includes("✓ "));
  assert.ok(checked.length >= 2, `集合应可多选，实际:\n${lines.slice(0, 8).join("\n")}`);
  const saved = settings.buildSettingItems(harness.host.config()).find((item) => item.id === "quietHours.exceptLevels");
  assert.deepEqual(harness.host.config().quietHours.exceptLevels, ["error", "warning"]);
  assert.deepEqual(saved.read(harness.host.config()), ["error", "warning"]);
});

await step("C2 集合字段的 Ctrl+S 写整个数组", () => {
  const harness = makeHarness();
  const item = settings.buildSettingItems(harness.host.config()).find((candidate) => candidate.id === "rules.runCompleted.channels");
  harness.host.setValue(item, []);
  harness.host.saveDefault(item, []);
  assert.deepEqual(harness.userFile(), { rules: { runCompleted: { channels: [] } } });
});

// ---------------------------------------------------------------------------
// I：数值 / 时间 / custom…
// ---------------------------------------------------------------------------

await step("I1 数值项：预设候选 + 末尾 `custom…`；当前值不在预设里时补一行", () => {
  const harness = makeHarness();
  const items = settings.buildSettingItems(harness.host.config());
  const index = items.findIndex((item) => item.id === "coalesce.windowMs");
  for (let step = 0; step < index; step += 1) harness.press(KEY.down);
  harness.press(KEY.enter);
  const lines = harness.render(80);
  assert.ok(rowWith(lines, settings.CUSTOM_ROW_LABEL), `缺少 custom… 行:\n${lines.slice(0, 8).join("\n")}`);
  assert.ok(rowWith(lines, "1500 ms"), "缺少预设候选");
});

await step("I2 custom… 输入：非法值就地报错且不改变当前值/用户默认", () => {
  const harness = makeHarness();
  const items = settings.buildSettingItems(harness.host.config());
  const index = items.findIndex((item) => item.id === "quietHours.start");
  for (let step = 0; step < index; step += 1) harness.press(KEY.down);
  harness.press(KEY.enter);
  // 走到 custom… 行
  let guard = 0;
  while (!focusRow(harness.render(80)).includes(settings.CUSTOM_ROW_LABEL) && guard < 40) {
    harness.press(KEY.down);
    guard += 1;
  }
  assert.ok(focusRow(harness.render(80)).includes(settings.CUSTOM_ROW_LABEL), "未能聚焦 custom… 行");
  harness.press(KEY.enter);
  assert.equal(harness.state().view.kind, "input");
  for (const character of ["2", "5", ":", "0", "0"]) {
    if (character === ":") harness.press(":");
    else harness.press(character);
  }
  harness.press(KEY.enter);
  assert.match(harness.state().view.error ?? "", /HH:MM/, "非法时间应就地报错");
  assert.equal(harness.host.config().quietHours.start, "23:00", "非法输入不得改变当前值");
  assert.equal(harness.userFile(), undefined, "非法输入不得写用户文件");
  harness.press(KEY.escape);
  assert.equal(harness.state().view.kind, "detail");
});

await step("I3 custom… 输入：合法值写入当前值", () => {
  const harness = makeHarness();
  const items = settings.buildSettingItems(harness.host.config());
  const index = items.findIndex((item) => item.id === "delivery.timeoutMs");
  for (let step = 0; step < index; step += 1) harness.press(KEY.down);
  harness.press(KEY.enter);
  let guard = 0;
  while (!focusRow(harness.render(80)).includes(settings.CUSTOM_ROW_LABEL) && guard < 40) {
    harness.press(KEY.down);
    guard += 1;
  }
  harness.press(KEY.enter);
  // 清空预填值后输入 4321
  for (let index2 = 0; index2 < 8; index2 += 1) harness.press(KEY.backspace);
  for (const character of "4321") harness.press(character);
  harness.press(KEY.enter);
  assert.equal(harness.host.config().delivery.timeoutMs, 4321);
  assert.ok(rowWith(harness.render(80), "4321 ms"), "补出来的当前值行应带 ✓ 标记");
});

// ---------------------------------------------------------------------------
// V：footer 与折叠动作
// ---------------------------------------------------------------------------

await step("V1 footer 常驻：每个视图的末尾都含 `Ctrl+S  save as default`", () => {
  const harness = makeHarness();
  const footer = "Ctrl+S  save as default";
  const assertFooter = (label) => {
    const lines = harness.render(80);
    assert.ok(
      lines.slice(-4).some((line) => line.includes(footer)),
      `${label}: footer 未常驻快捷键提示\n${lines.slice(-4).join("\n")}`,
    );
  };
  assertFooter("list");
  harness.press(KEY.enter);
  assertFooter("detail");
  harness.press(KEY.ctrlO);
  assertFooter("status");
  harness.press(KEY.escape);
  assert.ok(harness.finished === undefined, "Esc 在列表视图才结束组件");
});

await step("V2 Ctrl+T 发测试、Ctrl+R 重读、Ctrl+O 状态总览分页只读", () => {
  const harness = makeHarness();
  harness.press(KEY.ctrlT);
  assert.match(harness.state().message.text, /自检/);
  harness.press(KEY.ctrlR);
  assert.match(harness.state().message.text, /重新读取/);
  harness.press(KEY.ctrlO);
  assert.equal(harness.state().view.kind, "status");
  const lines = harness.render(80);
  assert.ok(lines.some((line) => line.includes("终端机制")), "状态总览应显示状态文本");
  harness.press(KEY.down);
  assert.equal(harness.state().view.kind, "status", "状态总览里滚动不应退出视图");
  harness.press(KEY.escape);
  assert.equal(harness.state().view.kind, "list");
  assert.equal(harness.calls.reload, 1);
  assert.ok(harness.calls.status > 0);
});

await step("V3 Esc 在列表视图结束组件，并带回摘要", () => {
  const harness = makeHarness();
  harness.press(KEY.down); // 基础 · 最低等级
  harness.press(KEY.enter); // 焦点落在当前值 info
  harness.press(KEY.down); // warning
  harness.press(KEY.down); // error
  harness.press(KEY.enter); // 本对话改为 error
  harness.press(KEY.ctrlS); // 固化为用户默认
  harness.press(KEY.escape); // 回列表
  assert.equal(harness.finished, undefined, "详情页的 Esc 只应返回上一级");
  harness.press(KEY.escape); // 关闭
  assert.deepEqual(harness.finished, { savedDefaults: 1, changed: 1 });
});

// ---------------------------------------------------------------------------
// S：三层值模型（overlay 优先级、fork 不继承）
// ---------------------------------------------------------------------------

await step("S1 applyOverlay：本对话覆盖 > 用户默认，未覆盖字段原样保留", () => {
  const base = configModule.defaultConfig();
  base.minLevel = "error"; // 假装这是用户默认读出来的值
  const applied = settings.applyOverlay(base, {
    patch: settings.setPatchPath({}, "minLevel", "warning"),
    providers: {},
  });
  assert.equal(applied.problems.length, 0);
  assert.equal(applied.config.minLevel, "warning", "本对话覆盖应压过用户默认");
  assert.deepEqual(applied.config.content, base.content, "未覆盖的字段必须原样保留");
  assert.equal(base.minLevel, "error", "applyOverlay 不得修改入参");
});

await step("S2 applyOverlay：规则单项覆盖不会重置同规则其它字段（base 继承）", () => {
  const base = configModule.defaultConfig();
  base.rules.runCompleted.channels = ["debug"];
  const applied = settings.applyOverlay(base, {
    patch: settings.setPatchPath({}, "rules.runCompleted.level", "warning"),
    providers: {},
  });
  assert.equal(applied.config.rules.runCompleted.level, "warning");
  assert.equal(applied.config.rules.runCompleted.enabled, true, "enabled 被重置了（checkRules 没从 base 继承）");
  assert.deepEqual(applied.config.rules.runCompleted.channels, ["debug"], "channels 被重置了");
});

await step("S3 applyOverlay：非法覆盖整体忽略并回报问题，绝不让投递变坏", () => {
  const base = configModule.defaultConfig();
  const applied = settings.applyOverlay(base, { patch: { minLevel: "loud" }, providers: {} });
  assert.equal(applied.problems.length >= 1, true);
  assert.equal(applied.config.minLevel, "info", "非法覆盖不应改变生效值");
  assert.deepEqual(applied.config, base);
});

await step("S4 applyOverlay：渠道开关只带 id → enabled，options 不进会话条目", () => {
  const base = configModule.defaultConfig();
  base.providers[0].options = { url: "https://example.invalid/hook", secretEnv: "PI_NOTIFY_WEBHOOK_SECRET" };
  const overlay = { patch: {}, providers: { terminal: false } };
  const applied = settings.applyOverlay(base, overlay);
  assert.equal(applied.config.providers[0].enabled, false);
  assert.deepEqual(applied.config.providers[0].options, base.providers[0].options, "渠道 options 应保持不变");
  assert.equal(JSON.stringify(overlay).includes("secretEnv"), false, "覆盖里不得出现渠道凭据/options");
});

await step("S5 会话覆盖恢复：只认本 sessionId；fork 复制来的旧条目必须忽略", () => {
  const entry = (sessionId, minLevel) => ({
    type: "custom",
    customType: settings.SESSION_OVERLAY_ENTRY,
    data: { sessionId, patch: { minLevel }, providers: {}, at: 1 },
  });
  const entries = [entry("session-A", "error"), entry("session-B", "warning")];
  const forB = settings.restoreOverlayFromEntries(entries, "session-B");
  assert.equal(forB.patch.minLevel, "warning", "应恢复本会话自己的覆盖");
  const forC = settings.restoreOverlayFromEntries(entries, "session-C");
  assert.deepEqual(forC, { patch: {}, providers: {} }, "fork 出来的新会话不得继承旧覆盖");
  const twice = [entry("session-B", "error"), entry("session-B", "warning")];
  assert.equal(settings.restoreOverlayFromEntries(twice, "session-B").patch.minLevel, "warning");
  const noise = [{ type: "message" }, { type: "custom", customType: "tools-config", data: { sessionId: "session-B" } }, ...twice];
  assert.equal(settings.restoreOverlayFromEntries(noise, "session-B").patch.minLevel, "warning");
  assert.deepEqual(settings.restoreOverlayFromEntries(noise, undefined), { patch: {}, providers: {} });
});

console.log(`\n通过：通知设置组件回归（${passed} 项）`);
fs.rmSync(TMP, { recursive: true, force: true });
