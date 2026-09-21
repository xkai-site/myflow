/**
 * 回归测试探针（**测试夹具，不是插件的一部分**）。
 *
 * 提供三样东西：
 *  1. 两个离线假 provider：`probe-fake`（成功 stop）与 `probe-fail`（error）。
 *     用 `createAssistantMessageEventStream()` 直接产出事件，**零网络、零 LLM 调用**。
 *  2. `/probe-cmd` 命令：用于验证「纯命令不产生 agent 生命周期」（§18.2 第 1 项）。
 *  3. 事件打点：把 hook 触发情况连同单调时钟写到 `PROBE_LOG`（JSONL），供断言读取。
 *
 * 打点是断言"settled 后多久启动下一次 run"的唯一时钟来源，因此 `mono` 用 `process.hrtime`，
 * 而不是墙上时钟。
 */

import { appendFileSync } from "node:fs";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const INSTANCE = process.env.PROBE_INSTANCE ?? Math.random().toString(36).slice(2, 8);
const T0 = process.hrtime.bigint();

/**
 * 目标日志文件**每次调用时读取**，不在模块加载时缓存：
 * 同一个进程里可能先后建多个 host（回归脚本就是这么做的），而扩展模块会被缓存复用，
 * 若在模块作用域缓存路径，第二个 host 的探针就会写到第一个 host 的文件里。
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
    // 打点失败不得影响被测行为
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
  return {
    role: "assistant",
    content: [{ type: "text", text: "OK" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
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
    stream.push({ type: "text_delta", contentIndex: 0, delta: "OK", partial: message });
    stream.push({ type: "text_end", contentIndex: 0, content: "OK", partial: message });
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

  // 走 Pi **真实**的 UI prompt 路径（runner 会包一层 `withUIPrompt`）：
  // 用于验证 `ui_prompt_start/end` 的真触发（kind=select、title 带过来）。
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
