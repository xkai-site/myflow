/**
 * Sparse patch helpers and settings helpers regression.
 *
 * These are the primitives behind the three value layers: the patch utilities merge a single saved
 * field into the raw user file, and the settings helpers answer "was this ever saved?" and "is this
 * candidate the current value?". They are pure functions, so no SDK, session or clock is needed.
 *
 * The end-to-end effects are covered elsewhere: the three-layer precedence and the fork rule in
 * test/host-lifecycle.mjs (S1-S5), the rendered rows in test/settings-ui.mjs.
 *
 *   MSYS_NO_PATHCONV=1 node test/settings-patch.mjs
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url));
const patch = await import(pathToFileURL(path.join(PLUGIN_DIR, "src", "patch.ts")).href);
const settings = await import(pathToFileURL(path.join(PLUGIN_DIR, "src", "settings.ts")).href);
const config = await import(pathToFileURL(path.join(PLUGIN_DIR, "src", "config.ts")).href);

const failures = [];
async function step(name, run) {
  try {
    await run();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}`);
    console.log(`    ${error?.message ?? error}`);
  }
}

const defaultItems = settings.buildSettingItems(config.defaultConfig());
const itemOf = (id) => {
  const item = defaultItems.find((candidate) => candidate.id === id);
  assert.ok(item, `未知配置项: ${id}`);
  return item;
};

console.log("稀疏补丁与配置项助手专项回归：pi-notification");

await step("P1 isPlainObject / getPathValue / hasPath 的边界语义", () => {
  assert.equal(patch.isPlainObject({}), true);
  assert.equal(patch.isPlainObject({ a: 1 }), true);
  assert.equal(patch.isPlainObject([]), false, "数组不是普通对象");
  assert.equal(patch.isPlainObject(null), false);
  assert.equal(patch.isPlainObject("x"), false);
  assert.equal(patch.isPlainObject(5), false);

  assert.equal(patch.getPathValue({ a: { b: 2 } }, "a.b"), 2);
  assert.deepEqual(patch.getPathValue({ a: { b: 2 } }, "a"), { b: 2 }, "路径指向对象时返回该对象本身");
  assert.equal(patch.getPathValue({ a: { b: 2 } }, "a.b.c"), undefined, "路径过长时返回 undefined");
  assert.equal(patch.getPathValue({ a: 1 }, "a.b"), undefined, "中间层是标量时返回 undefined");
  assert.equal(patch.getPathValue({ a: [1] }, "a.0"), undefined, "中间层是数组时返回 undefined");
  assert.equal(patch.getPathValue(undefined, "a"), undefined);
  assert.equal(patch.getPathValue({ a: { b: null } }, "a.b"), null, "显式的 null 要如实返回");

  assert.equal(patch.hasPath({ a: { b: null } }, "a.b"), true);
  assert.equal(patch.hasPath({ a: {} }, "a.b"), false);
  assert.equal(patch.hasPath({ a: 1 }, "a.b"), false);
  assert.equal(patch.hasPath({}, "toString"), false, "继承属性不算已保存");
  assert.equal(patch.hasPath({ a: undefined }, "a"), true, "显式 undefined 仍算存在");
});

await step("P2 setPatchPath 逐层创建、覆盖已有值、绝不修改入参", () => {
  const original = { x: { y: 1 }, keep: true };
  const updated = patch.setPatchPath(original, "x.z", 2);
  assert.deepEqual(updated, { x: { y: 1, z: 2 }, keep: true });
  assert.deepEqual(original, { x: { y: 1 }, keep: true }, "入参必须保持不变");

  assert.deepEqual(patch.setPatchPath({}, "a.b.c", 3), { a: { b: { c: 3 } } });
  assert.deepEqual(patch.setPatchPath({ a: { b: 1 } }, "a.b", 2), { a: { b: 2 } }, "同名路径是覆盖而不是合并");
  const nested = patch.setPatchPath({ a: "scalar" }, "a.b", 1);
  assert.deepEqual(nested, { a: { b: 1 } }, "中间层不是对象时按需替换成对象");
});

await step("P3 mergePatch：数组整体替换、对象深合并、标量覆盖、引用不共享", () => {
  assert.deepEqual(patch.mergePatch({ a: [1, 2, 3] }, { a: [9] }), { a: [9] }, "数组是整体替换，不逐元素合并");
  assert.deepEqual(patch.mergePatch({ a: { b: 1, c: 2 } }, { a: { c: 3 } }), { a: { b: 1, c: 3 } });
  assert.deepEqual(patch.mergePatch({ a: { b: 1 } }, { a: null }), { a: null }, "null 覆盖整个对象");
  assert.deepEqual(patch.mergePatch({ a: { b: 1 } }, { a: 7 }), { a: 7 }, "标量覆盖整个对象");
  assert.deepEqual(patch.mergePatch({ a: 1 }, 5), { a: 1 }, "补丁不是对象时原样返回 base");
  assert.deepEqual(patch.mergePatch(5, { a: 1 }), { a: 1 }, "base 不是对象时以补丁为准");
  assert.deepEqual(patch.mergePatch({}, {}), {});

  const source = { a: { b: 1 }, list: [1] };
  const merged = patch.mergePatch({}, source);
  merged.a.b = 2;
  merged.list.push(2);
  assert.equal(source.a.b, 1, "嵌套对象不得与入参共享引用");
  assert.deepEqual(source.list, [1], "数组也不得与入参共享引用");
});

await step("P4 补丁不能替换结果的原型：__proto__ / constructor / prototype 一律丢弃", () => {
  const polluted = patch.mergePatch({}, JSON.parse('{"__proto__":{"polluted":1}}'));
  assert.equal(Object.getPrototypeOf(polluted), Object.prototype, "原型被替换：非自有属性会混进配置读取");
  assert.equal(polluted.polluted, undefined, "污染键泄漏到了合并结果");
  assert.deepEqual(Object.keys(polluted), [], "污染键不得作为字段落地");

  const nested = patch.mergePatch({ a: { b: 1 } }, { a: JSON.parse('{"__proto__":{"x":1}}') });
  assert.equal(Object.getPrototypeOf(nested.a), Object.prototype, "嵌套对象的原型同样不得被替换");
  assert.deepEqual(nested.a, { b: 1 }, "嵌套合并的其它字段必须保留");

  for (const key of ["constructor", "prototype"]) {
    const merged = patch.mergePatch({}, { [key]: { polluted: 1 } });
    assert.deepEqual(Object.keys(merged), [], `${key} 不得作为字段落地`);
    assert.equal(Object.prototype.polluted, undefined, `${key} 污染了全局原型`);
  }
});

await step("S1 overlay 形状防御：空 overlay 与非法条目", () => {
  assert.deepEqual(settings.emptyOverlay(), { patch: {}, providers: {}, providerOptions: {} });
  assert.equal(settings.isEmptyOverlay(settings.emptyOverlay()), true);
  assert.equal(settings.isEmptyOverlay({ patch: { enabled: false }, providers: {}, providerOptions: {} }), false);
  assert.equal(settings.isEmptyOverlay({ patch: {}, providers: { terminal: false }, providerOptions: {} }), false);

  assert.equal(settings.overlayFromEntry(undefined), undefined);
  assert.equal(settings.overlayFromEntry(42), undefined);
  assert.deepEqual(settings.overlayFromEntry({ patch: {}, providers: {} }), { patch: {}, providers: {}, providerOptions: {} },
    "空快照是合法状态（已清空），必须保留以免 /reload 复活旧值");
  assert.deepEqual(settings.overlayFromEntry({ patch: "broken", providers: { a: "yes", b: true } }), {
    patch: {},
    providers: { b: true },
    providerOptions: {},
  }, "非对象 patch 归一为空，providers 只保留布尔值");
});

await step("S2 hasUserDefault / userDefaultValue：按路径存在性判断，不靠与出厂默认比较", () => {
  const boolItem = itemOf("content.includeCost");
  const providerItem = itemOf("provider:terminal");
  const minLevelItem = itemOf("minLevel");

  assert.equal(settings.hasUserDefault(undefined, boolItem), false, "没有用户文件时未保存");
  assert.equal(settings.hasUserDefault({}, boolItem), false);
  assert.equal(settings.hasUserDefault({ content: {} }, boolItem), false);
  assert.equal(settings.hasUserDefault({ content: { includeCost: false } }, boolItem), true, "等于出厂默认的值只要被保存过也算保存过");
  assert.equal(settings.userDefaultValue({ content: { includeCost: false } }, boolItem), false);
  assert.equal(settings.userDefaultValue({ content: {} }, boolItem), undefined);

  assert.equal(settings.hasUserDefault({ providers: "terminal" }, providerItem), false, "providers 不是数组时视为未保存");
  assert.equal(settings.hasUserDefault({ providers: [{ id: "terminal" }] }, providerItem), false, "条目里没有 enabled 就是未保存");
  assert.equal(settings.hasUserDefault({ providers: [{ id: "terminal", enabled: false }] }, providerItem), true);
  assert.equal(settings.userDefaultValue({ providers: [{ id: "terminal", enabled: false }] }, providerItem), false);
  assert.equal(settings.userDefaultValue({ providers: [{ id: "other", enabled: false }] }, providerItem), undefined);

  assert.equal(settings.hasUserDefault({ minLevel: "error" }, minLevelItem), true);
  assert.equal(settings.userDefaultValue({ minLevel: "error" }, minLevelItem), "error");
  assert.equal(settings.userDefaultValue({}, minLevelItem), undefined);
});

await step("S3 isCurrentValue / collectionValue：标量相等，集合按成员", () => {
  assert.equal(settings.isCurrentValue("number", 5, 5), true);
  assert.equal(settings.isCurrentValue("number", 5, 6), false);
  assert.equal(settings.isCurrentValue("collection", ["a", "b"], "b"), true);
  assert.equal(settings.isCurrentValue("collection", ["a"], "b"), false);
  assert.equal(settings.isCurrentValue("collection", "b", "b"), false, "集合项要求数组，标量不算成员");
  assert.equal(settings.isCurrentValue("collection", undefined, "b"), false);

  assert.deepEqual(settings.collectionValue(["a"], "b"), ["a", "b"], "新成员追加到末尾，顺序稳定");
  assert.deepEqual(settings.collectionValue(["a", "b"], "a"), ["b"], "再次点击即移除");
  assert.deepEqual(settings.collectionValue(undefined, "a"), ["a"], "当前值不是数组时从空集合开始");
  assert.deepEqual(settings.collectionValue(["a"], "a"), [], "最后一个成员也能移除");
});

await step("S4 candidatesOf：枚举项给出全部候选，时间项给出预设集", () => {
  assert.deepEqual(
    settings.candidatesOf(itemOf("minLevel"), config.defaultConfig()).map((candidate) => candidate.value),
    ["info", "warning", "error"],
  );
  assert.equal(settings.candidatesOf(itemOf("quietHours.start"), config.defaultConfig()).length, 7);
  assert.equal(settings.CUSTOM_ROW_LABEL, "自定义…", "custom 行标签是 UI 与测试共用的常量");
  assert.deepEqual(
    settings.candidatesOf(itemOf("quietHours.enabled"), config.defaultConfig()).map((candidate) => candidate.value),
    [true, false],
  );
});

await step("S5 中文化只改展示：值/配置键不变，阈值与规则严重程度使用不同文案", () => {
  const labels = (id) => settings.candidatesOf(itemOf(id), config.defaultConfig()).map((candidate) => candidate.label);
  // Values stay the enum ids; only the labels are translated.
  assert.deepEqual(labels("minLevel"), ["所有等级", "警告及错误", "仅错误"], "通知门槛应表达“及以上”");
  assert.deepEqual(labels("rules.runFailed.level"), ["提示", "警告", "错误"], "规则严重程度用常见日志等级名");
  assert.deepEqual(labels("rules.toolFailed.mode"), ["并入结果", "立即提醒"], "策略不应再是 aggregate/immediate");
  assert.deepEqual(labels("rules.waitingForUser.kinds"), ["选择", "确认", "输入", "编辑器"]);
  assert.deepEqual(labels("quietHours.exceptLevels"), ["提示", "警告", "错误"]);
  assert.deepEqual(labels("content.includeCost"), ["开启", "关闭"], "布尔候选项不应再露出 true/false");
  assert.deepEqual(labels("provider:terminal"), ["开启", "关闭"]);

  // format() is the single display path: parent rows, detail rows and the summary all read it.
  assert.equal(itemOf("minLevel").format("error"), "仅错误");
  assert.equal(itemOf("rules.runFailed.level").format("error"), "错误");
  assert.equal(itemOf("content.includeCost").format(false), "关闭");
  assert.equal(itemOf("rules.runCompleted.channels").format(["terminal", "hook"]), "terminal、hook");
  assert.equal(itemOf("quietHours.exceptLevels").format(["error"]), "错误");
  assert.equal(itemOf("provider:terminal").format(false), "关闭");
  assert.equal(itemOf("content.includeCost").format(undefined), "—");
});

await step("S6 时长展示用易读单位，输入写明单位与范围（底层仍为毫秒整数）", () => {
  const windowItem = itemOf("coalesce.windowMs");
  assert.equal(windowItem.format(1500), "1.5 秒");
  assert.equal(windowItem.format(3000), "3 秒");
  assert.equal(windowItem.format(60000), "60 秒");
  assert.equal(windowItem.format(200), "200 毫秒");
  assert.equal(windowItem.format(0), "0 毫秒");
  // Non-round values keep their precision instead of being rounded away.
  assert.equal(windowItem.format(4321), "4.321 秒");
  assert.equal(itemOf("delivery.timeoutMs").format(10500), "10.5 秒");
  // Presets go through the same formatter, so the list is not a mix of units.
  assert.deepEqual(
    settings.candidatesOf(windowItem, config.defaultConfig()).map((candidate) => candidate.label),
    ["0 毫秒", "1.5 秒", "3 秒", "10 秒", "60 秒"],
  );
  // A unitless number stays a bare integer.
  assert.equal(itemOf("delivery.maxRetries").format(2), "2");

  assert.equal(windowItem.inputHint, "整数 0..600000（毫秒）");
  assert.equal(itemOf("delivery.timeoutMs").inputHint, "整数 1..120000（毫秒）");
  assert.equal(itemOf("delivery.maxRetries").inputHint, "整数 0..10");
  assert.equal(itemOf("quietHours.start").inputHint, "HH:MM（00:00–23:59）");

  // Parsing still produces plain milliseconds and still rejects out-of-range input with the unit.
  assert.deepEqual(windowItem.parseInput("4321"), { ok: true, value: 4321 });
  const outOfRange = windowItem.parseInput("999999");
  assert.equal(outOfRange.ok, false);
  assert.match(outOfRange.message, /0\.\.600000/);
  assert.match(outOfRange.message, /毫秒/);
});

await step("S7 来源按 overlay 存在性判定：false / 空集合 / 与默认同值都算“已覆盖”", () => {
  const boolItem = itemOf("content.includeCost");
  const channelsItem = itemOf("rules.runCompleted.channels");
  const minLevelItem = itemOf("minLevel");

  // false is a value, not “no override”: comparing values would misreport it as inherited.
  assert.equal(settings.sessionOverrideValue({ patch: { content: { includeCost: false } }, providers: {} }, boolItem), false);
  assert.equal(settings.sessionOverrideValue({ patch: {}, providers: {} }, boolItem), undefined);
  // An empty collection is still an explicit choice.
  assert.deepEqual(
    settings.sessionOverrideValue({ patch: { rules: { runCompleted: { channels: [] } } }, providers: {} }, channelsItem),
    [],
  );
  assert.equal(settings.sessionOverrideValue({ patch: { rules: {} }, providers: {} }, channelsItem), undefined);
  // Same value as the user default: presence decides, so it still counts as a conversation override.
  assert.equal(settings.sessionOverrideValue({ patch: { minLevel: "info" }, providers: {} }, minLevelItem), "info");
  assert.equal(settings.sessionOverrideValue({ patch: { minLevel: "error" }, providers: {} }, minLevelItem), "error");

  // Channel switches live in the provider map, and a false switch is a real override.
  const terminal = itemOf("provider:terminal");
  assert.equal(settings.sessionOverrideValue({ patch: {}, providers: { terminal: false } }, terminal), false);
  assert.equal(settings.sessionOverrideValue({ patch: {}, providers: { terminal: true } }, terminal), true);
  assert.equal(settings.sessionOverrideValue({ patch: {}, providers: {} }, terminal), undefined);
});

await step("S8 渠道内置缺省：开关缺省为开启；定义来源看用户文件，不看同名 id", () => {
  const terminal = itemOf("provider:terminal");
  assert.equal(settings.builtinDefaultValue(terminal), true, "渠道开关的内置缺省是开启");
  assert.equal(settings.builtinDefaultValue(itemOf("minLevel")), "info");
  assert.equal(settings.builtinDefaultValue(itemOf("content.includeCost")), true);
  // Definition origin: the user file is the only layer that can provide a definition besides the
  // factory defaults, so a same-named user entry still means “user-provided”.
  assert.equal(settings.providerDefinitionSource(terminal, undefined), "default");
  assert.equal(settings.providerDefinitionSource(terminal, { providers: [{ id: "terminal", type: "webhook" }] }), "user");
  assert.equal(settings.providerDefinitionSource(terminal, { providers: "broken" }), "default");

  const customConfig = config.defaultConfig();
  customConfig.providers = [{ id: "team.myhook", type: "debug", enabled: false, options: {} }];
  const custom = settings.buildSettingItems(customConfig).find((item) => item.providerId === "team.myhook");
  assert.ok(custom, "自定义渠道项缺失");
  assert.equal(settings.providerDefinitionSource(custom, undefined), "default", "用户文件没写就按出厂默认处理");
  assert.equal(settings.providerDefinitionSource(custom, { providers: [{ id: "team.myhook" }] }), "user");
  // The switch itself still has a built-in default of on, matching checkProviders.
  assert.equal(settings.builtinDefaultValue(custom), true, "自定义渠道的开关内置缺省仍为开启");

  // A dotted id is addressed as a whole (array lookup / overlay map key), never split as a path.
  assert.equal(custom.userPath, "providers.team.myhook.enabled");
  assert.equal(settings.hasUserDefault({ providers: [{ id: "team.myhook", enabled: false }] }, custom), true);
  assert.equal(settings.userDefaultValue({ providers: [{ id: "team.myhook", enabled: false }] }, custom), false);
  assert.equal(settings.hasUserDefault({ providers: [{ id: "team.my", enabled: false }] }, custom), false);
  assert.equal(settings.sessionOverrideValue({ patch: {}, providers: { "team.myhook": false } }, custom), false);
  assert.equal(settings.sessionOverrideValue({ patch: {}, providers: { team: true } }, custom), undefined);

  // Prototype members are not overrides: ids like `toString` / `constructor` must be read as own keys.
  const weirdConfig = config.defaultConfig();
  weirdConfig.providers = [
    { id: "toString", type: "debug", enabled: true, options: {} },
    { id: "constructor", type: "debug", enabled: true, options: {} },
  ];
  const weirdItems = settings.buildSettingItems(weirdConfig);
  for (const id of ["toString", "constructor"]) {
    const weird = weirdItems.find((item) => item.providerId === id);
    assert.ok(weird, `缺少渠道项 ${id}`);
    assert.equal(settings.sessionOverrideValue({ patch: {}, providers: {} }, weird), undefined, `${id} 不得把原型成员当覆盖`);
    assert.equal(settings.sessionOverrideValue({ patch: {}, providers: { [id]: false } }, weird), false);
  }
});

await step("S9 渠道用户文件补丁：只改目标 enabled，保留 options/未知字段/其他渠道", () => {
  const raw = {
    providers: [
      { id: "terminal", type: "terminal", enabled: true, options: {} },
      { id: "debug", type: "debug", enabled: true, options: { url: "https://example.invalid/hook" }, note: "keep-me" },
    ],
  };
  const patched = settings.channelUserFilePatch(raw, "terminal", "terminal", false);
  assert.deepEqual(patched, {
    providers: [
      { id: "terminal", type: "terminal", enabled: false, options: {} },
      { id: "debug", type: "debug", enabled: true, options: { url: "https://example.invalid/hook" }, note: "keep-me" },
    ],
  }, `只应改目标渠道的 enabled: ${JSON.stringify(patched)}`);
  // 数组是整体替换的字段，补丁必须带完整数组。
  assert.equal(Array.isArray(patched.providers), true);
  // 入参保持不变（不把别的渠道的本对话选择/options 当输入改掉）。
  assert.equal(raw.providers[0].enabled, true);
  assert.equal(raw.providers[1].enabled, true);

  // 只存在于出厂默认的渠道：新增最小条目，不复制出厂 options。
  assert.deepEqual(
    settings.channelUserFilePatch(undefined, "terminal", "terminal", false),
    { providers: [{ id: "terminal", type: "terminal", enabled: false }] },
  );
  // providers 不是数组时按空数组重建为合法数组。
  assert.deepEqual(
    settings.channelUserFilePatch({ providers: "broken" }, "terminal", "terminal", false),
    { providers: [{ id: "terminal", type: "terminal", enabled: false }] },
  );
  // 目标不在用户文件里时只追加，不重写已有条目。
  const appended = settings.channelUserFilePatch({ providers: [{ id: "debug", enabled: true, options: { tag: 1 } }] }, "terminal", "terminal", false);
  assert.deepEqual(appended, {
    providers: [
      { id: "debug", enabled: true, options: { tag: 1 } },
      { id: "terminal", type: "terminal", enabled: false },
    ],
  });
});

await step("S10 恢复清空最后一个 overlay：空快照仍然被认作有效快照（不复活旧值）", () => {
  const entry = (sessionId, patch) => ({
    type: "custom",
    customType: settings.SESSION_OVERLAY_ENTRY,
    data: { sessionId, patch, providers: {} },
  });
  const entries = [entry("s", { minLevel: "error" }), entry("s", {})];
  assert.deepEqual(
    settings.restoreOverlayFromEntries(entries, "s"),
    { patch: {}, providers: {}, providerOptions: {} },
    "最后一条空快照表示已清空，不能被忽略而恢复成 error",
  );
});

await step("S11 removePath：删除单项并剪空祖先，保留旁支，缺失即幂等零变化", () => {
  assert.deepEqual(
    patch.removePath({ content: { includeCost: false, includeDuration: true } }, "content.includeCost"),
    { content: { includeDuration: true } },
    "应删除单项并保留兄弟字段",
  );
  assert.deepEqual(
    patch.removePath({ content: { includeCost: false } }, "content.includeCost"),
    {},
    "删空祖先对象，但不动其它分支",
  );
  assert.deepEqual(
    patch.removePath({ content: { includeCost: false }, coalesce: { windowMs: 0 } }, "content.includeCost"),
    { coalesce: { windowMs: 0 } },
    "旁支必须保留",
  );
  assert.deepEqual(patch.removePath({}, "content.includeCost"), {}, "缺失路径是零变化");
  assert.deepEqual(patch.removePath(undefined, "enabled"), {}, "没有用户文件时结果是空对象");
  const source = { content: { includeCost: false } };
  patch.removePath(source, "content.includeCost");
  assert.deepEqual(source, { content: { includeCost: false } }, "入参不得被修改");
});

await step("S12 removeArrayEntryField：按 provider id 删一个字段，保留定义/options/未知字段/其它渠道", () => {
  const raw = {
    providers: [
      { id: "terminal", type: "terminal", enabled: false, options: {} },
      { id: "debug", type: "debug", enabled: false, options: { url: "https://example.invalid" }, note: "keep" },
    ],
  };
  assert.deepEqual(patch.removeArrayEntryField(raw, "providers", "terminal", "enabled"), {
    providers: [
      { id: "terminal", type: "terminal", options: {} },
      { id: "debug", type: "debug", enabled: false, options: { url: "https://example.invalid" }, note: "keep" },
    ],
  });
  assert.equal(raw.providers[0].enabled, false, "入参不得被修改");
  assert.deepEqual(patch.removeArrayEntryField({ providers: "broken" }, "providers", "terminal", "enabled"), { providers: "broken" }, "非数组时零变化");
  assert.deepEqual(patch.removeArrayEntryField({}, "providers", "terminal", "enabled"), {}, "缺失即零变化");
});

await step("S13 clearItemOverride：只清目标项的本对话覆盖（普通字段/渠道都支持）", () => {
  const minLevel = itemOf("minLevel");
  const terminal = itemOf("provider:terminal");
  assert.deepEqual(
    settings.clearItemOverride({ patch: { minLevel: "error", enabled: false }, providers: {}, providerOptions: {} }, minLevel),
    { patch: { enabled: false }, providers: {}, providerOptions: {} },
  );
  assert.deepEqual(
    settings.clearItemOverride({ patch: {}, providers: { terminal: false, debug: true }, providerOptions: {} }, terminal),
    { patch: {}, providers: { debug: true }, providerOptions: {} },
  );
});

for (const item of failures) {
  console.error(`\n[FAIL] ${item.name}\n${item.error?.stack ?? item.error}`);
}

if (failures.length === 0) {
  console.log("\n通过：补丁语义 / overlay 形状 / 用户默认存在性 / 候选值 全部断言成立。");
  process.exit(0);
} else {
  console.error(`\n失败：${failures.length} 项断言未通过。`);
  process.exit(1);
}
