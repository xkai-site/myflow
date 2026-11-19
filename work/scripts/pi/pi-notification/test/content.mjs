import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.ts";
import { emailContent, notificationTitle } from "../src/content.ts";
import { evaluateCompactFailure, evaluateSettlement, evaluateToolFailure, evaluateWaitingForUser } from "../src/rules.ts";

const config = defaultConfig();
const ids = { sessionId: "private-session-id", runId: "private-run-id" };
const summary = { sessionName: "myflow", projectName: "fallback", contextPercent: 42 };
const outcome = { ...ids, status: "completed", startedAt: 0, durationMs: 155000, stopReason: "stop", costUsd: 0.0246, toolFailures: [] };
const settle = (overrides) => evaluateSettlement({ outcome: { ...outcome, ...overrides }, summary }, config);

assert.equal(settle().title, "myflow：已完成（2分35秒，$0.0246）");
assert.equal(settle().body, "");
assert.equal(settle().details, undefined);
assert.equal(notificationTitle("已完成", { sessionName: " \n \x1b[31m", projectName: "repo" }, 38000, 0), "repo：已完成（38秒，$0.0000）");
assert.equal(notificationTitle("已完成", undefined, 59999, 2.5), "已完成（1分，$2.50）");
assert.equal(notificationTitle("已完成", undefined, NaN, -1), "已完成");
assert.equal(settle({ startObserved: false, costUsd: undefined }).title, "myflow：已完成");
assert.equal(settle({ startObserved: false }).meta.durationMs, 155000, "Webhook v1 的观测耗时字段保留");
assert.equal(notificationTitle("已完成", { sessionName: "会话名称有一点长但仍放得下" }, 38000, 0),
  "已完成（38秒，$0.0000） · 会话名称有一点长但仍放得下");
const longName = notificationTitle("已完成", { sessionName: "👩🏽‍💻".repeat(70) }, 155000, 0.0246);
assert.match(longName, /^已完成（2分35秒，\$0\.0246） · (?:👩🏽‍💻)+…$/u);
assert.equal(settle({ status: "unknown" }), null);

const failure = settle({ status: "failed", errorMessage: "服务不可用", compactionError: true, toolFailures: [{ toolName: "bash", count: 2 }] });
assert.equal(failure.title, "myflow：运行失败（2分35秒，$0.0246）");
assert.equal(failure.body, "失败原因：服务不可用；上下文压缩失败；工具执行失败 2 次");
assert.equal(settle({ compactFailed: true }).body, "", "用户取消压缩不应在运行通知里冒充压缩失败");
assert.equal(settle({ status: "aborted" }), null);
config.rules.runAborted.enabled = true;
const abortedAfterLimit = settle({ status: "aborted", stopReason: "length" });
assert.equal(abortedAfterLimit.title, "myflow：已中止（2分35秒，$0.0246）");
assert.equal(abortedAfterLimit.level, "warning", "运行中止优先展示，长度终止仍保留原有等级下限");

const truncated = settle({ stopReason: "length" });
assert.equal(truncated.kind, "run_completed");
assert.equal(truncated.level, "warning");
assert.equal(truncated.title, "myflow：输出已截断（2分35秒，$0.0246）");
assert.equal(truncated.body, "已达到模型输出上限");

config.rules.waitingForUser.enabled = true;
const waiting = evaluateWaitingForUser({ ...ids, labels: summary, kind: "select", seq: 1, title: "继续执行？" }, config);
assert.equal(waiting.title, "myflow：等待输入");
assert.equal(waiting.body, "继续执行？");
assert.equal(waiting.details, undefined);
assert.equal(evaluateWaitingForUser({ ...ids, kind: "custom", seq: 2 }, config), null);
const compactInput = { ...ids, labels: summary, reason: "overflow", seq: 1, errorMessage: "服务不可用 token=private-value" };
const compact = evaluateCompactFailure({ ...compactInput, aborted: false }, config);
assert.equal(compact.title, "myflow：上下文压缩失败");
assert.match(compact.body, /^上下文溢出；失败原因：服务不可用 token=\*\*\*$/);
assert.equal(evaluateCompactFailure({ ...compactInput, aborted: true }, config), null);

const toolFailures = [{ toolName: "read", count: 1 }, { toolName: "bash", count: 2 }];
config.rules.runCompleted.enabled = false;
const aggregate = settle({ toolFailures });
assert.equal(aggregate.title, "myflow：工具执行失败（2分35秒，$0.0246）");
assert.equal(aggregate.body, "累计失败 3 次");
config.rules.toolFailed.mode = "immediate";
const immediate = evaluateToolFailure({ ...ids, labels: summary, toolName: "bash", toolFailures, accumulated: toolFailures }, config);
assert.equal(immediate.title, "myflow：工具执行失败");
assert.equal(immediate.dedupeKey, `${ids.sessionId}:${ids.runId}:tool_failed:bash`);
assert.equal(immediate.coalesceWindowMs, config.coalesce.toolFailureWindowMs);

config.rules.runCompleted.enabled = true;
config.content.mode = "full";
const reply = "\n# 标题\n\n- 第一项\n  - 第二项\n\n```ts\n\treturn value;\n```\n";
const full = settle({ finalReply: reply });
assert.equal(full.body, "");
assert.equal(emailContent(full).text, `上下文 42%\n\n最终回复\n\n${reply}`);
for (const contextPercent of [0, undefined, NaN, Infinity]) {
  const without = evaluateSettlement({ outcome, summary: { ...summary, contextPercent } }, config);
  assert.equal(emailContent(without).text, "没有最终回复。");
}
assert.equal(settle({ status: "failed" }).details.finalReply, null);
assert.equal(settle({ status: "aborted" }).details.finalReply, null);
console.log("Content: modes, titles, events and formatting passed");
