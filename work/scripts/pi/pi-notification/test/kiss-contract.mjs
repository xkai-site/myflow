/** JTBD contracts. Temporary files and fake channels only; never resolve real credentials. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as config from "../src/config.ts";
import * as settings from "../src/settings.ts";
import * as rules from "../src/rules.ts";
import { createService } from "../src/service.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "notify-kiss-"));
const failures = [];
async function step(name, run) {
  try { await run(); console.log(`  ✓ ${name}`); }
  catch (error) { failures.push({ name, error }); console.error(`  ✗ ${name}: ${error.message}`); }
}
const merged = (raw) => {
  const result = config.mergeConfig(config.defaultConfig(), raw, "test");
  assert.deepEqual(result.errors, []);
  return result.config;
};
const req = (key, channels = ["terminal"]) => ({ level: "info", kind: "run_completed", title: "Fixed test", body: "No user content", dedupeKey: key, channels,
  meta: { sessionId: "test", runId: key, level: "info" } });
const harness = (c) => {
  const sends = [];
  const service = createService({ config: c, now: () => 1000000, log: { log() {}, record() {} }, registry: { register() {}, create(id, type) {
    return { id, type, validate() {}, async send(r) { sends.push(r); }, async dispose() {} };
  } } });
  return { service, sends };
};
try {
  await step("legacy JSON explicit routes stay custom, even when equal to defaults", () => {
    const c = merged({ rules: { runCompleted: { channels: ["terminal"] }, runFailed: { channels: [] } } });
    assert.deepEqual(c.rules.runCompleted.channels, ["terminal"]);
    assert.deepEqual(c.rules.runFailed.channels, []);
    assert.deepEqual(c.channels, ["terminal"]);
  });
  await step("inherit, custom and empty destinations have distinct semantics", () => {
    const c = merged({ channels: ["terminal", "email", "email"], rules: { runCompleted: { channels: "inherit" }, runFailed: { channels: [] } } });
    assert.deepEqual(rules.resolveChannels(c, c.rules.runCompleted), ["terminal", "email"]);
    assert.deepEqual(rules.resolveChannels(c, c.rules.runFailed), []);
    assert.deepEqual(rules.resolveChannels(c, { channels: ["missing"] }), ["missing"]);
    assert.equal(config.defaultConfig().rules.runCompleted.channels, "inherit");
  });
  await step("old session arrays survive; changing unified destinations does not erase them", () => {
    const overlay = settings.overlayFromEntry({ patch: { rules: { runCompleted: { channels: ["custom"] } } }, providers: {} });
    overlay.patch.channels = ["terminal", "email"];
    const applied = settings.applyOverlay(config.defaultConfig(), overlay);
    assert.deepEqual(applied.problems, []);
    assert.deepEqual(rules.resolveChannels(applied.config, applied.config.rules.runCompleted), ["custom"]);
    assert.deepEqual(rules.resolveChannels(applied.config, applied.config.rules.runFailed), ["terminal", "email"]);
  });
  await step("manual test bypasses error threshold, ordinary bypassFilters does not", async () => {
    const c = config.defaultConfig(); c.minLevel = "error";
    const h = harness(c);
    try {
      const result = h.service.submit(req("manual"), { manualTest: true });
      assert.equal(result.accepted, true);
      await h.service.flush(1000);
      assert.equal(h.sends.length, 1);
      const ordinary = h.service.submit(req("ordinary"), { bypassFilters: true });
      assert.equal(ordinary.accepted, false);
      assert.equal(ordinary.reason, "below_min_level");
    } finally { await h.service.dispose(); }
  });
  await step("disabled master switch returns rejection, never a queued-success claim", async () => {
    const c = config.defaultConfig(); c.enabled = false;
    const h = harness(c);
    try {
      const result = h.service.submit(req("off"), { manualTest: true });
      assert.deepEqual(result, { accepted: false, reason: "disabled" });
      assert.equal(h.sends.length, 0);
    } finally { await h.service.dispose(); }
  });
  await step("configured email without any enabled rule reference is not ready-to-remind", () => {
    const c = config.defaultConfig();
    const email = c.providers.find((p) => p.id === "email");
    email.enabled = true; email.options.from = "sender@qq.com"; email.options.to = ["reader@example.com"];
    const state = settings.emailReadiness(c, true);
    assert.equal(state.usedBy, 0);
    assert.match(state.label, /尚无提醒使用/);
    c.channels = ["terminal", "email"];
    assert.ok(settings.emailReadiness(c, true).usedBy > 0);
  });
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
if (failures.length) process.exitCode = 1;
console.log(`KISS: ${6 - failures.length}/6 passed`);
