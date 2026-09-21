/**
 * Regression probe; a test fixture, not part of the plugin.
 *
 * It provides three things:
 *  1. two offline fake providers, `probe-fake` (stops successfully) and `probe-fail` (errors), which
 *     emit events through `createAssistantMessageEventStream()` with no network and no LLM call;
 *  2. the `/probe-cmd` command, used to verify that a pure command produces no agent lifecycle;
 *  3. event tracing: hook activity plus a monotonic timestamp is appended to `PROBE_LOG` as JSONL.
 *
 * That trace is the only clock source for asserting how soon the next run starts, so `mono` uses
 * `process.hrtime` rather than wall-clock time.
 */

import { appendFileSync } from "node:fs";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const INSTANCE = process.env.PROBE_INSTANCE ?? Math.random().toString(36).slice(2, 8);
const T0 = process.hrtime.bigint();

/**
 * The target log file is read on **every call** rather than cached at module load: several hosts can
 * be created one after another in the same process, and a cached path would make the second host's
 * probe write into the first host's file.
 */
function logFile(): string | undefined {
  return process.env.PROBE_LOG;
}

function monoMs() {
  return Number(process.hrtime.bigint() - T0) / 1e6;
}

function log(ev, extra = {}) {
  const file = logFile();
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify({
      mono: monoMs(),
      at: Date.now(),
      pid: process.pid,
      instance: INSTANCE,
      ev,
      ...extra,
    })}\n`, "utf8");
  } catch {
    // Tracing failures must not affect the behaviour under test.
  }
}

function mockModel(id) {
  return {
    id,
    name: `Probe ${id}`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 4096,
  };
}

function assistantMessage(model, overrides) {
  // Test knobs for the content fields: also read from the environment on every call, like
  // PROBE_DELAY_MS, so several hosts in one process can each supply their own values (the module is
  // loaded only once).
  const costUsd = Number(process.env.PROBE_COST_USD ?? 0) || 0;
  // The input token count is also what `ctx.getContextUsage()` reports, scaled against
  // model.contextWindow=100000.
  const inputTokens = Number(process.env.PROBE_CONTEXT_TOKENS ?? 1) || 1;
  return {
    role: "assistant",
    content: [{ type: "text", text: assistantText() }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: inputTokens,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: inputTokens + 1,
      cost: { input: costUsd, output: 0, cacheRead: 0, cacheWrite: 0, total: costUsd },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Body of the fake assistant message; `PROBE_ASSISTANT_TEXT` substitutes a controlled string including newlines and control characters. */
function assistantText() {
  return process.env.PROBE_ASSISTANT_TEXT ?? "OK";
}

/** mode: "ok" | "error" */
function buildStream(model, mode) {
  const stream = createAssistantMessageEventStream();
  const delay = Number(process.env.PROBE_DELAY_MS ?? 0);
  const schedule = Number.isFinite(delay) && delay > 0
    ? (run) => setTimeout(run, delay)
    : (run) => queueMicrotask(run);
  schedule(() => {
    if (mode === "error") {
      stream.push({
        type: "error",
        reason: "error",
        error: assistantMessage(model, {
          content: [],
          stopReason: "error",
          errorMessage: "Mock provider failure: invalid_request_error (probe-fail)",
        }),
      });
      return;
    }
    const message = assistantMessage(model, {});
    const pending = { ...message, content: [], stopReason: "pending" };
    stream.push({ type: "start", partial: pending });
    stream.push({ type: "text_start", contentIndex: 0, partial: pending });
    stream.push({ type: "text_delta", contentIndex: 0, delta: assistantText(), partial: message });
    stream.push({ type: "text_end", contentIndex: 0, content: assistantText(), partial: message });
    stream.push({ type: "done", reason: "stop", message });
  });
  return stream;
}

function providerConfig(modelId, mode) {
  return {
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "dummy-not-a-secret",
    api: "openai-completions",
    models: [mockModel(modelId)],
    streamSimple(model) {
      return buildStream(model, mode);
    },
  };
}

export default function probeExtension(pi) {
  pi.registerProvider("probe-fake", providerConfig("fake-model", "ok"));
  pi.registerProvider("probe-fail", providerConfig("fail-model", "error"));

  pi.registerCommand("probe-cmd", {
    description: "probe: 纯命令，不进入 agent 生命周期",
    handler: async () => {
      log("CMD_HANDLER_ENTER");
    },
  });

  // Goes through Pi's **real** UI prompt path (the runner wraps `withUIPrompt`), which is what makes
  // the `ui_prompt_start/end` triggers real: kind=select and the title is carried through.
  pi.registerCommand("probe-prompt", {
    description: "probe: 触发一次真实的 select 提示（不会真的阻塞：桩 UI 直接返回 undefined）",
    handler: async (_args, ctx) => {
      log("PROMPT_CMD_ENTER");
      const answer = await ctx.ui.select("选择 A", ["a", "b"]);
      log("PROMPT_CMD_EXIT", { answer: answer ?? null });
    },
  });

  pi.on("session_start", (event) => log("session_start", { reason: event.reason }));
  pi.on("agent_start", () => log("agent_start"));
  pi.on("message_end", (event) => {
    if (event.message?.role !== "assistant") return;
    log("assistant_stop", { stopReason: event.message.stopReason ?? null });
  });
  pi.on("agent_settled", (_event, ctx) => {
    let isIdle;
    try {
      isIdle = ctx.isIdle();
    } catch {
      isIdle = "unavailable";
    }
    log("settled_enter", { isIdle });
    log("settled_exit");
  });
  pi.on("session_shutdown", (event) => log("session_shutdown", { reason: event.reason }));
}
