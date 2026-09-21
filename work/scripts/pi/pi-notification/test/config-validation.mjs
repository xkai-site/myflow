/**
 * Config validation matrix: field-level checks, degradation, sparse writes and the atomic write path.
 *
 * A separate script because these are pure functions over one object: no SDK, no session, no clock.
 * The host-level effects of a config (thresholds, rules, channels, degradation reaching the user) are
 * covered in test/host-lifecycle.mjs (I1-I9) and the quiet-hours reading rules in
 * test/service-coalesce.mjs (Q); what is asserted here is the validation surface itself.
 *
 *   MSYS_NO_PATHCONV=1 node test/config-validation.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url));
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

const merge = (raw) => config.mergeConfig(config.defaultConfig(), raw, "test");
const errorPaths = (raw) => merge(raw).errors.map((problem) => problem.path);
const warningPaths = (raw) => merge(raw).warnings.map((problem) => problem.path);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-notify-config-"));
const cleanAgentDir = (label) => {
  const agentDir = path.join(TMP, label, "agent");
  fs.mkdirSync(path.join(agentDir, "pi-notification"), { recursive: true });
  return agentDir;
};
const writeRawFile = (agentDir, text) => fs.writeFileSync(config.userConfigPath(agentDir), text);

console.log("配置校验专项回归：pi-notification");

await step("C1 version 必须是 1；非法版本导致整份降级并保留原因", async () => {
  assert.deepEqual(errorPaths({ version: 2 }), ["version"]);
  assert.deepEqual(errorPaths({ version: "1" }), ["version"]);
  assert.deepEqual(errorPaths({ version: 1 }), [], "version=1 不该报错");

  const agentDir = cleanAgentDir("version");
  writeRawFile(agentDir, JSON.stringify({ version: 2 }));
  const load = config.loadConfig({ agentDir });
  assert.equal(load.degraded, true);
  assert.ok(load.errors.some((problem) => problem.path === "version"), `缺少 version 错误: ${JSON.stringify(load.errors)}`);
  assert.equal(load.config.minLevel, "error", "降级后应抬高门槛");
});

await step("C2 未知规则名只给警告（前向兼容）且不生效；rules 非对象才是错误", async () => {
  const merged = merge({ rules: { futureRule: { enabled: false }, runCompleted: { enabled: false } } });
  assert.deepEqual(merged.errors, [], "未知规则名不该导致降级");
  assert.deepEqual(merged.warnings.map((problem) => problem.path), ["rules.futureRule"]);
  assert.equal(merged.config.rules.runCompleted.enabled, false, "同一份配置里的已知规则必须生效");

  assert.deepEqual(errorPaths({ rules: [] }), ["rules"]);
  assert.deepEqual(errorPaths({ rules: { runCompleted: false } }), ["rules.runCompleted"]);

  // A rule inherits from the value already on `base`, so saving one field cannot reset its siblings.
  const base = config.defaultConfig();
  base.rules.runCompleted = { enabled: true, level: "warning", channels: ["debug"] };
  const inherited = config.mergeConfig(base, { rules: { runCompleted: { enabled: false } } }, "test");
  assert.deepEqual(inherited.config.rules.runCompleted, { enabled: false, level: "warning", channels: ["debug"] });
});

await step("C3 数值字段边界：边界值通过，越界/非整数/字符串数字一律报错", async () => {
  const cases = [
    ["content.maxMessageChars", 20, true],
    ["content.maxMessageChars", 2000, true],
    ["content.maxMessageChars", 19, false],
    ["content.maxMessageChars", 2001, false],
    ["content.maxMessageChars", 1.5, false],
    ["content.maxMessageChars", "300", false],
    ["coalesce.windowMs", 0, true],
    ["coalesce.windowMs", 600000, true],
    ["coalesce.windowMs", -1, false],
    ["coalesce.windowMs", 600001, false],
    ["coalesce.cooldownMs", 1.5, false],
    ["coalesce.toolFailureWindowMs", -1, false],
    ["delivery.maxRetries", 0, true],
    ["delivery.maxRetries", 10, true],
    ["delivery.maxRetries", 11, false],
    ["delivery.concurrency", 1, true],
    ["delivery.concurrency", 0, false],
    ["delivery.concurrency", 9, false],
    ["delivery.queueLimit", 1, true],
    ["delivery.queueLimit", 0, false],
    ["delivery.queueLimit", 1001, false],
    ["delivery.circuitBreakerFailures", 0, true],
    ["delivery.circuitBreakerFailures", 101, false],
  ];
  for (const [dotted, value, ok] of cases) {
    const [group, field] = dotted.split(".");
    const problems = errorPaths({ [group]: { [field]: value } });
    const label = `${dotted}=${JSON.stringify(value)}`;
    if (ok) assert.deepEqual(problems, [], `${label} 应该通过校验: ${problems}`);
    else assert.deepEqual(problems, [dotted], `${label} 应该被拒绝: ${problems}`);
  }

  assert.deepEqual(errorPaths({ shutdownFlushMs: 0 }), [], "0 表示不等待，合法");
  assert.deepEqual(errorPaths({ shutdownFlushMs: 5000 }), [], "上界包含");
  assert.deepEqual(errorPaths({ shutdownFlushMs: 5001 }), ["shutdownFlushMs"]);
  assert.deepEqual(errorPaths({ shutdownFlushMs: -1 }), ["shutdownFlushMs"]);
});

await step("C4 规则内部字段：level / channels / toolFailed 策略与阈值", async () => {
  assert.deepEqual(errorPaths({ rules: { runCompleted: { level: "loud" } } }), ["rules.runCompleted.level"]);
  assert.deepEqual(errorPaths({ rules: { runCompleted: { channels: [""] } } }), ["rules.runCompleted.channels"]);
  assert.deepEqual(errorPaths({ rules: { runCompleted: { channels: "terminal" } } }), ["rules.runCompleted.channels"]);
  assert.deepEqual(errorPaths({ rules: { runCompleted: { enabled: "yes" } } }), ["rules.runCompleted.enabled"]);

  const deduped = merge({ rules: { runCompleted: { channels: ["debug", "debug", "terminal"] } } });
  assert.deepEqual(deduped.config.rules.runCompleted.channels, ["debug", "terminal"], "渠道列表必须去重且保序");

  assert.deepEqual(errorPaths({ rules: { toolFailed: { mode: "batch" } } }), ["rules.toolFailed.mode"]);
  assert.deepEqual(errorPaths({ rules: { toolFailed: { threshold: 0 } } }), ["rules.toolFailed.threshold"]);
  assert.deepEqual(errorPaths({ rules: { toolFailed: { threshold: 101 } } }), ["rules.toolFailed.threshold"]);
  assert.deepEqual(errorPaths({ rules: { toolFailed: { mode: "immediate", threshold: 2 } } }), []);
});

await step("C5 waitingForUser.kinds：未知 kind 报错，custom 只警告并从生效值里滤掉", async () => {
  const unknown = merge({ rules: { waitingForUser: { kinds: ["select", "bogus"] } } });
  assert.deepEqual(unknown.errors.map((problem) => problem.path), ["rules.waitingForUser.kinds"]);
  assert.deepEqual(errorPaths({ rules: { waitingForUser: { kinds: "select" } } }), ["rules.waitingForUser.kinds"]);

  const custom = merge({ rules: { waitingForUser: { kinds: ["select", "custom", "select"] } } });
  assert.deepEqual(custom.errors, [], "custom 不该让整份配置失效");
  assert.deepEqual(custom.warnings.map((problem) => problem.path), ["rules.waitingForUser.kinds"]);
  assert.deepEqual(custom.config.rules.waitingForUser.kinds, ["select"], "custom 必须从生效值里消失");
});

await step("C6 providers：重复 id / 缺 type / options 非对象报错；非法项被丢弃而不是整份失效", async () => {
  assert.deepEqual(errorPaths({ providers: [{ id: "a", type: "debug" }, { id: "a", type: "debug" }] }), ["providers[1].id"]);
  assert.deepEqual(errorPaths({ providers: [{ id: "", type: "debug" }] }), ["providers[0].id"]);
  assert.deepEqual(errorPaths({ providers: [{ id: "a" }] }), ["providers[0].type"]);
  assert.deepEqual(errorPaths({ providers: [{ id: "a", type: "debug", options: "x" }] }), ["providers[0].options"]);
  assert.deepEqual(errorPaths({ providers: [null] }), ["providers[0]"]);

  const mixed = merge({ providers: [{ id: "ok", type: "debug" }, { id: "bad" }] });
  assert.deepEqual(mixed.config.providers.map((provider) => provider.id), ["ok"], "合法渠道应保留");
  assert.deepEqual(mixed.config.providers[0].options, {}, "options 缺失时补空对象");
  assert.equal(mixed.config.providers[0].enabled, true, "enabled 缺失时默认开启");
});

await step("C6b providers[].enabled 非布尔必须报错，而不是静默当作 true", () => {
  for (const value of ["false", 0, null]) {
    const problems = errorPaths({ providers: [{ id: "x", type: "debug", enabled: value }] });
    assert.deepEqual(problems, ["providers[0].enabled"], `enabled=${JSON.stringify(value)} 被静默接受`);
  }
  // The invalid entry is dropped, so it cannot be used even before degradation kicks in.
  const merged = merge({ providers: [{ id: "ok", type: "debug" }, { id: "bad", type: "debug", enabled: "false" }] });
  assert.deepEqual(merged.config.providers.map((provider) => provider.id), ["ok"]);
});

await step("C7 degradedConfig 形状：仅失败通知、error 门槛、唯一渠道、不启用静默时段", () => {
  const degraded = config.degradedConfig();
  assert.equal(degraded.minLevel, "error");
  assert.equal(degraded.enabled, true, "降级不是关闭通知");
  assert.deepEqual(
    Object.entries(degraded.rules).filter(([, rule]) => rule.enabled).map(([key]) => key),
    ["runFailed"],
  );
  assert.deepEqual(degraded.providers.map((provider) => provider.id), ["terminal"]);
  assert.equal(degraded.quietHours.enabled, false, "降级配置不得因为静默时段再吞掉失败通知");
  assert.deepEqual(degraded.rules.waitingForUser.kinds, ["select", "confirm", "input", "editor"]);
});

await step("C8 loadConfig：坏文件整份降级；只有未知字段时只提示不降级", async () => {
  const broken = cleanAgentDir("broken-json");
  writeRawFile(broken, "{not json");
  const brokenLoad = config.loadConfig({ agentDir: broken });
  assert.equal(brokenLoad.degraded, true);
  assert.equal(brokenLoad.config.minLevel, "error");
  assert.match(JSON.stringify(brokenLoad.errors), /JSON/);
  assert.ok(brokenLoad.sources.some((source) => source.includes("config.json")));

  const nonObject = cleanAgentDir("non-object");
  writeRawFile(nonObject, "[]");
  assert.equal(config.loadConfig({ agentDir: nonObject }).degraded, true, "根不是对象必须降级");

  const missing = cleanAgentDir("missing");
  const defaults = config.loadConfig({ agentDir: missing });
  assert.equal(defaults.degraded, false);
  assert.deepEqual(defaults.errors, []);
  assert.deepEqual(defaults.sources, ["defaults"], "没有文件时只有出厂默认一层");

  const forward = cleanAgentDir("forward");
  writeRawFile(forward, JSON.stringify({ version: 1, futureTop: true, content: { futureField: 1 } }));
  const forwardLoad = config.loadConfig({ agentDir: forward });
  assert.equal(forwardLoad.degraded, false, "未知字段（含已删字段）不得让配置降级");
  assert.deepEqual(forwardLoad.errors, []);
});

await step("C9 isDisabledByEnv 只认 1/true；describeConfig 汇总开关与渠道", () => {
  for (const value of ["1", "true"]) {
    assert.equal(config.isDisabledByEnv({ PI_NOTIFY_DISABLE: value }), true, `${value} 应视为静默`);
  }
  for (const value of ["0", "TRUE", "yes", "", undefined]) {
    assert.equal(config.isDisabledByEnv({ PI_NOTIFY_DISABLE: value }), false, `${String(value)} 不应视为静默`);
  }

  const described = config.describeConfig(config.defaultConfig());
  assert.match(described, /enabled=true/);
  assert.match(described, /minLevel=info/);
  assert.match(described, /rules=runCompleted,runFailed,toolFailed,compactFailed/);
  assert.match(described, /providers=terminal:terminal/);
  assert.match(described, /timeoutMs=8000/);

  const empty = config.defaultConfig();
  empty.providers = [];
  empty.rules.runCompleted.enabled = false;
  empty.rules.runFailed.enabled = false;
  empty.rules.toolFailed.enabled = false;
  empty.rules.compactFailed.enabled = false;
  assert.match(config.describeConfig(empty), /rules=none/);
  assert.match(config.describeConfig(empty), /providers=none/);
});

await step("C10 readUserConfigRaw：缺文件返回空、根不是对象与损坏 JSON 都拒绝", () => {
  const agentDir = cleanAgentDir("raw");
  assert.deepEqual(config.readUserConfigRaw(agentDir), { ok: true, raw: undefined });

  writeRawFile(agentDir, JSON.stringify([1, 2]));
  const array = config.readUserConfigRaw(agentDir);
  assert.equal(array.ok, false);
  assert.match(JSON.stringify(array.problems), /JSON 对象/);

  writeRawFile(agentDir, "\"text\"");
  assert.equal(config.readUserConfigRaw(agentDir).ok, false);

  writeRawFile(agentDir, "{broken");
  assert.equal(config.readUserConfigRaw(agentDir).ok, false);
});

await step("C11 writeUserDefault：稀疏写盘只动这一项，保留其它原文；拒绝损坏文件与非法值", () => {
  const agentDir = cleanAgentDir("sparse");
  writeRawFile(agentDir, JSON.stringify({ content: { includeCost: false }, futureTop: 7 }, null, 2));

  const result = config.writeUserDefault(agentDir, { coalesce: { windowMs: 0 } });
  assert.equal(result.ok, true, `写盘应成功: ${JSON.stringify(result.problems)}`);
  assert.deepEqual(
    config.readUserConfigRaw(agentDir).raw,
    { content: { includeCost: false }, futureTop: 7, coalesce: { windowMs: 0 } },
    "只应新增这一项并保留原文其它字段",
  );
  assert.equal(result.config.coalesce.windowMs, 0, "返回值必须带上合并后的生效配置");
  assert.equal(result.config.coalesce.cooldownMs, config.defaultConfig().coalesce.cooldownMs, "未保存的兄弟字段跟随出厂默认");

  const corrupt = cleanAgentDir("corrupt-write");
  writeRawFile(corrupt, "{broken");
  const refused = config.writeUserDefault(corrupt, { enabled: false });
  assert.equal(refused.ok, false, "损坏文件必须拒绝写入，而不是把降级结果固化下来");
  assert.equal(fs.readFileSync(config.userConfigPath(corrupt), "utf8"), "{broken", "拒绝写入时不得改动原文件");

  const invalidDir = cleanAgentDir("invalid-write");
  const invalid = config.writeUserDefault(invalidDir, { minLevel: "loud" });
  assert.equal(invalid.ok, false);
  assert.equal(fs.existsSync(config.userConfigPath(invalidDir)), false, "非法值不应留下任何文件");
});

await step("C12 writeUserConfig：写全量快照，失败时不留临时文件也不改动原文件", () => {
  const agentDir = cleanAgentDir("snapshot");
  const written = config.writeUserConfig(agentDir, { version: 1, minLevel: "warning" });
  assert.equal(written.ok, true);
  const onDisk = JSON.parse(fs.readFileSync(config.userConfigPath(agentDir), "utf8"));
  assert.equal(onDisk.minLevel, "warning");
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.delivery.timeoutMs, config.defaultConfig().delivery.timeoutMs, "快照写盘会把其余字段写成当前默认值");

  const blockedRoot = path.join(TMP, "blocked");
  fs.mkdirSync(blockedRoot, { recursive: true });
  const blocker = path.join(blockedRoot, "not-a-dir");
  fs.writeFileSync(blocker, "x");
  const failed = config.writeUserConfig(path.join(blocker, "agent"), { enabled: false });
  assert.equal(failed.ok, false, "目录不可创建时必须以失败返回而不是抛异常");
  assert.match(failed.problems[0].message, /ENOTDIR|ENOENT|EEXIST/);
  assert.deepEqual(fs.readdirSync(blockedRoot), ["not-a-dir"], "失败后不得留下临时文件");
});

fs.rmSync(TMP, { recursive: true, force: true });

for (const item of failures) {
  console.error(`\n[FAIL] ${item.name}\n${item.error?.stack ?? item.error}`);
}

if (failures.length === 0) {
  console.log("\n通过：字段校验矩阵 / 降级 / 稀疏与原子写盘 全部断言成立。");
  process.exit(0);
} else {
  console.error(`\n失败：${failures.length} 项断言未通过。`);
  process.exit(1);
}
