/** Pure UI derivations and test-observer lifecycle. No TUI, SDK, vault or real deliveries. */
import "./fixtures/isolate-keyring.cjs";
import assert from "node:assert/strict";
import { defaultConfig, mergeConfig } from "../src/config.ts";
import { buildSettingItems } from "../src/settings.ts";
import { candidateIsCurrent, candidateIsDefault, initialCandidateFocus, settingCandidates } from "../src/ui-candidates.ts";
import { emailTestKey, SettingsTestRun } from "../src/ui-test.ts";
import { channelState } from "../src/channels.ts";
import { settingsTestTarget } from "../src/ui-model.ts";

let passed = 0;
function step(name, run) { run(); passed++; console.log(`  ✓ ${name}`); }
const item = (config, id) => buildSettingItems(config).find((item) => item.id === id);
function observer(options = {}) {
  const run = new SettingsTestRun(), updates = [];
  let progress, unsubscribed = 0, valid = true;
  const start = () => run.start((callback) => {
    progress = callback;
    options.immediate?.(callback);
    return { ok: true, message: "已排队", unsubscribe() { unsubscribed++; } };
  }, { emailOnly: options.emailOnly ?? false, valid: () => valid, update: (value) => updates.push(value) });
  return { run, start, updates, emit: (stage, extra = {}) => progress({ id: "fake", stage, ...extra }),
    callback: () => progress, invalidate: () => { valid = false; }, unsubscribed: () => unsubscribed };
}

step("Candidate derivation includes non-preset current/default values exactly once, with independent markers", () => {
  const config = defaultConfig(); config.content.maxMessageChars = 417;
  const field = item(config, "content.maxMessageChars");
  const rows = settingCandidates(field, config, 619);
  assert.equal(rows.filter((row) => row.value === 417).length, 1);
  assert.equal(rows.filter((row) => row.value === 619).length, 1);
  assert.equal(rows.at(-1).custom, true);
  assert.equal(rows[initialCandidateFocus(field, rows, 417)].value, 417);
  for (const row of rows) {
    assert.equal(candidateIsCurrent(field, row, 417), row.value === 417);
    assert.equal(candidateIsDefault(field, row, 417, 619, true), row.value === 619);
    assert.equal(candidateIsDefault(field, row, 417, 619, false), false);
  }
  assert.equal(settingCandidates(field, config, 417).filter((row) => row.value === 417).length, 1);
});
step("Collections distinguish inherit, membership and empty selection; synthetic rows have no markers", () => {
  const config = defaultConfig(), field = item(config, "rules.runCompleted.channels");
  const rows = settingCandidates(field, config, undefined);
  const inherit = rows[0], terminal = rows.find((row) => row.value === "terminal");
  assert.equal(inherit.inherit, true);
  assert.equal(candidateIsCurrent(field, inherit, "inherit"), true);
  assert.equal(candidateIsDefault(field, inherit, [], "inherit", true), true);
  assert.equal(candidateIsCurrent(field, terminal, []), false);
  assert.equal(candidateIsCurrent(field, terminal, ["terminal"]), true);
  assert.equal(candidateIsDefault(field, terminal, [], ["terminal"], true), true);
  assert.equal(initialCandidateFocus(field, rows, []), 0);
  for (const extra of [{ ...terminal, custom: true }, { ...terminal, feedback: true }]) {
    assert.equal(candidateIsCurrent(field, extra, ["terminal"]), false);
    assert.equal(candidateIsDefault(field, extra, ["terminal"], ["terminal"], true), false);
  }
});
step("Mixed compound booleans are not coerced into an enabled/disabled current row", () => {
  const config = defaultConfig(); config.rules.compactFailed.enabled = false;
  const field = item(config, "reminders.failed"), current = field.read(config);
  const rows = settingCandidates(field, config, undefined);
  assert.equal(current, "mixed");
  assert.equal(rows.some((row) => candidateIsCurrent(field, row, current)), false);
});
step("Settings table excludes unsupported professional fields without a UI snapshot", () => {
  const ids = buildSettingItems(defaultConfig()).map((item) => item.id);
  assert.ok(ids.includes("rules.toolFailed.channels"));
  for (const id of ["delivery.timeoutMs", "coalesce.windowMs", "rules.toolFailed.mode", "rules.toolFailed.threshold", "rules.waitingForUser.kinds"]) assert.ok(!ids.includes(id));
});
step("Disabled channels show only their switch state; enabled channels expose missing prerequisites", () => {
  for (const enabled of [true, false]) {
    const config = mergeConfig(defaultConfig(), { providers: [{ id: "email", type: "email", enabled,
      options: { from: "fake@qq.com", to: ["reader@example.com"] } }] }, "test").config;
    const email = config.providers.find((p) => p.id === "email");
    assert.equal(channelState(config, "email", false), enabled ? "开启（缺授权码）" : "关闭");
    email.options.to = []; assert.equal(channelState(config, "email", true), enabled ? "开启（缺收件地址）" : "关闭");
    email.options.from = ""; assert.equal(channelState(config, "email", true), enabled ? "开启（缺发件地址）" : "关闭");
    config.providers.find((p) => p.id === "terminal").enabled = enabled;
    assert.equal(channelState(config, "terminal", true, "fake"), enabled ? "开启（不可用）" : "关闭");
  }
});
step("Test target resolution follows focused home channels, email page and rules, leaving config unchanged", () => {
  const config = mergeConfig(defaultConfig(), { channels: ["terminal", "email", "hook"], providers: [
    { id: "terminal", type: "terminal" }, { id: "email", type: "email" }, { id: "hook", type: "debug" }],
    rules: { runFailed: { channels: ["hook"] }, runCompleted: { channels: [] } } }, "test").config;
  const before = structuredClone(config);
  for (const [page, id, channels, emailOnly] of [
    ["home", "provider:terminal", ["terminal"], false], ["home", "provider:email", ["email"], true],
    ["home", "provider:hook", ["hook"], false], ["email-config", "provider:email:from", ["email"], true],
    ["email-config", undefined, ["email"], true], ["home", undefined, config.channels, false],
    ["home", "enabled", config.channels, false], ["category:providers", "provider:email", config.channels, false],
    ["rule:runFailed", undefined, ["hook"], false], ["rule:runCompleted", undefined, [], false],
    ["rule:waitingForUser", undefined, config.channels, false], [undefined, "rules.runFailed.level", ["hook"], false],
    [undefined, "provider:email", config.channels, false], ["status", undefined, config.channels, false],
  ]) assert.deepEqual(settingsTestTarget(config, id ? item(config, id) : undefined, page), { channels, emailOnly });
  assert.deepEqual(config, before);
});
step("Test result aggregation preserves partial results and redacts full diagnostics on cancellation", () => {
  const h = observer(); h.start();
  h.emit("result", { result: { providerId: "terminal", ok: true } });
  h.emit("result", { result: { providerId: "email", ok: false, error: "password=fake-private full-tail" } });
  assert.equal(h.updates.at(-1).result.ok, false);
  assert.match(h.updates.at(-1).result.message, /本机通知：服务已接受.*邮箱通知：发送失败/);
  h.emit("cancelled", { reason: "disposed" });
  const result = h.updates.at(-1).result;
  assert.match(result.message, /发送结果保留/);
  assert.match(result.feedback.details.join(""), /full-tail.*服务接受不代表实际送达/);
  assert.doesNotMatch(JSON.stringify(result), /fake-private/);
  const count = h.updates.length;
  h.emit("result", { result: { providerId: "email", ok: true } }); h.emit("finished");
  assert.equal(h.updates.length, count, "terminal events reject late progress");
  h.run.stop(); assert.equal(h.unsubscribed(), 0);
});
step("Observer replacement and stop invalidate callbacks before detaching, without cancelling delivery", () => {
  const h = observer(); h.start(); const old = h.callback();
  h.start(); assert.equal(h.unsubscribed(), 1);
  const count = h.updates.length;
  old({ id: "old", stage: "sending" }); assert.equal(h.updates.length, count);
  h.run.stop(); h.run.stop(); assert.equal(h.unsubscribed(), 2);
  h.emit("result", { result: { providerId: "terminal", ok: true } }); assert.equal(h.updates.length, count);
});
step("Synchronous finished results win over the initial queued message and require no later unsubscribe", () => {
  const h = observer({ immediate(callback) {
    callback({ id: "sync", stage: "result", result: { providerId: "terminal", ok: true } });
    callback({ id: "sync", stage: "finished" });
  } });
  h.start(); assert.match(h.updates.at(-1).result.message, /服务已接受/);
  h.run.stop(); assert.equal(h.unsubscribed(), 0);
});
step("Blocked submission is surfaced without inventing a sent result", () => {
  const updates = [], run = new SettingsTestRun();
  run.start(() => ({ ok: false, message: "fake blocked" }), { emailOnly: false, valid: () => true, update: (value) => updates.push(value) });
  assert.deepEqual(updates, [{ result: { ok: false, message: "fake blocked", feedback: { kind: "blocked", next: "diagnostics" } } }]);
});
step("Email cancellation distinguishes unsent, unknown and accepted; skipped is never accepted", () => {
  const h = observer({ emailOnly: true });
  h.start(); h.emit("cancelled", { reason: "disposed" }); assert.equal(h.updates.at(-1).emailLabel, "未发送");
  h.start(); h.emit("sending"); h.emit("cancelled", { reason: "disposed" }); assert.equal(h.updates.at(-1).emailLabel, "结果未知");
  h.start(); h.emit("finished"); assert.equal(h.updates.at(-1).emailLabel, "结果未知");
  h.start(); h.emit("result", { result: { providerId: "email", ok: true } });
  assert.equal(h.updates.at(-1).emailLabel, "服务已接受，尚未确认收件");
  h.emit("cancelled", { reason: "disposed" }); assert.equal(h.updates.at(-1).emailLabel, undefined, "preserve prior email status");
  h.start(); h.emit("result", { result: { providerId: "email", ok: true, skipped: true } });
  assert.equal(h.updates.at(-1).emailLabel, "未发送"); assert.equal(h.updates.at(-1).result.ok, false);
  h.invalidate(); const count = h.updates.length;
  h.emit("result", { result: { providerId: "email", ok: true } }); assert.equal(h.updates.length, count);
  h.run.stop(); assert.equal(h.unsubscribed(), 1);
});
step("Email test fingerprint tracks sender inputs/credential revision, never arbitrary secret options", () => {
  const config = defaultConfig(), email = config.providers.find((p) => p.id === "email");
  email.options.extra = { password: "fake-secret" };
  const before = emailTestKey(config, "已设置", 0);
  assert.doesNotMatch(before, /fake-secret|password/);
  email.options.extra.password = "fake-new-secret"; assert.equal(emailTestKey(config, "已设置", 0), before);
  email.options.to = ["reader@example.com"]; assert.notEqual(emailTestKey(config, "已设置", 0), before);
  assert.notEqual(emailTestKey(config, "已设置", 0), emailTestKey(config, "已设置", 1));
  assert.notEqual(emailTestKey(config, "已设置", 1), emailTestKey(config, "未设置", 1));
});
console.log(`Settings model: ${passed} passed`);
