import "./fixtures/isolate-keyring.cjs";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const root = fileURLToPath(new URL("..", import.meta.url));
const mail = async (name) => import(pathToFileURL(path.join(root, "src", name)).href);
const { createQqSmtpSender, QQ_AUTH_ENV } = await mail("mail/smtp.ts");
const { createQqCredentials } = await mail("mail/credentials.ts");
let stored;
const vault = { status: () => ({ available: true }), get: () => stored, set: (value) => { stored = value; }, delete: () => { stored = undefined; } };
const credentials = createQqCredentials(vault, () => process.env[QQ_AUTH_ENV]);
const { createEmailNotifier, MAX_MAIL_CONTENT_BYTES } = await mail("providers/email.ts");
const logLines = [];
const logger = { log: (_level, text, meta) => logLines.push({ text, meta }), record() {} };

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
    credentials, lookup: smtpLookup,
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
  // Exercise the default Nodemailer adapter too, without creating a socket or reading the real vault.
  const nodemailer = require("nodemailer");
  const previousCreateTransport = nodemailer.createTransport;
  let defaultOptions, defaultClosed = 0;
  nodemailer.createTransport = (transportOptions) => {
    defaultOptions = transportOptions;
    return { async sendMail(payload) {
      assert.deepEqual(payload, message);
      return { accepted: [payload.to], rejected: [] };
    }, close() { defaultClosed++; } };
  };
  try {
    const defaultSender = createQqSmtpSender(options, { credentials, lookup: smtpLookup });
    await defaultSender.send(message, new AbortController().signal);
    assert.equal(defaultOptions.auth.user, "sender@qq.com");
    assert.equal(defaultOptions.auth.pass, "test-auth-value");
    assert.equal(defaultOptions.host, "203.0.113.10");
    assert.deepEqual(defaultOptions.tls, { servername: "smtp.qq.com", rejectUnauthorized: true });
    assert.equal(defaultOptions.disableFileAccess, true);
    assert.equal(defaultOptions.disableUrlAccess, true);
    assert.equal(defaultClosed, 1);
    await defaultSender.dispose();
  } finally { nodemailer.createTransport = previousCreateTransport; }

  let createdAfterDnsFailure = false;
  const dnsFailure = createQqSmtpSender(options, {
    credentials,
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
    credentials, timeoutMs: 250,
    lookup: () => new Promise(() => {}),
    transportFactory() { createdAfterDnsFailure = true; throw new Error("must not create transport"); },
  });
  await assert.rejects(dnsTimeout.send(message, new AbortController().signal), /SMTP_DNS_TIMEOUT/);
  assert.equal(createdAfterDnsFailure, false);

  const dnsAbort = new AbortController();
  let lookupStartedAfterAbort = 0;
  const cancelledLookup = createQqSmtpSender(options, {
    credentials, timeoutMs: 10000,
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
  }, { log: logger, sender: fake });
  assert.equal(email.validate({ from: "sender@qq.com", to: ["good@example.org", "bad@example.org"] }), undefined);
  const request = { dedupeKey: "same", title: "title", body: "body", kind: "run_completed", level: "info", channels: ["email"], meta: { sessionId: "s", runId: "r", level: "info" } };
  await assert.rejects(email.send(request, new AbortController().signal), /1 个收件人.*EAUTH/);
  assert.deepEqual(attempts, ["good@example.org", "bad@example.org"]);
  await email.send(request, new AbortController().signal);
  assert.deepEqual(attempts, ["good@example.org", "bad@example.org", "bad@example.org"], "只重试未接受目标");
  assert.ok(logLines.every((entry) => !JSON.stringify(entry).includes("example.org")), "日志不得出现地址");
  assert.ok(logLines.some((entry) => JSON.stringify(entry).includes("EAUTH")), "日志应包含安全的 SMTP 错误代码");
  const beforeOversize = attempts.length;
  for (const finalReply of ["私".repeat(MAX_MAIL_CONTENT_BYTES / 2), "<".repeat(MAX_MAIL_CONTENT_BYTES / 4)]) {
    await assert.rejects(email.send({ ...request, details: { finalReply } }, new AbortController().signal), /超过 1 MiB 内容上限，未发送/);
    assert.equal(attempts.length, beforeOversize, "超限必须在任何收件人投递前明确失败");
  }
  await email.dispose();

  const dnsFailureNotifier = createEmailNotifier("email", {
    transport: { type: "smtp", profile: "qq" }, from: "sender@qq.com", to: ["one@example.org"], subjectPrefix: "[Pi]",
  }, { log: logger, sender: {
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
  }, { log: logger, sender: {
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
    coalesce: { cooldownMs: 0 },
  }, "normal-email-notification-test");
  assert.deepEqual(merged.errors, []);
  const notificationConfig = merged.config;
  const toasts = [];
  const messages = [];
  const registry = createRegistry({ log: logger });
  registry.register("terminal", (id) => createTerminalNotifier(id, {
    log: logger,
    io: {
      environment: () => ({ platform: "win32", env: {}, stdoutIsTTY: true }),
      write() { assert.fail("Windows notification must use the toast path"); },
      async runToast(invocation) { toasts.push(invocation); },
    },
  }));
  registry.register("email", (id, providerOptions) => createEmailNotifier(id, providerOptions, {
    log: logger,
    sender: { validate: () => undefined, async send(message) { messages.push(message); }, async dispose() {} },
  }));
  let now = 1000;
  const lifecycle = createLifecycle({ config: notificationConfig, log: logger, now: () => now, instanceToken: "email-route" });
  const service = createService({ config: notificationConfig, registry, log: logger, now: () => now });
  try {
    lifecycle.onSessionStart({ sessionId: "normal-session", reason: "startup" });
    const finalReply = `\n# PRIVATE FINAL\n\n- 列表\n  - 缩进\n\n\`\`\`js\n\tconst tag = "<img src=x> &";\n\`\`\`\n\n${"长回复段落。\n".repeat(1000)}回复完整结尾\n`;
    const run = (replyCandidate) => {
      lifecycle.onAgentStart({ sessionId: "normal-session" });
      lifecycle.onAssistantMessage({ sessionId: "normal-session", stopReason: "stop", usageCostUsd: 0.0123 });
      lifecycle.observe({ kind: "turn_finished", sessionId: "normal-session", at: now, replyCandidate });
      now += 38000;
      const outcome = lifecycle.onSettled({ sessionId: "normal-session", isIdle: true });
      return evaluateSettlement({ outcome, summary: { projectName: "myflow", contextPercent: 12 } }, notificationConfig);
    };
    const brief = run(finalReply);
    assert.equal(service.submit(brief).accepted, true);
    await service.flush(1000);
    assert.equal(messages[0].text, "");
    assert.doesNotMatch(messages[0].html, /PRIVATE FINAL|上下文/);

    notificationConfig.content.mode = "full";
    const full = run(finalReply);
    assert.deepEqual(full.channels, ["terminal", "email"]);
    assert.equal(service.submit(full).accepted, true);
    await service.flush(1000);
    assert.equal(service.submit(full).reason, "duplicate", "双渠道仍保持同事件去重");
    for (const toast of toasts) {
      assert.equal(Buffer.from(toast.env.PI_NOTIFY_TOAST_TITLE, "base64").toString("utf8"), "myflow：已完成（38秒，$0.0123）");
      assert.equal(Buffer.from(toast.env.PI_NOTIFY_TOAST_BODY, "base64").toString("utf8"), "");
    }
    const fullMail = messages[1];
    assert.equal(fullMail.subject, "[Pi]myflow：已完成（38秒，$0.0123）");
    assert.equal(fullMail.text, `上下文 12%\n\n最终回复\n\n${finalReply}`);
    assert.match(fullMail.html, /white-space:pre-wrap[\s\S]*\n- 列表\n  - 缩进[\s\S]*\n\tconst tag = &quot;&lt;img src=x&gt; &amp;&quot;;[\s\S]*回复完整结尾/);
    assert.doesNotMatch(fullMail.html, /<img/);
    assert.equal(service.submit(run(undefined)).accepted, true);
    await service.flush(1000);
    assert.equal(messages[2].text, "上下文 12%\n\n没有最终回复。");
    const snapshot = service.snapshot();
    assert.equal(snapshot.byProvider.terminal.delivered, 3);
    assert.equal(snapshot.byProvider.email.delivered, 3);
    assert.equal(snapshot.failed, 0);
    assert.equal(snapshot.skipped, 0);
    assert.doesNotMatch(JSON.stringify([snapshot, logLines]), /PRIVATE FINAL|回复完整结尾/);
  } finally { await service.dispose(); }

  const noCred = createQqSmtpSender(options, { credentials: createQqCredentials(vault, () => undefined) });
  assert.match(noCred.validate(), new RegExp(QQ_AUTH_ENV));
  assert.equal(credentials.save("vault-code").ok, true);
  const primary = createQqSmtpSender(options, { credentials, lookup: smtpLookup,
    transportFactory(transportOptions) {
      assert.equal(transportOptions.auth.pass, "test-auth-value", "explicit injection wins over stored code");
      assert.equal(transportOptions.host, "203.0.113.10");
      assert.equal(transportOptions.tls.servername, "smtp.qq.com");
      return { async sendMail(message) { return { accepted: [message.to], rejected: [] }; } };
    },
  });
  await primary.send(message, new AbortController().signal);
  assert.equal(credentials.delete().ok, true);
  assert.match(noCred.validate(), new RegExp(QQ_AUTH_ENV));
} finally {
  delete process.env[QQ_AUTH_ENV];
}
console.log("邮箱 SMTP sender/provider 离线回归通过");
