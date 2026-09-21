/**
 * S7 专项回归：Webhook 渠道 + 可靠性装饰器（设计 §17.1 P2 / §17.4 / §13 第 1、2、16 项）。
 *
 * 不需要 SDK：渠道只依赖 Node 内置 `fetch`，所以用一个**回环地址**上的真实 HTTP 服务做端到端断言
 * （不经任何外部网络、不依赖互联网）。回环之外的 fetch 一律被陷阱拦下并让本次回归失败。
 *
 *   MSYS_NO_PATHCONV=1 node test/webhook-channel.mjs
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url));
const webhook = await import(pathToFileURL(path.join(PLUGIN_DIR, "src", "providers", "webhook.ts")).href);
const decorators = await import(pathToFileURL(path.join(PLUGIN_DIR, "src", "providers", "decorators.ts")).href);

// 外部网络陷阱：只允许回环地址（证明「离线」不是靠运气）
const externalAttempts = [];
const realFetch = globalThis.fetch;
const LOOPBACK_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (LOOPBACK_RE.test(url)) return realFetch(input, init);
  externalAttempts.push(url);
  throw new Error(`回归脚本禁止外部网络访问: ${url}`);
};

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

// ---------------------------------------------------------------------------
// 回环 HTTP 服务：按路径决定响应
// ---------------------------------------------------------------------------

const received = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    received.push({ url: req.url, headers: req.headers, body });
    if (req.url.startsWith("/redirect")) {
      res.writeHead(302, { location: "http://127.0.0.1:1/nope" });
      res.end();
      return;
    }
    if (req.url.startsWith("/boom")) {
      res.writeHead(500, { "content-type": "text/plain" });
      // 故意带上一个看起来像凭据的串：错误消息必须被脱敏
      res.end("internal error apiKey=sk-abcdefgh12345678");
      return;
    }
    res.writeHead(202, { "content-type": "text/plain" });
    res.end("accepted");
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const PORT = server.address().port;
const SECRET = "unit-test-secret-value";
process.env.PI_NOTIFY_UNIT_SECRET = SECRET;

const silentLog = { log: () => {}, record: () => {} };
function trackingLog() {
  const records = [];
  return { records, log: () => {}, record: (entry) => records.push(entry) };
}

function request(overrides = {}) {
  return {
    level: "error",
    kind: "run_failed",
    title: "任务失败",
    body: "mock provider failure",
    dedupeKey: "s:1:run_failed",
    channels: ["hook"],
    meta: { sessionId: "s", runId: "1", level: "error" },
    ...overrides,
  };
}

const notifier = (options, deps = {}) =>
  webhook.createWebhookNotifier("hook", options, { log: silentLog, maxChars: 300, ...deps });

console.log("S7 Webhook 渠道 + 装饰器回归：pi-notification");

await step("validate：URL 合法性与「只存环境变量名」都被严格校验", () => {
  const validate = (options, env = process.env) => webhook.validateWebhookOptions(options, env);

  assert.equal(validate({ url: `http://127.0.0.1:${PORT}/hook` }), undefined, "合法 http URL 应通过");
  assert.match(validate({}), /缺少 url/);
  assert.match(validate({ url: "   " }), /缺少 url/);
  assert.match(validate({ url: "not a url" }), /不是合法 URL/);
  assert.match(validate({ url: "ftp://example.invalid/x" }), /协议/);
  assert.match(validate({ url: "file:///etc/passwd" }), /协议/);
  assert.match(validate({ url: "https://user:pass@example.invalid/hook" }), /不允许内嵌凭据/);
  assert.match(validate({ url: "https://example.invalid/hook", secretEnv: "PI_NOTIFY_MISSING_ENV" }), /未设置或为空/);
  assert.match(validate({ url: "https://example.invalid/hook", secretEnv: "not-a-name" }), /合法的环境变量名/);
  assert.match(validate({ url: "https://example.invalid/hook", headers: { "x-a": "1\n2" } }), /换行/);
  assert.match(validate({ url: "https://example.invalid/hook", headers: { "x-a": 1 } }), /必须是字符串/);
  // 真实的 secret 环境变量存在时通过；且**从不**校验 / 记录明文
  assert.equal(validate({ url: "https://example.invalid/hook", secretEnv: "PI_NOTIFY_UNIT_SECRET" }), undefined);
});

await step("format：结构化载荷只含元数据（不含 prompt / 完整回复 / 密钥）", () => {
  const payload = webhook.buildWebhookPayload(request(), 1_700_000_000_000);
  assert.equal(payload.source, "pi-notification");
  assert.equal(payload.version, 1);
  assert.equal(payload.event, "run_failed");
  assert.equal(payload.level, "error");
  assert.equal(payload.sessionId, "s");
  assert.equal(payload.runId, "1");
  assert.equal(payload.at, 1_700_000_000_000);
  assert.deepEqual(Object.keys(payload).sort(), [
    "at", "body", "dedupeKey", "event", "level", "runId", "sessionId", "source", "title", "version",
  ]);
});

await step("send：真实 POST + HMAC 签名（签名对象是实际发送的字节）", async () => {
  const log = trackingLog();
  const options = { url: `http://127.0.0.1:${PORT}/hook?token=in-query`, secretEnv: "PI_NOTIFY_UNIT_SECRET" };
  await notifier(options, { log }).send(request(), new AbortController().signal);

  assert.equal(received.length, 1);
  const sent = received[0];
  assert.equal(sent.url, "/hook?token=in-query");
  assert.equal(sent.headers["x-pi-notify-event"], "run_failed");
  const expected = `sha256=${createHmac("sha256", SECRET).update(sent.body, "utf8").digest("hex")}`;
  assert.equal(sent.headers["x-pi-notify-signature"], expected);
  assert.ok(!sent.body.includes(SECRET), "载荷里不得出现密钥");

  const record = log.records.find((row) => row.event === "webhook_sent");
  assert.ok(record, "成功投递应留结构化记录");
  assert.equal(record.signed, true);
  assert.equal(record.url, `http://127.0.0.1:${PORT}/hook`, "日志必须丢弃 query（常被用来传 token）");
  assert.ok(!JSON.stringify(log.records).includes(SECRET), "日志里出现了密钥明文");
});

await step("send：无 secretEnv 时发送但不签名（signed=false）", async () => {
  const log = trackingLog();
  await notifier({ url: `http://127.0.0.1:${PORT}/plain` }, { log }).send(request(), new AbortController().signal);
  const sent = received.at(-1);
  assert.equal(sent.headers["x-pi-notify-signature"], undefined);
  assert.equal(log.records.find((row) => row.event === "webhook_sent").signed, false);
});

await step("send：非 2xx 抛错（含状态码），错误信息里的凭据被脱敏", async () => {
  const log = trackingLog();
  await assert.rejects(
    notifier({ url: `http://127.0.0.1:${PORT}/boom` }, { log }).send(request(), new AbortController().signal),
    (error) => {
      assert.match(error.message, /HTTP 500/);
      assert.doesNotMatch(error.message, /sk-abcdefgh12345678/, "错误消息里泄露了凭据");
      return true;
    },
  );
  const record = log.records.find((row) => row.event === "webhook_response");
  assert.equal(record.status, 500);
});

await step("send：不跟随重定向（redirect: error），已 abort 时立即失败", async () => {
  await assert.rejects(
    notifier({ url: `http://127.0.0.1:${PORT}/redirect` }, {}).send(request(), new AbortController().signal),
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    notifier({ url: `http://127.0.0.1:${PORT}/aborted` }, {}).send(request(), controller.signal),
  );
});

await step("withRetry：有界重试 + 指数退避，失败尝试留痕", async () => {
  const log = trackingLog();
  let attempts = 0;
  const flaky = {
    id: "flaky",
    type: "test",
    validate: () => undefined,
    async send() {
      attempts += 1;
      if (attempts < 3) throw new Error(`第 ${attempts} 次失败`);
    },
    async dispose() {},
  };
  await decorators.withRetry(flaky, { maxRetries: 2, retryDelayMs: 10, log }).send(request(), new AbortController().signal);
  assert.equal(attempts, 3);
  assert.equal(log.records.filter((row) => row.event === "delivery_retry").length, 2);

  // 重试次数用完仍然失败：错误是最后一次的
  attempts = 0;
  const alwaysFails = { ...flaky, async send() { attempts += 1; throw new Error("始终失败"); } };
  await assert.rejects(
    decorators.withRetry(alwaysFails, { maxRetries: 1, retryDelayMs: 5 }).send(request(), new AbortController().signal),
    /始终失败/,
  );
  assert.equal(attempts, 2, "maxRetries=1 表示总共尝试 2 次");
});

await step("withRetry：外层 signal 已 abort 时不再重试", async () => {
  let attempts = 0;
  const inner = {
    id: "x",
    type: "test",
    validate: () => undefined,
    async send() {
      attempts += 1;
      throw new Error("失败");
    },
    async dispose() {},
  };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    decorators.withRetry(inner, { maxRetries: 5, retryDelayMs: 1 }).send(request(), controller.signal),
  );
  assert.equal(attempts, 0, "已取消的投递不应开始尝试");
});

await step("withCircuitBreaker：连续 N 次失败后熔断、冷却后半开恢复", async () => {
  const log = trackingLog();
  let nowMs = 0;
  let calls = 0;
  let fail = true;
  const inner = {
    id: "breaker",
    type: "test",
    validate: () => undefined,
    async send() {
      calls += 1;
      if (fail) throw new Error("坏掉了");
    },
    async dispose() {},
  };
  const breaker = decorators.withCircuitBreaker(inner, {
    failures: 2,
    cooldownMs: 1000,
    now: () => nowMs,
    log,
  });

  await assert.rejects(breaker.send(request(), new AbortController().signal));
  await assert.rejects(breaker.send(request(), new AbortController().signal));
  assert.equal(calls, 2);
  assert.equal(log.records.filter((row) => row.event === "circuit_open").length, 1, "达到阈值应开熔断");

  // 熔断期间：即使渠道已经恢复也不能调用它（快速失败）
  fail = false;
  await assert.rejects(breaker.send(request(), new AbortController().signal), /熔断/);
  assert.equal(calls, 2, "熔断期间不应真的调用渠道");
  assert.equal(log.records.filter((row) => row.event === "circuit_open_skip").length, 1);

  // 冷却结束 → 半开：放行一次，成功即复位
  nowMs = 2000;
  await breaker.send(request(), new AbortController().signal);
  assert.equal(calls, 3);
  await breaker.send(request(), new AbortController().signal);
  assert.equal(calls, 4, "成功后应完全恢复");

  // failures<=0 表示关闭熔断
  const off = decorators.withCircuitBreaker(inner, { failures: 0 });
  fail = true;
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(off.send(request(), new AbortController().signal));
  }
  assert.equal(calls, 9, "关闭熔断时不应拦截");
});

await step("withTimeout：内层无视 signal 也会被自己的 deadline 打断", async () => {
  const hanging = {
    id: "hang",
    type: "test",
    validate: () => undefined,
    async send(_req, signal) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    },
    async dispose() {},
  };
  const startedAt = Date.now();
  await assert.rejects(
    decorators.withTimeout(hanging, { timeoutMs: 50 }).send(request(), new AbortController().signal),
    /超时（50ms）/,
  );
  assert.ok(Date.now() - startedAt < 1500, "超时没有及时生效");
  // timeoutMs<=0 表示不额外加 deadline（只跟随外层 signal）
  await decorators.withTimeout(
    { ...hanging, async send() {} },
    { timeoutMs: 0 },
  ).send(request(), new AbortController().signal);
});

await step("withRedaction：出口错误信息一律脱敏", async () => {
  const leaky = {
    id: "leaky",
    type: "test",
    validate: () => undefined,
    async send() {
      throw new Error("Authorization: Bearer supersecretvalue /home/somebody/private");
    },
    async dispose() {},
  };
  const log = trackingLog();
  await assert.rejects(
    decorators.withRedaction(leaky, { log }).send(request(), new AbortController().signal),
    (error) => {
      assert.doesNotMatch(error.message, /supersecretvalue/);
      assert.ok(!/\/home\/somebody/.test(error.message), "家目录路径应被脱敏");
      return true;
    },
  );
  assert.equal(log.records.filter((row) => row.event === "delivery_error_redacted").length, 1);
});

await step("withReliability：每次尝试有自己的 deadline，重试才真的有意义", async () => {
  let calls = 0;
  const slowThenFast = {
    id: "slow",
    type: "test",
    validate: () => undefined,
    async send(_req, signal) {
      calls += 1;
      const delay = calls === 1 ? 200 : 1;
      if (delay > 100) {
        // 第一次尝试会被单次 deadline 打断
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, delay);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        if (signal.aborted) throw new Error("投递已取消");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    },
    async dispose() {},
  };
  const log = trackingLog();
  const stack = decorators.withReliability(slowThenFast, () => ({
    attemptTimeoutMs: 60,
    maxRetries: 1,
    retryDelayMs: 5,
    breakerFailures: 0,
    breakerCooldownMs: 0,
  }), log);
  await stack.send(request(), new AbortController().signal);
  assert.equal(calls, 2, "第一次尝试应被单次 deadline 打断，然后重试成功");
  assert.equal(log.records.filter((row) => row.event === "delivery_retry").length, 1);
  // 熔断在重试之外：一次投递彻底失败只计一次
  assert.equal(log.records.filter((row) => row.event === "circuit_open").length, 0);
});

await step("渠道契约：validate/format/dispose 都透传（渠道替换不改调用点）", async () => {
  const base = notifier({ url: `http://127.0.0.1:${PORT}/contract` }, {});
  assert.equal(base.id, "hook");
  assert.equal(base.type, "webhook");
  assert.equal(base.validate({ url: "nope" }) !== undefined, true);
  assert.ok(base.format(request()));
  const wrapped = decorators.withReliability(base, () => ({ attemptTimeoutMs: 100, maxRetries: 0, retryDelayMs: 0, breakerFailures: 2, breakerCooldownMs: 1000 }));
  assert.equal(wrapped.validate({ url: "nope" }) !== undefined, true, "包装后 validate 必须继续透传");
  assert.ok(wrapped.format(request()), "包装后 format 不得丢失");
  await wrapped.dispose();
});

await new Promise((resolve) => server.close(resolve));

for (const item of failures) {
  console.error(`\n[FAIL] ${item.name}\n${item.error?.stack ?? item.error}`);
}
if (failures.length === 0) {
  assert.deepEqual(externalAttempts, [], "出现了外部网络访问");
  console.log("\n通过：Webhook 校验/签名/错误处理 + 装饰器（重试/熔断/超时/脱敏）全部断言成立。");
  process.exit(0);
} else {
  console.error(`\n失败：${failures.length} 项断言未通过。`);
  process.exit(1);
}
