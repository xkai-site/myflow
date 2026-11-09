/** Application contracts without a TUI. Temp defaults, isolated vault, no notifier or network. */
import "./fixtures/isolate-keyring.cjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSettingsHost } from "../src/settings-actions.ts";
import { loadConfig, readUserConfigRaw, userConfigPath } from "../src/config.ts";
import { buildSettingItems } from "../src/settings.ts";
import { applyOverlay, emptyOverlay } from "../src/settings-state.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "notify-actions-"));
let serial = 0, passed = 0;
function harness(raw) {
  const dir = path.join(tmp, String(++serial));
  const file = userConfigPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw));
  let overlay = emptyOverlay(), commits = 0, silenced = false;
  const current = () => applyOverlay(loadConfig({ agentDir: dir }).config, overlay).config;
  const host = createSettingsHost({
    config: current, configLoad: () => loadConfig({ agentDir: dir }), agentDir: () => dir,
    log: { log() {}, record() {} }, sessionId: () => "test", isSilenced: () => silenced,
    service: () => { throw new Error("Configuration operations must not access delivery service"); },
    reload() {}, overlay: () => overlay,
    setOverlay(next) { overlay = next; commits++; },
    userRaw: () => readUserConfigRaw(dir).raw,
  });
  return { host, file, current, overlay: () => structuredClone(overlay), commits: () => commits,
    silence: () => { silenced = true; }, item: (id) => buildSettingItems(current()).find((item) => item.id === id) };
}
function step(name, run) { run(); passed++; console.log(`  ✓ ${name}`); }
try {
  step("Unused channel activation is one session transaction, with explicit unified-selection impact", () => {
    const h = harness({ channels: [], providers: [{ id: "terminal", type: "terminal", enabled: false }], rules: { runFailed: { channels: [] } } });
    const before = fs.readFileSync(h.file, "utf8"), rules = structuredClone(h.current().rules);
    assert.deepEqual(h.host.channelActivation("terminal"), { kind: "ready", addUnified: true });
    assert.equal(h.commits(), 0);
    assert.equal(h.host.enableChannel("terminal").ok, true);
    assert.equal(h.commits(), 1);
    assert.deepEqual(h.current().channels, ["terminal"]);
    assert.equal(h.current().providers.find((provider) => provider.id === "terminal").enabled, true);
    assert.deepEqual(h.current().rules, rules);
    assert.equal(fs.readFileSync(h.file, "utf8"), before);
  });
  step("Even a disabled rule reference prevents silently joining unified destinations", () => {
    const h = harness({ channels: [], providers: [{ id: "terminal", type: "terminal", enabled: false }],
      rules: { runFailed: { enabled: false, channels: ["terminal"] } } });
    assert.deepEqual(h.host.channelActivation("terminal"), { kind: "ready", addUnified: false });
    assert.equal(h.host.enableChannel("terminal").ok, true);
    assert.deepEqual(h.current().channels, []);
    assert.deepEqual(h.current().rules.runFailed.channels, ["terminal"]);
    assert.equal(h.current().rules.runFailed.enabled, false);
    h.host.saveDefault(h.item("provider:terminal"));
    assert.equal(h.host.userRaw().providers[0].enabled, true);
    assert.deepEqual(h.host.userRaw().channels, []);
  });
  step("Commit rechecks forced silence and unavailable channels, leaving the overlay untouched", () => {
    const h = harness({ channels: [], providers: [{ id: "terminal", type: "terminal", enabled: false }] });
    assert.equal(h.host.channelActivation("terminal").kind, "ready");
    h.silence();
    assert.equal(h.host.enableChannel("terminal").ok, false);
    assert.equal(h.commits(), 0);
    assert.deepEqual(h.overlay(), emptyOverlay());
    const invalid = harness({ providers: [{ id: "hook", type: "webhook", enabled: false }] });
    assert.equal(invalid.host.channelActivation("hook").kind, "blocked");
    assert.equal(invalid.host.enableChannel("hook").ok, false);
    assert.equal(invalid.host.enableChannel("missing").ok, false);
    assert.equal(invalid.commits(), 0);
  });
  step("Email prerequisite changes between planning and commit cannot open a channel", () => {
    const h = harness({ channels: [], providers: [{ id: "email", type: "email", enabled: false,
      options: { from: "fake@qq.com", to: ["reader@example.com"] } }] });
    process.env.PI_NOTIFY_QQ_SMTP_AUTH_CODE = "fake-test-only";
    assert.deepEqual(h.host.channelActivation("email"), { kind: "ready", addUnified: true });
    delete process.env.PI_NOTIFY_QQ_SMTP_AUTH_CODE;
    assert.deepEqual(h.host.channelActivation("email"), { kind: "email", field: "credential" });
    const result = h.host.enableChannel("email");
    assert.equal(result.ok, false);
    assert.equal(result.feedback.next, "email");
    assert.equal(h.commits(), 0);
    assert.doesNotMatch(JSON.stringify(h.overlay()) + JSON.stringify(h.host.userRaw()), /fake-test-only/);
  });
  step("Disabling an incomplete email channel needs no activation prerequisites and preserves routing", () => {
    const h = harness({ channels: ["email"], providers: [{ id: "email", type: "email", enabled: true }],
      rules: { runFailed: { channels: ["email"] } } });
    const before = fs.readFileSync(h.file, "utf8"), rules = structuredClone(h.current().rules);
    assert.equal(h.host.setValue(h.item("provider:email"), false).ok, true);
    assert.equal(h.commits(), 1);
    assert.equal(h.current().providers.find((provider) => provider.id === "email").enabled, false);
    assert.deepEqual(h.current().channels, ["email"]);
    assert.deepEqual(h.current().rules, rules);
    assert.equal(fs.readFileSync(h.file, "utf8"), before);
    assert.deepEqual(h.host.channelActivation("email"), { kind: "email", field: "from" });
    assert.equal(h.host.enableChannel("email").ok, false);
    assert.equal(h.commits(), 1);
  });
  step("Failed atomic save/restore preserves session choices and malformed file bytes", () => {
    const h = harness({});
    const item = h.item("enabled");
    assert.equal(h.host.setValue(item, false).ok, true);
    const overlay = h.overlay();
    fs.writeFileSync(h.file, "{broken");
    assert.equal(h.host.saveDefault(item).ok, false);
    assert.equal(h.host.saveChanges([item]).ok, false);
    assert.equal(h.host.restoreBuiltinDefault(item).ok, false);
    assert.equal(fs.readFileSync(h.file, "utf8"), "{broken");
    assert.deepEqual(h.overlay(), overlay);
    fs.writeFileSync(h.file, "{}");
    assert.equal(h.host.saveDefault(item).ok, true);
    assert.deepEqual(h.host.userRaw(), { enabled: false });
    assert.equal(h.host.restoreBuiltinDefault(item).ok, true);
    assert.deepEqual(h.host.userRaw(), {});
    assert.deepEqual(h.overlay(), emptyOverlay());
  });
} finally {
  delete process.env.PI_NOTIFY_QQ_SMTP_AUTH_CODE;
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`Settings actions: ${passed} passed`);
