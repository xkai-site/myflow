/**
 * Pure component regression for the settings UI: no real host and no writes to the real user directory.
 *
 * Covers the parts that look right but are easy to get wrong:
 *   N  navigation: the home page holds the two global fields, one row per category and two actions;
 *      Enter opens a category/rule/detail, Esc pops one level and restores the parent focus
 *   R  rendering: rows show the current value next to the label inside an 80-column content cap
 *      (no uniform checkmark, no repeated `未保存`), the focused row's three layers are wrapped into
 *      a readable help line, and candidate rows keep their marker columns
 *   K  keyboard: up/down movement, Enter to enter/select, Space quick toggle, Esc back
 *   D  Ctrl+S: the marker moves and the status line reports the action at the same time, only that
 *      one setting is written, and the already effective value is saved rather than a hovered row
 *   C  collection fields: Enter/Space toggles a member and several rows can carry `✓ `; saving writes
 *      the whole array
 *   I  numbers and times: preset candidates plus a `自定义…` input row, where an illegal value reports
 *      the problem in place without changing any state
 *   V  persistent footer and folded actions: the footer always shows `Ctrl+S 保存为默认`, and
 *      Ctrl+T/R/O stay available
 *   X  forced silence is shown as an extra restriction, never as a user default of "off"
 *
 * Like the other scripts it needs `MSYS_NO_PATHCONV=1` under Git Bash:
 *   MSYS_NO_PATHCONV=1 node test/settings-ui.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { resolvePiPackageEntry, resolveSdkEntry } from "./sdk-path.mjs";

// ui.ts imports @earendil-works/pi-tui, which resolves inside the pi/SDK loader but not under bare
// node, so the source is loaded through jiti with an alias.
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
// Keys (real terminal bytes; `matchesKey` takes the key name as its second argument)
// ---------------------------------------------------------------------------

const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  escape: "\x1b",
  space: " ",
  backspace: "\x7f",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  ctrlS: "\x13",
  ctrlT: "\x14",
  ctrlR: "\x12",
  ctrlO: "\x0f",
};

// ---------------------------------------------------------------------------
// Test harness
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

/** A clean user directory and a component instance per test; the host uses the real config and settings functions. */
function makeHarness(userConfig, options = {}) {
  fs.rmSync(path.join(agentDir, "pi-notification"), { recursive: true, force: true });
  if (userConfig !== undefined) {
    fs.mkdirSync(path.dirname(configModule.userConfigPath(agentDir)), { recursive: true });
    fs.writeFileSync(configModule.userConfigPath(agentDir), JSON.stringify(userConfig));
  }
  let overlay = settings.emptyOverlay();
  const calls = { set: [], save: [], test: 0, reload: 0, status: 0, preview: 0, follow: [], restore: [] };
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
    sessionOverride: (item) => settings.sessionOverrideValue(overlay, item),
    restrictions: () => options.restrictions ?? [],
    setValue(item, value) {
      calls.set.push({ id: item.id, value });
      const patch = item.patch(value);
      if (patch.kind === "providers") overlay.providers[patch.id] = patch.value;
      else if (patch.kind === "providerOption") overlay.providerOptions[patch.id] = settings.setPatchPath(overlay.providerOptions[patch.id] ?? {}, patch.optionPath, patch.value);
      else overlay.patch = settings.setPatchPath(overlay.patch, patch.path, patch.value);
      return { ok: true, message: "已选择（仅本对话）" };
    },
    saveDefault(item, value) {
      calls.save.push({ id: item.id, value });
      const patch = item.patch(value);
      const configPatch = patch.kind === "providers"
        ? settings.channelUserFilePatch(host.userRaw(), patch.id, effective().providers.find((provider) => provider.id === patch.id)?.type ?? "terminal", patch.value)
        : patch.kind === "providerOption"
          ? settings.providerOptionUserFilePatch(host.userRaw(), patch.id, "email", patch.optionPath, patch.value)
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
    testEmail() { return { ok: true, message: "已提交邮箱测试；SMTP 接受不等于送达" }; },
    credentialStatus: () => options.vault?.value ? "已保存于 Windows 凭据管理器" : "未设置",
    saveCredential(value) {
      if (options.vault) options.vault.value = value;
      return { ok: true, message: "授权码已保存" };
    },
    deleteCredential() {
      if (options.vault) delete options.vault.value;
      return { ok: true, message: "授权码已移除" };
    },
    openQqSettings: () => { calls.openQqSettings = (calls.openQqSettings ?? 0) + 1; return { ok: true, message: "已打开 QQ 邮箱" }; },
    reload() {
      calls.reload += 1;
      return { ok: true, message: "已重新读取配置" };
    },
    statusLines() {
      calls.status += 1;
      return ["pi-notification: 开启", "  终端机制: toast", ...Array.from({ length: 20 }, (_, index) => `  行 ${index + 1}`)];
    },
    preview() {
      calls.preview += 1;
      return { ok: true, message: "通知预览（内容示意，不会发送）", lines: ["示例（不会发送）：固定数据", "标题：任务完成 · 示例会话", "正文：本次成本 $0.0123 · 当前会话已知累计 $0.0456"] };
    },
    followUserDefault(item) {
      calls.follow.push(item.id);
      overlay = settings.clearItemOverride({ patch: overlay.patch, providers: overlay.providers }, item);
      return { ok: true, message: `已沿用以后默认「${item.label}」` };
    },
    restoreBuiltinDefault(item) {
      calls.restore.push(item.id);
      const removal = item.providerId !== undefined
        ? { kind: "provider", id: item.providerId }
        : { kind: "path", path: item.userPath };
      const result = configModule.deleteUserDefault(agentDir, removal);
      if (!result.ok) return { ok: false, message: `恢复失败：${result.problems.map((problem) => problem.path).join(",")}` };
      overlay = settings.clearItemOverride({ patch: overlay.patch, providers: overlay.providers }, item);
      return { ok: true, message: `已恢复「${item.label}」内置默认` };
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
    /** Drops the render cache after a direct host mutation (tests that bypass the keyboard). */
    redraw() { component.invalidate(); },
    state() { return component.debugState(); },
    userFile() {
      const raw = configModule.readUserConfigRaw(agentDir);
      return raw.ok ? raw.raw : undefined;
    },
  };
}

/** The focused row (carries `→ `). */
const focusRow = (lines) => lines.find((line) => line.startsWith("→ ")) ?? "";
/** The row containing a given text. */
const rowWith = (lines, needle) => lines.find((line) => line.includes(needle));
/** Joins a frame and drops all whitespace, so a wrap point never breaks a phrase assertion (CJK wraps per character). */
const squash = (lines) => lines.join("").replace(/\s+/g, "");
/**
 * Pages through the read-only details view one row at a time and returns every row exactly once.
 * `checkFrame` (optional) receives each rendered frame, so callers can assert width/height bounds.
 */
function collectHelpRows(harness, width, checkFrame) {
  const rows = [];
  let guard = 0;
  while (guard < 200) {
    const lines = harness.render(width);
    if (checkFrame) checkFrame(lines);
    const offset = harness.state().view.offset;
    if (rows[offset] === undefined) rows[offset] = lines[2] ?? "";
    harness.press(KEY.down);
    const next = harness.state().view.offset;
    if (next === offset) {
      const last = harness.render(width);
      for (let index = 0; index < 12; index += 1) {
        if (rows[offset + index] === undefined) rows[offset + index] = last[2 + index] ?? "";
      }
      break;
    }
    guard += 1;
  }
  return rows;
}
/** Display column of a text inside a line, zero-based. */
const columnOf = (line, needle) => tui.visibleWidth(line.slice(0, line.indexOf(needle)));

// ---------------------------------------------------------------------------
// Navigation helpers: drive the real key handling instead of a flat list index
// ---------------------------------------------------------------------------

/** Walks back to the home page from wherever the component is. */
function goHome(harness) {
  for (let guard = 0; guard < 30; guard += 1) {
    const state = harness.state();
    if (state.view.kind === "menu" && state.view.id === "home") return;
    harness.press(KEY.escape);
  }
  throw new Error("无法返回首页");
}

/** Moves the focus within the current page to `key` (no Enter). */
function moveToRow(harness, key) {
  const state = harness.state();
  const index = state.rows.indexOf(key);
  assert.ok(index >= 0, `当前页缺少行 ${key}：${state.rows.join(",")}`);
  const delta = index - state.focus;
  for (let step = 0; step < Math.abs(delta); step += 1) harness.press(delta > 0 ? KEY.down : KEY.up);
}

/** Moves the focus to `key` and opens it with Enter. */
function openRow(harness, key) {
  moveToRow(harness, key);
  harness.press(KEY.enter);
}

function itemOf(harness, id) {
  const item = settings.buildSettingItems(harness.host.config()).find((candidate) => candidate.id === id);
  assert.ok(item, `未知配置项: ${id}`);
  return item;
}

/** Navigates from the home page to the page holding the item's row (category / rule / home). */
function pageForItem(harness, item) {
  goHome(harness);
  if (item.rule) {
    openRow(harness, "category:rules");
    openRow(harness, `rule:${item.rule.key}`);
    return;
  }
  const category = settings.SETTING_CATEGORIES.find((candidate) => candidate.group === item.group);
  if (!category) return;
  openRow(harness, `category:${category.id}`);
  if (category.collapsed && category.collapsed.when(harness.host.config()) && category.collapsed.ids.includes(item.id)) {
    openRow(harness, `subgroup:${category.id}`);
  }
}

/** Focuses an item's row without opening it (used for Space / Ctrl+S on a page). */
function focusItem(harness, id) {
  const item = itemOf(harness, id);
  pageForItem(harness, item);
  moveToRow(harness, `item:${id}`);
  return item;
}

/** Focuses an item's row and opens its candidate detail view. */
function openItem(harness, id) {
  const item = focusItem(harness, id);
  harness.press(KEY.enter);
  assert.equal(harness.state().view.kind, "detail", `未能打开 ${id} 的详情`);
  return item;
}

// ---------------------------------------------------------------------------
// N: home page and navigation
// ---------------------------------------------------------------------------

await step("N1 首页简洁：两个全局字段 + 五个场景入口，不平铺全部字段", () => {
  const harness = makeHarness();
  const rows = harness.state().rows;
  assert.deepEqual(rows, [
    "item:enabled",
    "item:minLevel",
    "category:rules",
    "category:content",
    "category:quietHours",
    "category:channels",
    "category:advanced",
  ], `首页行不符: ${JSON.stringify(rows)}`);
  const frame = harness.render(80).join("\n");
  assert.match(frame, /启用通知/);
  assert.match(frame, /通知门槛/);
  assert.match(frame, /通知场景/);
  assert.match(frame, /通知内容/);
  assert.match(frame, /安静时间/);
  assert.match(frame, /通知方式/);
  assert.match(frame, /更多设置/);
  assert.doesNotMatch(frame, /发送测试通知/);
  assert.doesNotMatch(frame, /状态与诊断/);
  // Not a flat dump: a field buried in 高级设置 must not be on the home page.
  assert.ok(!/单次投递超时/.test(frame), "首页不应平铺高级设置字段");
  // The two global fields show their current value inline.
  assert.match(rowWith(harness.render(80), "启用通知"), /开启/);
  assert.match(rowWith(harness.render(80), "通知门槛"), /所有等级/);
});

await step("N2 分类行带摘要：通知渠道计数、免打扰开关状态、规则列表摘要随配置变化", () => {
  const harness = makeHarness();
  let frame = harness.render(80).join("\n");
  assert.match(frame, /1 个已启用/, "渠道分类应显示启用数量");
  assert.match(frame, /未开启/, "安静时间默认应显示未开启");

  const quiet = itemOf(harness, "quietHours.enabled");
  harness.host.setValue(quiet, true);
  harness.redraw();
  frame = harness.render(80).join("\n");
  assert.match(frame, /23:00–08:00/, "安静时间开启后摘要应显示时段");

  const debug = { providers: [{ id: "hook", type: "debug", enabled: false }] };
  const two = makeHarness(debug);
  assert.match(two.render(80).join("\n"), /0 个已启用|无启用渠道/, "关闭的渠道不应计入启用数");
});

await step("N2b 邮箱配置位于通知渠道子页并包含规则开关、地址编辑与专用测试", () => {
  const harness = makeHarness();
  openRow(harness, "category:channels");
  assert.ok(harness.state().rows.includes("email-config"));
  openRow(harness, "email-config");
  assert.ok(harness.state().rows.includes("item:provider:email"));
  assert.ok(harness.state().rows.includes("item:provider:email:from"));
  assert.ok(harness.state().rows.includes("item:provider:email:to"));
  assert.ok(harness.state().rows.includes("action:email-test"));
  assert.ok(harness.state().rows.includes("action:credential-save"));
  assert.ok(harness.state().rows.includes("action:credential-delete"));
  assert.ok(harness.state().rows.includes("qq:settings"));
});

await step("N2c 邮箱已开启时测试前提准确指出缺失项，而非误报开关关闭", () => {
  const harness = makeHarness();
  openRow(harness, "category:channels");
  openRow(harness, "email-config");
  moveToRow(harness, "item:provider:email");
  harness.press(KEY.space);
  let effective = harness.host.config();
  assert.equal(effective.providers.find((provider) => provider.id === "email").enabled, true);
  assert.match(settings.emailTestBlockReason(effective, false), /已开启.*发件/);
  harness.host.setValue(itemOf(harness, "provider:email:from"), "sender@qq.com");
  effective = harness.host.config();
  assert.match(settings.emailTestBlockReason(effective, false), /已开启.*收件/);
  harness.host.setValue(itemOf(harness, "provider:email:to"), ["reader@example.org"]);
  effective = harness.host.config();
  assert.match(settings.emailTestBlockReason(effective, false), /已开启.*凭据管理器.*PI_NOTIFY_QQ_SMTP_AUTH_CODE/);
  assert.equal(settings.emailTestBlockReason(effective, true), undefined);
  effective.providers.find((provider) => provider.id === "email").enabled = false;
  assert.match(settings.emailTestBlockReason(effective, true), /邮箱渠道未开启/);
});

await step("N2d 遮蔽输入只进凭据管理器；蓝色官网链接可点击且 Enter 可打开", () => {
  const vault = {};
  const harness = makeHarness(undefined, { vault });
  openRow(harness, "category:channels");
  openRow(harness, "email-config");
  moveToRow(harness, "qq:settings");
  const linked = harness.render(80).join("\n");
  assert.match(linked, /\x1b\[94m\x1b\]8;;https:\/\/mail\.qq\.com\//);
  harness.press(KEY.enter);
  assert.equal(harness.calls.openQqSettings, 1);
  openRow(harness, "action:credential-save");
  assert.equal(harness.state().view.kind, "secret");
  const secret = "qQTOKEN_1234";
  for (const char of secret) harness.press(char);
  assert.ok(!harness.render(80).join("\n").includes(secret), "遮蔽输入不应泄露明文");
  harness.press(KEY.enter);
  assert.equal(vault.value, secret);
  assert.ok(!JSON.stringify(harness.host.userRaw() ?? {}).includes(secret), "用户配置不应包含授权码");
  assert.ok(!harness.render(80).join("\n").includes(secret));
  openRow(harness, "action:credential-delete");
  harness.press(KEY.enter); // 默认取消
  assert.equal(vault.value, secret);
  openRow(harness, "action:credential-delete");
  harness.press(KEY.down);
  harness.press(KEY.enter);
  assert.equal(vault.value, undefined);
});

await step("N3 Enter 打开分类/规则，Esc 逐级返回且恢复父级焦点", () => {
  const harness = makeHarness();
  moveToRow(harness, "category:advanced");
  harness.press(KEY.enter);
  let state = harness.state();
  assert.equal(state.view.kind, "menu");
  assert.equal(state.view.id, "category:advanced");
  assert.ok(state.rows.includes("item:delivery.timeoutMs"));
  harness.press(KEY.escape);
  state = harness.state();
  assert.equal(state.view.id, "home");
  assert.equal(state.rows[state.focus], "category:advanced", "Esc 应回到原分类行");

  openRow(harness, "category:rules");
  assert.equal(harness.state().view.id, "category:rules");
  assert.deepEqual(harness.state().rows.slice(0, 2), ["rule:runCompleted", "rule:runFailed"]);
  harness.press(KEY.escape);
  assert.equal(harness.state().view.id, "home");
});

await step("N4 首页 Esc 关闭组件；详情/状态/帮助的 Esc 只返回上一级", () => {
  const harness = makeHarness();
  harness.press(KEY.escape);
  assert.deepEqual(harness.finished, { savedDefaults: 0, changed: 0 }, "首页 Esc 应关闭并带回摘要");
});

await step("N5 状态/输入/帮助返回原入口（不是一律回首页），并保留父级焦点", () => {
  const harness = makeHarness();
  openRow(harness, "category:advanced");
  moveToRow(harness, "item:delivery.timeoutMs");
  harness.press(KEY.enter);
  // Open the custom input from the candidate list, then cancel back to the detail page.
  let guard = 0;
  while (!focusRow(harness.render(80)).includes(settings.CUSTOM_ROW_LABEL) && guard < 40) {
    harness.press(KEY.down);
    guard += 1;
  }
  harness.press(KEY.enter);
  assert.equal(harness.state().view.kind, "input");
  harness.press(KEY.escape);
  assert.equal(harness.state().view.kind, "detail", "输入页 Esc 应回原详情页");

  // Status opened from the detail returns to that detail, not to the home page.
  harness.press(KEY.ctrlO);
  assert.equal(harness.state().view.id, "status");
  harness.press(KEY.escape);
  assert.equal(harness.state().view.kind, "detail", "状态页 Esc 应回原入口");

  // And the detail returns to the advanced page with its focus still on the same row.
  harness.press(KEY.escape);
  assert.equal(harness.state().view.id, "category:advanced");
  assert.equal(harness.state().rows[harness.state().focus], "item:delivery.timeoutMs", "应保留父级焦点");
});

await step("N6 条件展示：免打扰关闭时收起时间/例外，规则关闭仍可进入并解释“启用后生效”，工具失败窗口按模式显隐", () => {
  const harness = makeHarness();
  // 免打扰默认关闭：只留开关 + 一个可展开行。
  openRow(harness, "category:quietHours");
  assert.deepEqual(harness.state().rows, ["item:quietHours.enabled", "subgroup:quietHours"], `关闭时应收起时间与例外: ${JSON.stringify(harness.state().rows)}`);
  openRow(harness, "subgroup:quietHours");
  assert.deepEqual(harness.state().rows, ["item:quietHours.start", "item:quietHours.end", "item:quietHours.exceptLevels"], "收起项仍要可达");
  harness.press(KEY.escape);
  harness.press(KEY.escape);

  // 打开免打扰后，时间与例外直接平铺。
  goHome(harness);
  focusItem(harness, "quietHours.enabled");
  harness.press(KEY.space);
  goHome(harness);
  openRow(harness, "category:quietHours");
  assert.deepEqual(harness.state().rows, ["item:quietHours.enabled", "item:quietHours.start", "item:quietHours.end", "item:quietHours.exceptLevels"], "启用后应展开");

  // 关闭的规则：字段仍可进入，且写明启用后生效。
  goHome(harness);
  openRow(harness, "category:rules");
  openRow(harness, "rule:runAborted");
  assert.ok(harness.state().rows.includes("item:rules.runAborted.enabled"), "关闭的规则仍应有可配置字段");
  assert.ok(squash(harness.render(80)).includes("该规则已关闭"), `关闭规则应解释启用后生效: ${squash(harness.render(80))}`);

  // immediate 专用的聚合窗口：aggregate 模式下不出现，切到 immediate 后出现。
  goHome(harness);
  openRow(harness, "category:advanced");
  assert.ok(!harness.state().rows.includes("item:coalesce.toolFailureWindowMs"), "aggregate 模式不应展示 immediate 专用窗口");
  assert.ok(harness.state().rows.includes("item:coalesce.windowMs"), "通用窗口必须保留");
  const mode = itemOf(harness, "rules.toolFailed.mode");
  harness.host.setValue(mode, "immediate");
  harness.press(KEY.ctrlR); // refresh rebuilds the page rows from the new config
  assert.ok(harness.state().rows.includes("item:coalesce.toolFailureWindowMs"), "immediate 模式应展示聚合窗口");
});

await step("N7 分类摘要与帮助随配置刷新，不残留旧值", () => {
  const harness = makeHarness();
  const terminal = itemOf(harness, "provider:terminal");
  harness.host.setValue(terminal, false);
  harness.redraw();
  assert.match(harness.render(80).join("\n"), /0 个已启用|无启用渠道/, "关闭渠道后摘要应刷新");
  const minLevel = itemOf(harness, "minLevel");
  harness.host.setValue(minLevel, "error");
  moveToRow(harness, "item:minLevel");
  const frame = harness.render(80).join("\n");
  assert.match(rowWith(harness.render(80), "通知门槛"), /仅错误/, "阈值摘要应随本对话值刷新");
  assert.match(frame, /本对话已覆盖/, "来源帮助应随覆盖刷新");
});

await step("N8 窄屏修复：菜单标签可读、摘要简短让位，footer 始终能看到 Ctrl+S", () => {
  const harness = makeHarness();
  // Rule category summary is short instead of a comma-joined list of every event name.
  assert.match(squash(harness.render(80)), /4类已开启/, "规则分类摘要应简短");

  for (const width of [20, 24, 30, 40, 80]) {
    const lines = harness.render(width);
    assert.ok(lines.every((line) => tui.visibleWidth(line) <= width), `${width} 列：行超宽`);
    const frame = squash(lines);
    // Labels must survive: the summary yields, not the category name.
    assert.ok(frame.includes("通知场景"), `${width} 列：分类标签被摘要挤掉`);
    assert.ok(frame.includes("通知方式"), `${width} 列：分类标签被摘要挤掉`);
    // The core save key stays visible (it is the first item on the footer line).
    assert.ok(
      lines.some((line) => line.includes("Ctrl+S 设为以后默认")),
      `${width} 列：footer 看不到 Ctrl+S 设为以后默认\n${lines.join("\n")}`,
    );
    const footerLine = lines.find((line) => line.includes("Ctrl+S"));
    assert.ok(footerLine !== undefined && footerLine.indexOf("Ctrl+S") <= 2, `${width} 列：Ctrl+S 应排在最前`);
  }
});

// ---------------------------------------------------------------------------
// SE: search
// ---------------------------------------------------------------------------

await step("SE1 搜索：覆盖完整字段表（含当前不生效项）、结果带路径、Enter 可预配置、Esc 返回原位置", () => {
  const harness = makeHarness();
  harness.press("/"); // home shortcut
  assert.equal(harness.state().view.kind, "search");
  for (const character of "聚合窗口") harness.press(character);
  const frame = harness.render(80).join("\n");
  assert.match(frame, /工具失败聚合窗口/, `搜索应能找到当前不生效的字段:\n${frame}`);
  assert.ok(harness.state().rows.includes("item:coalesce.toolFailureWindowMs"), "结果应携带该字段");
  assert.match(squash(harness.render(80)), /高级设置|更多设置/, "结果应携带路径");
  assert.match(squash(harness.render(80)), /未生效/, "应标出当前不生效");

  // Enter opens the field even though it is hidden from the advanced page right now.
  harness.press(KEY.enter);
  assert.equal(harness.state().view.kind, "detail");
  harness.press("?");
  const help = squash(collectHelpRows(harness, 40));
  assert.ok(help.includes("尚未生效"), `帮助应解释尚未生效原因: ${help}`);
  assert.ok(!help.includes("自动开启"), help);
  harness.press(KEY.escape); // detail
  harness.press(KEY.escape); // search
  assert.equal(harness.state().view.kind, "search", "Esc 应回到搜索前位置");
  assert.equal(harness.state().view.query, "聚合窗口", "搜索词应保留");
  harness.press(KEY.escape); // home
  assert.equal(harness.state().view.id, "home");
});

// ---------------------------------------------------------------------------
// PR: local preview
// ---------------------------------------------------------------------------

await step("PR1 通知预览：固定示例、标注不会发送、零投递零写盘", () => {
  const harness = makeHarness();
  openRow(harness, "category:content");
  assert.ok(harness.state().rows.includes("action:preview"), "通知内容页应有预览入口");
  openRow(harness, "action:preview");
  assert.equal(harness.state().view.kind, "preview");
  const frame = harness.render(80).join("\n");
  assert.match(frame, /示例（不会发送）/, `预览应标注示意: ${frame}`);
  assert.match(frame, /不会发送/);
  assert.equal(harness.calls.preview, 1);
  assert.equal(harness.calls.test, 0, "预览不得触发送测试通知");
  assert.equal(harness.calls.save.length, 0, "预览不得写盘");
  harness.press(KEY.escape);
  assert.equal(harness.state().view.id, "category:content");
});

// ---------------------------------------------------------------------------
// RS: restore actions
// ---------------------------------------------------------------------------

await step("RS1 字段详情动作区：a 只改用以后默认；d 进确认页且默认焦点是取消", () => {
  const harness = makeHarness();
  harness.host.saveDefault(itemOf(harness, "minLevel"), "warning");
  harness.host.setValue(itemOf(harness, "minLevel"), "error");
  focusItem(harness, "minLevel");
  harness.press("?");
  const help = squash(collectHelpRows(harness, 40));
  assert.ok(help.includes("操作：a"), `详情应有恢复动作区: ${help}`);
  assert.ok(help.includes("操作：d"), help);

  harness.press("a");
  assert.deepEqual(harness.calls.follow.at(-1), "minLevel");
  assert.equal(harness.state().view.kind, "help", "沿用以后默认后仍停留在详情");
  assert.equal(settings.sessionOverrideValue(harness.overlay(), itemOf(harness, "minLevel")), undefined, "本对话覆盖应被清除");
  assert.deepEqual(harness.userFile(), { minLevel: "warning" }, "用户默认不得被 a 改动");

  harness.press("d");
  assert.equal(harness.state().view.kind, "confirm");
  assert.equal(harness.state().focus, 0, "默认焦点应在取消");
  const confirmFrame = squash(harness.render(80));
  assert.ok(confirmFrame.includes("取消") && confirmFrame.includes("确认恢复"), confirmFrame);
  assert.ok(confirmFrame.includes("仅此字段"), "确认页应说明影响范围");

  const before = JSON.stringify(harness.userFile());
  harness.press(KEY.escape);
  assert.equal(harness.state().view.kind, "help");
  assert.deepEqual(harness.calls.restore, [], "取消不得触发恢复");
  assert.equal(JSON.stringify(harness.userFile()), before, "取消零写入");
});

await step("RS2 确认恢复：只清除该项用户默认与本对话覆盖，其他字段不动", () => {
  const harness = makeHarness({ content: { includeCost: false }, coalesce: { windowMs: 0 } });
  harness.host.setValue(itemOf(harness, "content.includeCost"), true);
  focusItem(harness, "content.includeCost");
  harness.press("?");
  harness.press("d");
  harness.press(KEY.down);
  harness.press(KEY.enter);
  assert.deepEqual(harness.calls.restore, ["content.includeCost"]);
  assert.deepEqual(harness.userFile(), { coalesce: { windowMs: 0 } }, `只应删目标字段: ${JSON.stringify(harness.userFile())}`);
  assert.equal(harness.host.config().content.includeCost, true, "恢复后应回到内置默认");
  assert.equal(settings.sessionOverrideValue(harness.overlay(), itemOf(harness, "content.includeCost")), undefined);
});

await step("RS3 渠道恢复：只删该 provider 的 enabled，保留定义/options/未知字段/其他渠道", () => {
  const harness = makeHarness({
    providers: [
      { id: "terminal", type: "terminal", enabled: true, options: {} },
      { id: "debug", type: "debug", enabled: true, options: { url: "https://example.invalid" }, note: "keep" },
    ],
  });
  focusItem(harness, "provider:terminal");
  harness.press("?");
  harness.press("d");
  harness.press(KEY.down);
  harness.press(KEY.enter);
  assert.deepEqual(harness.userFile(), {
    providers: [
      { id: "terminal", type: "terminal", options: {} },
      { id: "debug", type: "debug", enabled: true, options: { url: "https://example.invalid" }, note: "keep" },
    ],
  }, `只应删目标 enabled: ${JSON.stringify(harness.userFile())}`);
});

await step("RS4 恢复失败：损坏用户文件被拒绝，本对话值不被提前清除", () => {
  const harness = makeHarness();
  fs.mkdirSync(path.dirname(configModule.userConfigPath(agentDir)), { recursive: true });
  fs.writeFileSync(configModule.userConfigPath(agentDir), "{ 坏掉的 JSON");
  const item = itemOf(harness, "minLevel");
  harness.host.setValue(item, "error");
  focusItem(harness, "minLevel");
  harness.press("?");
  harness.press("d");
  harness.press(KEY.down);
  harness.press(KEY.enter);
  assert.equal(harness.state().message.tone, "error");
  assert.match(harness.state().message.text, /恢复失败|未改动/);
  assert.equal(fs.readFileSync(configModule.userConfigPath(agentDir), "utf8"), "{ 坏掉的 JSON", "不得改写损坏文件");
  assert.notEqual(settings.sessionOverrideValue(harness.overlay(), item), undefined, "失败时不得提前清除本对话值");
  fs.rmSync(configModule.userConfigPath(agentDir), { force: true });
});

await step("RA1 全页面渲染扫描：20/24/30/40/80 列无 undefined/[object/null 且不超宽", () => {
  const harness = makeHarness();
  const widths = [20, 24, 30, 40, 80];
  const scan = (label) => {
    for (const width of widths) {
      for (const line of harness.render(width)) {
        assert.ok(tui.visibleWidth(line) <= width, `${label} ${width} 列：行超宽`);
        assert.doesNotMatch(line, /undefined|\[object|null/, `${label} ${width} 列：渲染出占位文本 ${JSON.stringify(line)}`);
      }
    }
  };

  scan("home");
  // Search is intentionally tucked into 更多设置 rather than competing with the main overview.
  goHome(harness);
  openRow(harness, "category:advanced");
  assert.match(harness.render(80).join("\n"), /搜索设置/, "更多设置页应有搜索入口");
  goHome(harness);

  for (const id of ["category:rules", "category:content", "category:quietHours", "category:channels", "category:advanced"]) {
    goHome(harness);
    openRow(harness, id);
    scan(id);
  }
  goHome(harness);
  openRow(harness, "category:content");
  assert.match(harness.render(80).join("\n"), /通知预览/, "通知内容页应有预览入口");

  goHome(harness);
  openRow(harness, "category:rules");
  openRow(harness, "rule:runCompleted");
  scan("rule");
  goHome(harness);
  openRow(harness, "category:quietHours");
  openRow(harness, "subgroup:quietHours");
  scan("subgroup");

  openItem(harness, "minLevel");
  scan("detail");
  harness.press("?");
  scan("help");
  harness.press("d");
  scan("confirm");
  harness.press(KEY.escape);
  harness.press(KEY.escape);

  goHome(harness);
  harness.press("/");
  scan("search-empty");
  for (const character of "窗口") harness.press(character);
  scan("search-query");
  harness.press(KEY.escape);
  harness.press(KEY.ctrlO);
  scan("status");
  harness.press(KEY.escape);

  goHome(harness);
  openRow(harness, "category:content");
  openRow(harness, "action:preview");
  scan("preview");
  assert.equal(harness.state().view.kind, "preview");
});

// ---------------------------------------------------------------------------
// R: rendering and marker columns
// ---------------------------------------------------------------------------

await step("R1 首页与分类页：每行内联当前值（中文），无统一勾号与重复「未保存」", () => {
  const harness = makeHarness();
  const lines = harness.render(80);
  const row = rowWith(lines, "通知门槛");
  assert.ok(row, "缺少「通知门槛」行");
  assert.match(row, /所有等级/, "未内联展示当前值");
  assert.ok(!row.includes("✓"), `行不应有统一勾号: ${JSON.stringify(row)}`);
  const body = lines.slice(2, 14);
  assert.ok(body.every((line) => !line.includes("未保存")), `不应重复「未保存」:\n${body.join("\n")}`);
  assert.ok(body.every((line) => !/\btrue\b|\bfalse\b/.test(line)), "布尔值不应再以 true/false 展示");

  openRow(harness, "category:content");
  const content = harness.render(80);
  assert.match(rowWith(content, "包含助手摘录"), /关闭/, "分类页应内联布尔当前值");
});

await step("R2 详情标记列固定占位：`✓` 出现/消失都不改变值文本的起始列", () => {
  const harness = makeHarness();
  openItem(harness, "minLevel");
  const lines = harness.render(80);
  const current = rowWith(lines, "✓ 所有等级");
  const other = lines.find((line) => line.includes("警告及错误"));
  assert.ok(current && other, `候选项行缺失:\n${lines.slice(0, 8).join("\n")}`);
  assert.equal(columnOf(current, "所有等级"), 4, "带 ✓ 的行值文本应从第 5 列开始");
  assert.equal(columnOf(other, "警告及错误"), 4, "不带 ✓ 的行值文本也必须从第 5 列开始");
});

await step("R3 焦点通道与当前值通道独立：同一行可同时出现 `→ ` 与 `✓ `", () => {
  const harness = makeHarness();
  openItem(harness, "minLevel");
  const focus = focusRow(harness.render(80));
  assert.equal(focus.slice(0, 4), "→ ✓ ", `焦点行应同时带两个标记，实际: ${JSON.stringify(focus.slice(0, 6))}`);
});

await step("R4 溢出策略：值列紧邻名称；候选项的 ` · 默认` 永不被截断", () => {
  const harness = makeHarness();
  const item = itemOf(harness, "minLevel");
  assert.equal(harness.host.saveDefault(item, "warning").ok, true);

  // Wide terminal: the value sits next to the label, not at the right edge.
  const wide = rowWith(harness.render(60), "通知门槛");
  assert.match(wide, /警告及错误/, `宽终端丢了当前值: ${JSON.stringify(wide)}`);
  assert.ok(columnOf(wide, "警告及错误") < 40, `值应紧邻名称，实际列 ${columnOf(wide, "警告及错误")}`);

  // Narrow terminal (20): the label yields so the value stays visible, nothing exceeds the width.
  const narrow = harness.render(20);
  assert.ok(narrow.every((line) => tui.visibleWidth(line) <= 20), "渲染行超过了给定宽度");
  const narrowRow = narrow[3]; // 第 2 个数据行 = 通知门槛
  assert.match(narrowRow, /警告及错误/, `窄终端应优先保留值: ${JSON.stringify(narrowRow)}`);

  // Candidate rows: width goes to the markers and the suffix first, so ` · 默认` is never truncated.
  openItem(harness, "minLevel");
  const detail = harness.render(32);
  assert.ok(
    detail.some((line) => line.includes("· 默认")),
    `候选项行在 32 列下应保留「默认」尾标:\n${detail.slice(0, 8).join("\n")}`,
  );
  assert.ok(detail.every((line) => tui.visibleWidth(line) <= 32), "候选项行超宽");
});

await step("R5 内容区封顶 80 列；窄屏靠换行的字段帮助仍能读到完整名称与当前值", () => {
  const harness = makeHarness();
  // 160 columns: every line still stops at 80, so label and value stay together.
  const wide = harness.render(160);
  assert.ok(wide.every((line) => tui.visibleWidth(line) <= 80), "内容区应封顶 80 列");
  assert.ok(columnOf(rowWith(wide, "通知门槛"), "所有等级") < 40, "宽屏时值不应贴到屏幕边缘");

  const item = itemOf(harness, "minLevel");
  assert.equal(harness.host.saveDefault(item, "warning").ok, true);
  moveToRow(harness, "item:minLevel");

  // The home page keeps a short summary; name and current value survive the narrowest width.
  for (const width of [20, 40]) {
    const lines = harness.render(width);
    const frame = squash(lines);
    assert.ok(frame.includes("基础·通知门槛"), `${width} 列：摘要缺完整字段名`);
    assert.ok(frame.includes("警告及错误"), `${width} 列：摘要缺当前值`);
    assert.ok(frame.includes("?字段详情"), `${width} 列：缺字段详情入口提示`);
    assert.ok(lines.every((line) => tui.visibleWidth(line) <= width), `${width} 列：行超宽`);
    assert.ok(lines.length <= 26, `${width} 列：行数应受控（${lines.length} 行）`);
  }
  // At 40 columns the summary also states where the value comes from.
  const mid = squash(harness.render(40));
  assert.ok(mid.includes("跟随用户默认") || mid.includes("本对话已覆盖"), "40 列摘要应写明来源");

  // Enter opens the candidate detail; its help line is the same bounded summary.
  harness.press(KEY.enter);
  for (const width of [20, 40]) {
    const lines = harness.render(width);
    const frame = squash(lines);
    assert.ok(frame.includes("基础·通知门槛"), `${width} 列：详情摘要缺完整字段名`);
    assert.ok(frame.includes("警告及错误"), `${width} 列：详情摘要缺当前值`);
    assert.ok(lines.every((line) => tui.visibleWidth(line) <= width), `${width} 列：行超宽`);
    assert.ok(lines.length <= 26, `${width} 列：行数应受控（${lines.length} 行）`);
  }
});

await step("R6 极窄宽度契约：0/1/4/7 列都不超宽、不崩溃（首页/分类/详情都适用）", () => {
  const harness = makeHarness();
  assert.ok(harness.render(0).every((line) => tui.visibleWidth(line) <= 0), "0 列应返回空行");
  for (const width of [1, 4, 7]) {
    assert.ok(harness.render(width).every((line) => tui.visibleWidth(line) <= width), `首页 ${width} 列超宽`);
  }
  moveToRow(harness, "category:content");
  harness.press(KEY.enter);
  for (const width of [1, 4, 7]) {
    assert.ok(harness.render(width).every((line) => tui.visibleWidth(line) <= width), `分类 ${width} 列超宽`);
  }
  openItem(harness, "minLevel");
  for (const width of [1, 4, 7]) {
    assert.ok(harness.render(width).every((line) => tui.visibleWidth(line) <= width), `详情 ${width} 列超宽`);
  }
});

await step("R7 超长渠道 id/多渠道值不会把帮助撑成几十行", () => {
  const longId = `channel-${"x".repeat(160)}`;
  const second = `hook-${"y".repeat(80)}`;
  const harness = makeHarness({
    rules: { runCompleted: { channels: [longId, second] } },
    providers: [
      { id: longId, type: "debug", enabled: true },
      { id: second, type: "debug", enabled: true },
    ],
  });
  focusItem(harness, "rules.runCompleted.channels");
  for (const width of [20, 80]) {
    const frame = harness.render(width);
    assert.ok(frame.every((line) => tui.visibleWidth(line) <= Math.min(width, 80)), `${width} 列：超宽行`);
    assert.ok(frame.length <= 26, `${width} 列：帮助行数失控（${frame.length} 行）`);
  }
});

await step("R8 字段详情（?）：有界可翻页，长渠道 id 与三层来源逐页可达，Esc 返回且零写入", () => {
  const longId = `channel-${"x".repeat(160)}`;
  const second = `hook-${"y".repeat(80)}`;
  const harness = makeHarness({
    rules: { runCompleted: { channels: [longId, second] } },
    providers: [
      { id: longId, type: "debug", enabled: true },
      { id: second, type: "debug", enabled: true },
    ],
  });
  focusItem(harness, "rules.runCompleted.channels");
  const before = { set: harness.calls.set.length, save: harness.calls.save.length, test: harness.calls.test };

  harness.press("?");
  assert.equal(harness.state().view.kind, "help", "? 应打开字段详情");

  // Walk one row at a time; every logical row keeps its full 原文（不断行截断）。
  const rows = collectHelpRows(harness, 20, (lines) => {
    assert.ok(lines.every((line) => tui.visibleWidth(line) <= 20), "详情页行超宽");
    assert.ok(lines.length <= 26, `详情页行数失控（${lines.length} 行）`);
  });
  const text = squash(rows);
  assert.ok(text.includes(longId), "长渠道 id 的完整原文应能逐页读到（含末尾）");
  assert.ok(text.includes(second), "第二个长渠道值应能读到");
  assert.ok(text.includes("当前值"), "缺当前值层");
  assert.ok(text.includes("本对话"), "缺本对话层");
  assert.ok(text.includes("用户默认"), "缺用户默认层");
  assert.ok(text.includes("内置默认"), "缺内置默认层");
  assert.equal(harness.calls.set.length, before.set, "查看详情不得改本对话值");
  assert.equal(harness.calls.save.length, before.save, "查看详情不得写用户默认");
  assert.equal(harness.calls.test, before.test, "查看详情不得发自检");

  harness.press(KEY.escape);
  assert.equal(harness.state().view.kind, "menu", "Esc 应返回规则页");
  assert.equal(harness.state().view.id, "rule:runCompleted");
  assert.equal(harness.state().rows[harness.state().focus], "item:rules.runCompleted.channels", "Esc 应回到原字段行");

  // From the detail view the same key opens it and Esc returns to that detail, same focus.
  harness.press(KEY.enter);
  harness.press(KEY.down);
  const focus = harness.state().focus;
  harness.press("?");
  assert.equal(harness.state().view.kind, "help");
  harness.press(KEY.escape);
  assert.equal(harness.state().view.kind, "detail", "应返回原详情页");
  assert.equal(harness.state().focus, focus, "应保留详情页焦点");
});

await step("H1 渠道字段详情：区分“渠道定义由用户配置”与“开关内置默认：开启”", () => {
  // A user-defined channel that factory defaults do not know about.
  const custom = makeHarness({ providers: [{ id: "team.myhook", type: "debug", enabled: false }] });
  focusItem(custom, "provider:team.myhook");
  custom.press("?");
  assert.equal(custom.state().view.kind, "help");
  const customText = squash(collectHelpRows(custom, 40));
  assert.ok(customText.includes("当前值：关闭"), `自定义渠道应展示当前值: ${customText}`);
  assert.ok(customText.includes("内置默认：开启"), "渠道开关内置缺省应为开启");
  assert.ok(!customText.includes("无内置默认"), "不得把渠道开关说成无内置默认（与删除 enabled 后开启相矛盾）");
  assert.ok(customText.includes("渠道定义：由用户配置"), `应说明渠道定义由用户提供: ${customText}`);
  assert.ok(customText.includes("渠道类型：debug"), "应展示渠道类型");
  assert.ok(customText.includes("凭据"), "渠道详情应说明凭据不外显");

  // A factory channel keeps the same switch default but its definition is built in.
  const builtin = makeHarness();
  focusItem(builtin, "provider:terminal");
  builtin.press("?");
  const builtinText = squash(collectHelpRows(builtin, 40));
  assert.ok(builtinText.includes("内置默认：开启"));
  assert.ok(builtinText.includes("渠道定义：出厂默认"), `出厂渠道应标注定义来源: ${builtinText}`);

  // A user file that redefines the built-in id must be reported as user-configured, not factory.
  const redefined = makeHarness({ providers: [{ id: "terminal", type: "webhook", enabled: true }] });
  focusItem(redefined, "provider:terminal");
  redefined.press("?");
  const redefinedText = squash(collectHelpRows(redefined, 40));
  assert.ok(redefinedText.includes("渠道定义：由用户配置"), `同名重定义应标为用户配置: ${redefinedText}`);
  assert.ok(redefinedText.includes("渠道类型：webhook"), redefinedText);
  assert.ok(!redefinedText.includes("渠道定义：出厂默认"), `不得用同名推断定义来源: ${redefinedText}`);
});

await step("H2 来源显示按存在性：与用户默认同值、渠道 false 都显示“本对话已覆盖”", () => {
  const harness = makeHarness();
  const minLevel = itemOf(harness, "minLevel");
  const terminal = itemOf(harness, "provider:terminal");
  // User default equals the factory value; the conversation then picks the same value.
  assert.equal(harness.host.saveDefault(minLevel, "info").ok, true);
  harness.host.setValue(minLevel, "info");
  assert.equal(harness.host.setValue(terminal, false).ok, true);

  moveToRow(harness, "item:minLevel");
  const homeFrame = squash(harness.render(40));
  assert.ok(homeFrame.includes("本对话已覆盖"), `同值 override 也应按存在性显示已覆盖: ${homeFrame}`);
  harness.press("?");
  const helpFrame = squash(collectHelpRows(harness, 40));
  assert.ok(helpFrame.includes("本对话：已覆盖（所有等级）"), `应显示被覆盖的值: ${helpFrame}`);
  assert.ok(!helpFrame.includes("本对话：未覆盖"), `不得把已覆盖说成未覆盖: ${helpFrame}`);
  harness.press(KEY.escape);

  focusItem(harness, "provider:terminal");
  harness.press("?");
  const channelFrame = squash(collectHelpRows(harness, 40));
  assert.ok(channelFrame.includes("本对话：已覆盖（关闭）"), `渠道 false 应显示为已覆盖: ${channelFrame}`);
  harness.press(KEY.escape);
});

// ---------------------------------------------------------------------------
// K: keyboard, focus and quick toggle
// ---------------------------------------------------------------------------

await step("K1 ↑↓ 移动焦点；Enter 进入详情；Esc 返回后父级焦点不变", () => {
  const harness = makeHarness();
  assert.match(focusRow(harness.render(80)), /启用通知/);
  harness.press(KEY.down);
  assert.match(focusRow(harness.render(80)), /通知门槛/);
  harness.press(KEY.up);
  assert.match(focusRow(harness.render(80)), /启用通知/);
  harness.press(KEY.enter);
  assert.equal(harness.state().view.kind, "detail");
  harness.press(KEY.escape);
  assert.equal(harness.state().view.kind, "menu");
  assert.match(focusRow(harness.render(80)), /启用通知/, "返回父级后焦点应保持在原行");
});

await step("K2 进入详情时焦点落在「当前值」那一行", () => {
  const harness = makeHarness();
  openItem(harness, "minLevel");
  const focus = focusRow(harness.render(80));
  assert.equal(focus.slice(2, 4), "✓ ", `详情焦点应在当前值行: ${JSON.stringify(focus.slice(0, 8))}`);
});

await step("K3 长页面滚动：焦点行始终在可视窗口内，位置提示走独立一行", () => {
  const providers = Array.from({ length: 15 }, (_, index) => ({ id: `c${String(index + 1).padStart(2, "0")}`, type: "debug", enabled: true }));
  const harness = makeHarness({ providers });
  openRow(harness, "category:channels");
  assert.equal(harness.state().rows.length, 16, "分类页包含新增 email 与 15 个自定义渠道");
  for (let index = 0; index < 14; index += 1) harness.press(KEY.down);
  const lines = harness.render(80);
  const focus = focusRow(lines);
  assert.match(focus, /c15/, `焦点应已移到列表下部: ${focus}`);
  assert.ok(lines.some((line) => /\d+–\d+\/16/.test(line)), `位置提示应在某一行:\n${lines.join("\n")}`);
  const body = lines.slice(2, 14);
  const focusIndex = body.findIndex((line) => line.startsWith("→ "));
  assert.ok(focusIndex >= 6, `滚动后焦点应位于窗口下半部，实际第 ${focusIndex} 行`);
  assert.ok(lines.every((line) => tui.visibleWidth(line) <= 80), "渲染行超宽");
});

await step("K4 Space 快速切换布尔（本对话）；复杂字段 Space 打开候选，不触发动作行", () => {
  const harness = makeHarness();
  focusItem(harness, "content.includeAssistantExcerpt");
  assert.equal(harness.host.config().content.includeAssistantExcerpt, false);
  harness.press(KEY.space);
  assert.equal(harness.state().view.kind, "menu", "Space 不应离开当前页");
  assert.equal(harness.host.config().content.includeAssistantExcerpt, true, "Space 应快速切换布尔");
  assert.deepEqual(harness.calls.set.at(-1), { id: "content.includeAssistantExcerpt", value: true });

  // A non-boolean field opens its candidate list instead of guessing a value.
  focusItem(harness, "coalesce.windowMs");
  harness.press(KEY.space);
  assert.equal(harness.state().view.kind, "detail", "复杂字段的 Space 应打开候选");
  harness.press(KEY.escape);

  // An action row must not react to Space.
  goHome(harness);
  openRow(harness, "category:advanced");
  moveToRow(harness, "action:test");
  harness.press(KEY.space);
  assert.equal(harness.calls.test, 0, "Space 不得触发送测试通知");
  harness.press(KEY.enter);
  assert.equal(harness.calls.test, 1, "Enter 才执行动作");
});

// ---------------------------------------------------------------------------
// D: Ctrl+S
// ---------------------------------------------------------------------------

await step("D1 Ctrl+S：标记迁移到当前值行 + 状态行给出确认（两者都要有）", () => {
  const harness = makeHarness();
  openItem(harness, "minLevel");
  harness.press(KEY.ctrlS); // 先把 info 固化为用户默认
  const seeded = harness.render(80);
  assert.match(rowWith(seeded, "所有等级"), /· 默认/, "第一次 Ctrl+S 应把「默认」打到「所有等级」行");
  assert.match(harness.state().message.text, /已保存为默认/);

  harness.press(KEY.down); // → 警告及错误
  harness.press(KEY.enter); // 当前值 = warning（仅本对话）
  harness.press(KEY.ctrlS); // 固化为用户默认
  const after = harness.render(80);
  const warningRow = rowWith(after, "警告及错误");
  assert.match(warningRow, /✓ 警告及错误/, "当前值标记应在「警告及错误」行");
  assert.match(warningRow, /· 默认/, "Ctrl+S 后「默认」标记应迁移到「警告及错误」行");
  const infoRow = rowWith(after, "所有等级");
  assert.ok(!/· 默认/.test(infoRow ?? ""), `「所有等级」行的旧「默认」标记未清除: ${JSON.stringify(infoRow)}`);
  assert.match(harness.state().message.text, /已保存为默认/, "标记迁移之外还要有轻量确认");
});

await step("D2 Ctrl+S 只写这一项（稀疏），其它字段不落进用户文件", () => {
  const harness = makeHarness();
  harness.host.saveDefault(itemOf(harness, "content.includeCost"), false);
  assert.deepEqual(harness.userFile(), { content: { includeCost: false } }, `用户文件应只含被保存的字段: ${JSON.stringify(harness.userFile())}`);
  // Saving a second setting keeps both and still leaves every other field out of the file.
  harness.host.saveDefault(itemOf(harness, "coalesce.windowMs"), 0);
  assert.deepEqual(harness.userFile(), { content: { includeCost: false }, coalesce: { windowMs: 0 } });
});

await step("D3 保存失败：不迁移标记、当前值仍生效、状态行报错", () => {
  const harness = makeHarness();
  fs.mkdirSync(path.dirname(configModule.userConfigPath(agentDir)), { recursive: true });
  fs.writeFileSync(configModule.userConfigPath(agentDir), "{ 坏掉的 JSON");
  const item = settings.buildSettingItems(configModule.defaultConfig()).find((candidate) => candidate.id === "minLevel");
  const result = harness.host.saveDefault(item, "warning");
  assert.equal(result.ok, false);
  harness.press(KEY.ctrlS); // 首页焦点在「启用通知」
  assert.equal(harness.state().message.tone, "error");
  const lines = harness.render(80);
  assert.ok(lines.every((line) => !line.includes(" · 默认")), "失败时不该出现「默认」标记");
  assert.match(rowWith(lines, "通知门槛"), /仅错误/, "损坏配置时应显示降级后的生效值");
  assert.equal(fs.readFileSync(configModule.userConfigPath(agentDir), "utf8"), "{ 坏掉的 JSON", "失败时不得改写原文件");
  fs.rmSync(configModule.userConfigPath(agentDir), { force: true });
});

await step("D4 Ctrl+S 保存的是该字段已生效值，而不是光标悬停但尚未选中的候选", () => {
  const harness = makeHarness();
  const minLevel = itemOf(harness, "minLevel");
  harness.host.setValue(minLevel, "warning"); // 本对话已生效值是 warning
  openItem(harness, "minLevel"); // 详情焦点落在当前值 warning 行
  harness.press(KEY.down); // 悬停在「仅错误」，但**不按 Enter**
  harness.press(KEY.ctrlS);
  assert.deepEqual(harness.calls.save.at(-1), { id: "minLevel", value: "warning" }, "Ctrl+S 必须写已生效值而非悬停候选");
  assert.deepEqual(harness.userFile(), { minLevel: "warning" }, "写盘内容也应是已生效值");
  assert.equal(harness.host.config().minLevel, "warning", "悬停候选不得被提交");
});

// ---------------------------------------------------------------------------
// C: collection fields
// ---------------------------------------------------------------------------

await step("C1 集合字段可多行同时带 `✓ `，Enter 切换成员", () => {
  const harness = makeHarness();
  openItem(harness, "quietHours.exceptLevels");
  // The detail view opens on the current-value row (error), then moves up to warning and adds it.
  harness.press(KEY.up);
  harness.press(KEY.enter);
  const lines = harness.render(80);
  const checked = lines.filter((line) => line.includes("✓ "));
  assert.ok(checked.length >= 2, `集合应可多选，实际:\n${lines.slice(0, 8).join("\n")}`);
  assert.deepEqual(harness.host.config().quietHours.exceptLevels, ["error", "warning"]);
  assert.deepEqual(itemOf(harness, "quietHours.exceptLevels").read(harness.host.config()), ["error", "warning"]);
});

await step("C2 集合字段的 Ctrl+S 写整个数组", () => {
  const harness = makeHarness();
  const item = itemOf(harness, "rules.runCompleted.channels");
  harness.host.setValue(item, []);
  harness.host.saveDefault(item, []);
  assert.deepEqual(harness.userFile(), { rules: { runCompleted: { channels: [] } } });
});

// ---------------------------------------------------------------------------
// I: numbers, times and custom input
// ---------------------------------------------------------------------------

await step("I1 数值项：预设候选 + 末尾 `自定义…`；当前值不在预设里时补一行", () => {
  const harness = makeHarness();
  openItem(harness, "coalesce.windowMs");
  const lines = harness.render(80);
  assert.ok(rowWith(lines, settings.CUSTOM_ROW_LABEL), `缺少自定义行:\n${lines.slice(0, 8).join("\n")}`);
  assert.ok(rowWith(lines, "1.5 秒"), "时长预设应以易读单位显示（1500 ms → 1.5 秒）");
  assert.ok(!lines.some((line) => /\d+ ms/.test(line)), "不应再出现 `1500 ms` 这类原始毫秒文本");
});

await step("I2 custom… 输入：非法值就地报错且不改变当前值/用户默认", () => {
  const harness = makeHarness();
  openItem(harness, "quietHours.start");
  // Walk down to the custom… row.
  let guard = 0;
  while (!focusRow(harness.render(80)).includes(settings.CUSTOM_ROW_LABEL) && guard < 40) {
    harness.press(KEY.down);
    guard += 1;
  }
  assert.ok(focusRow(harness.render(80)).includes(settings.CUSTOM_ROW_LABEL), "未能聚焦自定义行");
  harness.press(KEY.enter);
  assert.equal(harness.state().view.kind, "input");
  assert.ok(
    harness.render(80).some((line) => line.includes("静默时段 · 开始")),
    "输入页应写明是哪个字段",
  );
  assert.ok(
    harness.render(80).some((line) => line.includes("HH:MM")),
    "时间输入应显示合法格式",
  );
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

await step("I3 custom… 输入：合法值写入当前值，显示单位可读且精度不丢", () => {
  const harness = makeHarness();
  openItem(harness, "delivery.timeoutMs");
  let guard = 0;
  while (!focusRow(harness.render(80)).includes(settings.CUSTOM_ROW_LABEL) && guard < 40) {
    harness.press(KEY.down);
    guard += 1;
  }
  harness.press(KEY.enter);
  // The input view states the unit and the legal range before anything is typed.
  const inputFrame = harness.render(80).join("\n");
  assert.match(inputFrame, /毫秒/, `输入页应写明单位:\n${inputFrame}`);
  assert.match(inputFrame, /1\.\.120000/, `输入页应写明合法范围:\n${inputFrame}`);
  // Clear the pre-filled value, then type 4321.
  for (let index = 0; index < 8; index += 1) harness.press(KEY.backspace);
  for (const character of "4321") harness.press(character);
  harness.press(KEY.enter);
  assert.equal(harness.host.config().delivery.timeoutMs, 4321);
  assert.ok(rowWith(harness.render(80), "4.321 秒"), "补充的当前值行应带可读单位且保留毫秒精度");
});

await step("I4 custom… 越界输入：报错写明单位与范围，当前值与用户默认零变化", () => {
  const harness = makeHarness();
  openItem(harness, "coalesce.cooldownMs");
  let guard = 0;
  while (!focusRow(harness.render(80)).includes(settings.CUSTOM_ROW_LABEL) && guard < 40) {
    harness.press(KEY.down);
    guard += 1;
  }
  harness.press(KEY.enter);
  for (let index = 0; index < 8; index += 1) harness.press(KEY.backspace);
  for (const character of "999999") harness.press(character);
  harness.press(KEY.enter);
  const error = harness.state().view.error ?? "";
  assert.match(error, /0\.\.600000/, `越界错误应写明范围: ${error}`);
  assert.match(error, /毫秒/, `越界错误应写明单位: ${error}`);
  assert.equal(harness.host.config().coalesce.cooldownMs, 3000, "越界输入不得改变当前值");
  assert.equal(harness.userFile(), undefined, "越界输入不得写用户文件");
});

// ---------------------------------------------------------------------------
// V: footer and folded actions
// ---------------------------------------------------------------------------

await step("V1 footer 常驻：字段/详情页含 `Ctrl+S 设为以后默认`，状态页给出自己的可用键", () => {
  const harness = makeHarness();
  const tail = () => harness.render(80).slice(-5).join("\n");
  assert.match(tail(), /Ctrl\+S 设为以后默认/, "首页字段行应常驻保存提示");
  harness.press(KEY.enter); // 启用通知详情
  assert.match(tail(), /Ctrl\+S 设为以后默认/, "详情页应常驻保存提示");
  harness.press(KEY.ctrlO);
  assert.match(tail(), /Enter 重读配置/, "状态页应给出自己的可用键");
  assert.match(tail(), /Ctrl\+T 自检/, "状态页应给出自检快捷键");
  harness.press(KEY.escape); // 回详情
  assert.equal(harness.finished, undefined, "Esc 只在首页才结束组件");
});

await step("V2 Ctrl+T 发测试、Ctrl+R 重读、Ctrl+O 状态与诊断只读", () => {
  const harness = makeHarness();
  harness.press(KEY.ctrlT);
  assert.match(harness.state().message.text, /自检/);
  harness.press(KEY.ctrlR);
  assert.match(harness.state().message.text, /重新读取/);
  harness.press(KEY.ctrlO);
  assert.equal(harness.state().view.id, "status", "Ctrl+O 应打开状态与诊断页");
  const lines = harness.render(80);
  assert.ok(lines.some((line) => line.includes("终端机制")), "状态页应显示状态文本");
  harness.press(KEY.down);
  assert.equal(harness.state().view.id, "status", "状态页里滚动不应退出视图");
  harness.press(KEY.escape);
  assert.equal(harness.state().view.kind, "menu");
  assert.equal(harness.calls.reload, 1);
  assert.ok(harness.calls.status > 0);
});

await step("V3 Esc 在首页结束组件，并带回摘要", () => {
  const harness = makeHarness();
  openItem(harness, "minLevel");
  harness.press(KEY.down); // warning
  harness.press(KEY.down); // error
  harness.press(KEY.enter); // 本对话改为 error
  harness.press(KEY.ctrlS); // 固化为用户默认
  harness.press(KEY.escape); // 回首页
  assert.equal(harness.finished, undefined, "详情页的 Esc 只应返回上一级");
  harness.press(KEY.escape); // 关闭
  assert.deepEqual(harness.finished, { savedDefaults: 1, changed: 1 });
});

// ---------------------------------------------------------------------------
// F: focus-aware footer and the status page's visible reload action
// ---------------------------------------------------------------------------

await step("F1 footer 按焦点类型给出可用操作：分类行不宣称 Ctrl+S/Space，输入页只给 Enter/Esc", () => {
  const harness = makeHarness();
  /** Footer hint lines only (they carry a navigation key or the global Ctrl+T hint). */
  const hints = () => harness.render(80).filter((line) => /↑↓|Enter 应用|Ctrl\+T 自检|Ctrl\+S/.test(line)).join("\n");

  // Home, focused on the global switch: save and quick toggle are available.
  assert.match(hints(), /Ctrl\+S 设为以后默认/, "字段行应提供 Ctrl+S");
  assert.match(hints(), /Space 快速切换/, "字段行应提供 Space");

  // Home, focused on a category row: no save/quick toggle, only open.
  moveToRow(harness, "category:rules");
  assert.doesNotMatch(hints(), /Ctrl\+S 设为以后默认/, "分类行不得宣称 Ctrl+S");
  assert.doesNotMatch(hints(), /Space 快速切换/, "分类行不得宣称 Space");
  assert.match(hints(), /Enter 打开/, "分类行应提供 Enter 打开");
  openItem(harness, "minLevel");
  assert.match(hints(), /Ctrl\+S 设为以后默认/, "详情页应提供 Ctrl+S");

  // Text input: only apply/cancel, no external action advertised.
  openItem(harness, "delivery.timeoutMs");
  let guard = 0;
  while (!focusRow(harness.render(80)).includes(settings.CUSTOM_ROW_LABEL) && guard < 40) {
    harness.press(KEY.down);
    guard += 1;
  }
  harness.press(KEY.enter);
  const inputFooter = hints();
  assert.match(inputFooter, /Enter 应用/);
  assert.doesNotMatch(inputFooter, /Ctrl\+S/, "文本输入不得宣称保存");
  assert.doesNotMatch(inputFooter, /Ctrl\+O/, "文本输入不得宣称外发动作");
});

await step("F2 状态与诊断页提供可见的“重新读取配置”动作，可解释状态不宣称送达", () => {
  const harness = makeHarness();
  harness.press(KEY.ctrlO);
  assert.equal(harness.state().rows[0], "action:reload", "状态页首行应是重读配置动作");
  assert.match(harness.render(80).join("\n"), /重新读取配置/);
  assert.match(harness.render(80).join("\n"), /↑↓ 滚动\s+Enter 重读配置/, "footer 应说明该行可用键");
  harness.press(KEY.enter);
  assert.equal(harness.calls.reload, 1, "Enter 应执行重读配置");
  assert.match(harness.state().message.text, /重新读取/);
  assert.equal(harness.state().view.id, "status", "重读后仍在状态页");
});

// ---------------------------------------------------------------------------
// S: three-layer values (overlay precedence, no inheritance through fork)
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

await step("S4b 邮箱会话选项快照可恢复，且不把授权码存进会话", () => {
  const overlay = { patch: {}, providers: { email: true }, providerOptions: { email: { from: "sender@qq.com", to: ["reader@example.org"] } } };
  const data = settings.overlayEntryData("s", overlay, 1);
  assert.equal(JSON.stringify(data).includes("PI_NOTIFY_QQ_SMTP_AUTH_CODE"), false);
  const restored = settings.restoreOverlayFromEntries([{ type: "custom", customType: settings.SESSION_OVERLAY_ENTRY, data }], "s");
  assert.deepEqual(restored, overlay);
  const applied = settings.applyOverlay(configModule.defaultConfig(), restored);
  assert.equal(applied.problems.length, 0);
  assert.equal(applied.config.providers.find((provider) => provider.id === "email").enabled, true);
  assert.deepEqual(applied.config.providers.find((provider) => provider.id === "email").options.to, ["reader@example.org"]);
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
  assert.deepEqual(forC, { patch: {}, providers: {}, providerOptions: {} }, "fork 出来的新会话不得继承旧覆盖");
  const twice = [entry("session-B", "error"), entry("session-B", "warning")];
  assert.equal(settings.restoreOverlayFromEntries(twice, "session-B").patch.minLevel, "warning");
  const noise = [{ type: "message" }, { type: "custom", customType: "tools-config", data: { sessionId: "session-B" } }, ...twice];
  assert.equal(settings.restoreOverlayFromEntries(noise, "session-B").patch.minLevel, "warning");
  assert.deepEqual(settings.restoreOverlayFromEntries(noise, undefined), { patch: {}, providers: {}, providerOptions: {} });
});

// ---------------------------------------------------------------------------
// X: forced silence is an extra restriction, never a user default
// ---------------------------------------------------------------------------

await step("X1 强制静默作为“额外限制”常驻展示，不冒充用户默认关闭", () => {
  const harness = makeHarness(undefined, { restrictions: [{ label: "强制静默", reason: "--no-notify" }] });
  const lines = harness.render(40);
  const frame = squash(lines);
  assert.ok(frame.includes("额外限制"), `缺少额外限制说明: ${frame}`);
  assert.ok(frame.includes("强制静默"), `应点名强制静默: ${frame}`);
  assert.ok(frame.includes("--no-notify"), `应写明限制来源: ${frame}`);
  assert.ok(lines.every((line) => tui.visibleWidth(line) <= 40), "限制行超宽");
  assert.ok(lines.length <= 26, `限制说明不应把列表挤出屏幕（${lines.length} 行）`);

  // The global switch's details keep the three value layers untouched and add the restriction row.
  harness.press("?");
  assert.equal(harness.state().view.kind, "help");
  const help = squash(collectHelpRows(harness, 40));
  assert.ok(help.includes("额外限制：强制静默"), `字段详情应把强制静默标为额外限制: ${help}`);
  assert.ok(!help.includes("用户默认：关闭"), `不得把强制静默说成用户默认关闭: ${help}`);
});

console.log(`\n通过：通知设置组件回归（${passed} 项）`);
fs.rmSync(TMP, { recursive: true, force: true });
