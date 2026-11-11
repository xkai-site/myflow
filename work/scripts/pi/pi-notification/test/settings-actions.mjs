/** Application contracts without a TUI. Temp defaults, isolated vault, no notifier or network. */
import "./fixtures/isolate-keyring.cjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSettingsHost } from "../src/settings-actions.ts";
import { createQqCredentials, QQ_AUTH_ENV } from "../src/mail/credentials.ts";
import { loadConfig, readUserConfigRaw, userConfigPath } from "../src/config.ts";
import { buildSettingItems } from "../src/settings.ts";
import { applyOverlay, emptyOverlay } from "../src/settings-state.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "notify-actions-"));
let serial = 0, passed = 0;
function harness(raw, credentials = createQqCredentials({ status: () => ({ available: true }), get: () => undefined, set() {}, delete() {} }, () => process.env[QQ_AUTH_ENV]), openUrl, runtimeGuard) {
  const dir = path.join(tmp, String(++serial));
  const file = userConfigPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw));
  let overlay = emptyOverlay(), commits = 0, silenced = false;
  const declared = () => applyOverlay(loadConfig({ agentDir: dir }).config, overlay).config;
  // The declaration is snapshotted at load time, like the host: an external file edit only becomes
  // visible after a successful reload. `runtimeGuard` models a host downgrade that never touches it.
  let declaration = structuredClone(declared());
  const current = () => { const config = declared(); return runtimeGuard ? runtimeGuard(config) : config; };
  const host = createSettingsHost({
    credentials, openUrl,
    config: current, configLoad: () => loadConfig({ agentDir: dir }), agentDir: () => dir, declared: () => declaration,
    log: { log() {}, record() {} }, sessionId: () => "test", isSilenced: () => silenced,
    service: () => { throw new Error("Configuration operations must not access delivery service"); },
    reload() { declaration = structuredClone(declared()); }, overlay: () => overlay,
    setOverlay(next) { overlay = next; commits++; declaration = structuredClone(declared()); },
    userRaw: () => readUserConfigRaw(dir).raw,
  });
  return { host, file, current, overlay: () => structuredClone(overlay), commits: () => commits,
    silence: () => { silenced = true; }, item: (id) => buildSettingItems(current()).find((item) => item.id === id) };
}
function step(name, run) { run(); passed++; console.log(`  ✓ ${name}`); }
try {
  for (const capability of [undefined, async () => true, async () => false, async () => { throw new Error("fake-url-private"); }]) {
    const h = harness({}, undefined, capability);
    const result = await h.host.openQqSettings();
    assert.match(result.message, /https:\/\/mail\.qq\.com\//);
    assert.doesNotMatch(JSON.stringify(result), /fake-url-private/);
    assert.equal(h.commits(), 0);
  }
  passed++; console.log("  ✓ No browser, open-capable, unavailable and failed host adapters all expose the official URL without secrets");
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
    assert.deepEqual(h.host.channelActivation("email"), { kind: "ready", addUnified: false });
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
  step("Every email enable entry checks prerequisites; destination edits never open gates", () => {
    const options = { from: "fake@qq.com", to: ["reader@example.com"] };
    for (const state of ["missing", "unavailable", "read-failed"]) {
      const credentials = createQqCredentials({ status: () => state === "unavailable" ? { available: false, reason: "离线测试无系统服务" } : { available: true },
        get() { if (state === "read-failed") throw new Error("fake-private"); }, set() {}, delete() {} }, () => undefined);
      const h = harness({ channels: [], providers: [{ id: "email", type: "email", enabled: false, options }] }, credentials);
      for (const result of [h.host.enableChannel("email"), h.host.setValue(h.item("provider:email"), true)]) {
        assert.equal(result.ok, false); assert.equal(result.feedback.next, "email");
        assert.match(result.message, state === "missing" ? /未配置授权码/ : state === "unavailable" ? /安全存储不可用/ : /读取失败/);
        assert.doesNotMatch(JSON.stringify(result), /fake-private/);
      }
      assert.equal(h.commits(), 0);
      assert.equal(h.host.setValue(h.item("channels"), ["email"]).ok, true);
      assert.equal(h.host.setValue(h.item("rules.runFailed.channels"), ["email"]).ok, true);
      assert.equal(h.current().providers.find((p) => p.id === "email").enabled, false);
      assert.deepEqual(h.current().rules.runFailed.channels, ["email"]);
      const raw = { channels: [], providers: [{ id: "email", type: "email", enabled: true, options }] };
      fs.writeFileSync(h.file, JSON.stringify(raw));
      // Explicitly pin the old off gate before following a newly-enabled user default.
      h.host.setValue(h.item("provider:email"), false);
      assert.equal(h.host.followUserDefault(h.item("provider:email")).ok, false);
      assert.equal(h.current().providers.find((p) => p.id === "email").enabled, false);
      const paused = harness({ ...raw, enabled: false }, credentials);
      assert.equal(paused.host.restoreBuiltinDefault(paused.item("enabled")).ok, false);
      assert.equal(paused.current().enabled, false);
      assert.equal(paused.host.restoreBuiltinDefault(paused.item("provider:email")).ok, true, "restoring built-in email gate always closes it");
      assert.deepEqual(paused.current().channels, []);
    }
  });
  step("Enable/disable/restore defaults preserve all email routes and do not access delivery service", () => {
    let value;
    const credentials = createQqCredentials({ status: () => ({ available: true }), get: () => value, set: (next) => { value = next; }, delete: () => { value = undefined; } }, () => undefined);
    const h = harness({ channels: [], providers: [{ id: "email", type: "email", enabled: false,
      options: { from: "fake@qq.com", to: ["reader@example.com"] } }], rules: { runFailed: { channels: ["email"], enabled: false } } }, credentials);
    const routes = structuredClone(h.current().rules);
    assert.equal(h.host.saveCredential("fake-new").ok, true);
    assert.equal(h.current().providers.find((p) => p.id === "email").enabled, false);
    for (let i = 0; i < 2; i++) {
      assert.equal(h.host.enableChannel("email").ok, true);
      assert.equal(h.host.setValue(h.item("provider:email"), false).ok, true);
    }
    assert.equal(h.host.deleteCredential().ok, true);
    assert.equal(h.host.enableChannel("email").ok, false);
    assert.equal(h.host.restoreBuiltinDefault(h.item("channels")).ok, true);
    assert.deepEqual(h.current().rules, routes);
    assert.doesNotMatch(JSON.stringify(h.overlay()) + fs.readFileSync(h.file, "utf8"), /fake-new/);
  });
  step("Following email defaults rejects missing addresses and invalid credentials without changing either layer", () => {
    for (const missing of ["from", "to", "credential"]) {
      const options = { from: "fake@qq.com", to: ["reader@example.com"] };
      if (missing === "from") options.from = "";
      if (missing === "to") options.to = [];
      const credentials = createQqCredentials({ status: () => ({ available: true }), get: () => "fake-only", set() {}, delete() {} },
        () => missing === "credential" ? "invalid\ncode" : undefined);
      const h = harness({ channels: [], providers: [{ id: "email", type: "email", enabled: true, options }],
        rules: { runFailed: { channels: ["email"], enabled: false } } }, credentials);
      const item = h.item("provider:email");
      assert.equal(h.host.setValue(item, false).ok, true);
      const before = h.overlay(), file = fs.readFileSync(h.file, "utf8"), commits = h.commits();
      const result = h.host.followUserDefault(item);
      assert.equal(result.ok, false);
      assert.equal(result.feedback.next, "email");
      assert.match(result.message, missing === "from" ? /发件/ : missing === "to" ? /收件/ : /授权码无效/);
      assert.deepEqual(h.overlay(), before);
      assert.equal(h.commits(), commits);
      assert.equal(fs.readFileSync(h.file, "utf8"), file);
      assert.doesNotMatch(JSON.stringify(result), /invalid|code/);
    }
  });
  step("All channel writes share availability checks; a/d rejection leaves defaults, overlay and routes intact", () => {
    for (const provider of [{ id: "hook", type: "webhook", options: {} }, { id: "custom", type: "unregistered", options: {} }]) {
      const h = harness({ channels: [], providers: [{ ...provider, enabled: true }], rules: { runFailed: { channels: [provider.id] } } });
      const item = h.item(`provider:${provider.id}`);
      assert.equal(h.host.setValue(item, false).ok, true);
      const before = h.overlay(), file = fs.readFileSync(h.file, "utf8"), commits = h.commits();
      assert.equal(h.host.channelActivation(provider.id).kind, "blocked");
      for (const result of [h.host.setValue(item, true), h.host.followUserDefault(item), h.host.restoreBuiltinDefault(item)]) {
        assert.equal(result.ok, false); assert.match(result.message, /不可用/);
      }
      assert.deepEqual(h.overlay(), before); assert.equal(h.commits(), commits);
      assert.equal(fs.readFileSync(h.file, "utf8"), file);
      assert.deepEqual(h.current().channels, []);
      assert.deepEqual(h.current().rules.runFailed.channels, [provider.id]);
    }
  });
  step("a follows the latest target, rechecks changed prerequisites and clears only the selected gate", () => {
    let code = "fake-only";
    const credentials = createQqCredentials({ status: () => ({ available: true }), get: () => code, set() {}, delete() {} }, () => undefined);
    const raw = { channels: [], providers: [{ id: "email", type: "email", enabled: true,
      options: { from: "fake@qq.com", to: ["reader@example.com"] } }], rules: { runFailed: { channels: ["email"], enabled: false } } };
    const h = harness(raw, credentials), item = h.item("provider:email");
    h.host.setValue(h.item("content.includeCost"), false);
    h.host.setValue(item, false);
    const before = h.overlay(), file = fs.readFileSync(h.file, "utf8");
    assert.equal(h.host.channelActivation("email").kind, "ready");
    code = undefined;
    assert.equal(h.host.followUserDefault(item).ok, false);
    assert.deepEqual(h.overlay(), before);
    code = "fake-only";
    raw.providers[0].options.to = [];
    fs.writeFileSync(h.file, JSON.stringify(raw));
    assert.match(h.host.followUserDefault(item).message, /收件/);
    assert.deepEqual(h.overlay(), before);
    fs.writeFileSync(h.file, file);
    assert.equal(h.host.followUserDefault(item).ok, true);
    const expected = structuredClone(before); delete expected.providers.email;
    assert.deepEqual(h.overlay(), expected);
    assert.deepEqual(h.current().channels, []); assert.deepEqual(h.current().rules.runFailed.channels, ["email"]);
    assert.equal(h.current().rules.runFailed.enabled, false);
    assert.equal(fs.readFileSync(h.file, "utf8"), file);
    // An already-open gate is not an activation, even if credentials have disappeared.
    code = undefined;
    assert.equal(h.host.followUserDefault(item).ok, true);
    // A changed default now closes the gate. No credential lookup is needed.
    code = "fake-only";
    assert.equal(h.host.setValue(item, true).ok, true);
    code = undefined;
    raw.providers[0].enabled = false;
    fs.writeFileSync(h.file, JSON.stringify(raw));
    credentials.status = () => { throw new Error("Closing must not inspect credentials"); };
    assert.equal(h.host.followUserDefault(item).ok, true);
    assert.equal(h.current().providers.find((p) => p.id === "email").enabled, false);
  });
  step("Runtime email downgrade never blocks an unrelated restore, reload or setting change", () => {
    const options = { from: "fake@qq.com", to: ["reader@example.com"] };
    const credentials = createQqCredentials({ status: () => ({ available: true }), get: () => undefined, set() {}, delete() {} }, () => undefined);
    // The host guard only closes the runtime copy when the credential is missing; the file keeps declaring it on.
    const guard = (config) => ({ ...config, providers: config.providers.map((provider) =>
      provider.id === "email" ? { ...provider, enabled: false } : provider) });
    const raw = { channels: [], providers: [{ id: "email", type: "email", enabled: true, options }], content: { includeCost: false } };
    const h = harness(raw, credentials, undefined, guard);
    const emailEnabled = () => h.current().providers.find((provider) => provider.id === "email").enabled;
    assert.equal(emailEnabled(), false, "runtime email must start closed");
    assert.equal(h.host.reload().ok, true, "reloading the same declaration must not look like an activation");
    // Enter on an unrelated field, then “a”: drop only this conversation's value.
    assert.equal(h.host.setValue(h.item("content.includeCost"), true).ok, true);
    assert.equal(h.host.followUserDefault(h.item("content.includeCost")).ok, true);
    assert.equal(h.current().content.includeCost, false);
    assert.equal(emailEnabled(), false, "email must stay unavailable after following an unrelated default");
    // “d”: restore the built-in default of another unrelated field.
    assert.equal(h.host.setValue(h.item("content.includeCost"), true).ok, true);
    assert.equal(h.host.setValue(h.item("content.includeDuration"), true).ok, true);
    assert.equal(h.host.restoreBuiltinDefault(h.item("content.includeCost")).ok, true);
    assert.equal(h.host.userRaw().content?.includeCost, undefined);
    assert.equal(h.current().content.includeCost, true);
    assert.equal(emailEnabled(), false, "email must stay unavailable after restoring an unrelated built-in default");
    // A real activation still asks for the credential, and a changed declaration still guards a reload.
    assert.equal(h.host.setValue(h.item("provider:email"), false).ok, true);
    assert.equal(h.host.followUserDefault(h.item("provider:email")).ok, false);
    const reopened = harness({ ...raw, providers: [{ ...raw.providers[0], enabled: false }] }, credentials);
    fs.writeFileSync(reopened.file, JSON.stringify(raw));
    const blocked = reopened.host.reload();
    assert.equal(blocked.ok, false, "a file edit that opens email still needs a credential");
    assert.match(blocked.message, /授权码/);
    assert.equal(reopened.host.userRaw().providers[0].enabled, true, "only the activation is blocked, never the file");
  });
  step("d validates the real post-delete gate and keeps sparse persistence and unrelated overlay semantics", () => {
    const h = harness({ channels: [], providers: [{ id: "custom", type: "debug", enabled: false, options: { label: "keep" } }],
      content: { includeCost: false }, rules: { runFailed: { channels: [], enabled: false } } });
    const item = h.item("provider:custom");
    h.host.setValue(item, false); h.host.setValue(h.item("content.includeDuration"), false);
    const before = h.overlay();
    assert.equal(h.host.restoreBuiltinDefault(item).ok, true);
    const expected = structuredClone(before); delete expected.providers.custom;
    assert.deepEqual(h.overlay(), expected);
    assert.deepEqual(h.host.userRaw(), { channels: [], providers: [{ id: "custom", type: "debug", options: { label: "keep" } }],
      content: { includeCost: false }, rules: { runFailed: { channels: [], enabled: false } } });
    assert.equal(h.current().providers[0].enabled, true);
    assert.deepEqual(h.current().channels, []); assert.deepEqual(h.current().rules.runFailed.channels, []);
    const silenced = harness({ providers: [{ id: "terminal", type: "terminal", enabled: false }] });
    silenced.host.setValue(silenced.item("provider:terminal"), false); silenced.silence();
    const file = fs.readFileSync(silenced.file, "utf8");
    assert.equal(silenced.host.followUserDefault(silenced.item("provider:terminal")).ok, true, "default remains off");
    const overlay = silenced.overlay();
    assert.equal(silenced.host.restoreBuiltinDefault(silenced.item("provider:terminal")).ok, false);
    assert.deepEqual(silenced.overlay(), overlay);
    assert.equal(fs.readFileSync(silenced.file, "utf8"), file);
    assert.equal(silenced.current().providers[0].enabled, false);
    // Restoring the master default keeps its existing persistence semantics under silence.
    const master = harness({ enabled: false }); master.silence();
    assert.equal(master.host.restoreBuiltinDefault(master.item("enabled")).ok, true);
    assert.equal(master.host.userRaw().enabled, undefined);
  });
  step("Restoration checks only opening gates, even when d would leave the sparse file unchanged", () => {
    const credentials = createQqCredentials({ status() { throw new Error("Unrelated or closing gates must not inspect credentials"); },
      get() {}, set() {}, delete() {} }, () => undefined);
    const h = harness({ providers: [{ id: "custom", type: "unregistered" }] }, credentials), item = h.item("provider:custom");
    assert.equal(h.host.followUserDefault(item).ok, true, "already-open gate needs no activation check");
    assert.equal(h.host.restoreBuiltinDefault(item).ok, true, "same state, no disk write needed");
    assert.equal(h.host.setValue(item, false).ok, true);
    const overlay = h.overlay(), file = fs.readFileSync(h.file, "utf8");
    assert.equal(h.host.restoreBuiltinDefault(item).ok, false, "preflight still runs if the default is already absent");
    assert.deepEqual(h.overlay(), overlay); assert.equal(fs.readFileSync(h.file, "utf8"), file);
    const email = harness({ providers: [{ id: "email", type: "email", enabled: true }] }, credentials);
    assert.equal(email.host.restoreBuiltinDefault(email.item("provider:email")).ok, true, "built-in email default closes the gate");
    assert.equal(email.current().providers.find((p) => p.id === "email").enabled, false);
    const terminal = harness({ providers: [{ id: "terminal", type: "terminal", enabled: false }] }, credentials);
    assert.equal(terminal.host.restoreBuiltinDefault(terminal.item("provider:terminal")).ok, true, "other channels do not read email credentials");
  });
  step("Email gate single-save snapshots no addresses, credentials, routing or unrelated session values", () => {
    const credentials = createQqCredentials({ status: () => ({ available: true }), get: () => "fake-save-only", set() {}, delete() {} }, () => undefined);
    const h = harness({}, credentials);
    for (const [id, value] of [["provider:email:from", "fake@qq.com"], ["provider:email:to", ["reader@example.com"]],
      ["provider:email", true], ["channels", ["email"]], ["rules.runFailed.channels", []], ["content.includeCost", false]]) {
      assert.equal(h.host.setValue(h.item(id), value).ok, true);
    }
    const overlay = h.overlay();
    assert.equal(h.host.saveDefault(h.item("provider:email")).ok, true);
    assert.deepEqual(h.host.userRaw(), { providers: [{ id: "email", type: "email", enabled: true }] });
    assert.deepEqual(h.overlay(), overlay);
    assert.doesNotMatch(fs.readFileSync(h.file, "utf8"), /fake-save-only|fake@qq|reader|channels|content/);
  });
  step("The same credential core serves a settings host and a plain non-Pi host", () => {
    let value;
    const credentials = createQqCredentials({ status: () => ({ available: true }), get: () => value, set: (next) => { value = next; }, delete: () => { value = undefined; } }, () => undefined);
    const h = harness({}, credentials);
    const plainHost = { save: (text) => credentials.save(text), status: () => credentials.status(), remove: () => credentials.delete() };
    assert.equal(plainHost.save("fake-other-host").ok, true);
    assert.equal(h.host.credentialState().source, "vault");
    assert.equal(h.host.deleteCredential().ok, true);
    assert.equal(plainHost.status().state, "missing");
  });
  step("Failed atomic save/restore preserves session choices and malformed file bytes", () => {
    const h = harness({});
    const item = h.item("enabled");
    assert.equal(h.host.setValue(item, false).ok, true);
    const overlay = h.overlay();
    fs.writeFileSync(h.file, "{broken");
    assert.equal(h.host.saveDefault(item).ok, false);
    assert.equal(h.host.saveChanges([item]).ok, false);
    assert.equal(h.host.followUserDefault(item).ok, false);
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
