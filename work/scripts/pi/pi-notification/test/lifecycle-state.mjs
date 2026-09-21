/**
 * Run state machine and delivery service edge cases.
 *
 * These two modules are exercised end to end by test/host-lifecycle.mjs and test/service-coalesce.mjs,
 * so this script deliberately targets what those cannot reach: structural drops the host cannot easily
 * produce (not idle, session mismatch, stale instance), run-state bookkeeping, and the service paths
 * that need direct control of the clock, the queue and the channel factory.
 *
 *   MSYS_NO_PATHCONV=1 node test/lifecycle-state.mjs
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url));
const { createLifecycle } = await import(pathToFileURL(path.join(PLUGIN_DIR, "src", "lifecycle.ts")).href);
const { createService } = await import(pathToFileURL(path.join(PLUGIN_DIR, "src", "service.ts")).href);
const { defaultConfig } = await import(pathToFileURL(path.join(PLUGIN_DIR, "src", "config.ts")).href);

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

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const makeLog = () => {
  const records = [];
  const logs = [];
  return {
    records,
    logs,
    events: () => records.map((entry) => entry.event),
    log: {
      log: (level, message, meta) => logs.push({ level, message, meta }),
      record: (entry) => records.push(entry),
    },
  };
};

/** Lifecycle harness with an injectable clock, so duration and cost bookkeeping stay deterministic. */
function makeLifecycle(instanceToken = "tok") {
  const harness = makeLog();
  let nowMs = 1_000;
  const lifecycle = createLifecycle({
    config: defaultConfig(),
    log: harness.log,
    now: () => nowMs,
    instanceToken,
  });
  return {
    ...harness,
    lifecycle,
    now: () => nowMs,
    advance: (ms) => {
      nowMs += ms;
    },
    setNow: (ms) => {
      nowMs = ms;
    },
  };
}

/** Starts a session and one run, leaving the run open for the case under test. */
function startRun(harness, sessionId = "s1") {
  harness.lifecycle.onSessionStart({ sessionId, reason: "startup" });
  harness.lifecycle.onAgentStart({ sessionId });
}

console.log("状态机与投递服务边界专项回归：pi-notification");

await step("L1 stopReason 判定表：只有终态语义才给出结论", () => {
  const expected = {
    stop: "completed",
    length: "completed",
    toolUse: "completed",
    error: "failed",
    aborted: "aborted",
    pending: "unknown",
    deferred: "unknown",
    undefined: "unknown",
  };
  for (const [stopReason, status] of Object.entries(expected)) {
    const harness = makeLifecycle();
    startRun(harness);
    harness.lifecycle.onAssistantMessage({ sessionId: "s1", stopReason: stopReason === "undefined" ? undefined : stopReason });
    const outcome = harness.lifecycle.onSettled({ sessionId: "s1", isIdle: true });
    assert.equal(outcome?.status, status, `stopReason=${stopReason} 应判定为 ${status}`);
  }
});

await step("L2 结构性丢弃：非空闲 / 会话不匹配 / 陈旧实例都不消耗 run 状态", () => {
  const harness = makeLifecycle();
  startRun(harness);
  harness.lifecycle.onAssistantMessage({ sessionId: "s1", stopReason: "stop" });

  assert.equal(harness.lifecycle.onSettled({ sessionId: "s1", isIdle: false }), null);
  assert.deepEqual(harness.records.at(-1), { event: "settled_ignored", status: "not_idle" });

  assert.equal(harness.lifecycle.onSettled({ sessionId: "s2", isIdle: true }), null);
  assert.equal(harness.records.at(-1).status, "session_mismatch");
  assert.match(harness.records.at(-1).reason, /s1 != s2/);

  // Neither drop may consume the run: the real settle still reports it.
  const outcome = harness.lifecycle.onSettled({ sessionId: "s1", isIdle: true });
  assert.equal(outcome?.status, "completed", "被丢弃的 settle 不得吃掉 run 状态");
  assert.equal(harness.events().filter((event) => event === "run_settled").length, 1);

  harness.lifecycle.onShutdown("reload");
  assert.equal(harness.lifecycle.isStale(), true);
  assert.equal(harness.lifecycle.onSettled({ sessionId: "s1", isIdle: true }), null, "shutdown 后不得再产生结论");
  assert.equal(harness.records.at(-1).status, "instance_stale");
});

await step("L3 隐式 run：没有 agent_start 也能记录，并使用实例内递增的 runId", () => {
  const harness = makeLifecycle();
  harness.lifecycle.onSessionStart({ sessionId: "s1", reason: "startup" });
  harness.lifecycle.onAssistantMessage({ sessionId: "s1", stopReason: "stop" });
  assert.deepEqual(harness.events(), ["lifecycle_session_start", "lifecycle_run_implicit"]);

  const implicit = harness.lifecycle.onSettled({ sessionId: "s1", isIdle: true });
  assert.equal(implicit?.runId, "tok-1");

  startRun(harness);
  harness.lifecycle.onAssistantMessage({ sessionId: "s1", stopReason: "stop" });
  assert.equal(harness.lifecycle.onSettled({ sessionId: "s1", isIdle: true })?.runId, "tok-2", "runId 必须自增");
});

await step("L4 无 run 的 settle：给出 orphan 键，且时钟回退时时长不为负", () => {
  const harness = makeLifecycle("t3");
  harness.lifecycle.onSessionStart({ sessionId: "session-abcdef", reason: "startup" });
  const orphan = harness.lifecycle.onSettled({ sessionId: "session-abcdef", isIdle: true });
  assert.equal(orphan.runId, "t3-orphan-session-");
  assert.equal(orphan.status, "unknown", "没有 stopReason 时不得当作完成");
  assert.equal(orphan.durationMs, 0);
  assert.deepEqual(orphan.toolFailures, []);
  assert.equal(orphan.stopReason, undefined);

  const backwards = makeLifecycle();
  startRun(backwards);
  backwards.setNow(500);
  const outcome = backwards.lifecycle.onSettled({ sessionId: "s1", isIdle: true });
  assert.equal(outcome.durationMs, 0, "时钟回退时时长取 0 而不是负数");
});

await step("L5 成本累计：只认有限正值，本 run 与会话累计分开，换会话复位", () => {
  const harness = makeLifecycle();
  startRun(harness);
  harness.lifecycle.onAssistantMessage({ sessionId: "s1", stopReason: "stop", usageCostUsd: 0.25 });
  harness.lifecycle.onAssistantMessage({ sessionId: "s1", stopReason: "stop", usageCostUsd: 0.75 });
  harness.lifecycle.onAssistantMessage({ sessionId: "s1", stopReason: "stop", usageCostUsd: Number.NaN });
  harness.lifecycle.onAssistantMessage({ sessionId: "s1", stopReason: "stop", usageCostUsd: -1 });
  assert.equal(harness.lifecycle.sessionCostUsd(), 1);

  const outcome = harness.lifecycle.onSettled({ sessionId: "s1", isIdle: true });
  assert.equal(outcome.costUsd, 1, "本 run 成本是多轮 usage 之和");

  // A second run in the same session: only agent_start, because session_start resets the accumulator.
  harness.lifecycle.onAgentStart({ sessionId: "s1" });
  harness.lifecycle.onAssistantMessage({ sessionId: "s1", stopReason: "stop", usageCostUsd: 0.5 });
  assert.equal(harness.lifecycle.onSettled({ sessionId: "s1", isIdle: true }).costUsd, 0.5, "新 run 的成本独立统计");
  assert.equal(harness.lifecycle.sessionCostUsd(), 1.5, "会话累计跨 run 累加");

  harness.lifecycle.onSessionStart({ sessionId: "s2", reason: "new" });
  assert.equal(harness.lifecycle.sessionCostUsd(), 0, "换会话后累计归零");
});

await step("L6 工具失败与压缩失败：失败计数、累积顺序与标志位", () => {
  const harness = makeLifecycle();
  startRun(harness);
  assert.equal(harness.lifecycle.onToolExecutionEnd({ sessionId: "s1", toolName: "read", isError: false }), null, "成功执行不累积");
  assert.equal(harness.events().includes("lifecycle_tool_failed"), false);

  const first = harness.lifecycle.onToolExecutionEnd({ sessionId: "s1", toolName: "read", isError: true });
  assert.equal(first.count, 1);
  harness.lifecycle.onToolExecutionEnd({ sessionId: "s1", toolName: "bash", isError: true });
  const third = harness.lifecycle.onToolExecutionEnd({ sessionId: "s1", toolName: "read", isError: true });
  assert.equal(third.count, 2, "同名工具按去重后的次数累加");
  assert.deepEqual(third.accumulated, [{ toolName: "read", count: 2 }, { toolName: "bash", count: 1 }], "累积保持首次失败顺序");

  assert.equal(harness.lifecycle.onCompactFailed({ sessionId: "s1", reason: "threshold", aborted: true })?.runId, "tok-1");
  const outcome = harness.lifecycle.onSettled({ sessionId: "s1", isIdle: true });
  assert.equal(outcome.compactFailed, true, "用户取消压缩也置位，是否通知由规则层决定");
  assert.deepEqual(outcome.toolFailures, [{ toolName: "read", count: 2 }, { toolName: "bash", count: 1 }]);

  const abandoned = makeLifecycle();
  abandoned.lifecycle.onSessionStart({ sessionId: "s1", reason: "startup" });
  assert.equal(abandoned.lifecycle.onCompactFailed({ sessionId: "s1", reason: "overflow", aborted: false })?.runId, "tok-1");
  assert.equal(abandoned.lifecycle.onSettled({ sessionId: "s1", isIdle: true }).compactFailed, true, "没有 agent_start 时也要保留压缩失败");
});

await step("L7 等待输入计数：custom 不计、多余的 end 不会变负、shutdown 兜底复位", () => {
  const harness = makeLifecycle();
  harness.lifecycle.onSessionStart({ sessionId: "s1", reason: "startup" });

  harness.lifecycle.onUiPromptStart({ sessionId: "s1", kind: "custom" });
  assert.equal(harness.lifecycle.isWaitingForUser(), false, "custom 不代表用户在输入");

  harness.lifecycle.onUiPromptStart({ sessionId: "s1", kind: "select" });
  assert.equal(harness.lifecycle.isWaitingForUser(), true);
  harness.lifecycle.onUiPromptEnd({ sessionId: "s1", kind: "select" });
  harness.lifecycle.onUiPromptEnd({ sessionId: "s1", kind: "select" });
  harness.lifecycle.onUiPromptEnd({ sessionId: "s1", kind: "select" });
  assert.equal(harness.lifecycle.isWaitingForUser(), false, "计数不得为负，也不会一直挂着");

  harness.lifecycle.onUiPromptStart({ sessionId: "s1", kind: "editor" });
  harness.lifecycle.onShutdown("quit");
  assert.equal(harness.lifecycle.isWaitingForUser(), false, "强杀可能不发 end，shutdown 必须复位");
});

await step("L8 摘录与错误消息：只保留最后一条非空文本，错误原文交给上层脱敏", () => {
  const harness = makeLifecycle();
  startRun(harness);
  harness.lifecycle.onAssistantMessage({ sessionId: "s1", stopReason: "stop", text: "第一条" });
  harness.lifecycle.onAssistantMessage({ sessionId: "s1", stopReason: "stop", text: "" });
  harness.lifecycle.onAssistantMessage({ sessionId: "s1", stopReason: "stop", text: "最后一条" });
  harness.lifecycle.onAssistantMessage({ sessionId: "s1", stopReason: "error", errorMessage: "provider 500" });
  const outcome = harness.lifecycle.onSettled({ sessionId: "s1", isIdle: true });
  assert.equal(outcome.assistantExcerpt, "最后一条", "空文本不得覆盖已有摘录");
  assert.equal(outcome.errorMessage, "provider 500");
  assert.equal(outcome.status, "failed");
});

/** Service harness: injected clock, controllable channel factory and no coalescing noise. */
function makeService(overrides = {}) {
  const harness = makeLog();
  const config = defaultConfig();
  config.coalesce = { windowMs: 0, cooldownMs: 0, toolFailureWindowMs: 0 };
  Object.assign(config, overrides);
  const created = [];
  const behaviour = { send: "ok" };
  const registry = {
    register: () => {},
    create: (id, type) => {
      created.push(type);
      return {
        id,
        type,
        validate: () => undefined,
        send: async (_req, signal) => {
          if (behaviour.send === "fail") throw new Error("通道坏了");
          if (behaviour.send === "hang") {
            await new Promise((resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              setTimeout(resolve, 50);
            });
          }
        },
        dispose: async () => {},
      };
    },
  };
  const service = createService({ config, registry, log: harness.log, now: () => Date.now() });
  const request = (dedupeKey) => ({
    level: "info",
    kind: "run_completed",
    title: "t",
    body: "b",
    dedupeKey,
    channels: ["terminal"],
    meta: { sessionId: "s", runId: "r", level: "info" },
  });
  return { ...harness, config, service, created, behaviour, request };
}

await step("S1 失败投递：计数与上次错误可见，且不抛回调用方", async () => {
  const harness = makeService();
  harness.behaviour.send = "fail";
  harness.service.submit(harness.request("k1"));
  await tick();
  const snapshot = harness.service.snapshot();
  assert.equal(snapshot.failed, 1);
  assert.equal(snapshot.delivered, 0);
  assert.equal(snapshot.lastError, "通道坏了");
  assert.equal(typeof snapshot.lastAttemptAt, "number");
  assert.equal(snapshot.lastOkAt, undefined, "从未成功时不得留下成功时间");
  assert.ok(harness.logs.some((entry) => entry.level === "warning" && /投递失败/.test(entry.message)));
  await harness.service.dispose();
});

await step("S2 渠道缓存随配置刷新失效：同一 id 换 type 后必须按新类型重建", async () => {
  const harness = makeService();
  harness.service.submit(harness.request("k1"));
  await tick();
  assert.deepEqual(harness.created, ["terminal"]);

  harness.service.submit(harness.request("k2"));
  await tick();
  assert.deepEqual(harness.created, ["terminal"], "配置未变时必须复用渠道实例");

  harness.config.providers = [{ id: "terminal", type: "debug", enabled: true, options: {} }];
  harness.service.submit(harness.request("k3"));
  await tick();
  assert.deepEqual(harness.created, ["terminal", "debug"], "配置数组被替换后必须重新创建渠道");
  await harness.service.dispose();
});

await step("S3 discardPending：清空队列、中止在途、留下记录，且服务仍可继续使用", async () => {
  const harness = makeService();
  harness.config.delivery.concurrency = 1;
  harness.behaviour.send = "hang";
  harness.service.submit(harness.request("k1"));
  await tick();
  harness.service.submit(harness.request("k2"));
  assert.equal(harness.service.snapshot().queued, 1, "并发为 1 时第二条必须排队");

  harness.service.discardPending("reload");
  assert.equal(harness.service.snapshot().queued, 0);
  const discarded = harness.records.find((entry) => entry.event === "queue_discarded");
  assert.deepEqual({ reason: discarded.reason, count: discarded.count }, { reason: "reload", count: 1 });

  harness.behaviour.send = "ok";
  harness.service.submit(harness.request("k3"));
  await tick();
  assert.equal(harness.service.snapshot().delivered, 1, "discardPending 不是 dispose，之后仍应投递");
  await harness.service.dispose();
});

await step("S4 flush：预算到期就返回，并把超预算未完成写进日志", async () => {
  const harness = makeService();
  harness.behaviour.send = "hang";
  harness.service.submit(harness.request("k1"));
  await tick();

  const started = Date.now();
  await harness.service.flush(0);
  assert.ok(Date.now() - started < 500, "flush(0) 不得等待在途投递完成");
  const overBudget = harness.logs.find((entry) => /超预算/.test(entry.message));
  assert.ok(overBudget, `缺少超预算告警: ${JSON.stringify(harness.logs.map((entry) => entry.message))}`);
  assert.match(overBudget.message, /active=1/);

  harness.behaviour.send = "ok";
  await harness.service.flush(1000);
  assert.equal(harness.service.snapshot().active, 0, "在途结束后 flush 应正常返回");
  await harness.service.dispose();
});

await step("S5 dispose 幂等且丢弃之后的提交；dispose 之后 submit 不再投递", async () => {
  const harness = makeService();
  await harness.service.dispose();
  await harness.service.dispose();
  harness.service.submit(harness.request("k1"));
  await tick();
  assert.equal(harness.service.snapshot().delivered, 0);
  assert.equal(harness.service.snapshot().queued, 0);
  assert.ok(harness.records.some((entry) => entry.event === "service_disposed"));
});

for (const item of failures) {
  console.error(`\n[FAIL] ${item.name}\n${item.error?.stack ?? item.error}`);
}

if (failures.length === 0) {
  console.log("\n通过：状态机结构性丢弃 / run 簿记 / 服务队列与 dispose 全部断言成立。");
  process.exit(0);
} else {
  console.error(`\n失败：${failures.length} 项断言未通过。`);
  process.exit(1);
}
