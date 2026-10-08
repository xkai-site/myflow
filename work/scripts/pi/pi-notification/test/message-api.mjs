/** Read-only machine API contracts. Only loopback HTTP and injected senders. */
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig, loadConfig, userConfigPath, writeUserDefault } from "../src/config.ts";
import { createEnvelope } from "../src/messages.ts";
import { createMessagePublisher } from "../src/api.ts";
import { createRuntime } from "../src/runtime.ts";
import { applyOverlay, overlayEntryData, overlayFromEntry } from "../src/settings.ts";
import { sendHttpBody, validateHttpOptions } from "../src/providers/http.ts";

const log = { log() {}, record() {} };
const failures = [];
async function step(name, run) {
  if (process.env.PI_MESSAGE_TEST_FILTER && !new RegExp(process.env.PI_MESSAGE_TEST_FILTER).test(name)) return;
  try { await run(); console.log(`  ✓ ${name}`); }
  catch (error) { failures.push({ name, error }); console.error(`  ✗ ${name}: ${error.message}`); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const configFor = (overrides = {}) => ({ ...defaultConfig().api, enabled: true, url: "http://127.0.0.1:1/hook", timeoutMs: 1000, maxRetries: 0, ...overrides });
const envelope = (seq = 1, overrides = {}) => createEnvelope({
  streamId: "stream", seq, sessionId: "session", includeLabels: false,
  fact: { type: "state.snapshot", at: 1700000000000, data: {} },
  snapshot: { state: "idle", prompts: [] }, ...overrides,
});

const received = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    received.push({ path: req.url, headers: req.headers, body });
    if (req.url === "/redirect") { res.writeHead(302, { location: "/ok" }); res.end(); return; }
    if (req.url.startsWith("/echo")) { res.writeHead(500); res.end("private-header private-query test-shared-secret"); return; }
    const status = req.url === "/retry" && received.filter((item) => item.path === "/retry").length === 1 ? 503
      : req.url === "/401" ? 401 : req.url === "/408" ? 408 : req.url === "/429" ? 429 : 202;
    res.writeHead(status);
    res.end("token=sk-abcdefgh12345678");
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = (suffix = "/ok") => `http://127.0.0.1:${server.address().port}${suffix}`;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const target = String(input?.url ?? input);
  assert.match(target, /^http:\/\/127\.0\.0\.1(?::\d+)?\//, "禁止外网请求");
  return realFetch(input, init);
};
const publishers = [];
function publisher(config, sender) {
  const api = createMessagePublisher({ config, log, sender });
  publishers.push(api);
  return api;
}

try {
  await step("信封：稳定身份、白名单、隐私和不可变快照", () => {
    const snapshot = { state: "done", prompts: [], lastRun: {
      runId: "run", status: "completed", startObserved: false, startedAt: 99, durationMs: 2,
      toolFailures: [{ toolName: "bash", count: 2 }], assistantExcerpt: "SECRET_REPLY", cwd: "SECRET_CWD",
    }, rawPrompt: "SECRET_PROMPT" };
    const fact = { type: "run.settled", at: 123, runId: "run", data: snapshot.lastRun };
    const item = envelope(9, { snapshot, fact, labels: { sessionName: "PRIVATE_LABEL" } });
    assert.equal(item.eventId, "stream:9");
    assert.equal(item.schemaVersion, 1);
    assert.equal(item.occurredAt, 123);
    assert.equal(item.labels, undefined);
    assert.equal(item.data.startedAt, undefined, "隐式 run 不冒充真实耗时");
    assert.equal(item.data.durationMs, undefined);
    snapshot.lastRun.toolFailures[0].count = 9;
    assert.equal(item.snapshot.lastRun.toolFailures[0].count, 2);
    assert.doesNotMatch(JSON.stringify(item), /SECRET_|PRIVATE_LABEL/);
    const labelled = envelope(10, { labels: { sessionName: "name\u001b[31m token=sk-abcdefgh12345678" }, includeLabels: true });
    assert.doesNotMatch(JSON.stringify(labelled), /sk-abcdefgh12345678|\\u001b/);
  });

  await step("旧配置默认不外发；API 非法独立降级；稀疏写保留 API", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-message-config-"));
    try {
      fs.mkdirSync(path.dirname(userConfigPath(dir)), { recursive: true });
      fs.writeFileSync(userConfigPath(dir), JSON.stringify({ version: 1, enabled: false }));
      assert.equal(loadConfig({ agentDir: dir }).config.api.enabled, false);
      const raw = { enabled: false, api: { enabled: true, url: url(), headers: { Authorization: "private-header" } } };
      fs.writeFileSync(userConfigPath(dir), JSON.stringify(raw));
      assert.equal(writeUserDefault(dir, { content: { includeCost: false } }).ok, true);
      assert.deepEqual(JSON.parse(fs.readFileSync(userConfigPath(dir), "utf8")).api, raw.api);
      assert.equal(loadConfig({ agentDir: dir }).config.api.enabled, true);
      fs.writeFileSync(userConfigPath(dir), JSON.stringify({ enabled: false, api: { enabled: true, queueLimit: 0 } }));
      const invalid = loadConfig({ agentDir: dir });
      assert.equal(invalid.config.enabled, false, "API 错误不覆盖通知配置");
      assert.equal(invalid.config.api.enabled, false);
      assert.ok(invalid.errors.some((problem) => problem.path === "api.queueLimit"));
      assert.equal(invalid.degraded, false);
      assert.equal(writeUserDefault(dir, { enabled: true }).ok, false);
      fs.writeFileSync(userConfigPath(dir), "{broken");
      assert.equal(loadConfig({ agentDir: dir }).config.api.enabled, false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await step("API endpoint/凭据不进入会话 overlay", () => {
    const raw = { patch: { enabled: false, api: { enabled: true, headers: { Authorization: "private-session-header" } } }, providers: {} };
    const overlay = overlayFromEntry(raw);
    assert.deepEqual(overlay.patch, { enabled: false });
    assert.equal(applyOverlay(defaultConfig(), raw).config.api.enabled, false);
    assert.doesNotMatch(JSON.stringify(overlayEntryData("s", raw, 123)), /private-session-header|Authorization/);
  });

  await step("真实 HTTP：重试不改变字节/身份，HMAC 可验证", async () => {
    process.env.PI_MESSAGE_TEST_SECRET = "test-shared-secret";
    const api = publisher(configFor({ url: url("/retry"), secretEnv: "PI_MESSAGE_TEST_SECRET", maxRetries: 1 }));
    api.publish(envelope());
    await api.flush(1500);
    const requests = received.filter((item) => item.path === "/retry");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body, requests[1].body);
    for (const item of requests) {
      assert.equal(item.headers["x-pi-message-event"], "state.snapshot");
      assert.equal(item.headers["x-pi-message-id"], "stream:1");
      assert.equal(item.headers["x-pi-message-signature"], `sha256=${createHmac("sha256", "test-shared-secret").update(item.body).digest("hex")}`);
    }
    assert.equal(api.snapshot().delivered, 1);
  });

  await step("永久 4xx 不重试，408/429 可有限重试", async () => {
    for (const status of [401, 408, 429]) {
      const api = publisher(configFor({ url: url(`/${status}`), maxRetries: 1 }));
      api.publish(envelope(status)); await api.flush(1500);
      assert.equal(received.filter((item) => item.path === `/${status}`).length, status === 401 ? 1 : 2);
      assert.equal(api.snapshot().failed, 1);
      assert.doesNotMatch(api.snapshot().lastError, /sk-abcdefgh12345678/);
    }
  });

  await step("安全：保留头大小写、凭据 URL、重定向、密钥运行中消失", async () => {
    for (const header of ["CONTENT-TYPE", "x-pi-message-signature", "X-Pi-Notify-Event"]) {
      assert.match(validateHttpOptions({ url: url(), headers: { [header]: "bad" } }), /保留/);
    }
    assert.match(validateHttpOptions({ url: "https://user:password@example.invalid/hook" }), /内嵌凭据/);
    await assert.rejects(sendHttpBody({ url: url("/redirect") }, "{}", {}, new AbortController().signal));
    const config = configFor({ secretEnv: "PI_MESSAGE_TEST_SECRET" });
    assert.equal(validateHttpOptions(config), undefined);
    const records = [];
    await assert.rejects(sendHttpBody({ url: url("/echo?arbitrary=private-query"), headers: { "X-Private": "private-header" }, secretEnv: "PI_MESSAGE_TEST_SECRET" }, "{}", {}, new AbortController().signal,
      { log: { log() {}, record(row) { records.push(row); } } }), (error) => {
      assert.doesNotMatch(error.message, /private-header|private-query|test-shared-secret/); return true;
    });
    assert.doesNotMatch(JSON.stringify(records), /private-header|private-query|test-shared-secret/);
    delete process.env.PI_MESSAGE_TEST_SECRET;
    const before = received.length;
    await assert.rejects(sendHttpBody(config, "{}", {}, new AbortController().signal), /未设置|为空/);
    assert.equal(received.length, before, "缺失签名密钥时不得发送");
  });

  await step("有界 FIFO：不丢在途，丢最旧等待消息，保留最新快照", async () => {
    const sent = [];
    let release;
    const api = publisher(configFor({ queueLimit: 2 }), async (body) => {
      sent.push(JSON.parse(body).seq);
      if (sent.length === 1) await new Promise((resolve) => { release = resolve; });
    });
    api.publish(envelope(1)); await sleep(0);
    api.publish(envelope(2)); api.publish(envelope(3)); api.publish(envelope(4));
    assert.equal(api.snapshot().queued, 2);
    assert.equal(api.snapshot().dropped, 1);
    release(); await api.flush(1000);
    assert.deepEqual(sent, [1, 3, 4]);
  });

  await step("超时/flush/dispose 有界，即使注入 sender 忽略 signal", async () => {
    const api = publisher(configFor({ timeoutMs: 60 }), () => new Promise(() => {}));
    api.publish(envelope());
    const started = performance.now();
    await api.flush(500);
    assert.ok(performance.now() - started < 300);
    assert.equal(api.snapshot().failed, 1);
    const hanging = publisher(configFor({ timeoutMs: 10000 }), () => new Promise(() => {}));
    hanging.publish(envelope()); await sleep(0);
    const flushStart = performance.now(); await hanging.flush(20);
    assert.ok(performance.now() - flushStart < 150);
    hanging.dispose(); hanging.dispose(); await sleep(0);
    assert.equal(hanging.snapshot().active, 0);
    hanging.publish(envelope(2)); assert.equal(hanging.snapshot().queued, 0);
  });

  await step("runtime：事实不受通知关闭/强制静默影响，热切换与恢复发快照", async () => {
    const config = defaultConfig(); config.enabled = false; config.api = configFor();
    const sent = [];
    let silenced = false;
    const service = { submit() { throw new Error("关闭通知不能提交"); }, async flush() {}, discardPending() {}, async dispose() {} };
    const runtime = createRuntime({ config, service, log, now: () => 100, instanceToken: "runtime", isSilenced: () => silenced,
      sender: async (body) => { sent.push(JSON.parse(body)); } });
    runtime.handle({ kind: "session_started", sessionId: "s", at: 100, reason: "startup" });
    runtime.handle({ kind: "run_started", sessionId: "s", at: 100 });
    runtime.handle({ kind: "assistant_message", sessionId: "s", at: 100, assistant: { stopReason: "stop" } });
    runtime.handle({ kind: "run_settled", sessionId: "s", at: 100, settled: { isIdle: true, aborted: true } });
    await sleep(10);
    assert.equal(runtime.snapshot().lastRun.status, "aborted");
    assert.ok(sent.some((item) => item.type === "run.settled" && item.data.status === "aborted"));
    silenced = true;
    const before = sent.length;
    runtime.handle({ kind: "run_started", sessionId: "s", at: 100 });
    runtime.handle({ kind: "ui_prompt_start", sessionId: "s", at: 100, uiPrompt: { kind: "input", title: "SECRET_TITLE" } });
    await sleep(10);
    assert.equal(sent.length, before);
    assert.equal(runtime.snapshot().state, "blocked");
    silenced = false;
    runtime.updateConfig(); await sleep(10);
    assert.equal(sent.at(-1).type, "state.snapshot");
    assert.doesNotMatch(JSON.stringify(sent), /SECRET_TITLE/);
    config.api = { ...config.api, url: url("/changed") }; runtime.updateConfig(); await sleep(10);
    assert.equal(sent.at(-1).type, "state.snapshot");
    await runtime.shutdown("reload");
    assert.equal(runtime.lifecycle.isStale(), true);
    const closed = sent.length;
    runtime.handle({ kind: "run_settled", sessionId: "s", at: 100, settled: { isIdle: true } });
    await sleep(10); assert.equal(sent.length, closed);
  });
  await step("热切换中止旧请求；最初缺密钥可恢复；quit 强制静默仍零外发", async () => {
    const config = defaultConfig(); config.enabled = false; config.api = configFor();
    const calls = [];
    let silenced = false;
    const service = { submit() {}, async flush() {}, discardPending() {}, async dispose() {} };
    const runtime = createRuntime({ config, service, log, now: () => 100, instanceToken: "hot", isSilenced: () => silenced,
      sender: async (body, _headers, signal) => {
        calls.push({ body: JSON.parse(body), signal });
        if (calls.length === 1) await new Promise(() => {});
      } });
    runtime.handle({ kind: "session_started", sessionId: "s", at: 100 }); await sleep(0);
    config.api = { ...config.api, url: url("/new-target") }; runtime.updateConfig(); await sleep(10);
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(calls.at(-1).body.type, "state.snapshot");
    const before = calls.length; silenced = true; await runtime.shutdown("quit");
    assert.equal(calls.length, before, "最后一个 hook 也必须检查强制静默");

    const signed = defaultConfig(); signed.enabled = false; signed.api = configFor({ secretEnv: "PI_MESSAGE_RECOVER_SECRET" });
    delete process.env.PI_MESSAGE_RECOVER_SECRET;
    const seen = [];
    const recovering = createRuntime({ config: signed, service, log, now: () => 100, instanceToken: "recover", isSilenced: () => false,
      sender: async (body) => { seen.push(JSON.parse(body)); } });
    recovering.handle({ kind: "session_started", sessionId: "s", at: 100 });
    assert.equal(recovering.apiSnapshot().enabled, false);
    process.env.PI_MESSAGE_RECOVER_SECRET = "recover-test-value";
    recovering.updateConfig(); await sleep(10);
    assert.equal(seen.at(-1).type, "state.snapshot");
    assert.equal(recovering.apiSnapshot().enabled, true);
    await recovering.shutdown("reload"); delete process.env.PI_MESSAGE_RECOVER_SECRET;
  });

  await step("quit 收尾共用一次预算，reload 立即丢弃旧在途", async () => {
    const config = defaultConfig(); config.enabled = false; config.api = configFor({ timeoutMs: 5000 }); config.shutdownFlushMs = 80;
    const service = { submit() {}, async flush(ms) { await sleep(ms); }, discardPending() {}, async dispose() {} };
    const make = () => createRuntime({ config, service, log, now: () => 100, instanceToken: "shutdown", isSilenced: () => false,
      sender: () => new Promise(() => {}) });
    const quitting = make(); quitting.handle({ kind: "session_started", sessionId: "s", at: 100 }); await sleep(0);
    const started = performance.now(); await quitting.shutdown("quit");
    assert.ok(performance.now() - started < 140, "两个 flush 不可串行用完两个预算");
    assert.equal(quitting.apiSnapshot().active, 0);
    const reloading = make(); reloading.handle({ kind: "session_started", sessionId: "s", at: 100 }); await sleep(0);
    const switched = performance.now(); await reloading.shutdown("reload");
    assert.ok(performance.now() - switched < 60);
    assert.equal(reloading.snapshot().state, "unknown");
  });
} finally {
  for (const api of publishers) api.dispose();
  globalThis.fetch = realFetch;
  delete process.env.PI_MESSAGE_TEST_SECRET;
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
}
for (const { name, error } of failures) console.error(`\n[FAIL] ${name}\n${error.stack}`);
if (failures.length) process.exitCode = 1;
else console.log("\n通过：消息契约 / API 配置 / 队列 / HTTP / runtime 全部成立。");
