import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchCodexUsage,
  formatCodexUsage,
  parseCodexUsage,
  type UsageFetch,
} from "../extensions/codex-usage.ts";

const NOW = Date.UTC(2025, 0, 1, 0, 0, 0);

test("parses plan and both known rate-limit windows", () => {
  const summary = parseCodexUsage({
    plan_type: "plus",
    extra_field: "ignored",
    rate_limit: {
      primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: 1_735_700_000 },
      secondary_window: { used_percent: 75.5, limit_window_seconds: 604_800, reset_after_seconds: 3_600 },
    },
  });
  assert.deepEqual(summary, {
    planType: "plus",
    windows: [
      { label: "5 小时窗口", usedPercent: 20, resetAtMs: 1_735_700_000_000 },
      { label: "7 天窗口", usedPercent: 75.5, resetAfterSeconds: 3_600 },
    ],
  });
  const output = formatCodexUsage(summary, NOW);
  assert.match(output, /套餐：plus/);
  assert.match(output, /已用 20%/);
  assert.match(output, /已用 75\.5%/);
  assert.match(output, /重置时间：2025-01-01 01:00 UTC（北京时间：2025-01-01 09:00）/);
  assert.match(output, /5 小时窗口：已用 20%/);
  assert.match(output, /7 天窗口  ：已用 75\.5%/);
});

test("aligns the reset-time text after one- and two-digit percentages", () => {
  const output = formatCodexUsage({
    windows: [
      { label: "5 小时窗口", usedPercent: 1, resetAtMs: NOW },
      { label: "7 天窗口", usedPercent: 38, resetAtMs: NOW },
    ],
  }, NOW);
  assert.match(output, /5 小时窗口：已用 1%； 重置时间：/);
  assert.match(output, /7 天窗口  ：已用 38%；重置时间：/);
});

test("preserves percentage boundaries and omits unrepresentable reset times", () => {
  const summary = parseCodexUsage({
    plan_type: " plus ",
    rate_limit: {
      primary_window: { used_percent: 0, reset_at: 0 },
      secondary_window: { used_percent: 100, reset_after_seconds: Number.MAX_VALUE },
    },
  });
  const output = formatCodexUsage(summary, NOW);
  assert.match(output, /套餐：plus/);
  assert.match(output, /已用 0%/);
  assert.match(output, /已用 100%/);
  assert.doesNotMatch(output, /重置时间：/);
});

test("parses legacy windows, percent-left and ISO reset values", () => {
  const summary = parseCodexUsage({
    five_hour: { percent_left: 0, reset_at: "2025-01-02T00:00:00Z" },
    weekly: { percent_left: 100, reset_after_seconds: 0 },
  });
  assert.deepEqual(summary.windows, [
    { label: "5 小时窗口", usedPercent: 100, resetAtMs: Date.UTC(2025, 0, 2) },
    { label: "7 天窗口", usedPercent: 0, resetAfterSeconds: 0 },
  ]);
  assert.match(formatCodexUsage(summary, NOW), /重置时间：2025-01-01 00:00 UTC（北京时间：2025-01-01 08:00）/);
});

test("accepts plural and feature-specific rate-limit response variants", () => {
  const summary = parseCodexUsage({
    rate_limits: {
      primary_window: { used_percent: 10, limit_window_seconds: 3_600 },
    },
    additional_rate_limits: [
      { name: "Video", rate_limit: { used_percent: 50, reset_after_seconds: 60 } },
    ],
  });
  assert.deepEqual(summary.windows, [
    { label: "主要窗口（3600 秒）", usedPercent: 10 },
    { label: "Video", usedPercent: 50, resetAfterSeconds: 60 },
  ]);
});

test("ignores malformed, out-of-range, missing and unknown window fields", () => {
  const summary = parseCodexUsage({
    unexpected: { used_percent: 44 },
    rate_limit: {
      primary_window: { used_percent: 101, reset_at: "not a date", reset_after_seconds: -1 },
      secondary_window: null,
    },
  });
  assert.deepEqual(summary, { windows: [] });
  assert.match(formatCodexUsage(summary, NOW), /暂未识别到套餐或用量窗口/);
});

test("fetches with bearer token and account ID without exposing them in errors", async () => {
  let requestedUrl = "";
  let requestedMethod = "";
  let requestedHeaders: Headers | undefined;
  let requestedSignal: AbortSignal | null | undefined;
  const fakeFetch: UsageFetch = async (input, init) => {
    requestedUrl = String(input);
    requestedMethod = init?.method ?? "";
    requestedHeaders = new Headers(init?.headers);
    requestedSignal = init?.signal as AbortSignal | null | undefined;
    return new Response(JSON.stringify({ plan_type: "plus" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await fetchCodexUsage("secret-token", "account-123", fakeFetch);
  assert.deepEqual(result, { plan_type: "plus" });
  assert.equal(requestedUrl, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(requestedMethod, "GET");
  assert.equal(requestedHeaders?.get("accept"), "application/json");
  assert.equal(requestedHeaders?.get("authorization"), "Bearer secret-token");
  assert.equal(requestedHeaders?.get("chatgpt-account-id"), "account-123");
  assert.ok(requestedSignal instanceof AbortSignal);
  assert.equal(requestedSignal?.aborted, false);
});

test("keeps credentials isolated across concurrent usage requests", async () => {
  const seen = new Map<string, string>();
  const fakeFetch: UsageFetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    const accountId = headers.get("chatgpt-account-id") ?? "";
    seen.set(accountId, headers.get("authorization") ?? "");
    return new Response(JSON.stringify({ account: accountId }), { status: 200 });
  };
  const [first, second] = await Promise.all([
    fetchCodexUsage("token-a", "account-a", fakeFetch),
    fetchCodexUsage("token-b", "account-b", fakeFetch),
  ]);
  assert.deepEqual(first, { account: "account-a" });
  assert.deepEqual(second, { account: "account-b" });
  assert.deepEqual([...seen.entries()].sort(), [
    ["account-a", "Bearer token-a"],
    ["account-b", "Bearer token-b"],
  ]);
});

test("rejects empty or non-string credentials before making a request", async () => {
  let calls = 0;
  const fakeFetch: UsageFetch = async () => {
    calls++;
    return new Response(JSON.stringify({ plan_type: "plus" }), { status: 200 });
  };
  const invalidInputs: Array<[unknown, unknown, RegExp]> = [
    ["", "account-123", /access token/],
    ["   ", "account-123", /access token/],
    ["token", "  ", /账号 ID/],
    [null, "account-123", /access token/],
    ["token", undefined, /账号 ID/],
  ];
  for (const [token, accountId, expectedMessage] of invalidInputs) {
    await assert.rejects(
      fetchCodexUsage(token as string, accountId as string, fakeFetch),
      expectedMessage,
    );
  }
  assert.equal(calls, 0);
});

test("reports unauthorized and malformed JSON without leaking response bodies", async () => {
  const unauthorized: UsageFetch = async () => new Response("private response", { status: 401 });
  await assert.rejects(fetchCodexUsage("secret-token", "account-123", unauthorized), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /更新登录/);
    assert.doesNotMatch(error.message, /secret-token|private response/);
    return true;
  });

  const invalidJson: UsageFetch = async () => new Response("not-json", { status: 200 });
  await assert.rejects(fetchCodexUsage("secret-token", "account-123", invalidJson), /无效 JSON/);

  const invalidRoot: UsageFetch = async () => new Response("[]", { status: 200 });
  await assert.rejects(fetchCodexUsage("secret-token", "account-123", invalidRoot), /不是 JSON 对象/);
});

test("reports other HTTP failures generically and handles request timeouts", async () => {
  const forbidden: UsageFetch = async () => new Response("private response", { status: 500 });
  await assert.rejects(fetchCodexUsage("secret-token", "account-123", forbidden), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /HTTP 500/);
    assert.doesNotMatch(error.message, /secret-token|private response/);
    return true;
  });

  const timeout: UsageFetch = async () => {
    throw new DOMException("timeout", "TimeoutError");
  };
  await assert.rejects(fetchCodexUsage("secret-token", "account-123", timeout), /查询 OpenAI 用量超时/);
});
