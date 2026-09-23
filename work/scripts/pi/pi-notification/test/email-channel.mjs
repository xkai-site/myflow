import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

// Provider validation must never read the operator's real Windows credential store.
const require = createRequire(import.meta.url);
const keyringPath = require.resolve("@napi-rs/keyring");
const previousKeyring = require.cache[keyringPath];
require.cache[keyringPath] = { id: keyringPath, filename: keyringPath, loaded: true, exports: {
  Entry: class {
    getPassword() { return null; }
    setPassword() { throw new Error("Unexpected system credential write in test"); }
    deletePassword() { throw new Error("Unexpected system credential deletion in test"); }
  },
} };

const root = fileURLToPath(new URL("..", import.meta.url));
const mail = async (name) => import(pathToFileURL(path.join(root, "src", name)).href);
const { createQqSmtpSender, QQ_AUTH_ENV } = await mail("mail/smtp.ts");
const { resolveQqCredential, saveQqCredential, deleteQqCredential } = await mail("mail/credentials.ts");
let stored;
const vault = { get: () => stored, set: (value) => { stored = value; }, delete: () => { stored = undefined; } };
assert.equal(resolveQqCredential({ [QQ_AUTH_ENV]: "legacy" }, vault).source, "environment");
assert.equal(saveQqCredential("vault-code", vault), true);
assert.deepEqual(resolveQqCredential({ [QQ_AUTH_ENV]: "legacy" }, vault), { source: "vault", value: "vault-code" });
assert.equal(saveQqCredential("bad\ncode", vault), false);
assert.equal(stored, "vault-code");
assert.equal(deleteQqCredential(vault), true);
assert.equal(resolveQqCredential({}, vault).source, "missing");
assert.equal(resolveQqCredential({ [QQ_AUTH_ENV]: "legacy" }, { get() { throw new Error("secret in OS error"); } }).source, "environment");
assert.equal(saveQqCredential("test", { set() { throw new Error("secret in OS error"); }, get() { return undefined; } }), false);
assert.equal(saveQqCredential("test", { set() {}, get() { return "different"; } }), false);
const { createEmailNotifier } = await mail("providers/email.ts");
const logLines = [];
const logger = { log: (_level, text, meta) => logLines.push({ text, meta }), record() {} };

const old = process.env[QQ_AUTH_ENV];
process.env[QQ_AUTH_ENV] = "test-auth-value";
try {
  let received;
  let closed = 0;
  const options = { from: "sender@qq.com", to: ["a@example.org"] };
  const smtpLookup = async (hostname, lookupOptions) => {
    assert.equal(hostname, "smtp.qq.com");
    assert.deepEqual(lookupOptions, { all: true });
    return [{ address: "203.0.113.10", family: 4 }];
  };
  const sender = createQqSmtpSender(options, {
    env: process.env, credentialStore: vault, lookup: smtpLookup,
    transportFactory(value) {
      received = value;
      return { async sendMail(message) { assert.equal(message.to, "a@example.org"); return { accepted: [message.to], rejected: [] }; }, close() { closed += 1; } };
    },
  });
  assert.equal(sender.validate(), undefined);
  const expired = AbortSignal.abort(new DOMException("deadline", "TimeoutError"));
  await assert.rejects(sender.send({ from: "sender@qq.com", to: "a@example.org", subject: "test", text: "plain" }, expired), /SMTP_TIMEOUT/);
  await sender.send({ from: "sender@qq.com", to: "a@example.org", subject: "test", text: "plain" }, new AbortController().signal);
  assert.equal(received.host, "203.0.113.10");
  assert.equal(received.port, 465);
  assert.equal(received.secure, true);
  assert.equal(received.auth.pass, "test-auth-value");
  assert.equal(received.disableFileAccess, true);
  assert.equal(received.disableUrlAccess, true);
  assert.equal(received.logger, false);
  assert.equal(received.connectionTimeout, 15000);
  assert.equal(received.greetingTimeout, 15000);
  assert.equal(received.socketTimeout, 15000);
  assert.deepEqual(received.tls, { servername: "smtp.qq.com", rejectUnauthorized: true });
  assert.equal(closed, 1);

  const message = { from: "sender@qq.com", to: "a@example.org", subject: "test", text: "plain" };
  let createdAfterDnsFailure = false;
  const dnsFailure = createQqSmtpSender(options, {
    env: process.env, credentialStore: vault,
    async lookup() { throw new Error("private DNS diagnostic"); },
    transportFactory() { createdAfterDnsFailure = true; throw new Error("must not create transport"); },
  });
  await assert.rejects(dnsFailure.send(message, new AbortController().signal), (error) => {
    assert.match(error.message, /SMTP_DNS_ERROR/);
    assert.doesNotMatch(error.message, /private DNS diagnostic/);
    return true;
  });
  assert.equal(createdAfterDnsFailure, false);

  const dnsTimeout = createQqSmtpSender(options, {
    env: process.env, credentialStore: vault, timeoutMs: 250,
    lookup: () => new Promise(() => {}),
    transportFactory() { createdAfterDnsFailure = true; throw new Error("must not create transport"); },
  });
  await assert.rejects(dnsTimeout.send(message, new AbortController().signal), /SMTP_DNS_TIMEOUT/);
  assert.equal(createdAfterDnsFailure, false);

  const dnsAbort = new AbortController();
  let lookupStartedAfterAbort = 0;
  const cancelledLookup = createQqSmtpSender(options, {
    env: process.env, credentialStore: vault, timeoutMs: 10000,
    lookup: () => { lookupStartedAfterAbort += 1; return new Promise(() => {}); },
    transportFactory() { createdAfterDnsFailure = true; throw new Error("must not create transport"); },
  });
  const cancelledSend = cancelledLookup.send(message, dnsAbort.signal);
  dnsAbort.abort(new DOMException("deadline", "TimeoutError"));
  await assert.rejects(cancelledSend, /SMTP_TIMEOUT/);
  assert.equal(lookupStartedAfterAbort, 0);
  assert.equal(createdAfterDnsFailure, false);

  let attempts = [];
  const fake = {
    validate: () => undefined,
    async send(message) {
      attempts.push(message.to);
      if (message.to === "bad@example.org" && attempts.filter((address) => address === message.to).length === 1) throw new Error("QQ SMTP 发送失败 (EAUTH)");
    },
    async dispose() {},
  };
  const email = createEmailNotifier("email", {
    transport: { type: "smtp", profile: "qq" },
    from: "sender@qq.com", to: ["good@example.org", "bad@example.org"], subjectPrefix: "[Pi]",
  }, { log: logger, maxChars: 300, sender: fake });
  assert.equal(email.validate({ from: "sender@qq.com", to: ["good@example.org", "bad@example.org"] }), undefined);
  const request = { dedupeKey: "same", title: "title", body: "body", kind: "run_completed", level: "info", channels: ["email"], meta: { sessionId: "s", runId: "r", level: "info" } };
  await assert.rejects(email.send(request, new AbortController().signal), /1 个收件人.*EAUTH/);
  assert.deepEqual(attempts, ["good@example.org", "bad@example.org"]);
  await email.send(request, new AbortController().signal);
  assert.deepEqual(attempts, ["good@example.org", "bad@example.org", "bad@example.org"], "只重试未接受目标");
  assert.ok(logLines.every((entry) => !JSON.stringify(entry).includes("example.org")), "日志不得出现地址");
  assert.ok(logLines.some((entry) => JSON.stringify(entry).includes("EAUTH")), "日志应包含安全的 SMTP 错误代码");
  await email.dispose();

  const dnsFailureNotifier = createEmailNotifier("email", {
    transport: { type: "smtp", profile: "qq" }, from: "sender@qq.com", to: ["one@example.org"], subjectPrefix: "[Pi]",
  }, { log: logger, maxChars: 300, sender: {
    validate: () => undefined,
    async send() { throw new Error("QQ SMTP 发送失败 (SMTP_DNS_ERROR)"); },
    async dispose() {},
  } });
  await assert.rejects(dnsFailureNotifier.send({ ...request, dedupeKey: "dns-failure" }, new AbortController().signal), (error) => {
    assert.match(error.message, /发送未成功或结果未确认/);
    assert.doesNotMatch(error.message, /未被 SMTP 接受/);
    assert.match(error.message, /SMTP_DNS_ERROR/);
    return true;
  });
  await dnsFailureNotifier.dispose();

  const missingCredential = createEmailNotifier("email", {
    transport: { type: "smtp", profile: "qq" }, from: "sender@qq.com", to: ["one@example.org"], subjectPrefix: "[Pi]",
  }, { log: logger, maxChars: 300, sender: {
    validate: () => undefined,
    async send() { throw new Error("SMTP_NOT_CONFIGURED"); },
    async dispose() {},
  } });
  await assert.rejects(missingCredential.send({ ...request, dedupeKey: "missing-credential" }, new AbortController().signal), /SMTP_NOT_CONFIGURED/);
  await missingCredential.dispose();

  // Normal lifecycle -> rules -> service -> both real providers (only their IO is fake).
  // This is deliberately not the dedicated email test path and uses no bypassFilters.
  const { defaultConfig, mergeConfig } = await mail("config.ts");
  const { createLifecycle } = await mail("lifecycle.ts");
  const { evaluateSettlement } = await mail("rules.ts");
  const { createService } = await mail("service.ts");
  const { createRegistry } = await mail("providers/registry.ts");
  const { createTerminalNotifier } = await mail("providers/terminal.ts");
  const merged = mergeConfig(defaultConfig(), {
    providers: [{ id: "email", type: "email", enabled: true, options }],
    rules: { runCompleted: { channels: ["terminal", "email"] } },
  }, "normal-email-notification-test");
  assert.deepEqual(merged.errors, []);
  const notificationConfig = merged.config;
  const toasts = [];
  const messages = [];
  const registry = createRegistry({ log: logger });
  registry.register("terminal", (id) => createTerminalNotifier(id, {
    log: logger, maxChars: notificationConfig.content.maxMessageChars,
    io: {
      environment: () => ({ platform: "win32", env: {}, stdoutIsTTY: true }),
      write() { assert.fail("Windows notification must use the toast path"); },
      async runToast(invocation) { toasts.push(invocation); },
    },
  }));
  registry.register("email", (id, providerOptions) => createEmailNotifier(id, providerOptions, {
    log: logger, maxChars: notificationConfig.content.maxMessageChars,
    sender: { validate: () => undefined, async send(message) { messages.push(message); }, async dispose() {} },
  }));
  let now = 1000;
  const lifecycle = createLifecycle({ config: notificationConfig, log: logger, now: () => now, instanceToken: "email-route" });
  const service = createService({ config: notificationConfig, registry, log: logger, now: () => now });
  try {
    lifecycle.onSessionStart({ sessionId: "normal-session", reason: "startup" });
    lifecycle.onAgentStart({ sessionId: "normal-session" });
    lifecycle.onAssistantMessage({ sessionId: "normal-session", stopReason: "stop", text: "Do not email the full AI response", usageCostUsd: 0.0123 });
    now = 3500;
    const outcome = lifecycle.onSettled({ sessionId: "normal-session", isIdle: true });
    assert.ok(outcome);
    const notification = evaluateSettlement({ outcome, summary: { projectName: "myflow", contextPercent: 12 } }, notificationConfig);
    assert.ok(notification);
    assert.deepEqual(notification.channels, ["terminal", "email"]);
    service.submit(notification);
    await service.flush(1000);
    assert.equal(toasts.length, 1, "正常 AI 完成必须产生本机通知");
    assert.equal(messages.length, 1, "正常 AI 完成必须产生邮件");
    const toastTitle = Buffer.from(toasts[0].env.PI_NOTIFY_TOAST_TITLE, "base64").toString("utf8");
    const toastBody = Buffer.from(toasts[0].env.PI_NOTIFY_TOAST_BODY, "base64").toString("utf8");
    assert.equal(toastTitle, "任务完成 · myflow");
    assert.equal(messages[0].subject, `[Pi]${toastTitle}`);
    assert.equal(messages[0].text, toastBody, "邮件正文与本机通知正文完全一致");
    assert.match(toastBody, /2\.5s.*0\.0123.*12%/);
    assert.doesNotMatch(messages[0].text, /Do not email/);
    const snapshot = service.snapshot();
    assert.equal(snapshot.byProvider.terminal.delivered, 1);
    assert.equal(snapshot.byProvider.email.delivered, 1);
    assert.equal(snapshot.failed, 0);
    assert.equal(snapshot.skipped, 0);
    service.submit(notification);
    await service.flush(1000);
    assert.equal(toasts.length, 1);
    assert.equal(messages.length, 1, "双渠道仍保持同事件去重");
  } finally { await service.dispose(); }

  const noCred = createQqSmtpSender(options, { env: {}, credentialStore: vault });
  assert.match(noCred.validate(), new RegExp(QQ_AUTH_ENV));
  saveQqCredential("vault-code", vault);
  const primary = createQqSmtpSender(options, { env: { [QQ_AUTH_ENV]: "legacy" }, credentialStore: vault, lookup: smtpLookup,
    transportFactory(transportOptions) {
      assert.equal(transportOptions.auth.pass, "vault-code");
      assert.equal(transportOptions.host, "203.0.113.10");
      assert.equal(transportOptions.tls.servername, "smtp.qq.com");
      return { async sendMail(message) { return { accepted: [message.to], rejected: [] }; } };
    },
  });
  await primary.send(message, new AbortController().signal);
  deleteQqCredential(vault);
  assert.match(noCred.validate(), new RegExp(QQ_AUTH_ENV));
} finally {
  if (old === undefined) delete process.env[QQ_AUTH_ENV]; else process.env[QQ_AUTH_ENV] = old;
  if (previousKeyring) require.cache[keyringPath] = previousKeyring; else delete require.cache[keyringPath];
}
console.log("邮箱 SMTP sender/provider 离线回归通过");
