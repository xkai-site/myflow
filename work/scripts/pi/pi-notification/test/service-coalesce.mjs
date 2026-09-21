/**
 * Delivery service thresholds and filters regression: coalescing window, cooldown, dedupe,
 * threshold, queue and timeout.
 *
 * A separate script because these are all time- and order-dependent policies: an injected clock
 * and fake channels make the assertions fast and deterministic, with no SDK, no real session and
 * no notification. The host-level effects (defaults, recovery after `cooldownMs=0`, coalescing of
 * `immediate` tool failures) are covered by L1/L2/K3 in `test/host-lifecycle.mjs`.
 *
 *   MSYS_NO_PATHCONV=1 node test/service-coalesce.mjs
 */

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url));
const serviceModule = await import(pathToFileURL(path.join(PLUGIN_DIR, "src", "service.ts")).href);
const configModule = await import(pathToFileURL(path.join(PLUGIN_DIR, "src", "config.ts")).href);

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

/** Injected clock, so cooldown and coalescing windows can be advanced deterministically. */
function makeHarness({ mutateConfig, send } = {}) {
  const config = configModule.defaultConfig();
  if (mutateConfig) mutateConfig(config);
  let nowMs = 1_000_000;
  const records = [];
  const sends = [];
  const log = {
    log: () => {},
    record: (entry) => records.push(entry),
  };
  const registry = {
    register: () => {},
    create: (id, type) => ({
      id,
      type,
      validate: () => undefined,
      async send(req, signal) {
        sends.push({ id, kind: req.kind, dedupeKey: req.dedupeKey, at: nowMs });
        if (send) return send(req, signal, sends.length);
        return undefined;
      },
      async dispose() {},
    }),
  };
  const service = serviceModule.createService({ config, registry, log, now: () => nowMs });
  return {
    config,
    service,
    records,
    sends,
    log,
    setTime(value) { nowMs = value; },
    /** Advances the fake clock. */
    advance(ms) {
      nowMs += ms;
    },
    events: () => records.map((row) => row.event),
    /** Delivery is asynchronous: wait for it to settle before asserting. */
    async settle() {
      await service.flush(1000);
    },
  };
}

function request(overrides = {}) {
  const kind = overrides.kind ?? "run_completed";
  return {
    level: "info",
    kind,
    title: "任务完成",
    body: "用时 21ms",
    dedupeKey: `s:1:${kind}`,
    channels: ["terminal"],
    meta: { sessionId: "s", runId: "1", level: "info" },
    ...overrides,
  };
}

console.log("S4 投递服务门槛/过滤回归：pi-notification");

await step("默认值：windowMs=1500 / cooldownMs=3000（0 表示关闭该过滤）", () => {
  const config = configModule.defaultConfig();
  assert.equal(config.coalesce.windowMs, 1500);
  assert.equal(config.coalesce.cooldownMs, 3000);
  assert.equal(config.coalesce.toolFailureWindowMs, 10000);
});

await step("精确去重：同一个 dedupeKey 只投递一次", async () => {
  const h = makeHarness({ mutateConfig: (c) => { c.coalesce.windowMs = 0; c.coalesce.cooldownMs = 0; } });
  h.service.submit(request());
  h.service.submit(request());
  await h.settle();
  assert.equal(h.sends.length, 1);
  assert.equal(h.service.snapshot().deduped, 1);
  assert.ok(h.events().includes("dedupe_drop"));
});

await step("门槛：enabled=false / minLevel / 空渠道列表都不投递", async () => {
  const disabled = makeHarness({ mutateConfig: (c) => { c.enabled = false; } });
  disabled.service.submit(request());
  await disabled.settle();
  assert.equal(disabled.sends.length, 0, "enabled=false 仍在投递");

  const level = makeHarness({ mutateConfig: (c) => { c.minLevel = "error"; } });
  level.service.submit(request({ level: "info" }));
  await level.settle();
  assert.equal(level.sends.length, 0, "minLevel 门槛未生效");
  level.service.submit(request({ level: "error", dedupeKey: "s:1:b" }));
  await level.settle();
  assert.equal(level.sends.length, 1, "error 级应当通过门槛");

  const noChannel = makeHarness({ mutateConfig: (c) => { c.coalesce.windowMs = 0; c.coalesce.cooldownMs = 0; } });
  noChannel.service.submit(request({ channels: [] }));
  await noChannel.settle();
  assert.equal(noChannel.sends.length, 0);
});

await step("冷却：同 kind 在 cooldownMs 内只放行一条，窗口过后恢复", async () => {
  const h = makeHarness({ mutateConfig: (c) => { c.coalesce.windowMs = 0; } }); // 只留冷却，避免合并窗口抢答
  h.service.submit(request({ dedupeKey: "s:1:run_completed" }));
  await h.settle();
  assert.equal(h.sends.length, 1);

  h.advance(1000);
  h.service.submit(request({ dedupeKey: "s:2:run_completed", meta: { sessionId: "s", runId: "2", level: "info" } }));
  await h.settle();
  assert.equal(h.sends.length, 1, "冷却窗口内不应再投递");
  assert.equal(h.service.snapshot().cooled, 1);
  assert.ok(h.events().includes("cooldown_drop"));

  // A different kind is not affected by another kind's cooldown.
  h.service.submit(
    request({ kind: "run_failed", level: "error", dedupeKey: "s:2:run_failed", meta: { sessionId: "s", runId: "2", level: "error" } }),
  );
  await h.settle();
  assert.equal(h.sends.length, 2, "不同 kind 不应被同 kind 冷却拦住");

  h.advance(3000);
  h.service.submit(request({ dedupeKey: "s:3:run_completed", meta: { sessionId: "s", runId: "3", level: "info" } }));
  await h.settle();
  assert.equal(h.sends.length, 3, "冷却窗口过后应恢复投递");
});

await step("合并窗口：同一（sessionId+runId）只放行一条，换 runId 立即放行", async () => {
  const h = makeHarness();
  // Two different events of one run, for example run_completed plus waiting_for_user.
  h.service.submit(request({ dedupeKey: "s:1:run_completed" }));
  h.service.submit(request({ kind: "waiting_for_user", dedupeKey: "s:1:waiting", channels: ["terminal"] }));
  await h.settle();
  assert.equal(h.sends.length, 1, "同一运行的第二条应被合并");
  assert.equal(h.service.snapshot().coalesced, 1);
  assert.ok(h.events().includes("coalesce_drop"));

  h.advance(1000);
  h.service.submit(
    request({ dedupeKey: "s:9:run_completed", meta: { sessionId: "s", runId: "9", level: "info" }, kind: "run_failed", level: "error" }),
  );
  await h.settle();
  assert.equal(h.sends.length, 2, "不同 runId 不应被合并（注意同 kind 冷却只作用于同 kind）");
});

await step("请求级窗口覆盖：coalesceWindowMs 优先于配置（immediate 工具失败靠它聚合）", async () => {
  // Both filters off, leaving only the window carried by the request itself.
  const h = makeHarness({ mutateConfig: (c) => { c.coalesce.windowMs = 0; c.coalesce.cooldownMs = 0; } });
  h.service.submit(request({ kind: "tool_failed", level: "warning", dedupeKey: "s:1:tool_failed:bash", coalesceWindowMs: 10000 }));
  await h.settle();
  assert.equal(h.sends.length, 1);
  h.advance(2000);
  // The config has windowMs=0, but the first request pushed its run's window out to 10000ms.
  h.service.submit(request({ kind: "tool_failed", level: "warning", dedupeKey: "s:1:tool_failed:read" }));
  await h.settle();
  assert.equal(h.sends.length, 1, "请求级窗口未生效");
  assert.equal(h.service.snapshot().coalesced, 1);
});

await step("bypassFilters：自检通知不受合并/冷却影响（但仍受去重与门槛约束）", async () => {
  const h = makeHarness();
  h.service.submit(request({ dedupeKey: "s:1:run_completed" }));
  await h.settle();
  h.service.submit(request({ dedupeKey: "manual:1", meta: { sessionId: "manual", runId: "1", level: "info" } }), { bypassFilters: true });
  await h.settle();
  assert.equal(h.sends.length, 2, "自检通知被冷却吃了（会被误读成渠道坏了）");

  h.service.submit(request({ dedupeKey: "manual:1" }), { bypassFilters: true });
  await h.settle();
  assert.equal(h.sends.length, 2, "bypassFilters 不应绕过去重");
});

await step("队列上限：丢等级最低的最新一项并计数，不无限增长", async () => {
  const h = makeHarness({
    mutateConfig: (c) => {
      c.coalesce.windowMs = 0;
      c.coalesce.cooldownMs = 0;
      c.delivery.queueLimit = 2;
      c.delivery.concurrency = 1;
    },
    // The first delivery is stuck, so the rest have to queue.
    send: async (_req, signal, index) => {
      if (index === 1) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 200);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    },
  });
  h.service.submit(request({ dedupeKey: "q:1", meta: { sessionId: "q", runId: "1", level: "info" } }));
  h.service.submit(request({ kind: "run_failed", level: "error", dedupeKey: "q:1:err", meta: { sessionId: "q", runId: "1", level: "error" } }));
  h.service.submit(request({ kind: "compact_failed", level: "info", dedupeKey: "q:1:info", meta: { sessionId: "q", runId: "1", level: "info" } }));
  // Queue full (limit=2) with one more info notification: one entry must be dropped and counted.
  h.service.submit(request({ kind: "waiting_for_user", level: "info", dedupeKey: "q:1:waiting", meta: { sessionId: "q", runId: "1", level: "info" } }));
  await h.settle();
  assert.equal(h.service.snapshot().dropped, 1, "队列满应恰好丢弃 1 条");
  assert.ok(h.events().includes("queue_drop"));
  assert.equal(h.service.snapshot().failed, 0);
  assert.equal(h.service.snapshot().delivered, 3, "被丢的应只是最低级的新条目");
});

await step("Provider 挂起：超时算失败，不阻塞后面", async () => {
  const h = makeHarness({
    mutateConfig: (c) => {
      c.coalesce.windowMs = 0;
      c.coalesce.cooldownMs = 0;
      c.delivery.timeoutMs = 60;
    },
    send: async (_req, signal) => {
      await new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("渠道没有理会 signal")), 5000);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("投递已取消"));
          },
          { once: true },
        );
      });
    },
  });
  const startedAt = Date.now();
  h.service.submit(request());
  await h.settle();
  assert.equal(h.sends.length, 1);
  assert.equal(h.service.snapshot().failed, 1, "超时应计为投递失败");
  assert.ok(Date.now() - startedAt < 2000, "超时没有生效（挂起的 provider 拖住了服务）");
});

await step("dispose 幂等：之后 submit 一律丢弃，且不抛异常", async () => {
  const h = makeHarness({ mutateConfig: (c) => { c.coalesce.windowMs = 0; c.coalesce.cooldownMs = 0; } });
  await h.service.dispose();
  await h.service.dispose();
  h.service.submit(request());
  await h.settle();
  assert.equal(h.sends.length, 0);
  assert.ok(h.events().includes("service_disposed"));
});

// M3: build local calendar values instead of relying on the host time zone; the check must use the injected clock.
function quietHarness(quiet = {}) {
  return makeHarness({ mutateConfig: (c) => {
    c.coalesce.windowMs = 0;
    c.coalesce.cooldownMs = 0;
    c.quietHours = { ...c.quietHours, enabled: true, ...quiet };
  } });
}
for (const [hour, minute, blocked] of [[23, 0, true], [23, 30, true], [7, 59, true], [8, 0, false], [12, 0, false]]) {
  await step(`Q 静默跨午夜 ${hour}:${String(minute).padStart(2, "0")} → ${blocked ? "静默" : "放行"}`, async () => {
    const h = quietHarness();
    h.setTime(new Date(2025, 0, 15, hour, minute).getTime());
    assert.equal(h.service.isQuietHours(), blocked);
    h.service.submit(request());
    await h.settle();
    assert.equal(h.sends.length, blocked ? 0 : 1);
    assert.equal(h.events().includes("quiet_hours_drop"), blocked);
  });
}
await step("Q 等级例外：静默时 error 仍投递，warning 静默", async () => {
  const h = quietHarness();
  h.setTime(new Date(2025, 0, 15, 23, 30).getTime());
  h.service.submit(request({ level: "warning", dedupeKey: "quiet:warning" }));
  h.service.submit(request({ level: "error", dedupeKey: "quiet:error" }));
  await h.settle();
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].dedupeKey, "quiet:error");
});
await step("Q enabled=false 全时段放行；默认与降级均不启用静默", async () => {
  assert.deepEqual(configModule.defaultConfig().quietHours, { enabled: false, start: "23:00", end: "08:00", exceptLevels: ["error"] });
  assert.equal(configModule.degradedConfig().quietHours.enabled, false);
  const h = quietHarness({ enabled: false });
  for (const hour of [0, 7, 8, 12, 23]) {
    h.setTime(new Date(2025, 0, 15, hour, 30).getTime());
    h.service.submit(request({ dedupeKey: `disabled:${hour}` }));
  }
  await h.settle();
  assert.equal(h.sends.length, 5);
});
await step("Q 同日左闭右开 / start=end 全天", async () => {
  const h = quietHarness({ start: "09:00", end: "17:00" });
  for (const [hour, minute, expected] of [[8, 59, false], [9, 0, true], [16, 59, true], [17, 0, false]]) {
    h.setTime(new Date(2025, 0, 15, hour, minute).getTime());
    assert.equal(h.service.isQuietHours(), expected);
  }
  h.config.quietHours.end = "09:00";
  for (const hour of [0, 9, 23]) {
    h.setTime(new Date(2025, 0, 15, hour, 0).getTime());
    h.service.submit(request({ dedupeKey: `all:${hour}` }));
  }
  await h.settle();
  assert.equal(h.sends.length, 0);
});
await step("Q 自检绕过静默，不绕过门槛；静默不推进合并/冷却", async () => {
  const h = quietHarness();
  h.config.coalesce.windowMs = 600000;
  h.config.coalesce.cooldownMs = 600000;
  h.setTime(new Date(2025, 0, 15, 7, 59).getTime());
  h.service.submit(request());
  h.service.submit(request({ dedupeKey: "manual:quiet" }), { bypassFilters: true });
  await h.settle();
  assert.equal(h.sends.length, 1);
  h.advance(60000);
  h.service.submit(request({ dedupeKey: "after:quiet" }));
  await h.settle();
  assert.equal(h.sends.length, 2);
  h.config.minLevel = "error";
  h.service.submit(request({ dedupeKey: "manual:threshold" }), { bypassFilters: true });
  await h.settle();
  assert.equal(h.sends.length, 2);
});
for (const value of ["25:00", "8:00"]) {
  await step(`Q 非法时间 ${value} → 读盘降级并保留原因`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-notify-quiet-"));
    try {
      const file = configModule.userConfigPath(dir);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ quietHours: { enabled: true, start: value } }));
      const result = configModule.loadConfig({ agentDir: dir });
      assert.equal(result.degraded, true);
      assert.equal(result.config.quietHours.enabled, false);
      assert.ok(result.errors.some((p) => p.path === "quietHours.start"));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
await step("Q exceptLevels 严格数组/去重，enabled/end 同样严格校验", () => {
  const base = configModule.defaultConfig();
  const merged = configModule.mergeConfig(base, { quietHours: { exceptLevels: ["error", "error", "info"] } }, "test");
  assert.deepEqual(merged.config.quietHours.exceptLevels, ["error", "info"]);
  for (const quietHours of [{ exceptLevels: "error" }, { exceptLevels: ["loud"] }, { exceptLevels: [null] }, { enabled: 1 }, { end: "24:00" }, { end: "08:60" }, null]) {
    assert.ok(configModule.mergeConfig(base, { quietHours }, "test").errors.length > 0);
  }
});

for (const item of failures) {
  console.error(`\n[FAIL] ${item.name}\n${item.error?.stack ?? item.error}`);
}

if (failures.length === 0) {
  console.log("\n通过：门槛/去重/静默时段/冷却/合并窗口/队列/超时 全部断言成立。");
  process.exit(0);
} else {
  console.error(`\n失败：${failures.length} 项断言未通过。`);
  process.exit(1);
}
