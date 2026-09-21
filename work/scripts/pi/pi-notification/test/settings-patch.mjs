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
  assert.deepEqual(settings.emptyOverlay(), { patch: {}, providers: {} });
  assert.equal(settings.isEmptyOverlay(settings.emptyOverlay()), true);
  assert.equal(settings.isEmptyOverlay({ patch: { enabled: false }, providers: {} }), false);
  assert.equal(settings.isEmptyOverlay({ patch: {}, providers: { terminal: false } }), false);

  assert.equal(settings.overlayFromEntry(undefined), undefined);
  assert.equal(settings.overlayFromEntry(42), undefined);
  assert.equal(settings.overlayFromEntry({ patch: {}, providers: {} }), undefined, "空条目等同于没有覆盖");
  assert.deepEqual(settings.overlayFromEntry({ patch: "broken", providers: { a: "yes", b: true } }), {
    patch: {},
    providers: { b: true },
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
  assert.equal(settings.CUSTOM_ROW_LABEL, "custom…", "custom 行标签是 UI 与测试共用的常量");
  assert.deepEqual(
    settings.candidatesOf(itemOf("quietHours.enabled"), config.defaultConfig()).map((candidate) => candidate.value),
    [true, false],
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
