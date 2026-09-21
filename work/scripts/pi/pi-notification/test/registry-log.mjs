/**
 * Channel registry degradation and logging/redaction regression.
 *
 * The registry is the only dispatch point, so its rule "an unusable channel becomes a Noop with a
 * reason, never an exception" is asserted for all four paths. The logging helpers are asserted here
 * because they are the last gate before text leaves the plugin (or reaches the diagnostic sink).
 *
 * The channels themselves are covered by test/terminal-channel.mjs and test/webhook-channel.mjs; the
 * end-to-end effect of a degraded channel under a real host by test/host-lifecycle.mjs (H, I8).
 *
 *   MSYS_NO_PATHCONV=1 node test/registry-log.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url));
const { createRegistry } = await import(pathToFileURL(path.join(PLUGIN_DIR, "src", "providers", "registry.ts")).href);
const { createNoopNotifier } = await import(pathToFileURL(path.join(PLUGIN_DIR, "src", "providers", "noop.ts")).href);
const { createDebugNotifier } = await import(pathToFileURL(path.join(PLUGIN_DIR, "src", "providers", "debug.ts")).href);
const { createLogger, createSilentLogger, redact, sanitize, sanitizeError } = await import(
  pathToFileURL(path.join(PLUGIN_DIR, "src", "log.ts")).href
);

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-notify-registry-"));
const makeLog = () => {
  const logs = [];
  const records = [];
  return {
    logs,
    records,
    log: {
      log: (level, message, meta) => logs.push({ level, message, meta }),
      record: (entry) => records.push(entry),
    },
  };
};
const request = (overrides = {}) => ({
  level: "info",
  kind: "run_completed",
  title: "t",
  body: "b",
  dedupeKey: "k",
  channels: ["c"],
  meta: { sessionId: "s", runId: "r", level: "info" },
  ...overrides,
});

console.log("渠道注册降级与日志/脱敏专项回归：pi-notification");

await step("L1 注册表是唯一分派点：正常渠道透传，四条不可用路径都降级为 Noop 并留痕", () => {
  const harness = makeLog();
  const registry = createRegistry({ log: harness.log });
  let disposed = 0;
  registry.register("good", (id) => ({
    id,
    type: "good",
    validate: () => undefined,
    format: () => ({ ok: true }),
    send: async () => {},
    dispose: async () => {
      disposed += 1;
    },
  }));
  registry.register("withProblem", (id) => ({ id, type: "withProblem", validate: () => "缺少 url", send: async () => {}, dispose: async () => {} }));
  registry.register("boom", () => {
    throw new Error("factory boom");
  });
  registry.register("badValidate", (id) => ({
    id,
    type: "badValidate",
    validate: () => {
      throw new Error("validate boom");
    },
    send: async () => {},
    dispose: async () => {},
  }));

  const good = registry.create("g", "good", {});
  assert.equal(good.id, "g");
  assert.equal(good.type, "good");
  assert.equal(good.validate({}), undefined, "validate 必须透传");
  assert.deepEqual(good.format(request()), { ok: true }, "渠道特定 format 必须在包装后仍然可用");
  void good.dispose().then(() => assert.equal(disposed, 1));

  const degraded = [
    ["unregistered", registry.create("u", "unregistered", {}), "未注册的渠道类型"],
    ["withProblem", registry.create("p", "withProblem", {}), "缺少 url"],
    ["boom", registry.create("b", "boom", {}), "渠道工厂抛错"],
    ["badValidate", registry.create("v", "badValidate", {}), "validate() 抛错"],
  ];
  for (const [type, notifier, expected] of degraded) {
    assert.equal(notifier.type, type, "降级后应保留原 type，便于排障");
    assert.ok(
      String(notifier.validate({})).includes(expected),
      `${type} 的降级原因不对: ${String(notifier.validate({}))}`,
    );
  }
  assert.deepEqual(
    harness.records.map((entry) => entry.event),
    ["channel_degraded", "channel_degraded", "channel_degraded", "channel_degraded"],
  );
  assert.equal(
    harness.records.filter((entry) => entry.reason.includes("未注册的渠道类型")).length,
    1,
    "降级必须带上可查的原因",
  );
  assert.equal(harness.logs.filter((entry) => entry.level === "warning").length, 4, "每次降级都要有警告");
});

await step("L2 Noop 渠道：validate 回显原因、send 无副作用、dispose 可重复", async () => {
  const noop = createNoopNotifier("n", "noop", "原因X");
  assert.equal(noop.id, "n");
  assert.equal(noop.type, "noop");
  assert.equal(noop.validate({}), "原因X");
  assert.equal(await noop.send(request(), new AbortController().signal), undefined);
  assert.equal(await noop.dispose(), undefined);
  assert.equal(await noop.dispose(), undefined, "dispose 必须可重复");
  assert.equal(noop.format, undefined, "Noop 不提供渠道特定格式");

  const anonymous = createNoopNotifier("n", "noop");
  assert.equal(anonymous.validate({}), undefined, "没有原因时 validate 视为可用（它本来就不做任何事）");
});

await step("L3 Debug 渠道：按 maxChars 截断、换行归一、已取消的投递要抛错", async () => {
  const harness = makeLog();
  const notifier = createDebugNotifier("d", { log: harness.log, maxChars: 5 });
  await notifier.send(request({ title: "1234567890", body: "a\nb" }), new AbortController().signal);
  assert.equal(harness.logs.length, 1);
  assert.deepEqual(harness.logs[0].meta, { kind: "run_completed", dedupeKey: "k" }, "结构化元数据只带 kind 与去重键");
  assert.match(harness.logs[0].message, /\[run_completed\] 1234… — a b/, "标题截断、正文换行归一为空格");

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    () => notifier.send(request(), cancelled.signal),
    /投递已取消/,
    "已取消的投递必须失败，而不是静默当作成功",
  );
});

await step("L4 redact：按 token 家族遮蔽，并去掉家目录前缀", () => {
  assert.equal(redact("token ghp_abcdefghijklmnopqrst"), "token gh*_***");
  assert.equal(redact("xoxb-1234567890abcdef"), "xox*-***");
  assert.equal(
    redact("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ"),
    "***jwt***",
    "JWT 必须整段遮蔽",
  );
  assert.equal(redact("A".repeat(45)), "***", "超长无分隔串视作不透明凭据");
  assert.equal(redact("short"), "short", "普通短文不应被遮蔽");
  assert.equal(redact("apiKey=secret123"), "apiKey=***");
  assert.equal(redact("X-Api-Key: abcdef123"), "X-Api-Key: ***");
  assert.equal(redact("Bearer supersecret"), "Bearer ***");
  assert.equal(redact("Authorization: Bearer supersecret"), "Authorization: ***", "方案名与凭据一起遮蔽");

  assert.equal(redact(`${os.homedir()}/.pi/agent/auth.json`), "~/.pi/agent/auth.json");
  assert.equal(redact(`${os.homedir().replace(/\\/g, "/")}/.pi/x`), "~/.pi/x", "两种路径分隔符都要处理");
});

await step("L4b 带认证方案的 Authorization 头与 Cookie 头必须整段遮蔽", () => {
  // The key/value rule alone masks only the first token after the separator, so without a dedicated
  // rule the credential after an auth scheme would survive as clear text.
  assert.equal(redact("Authorization: Basic dXNlcjpwYXNz"), "Authorization: ***");
  assert.equal(redact("authorization=Basic dXNlcjpwYXNz"), "authorization=***");
  assert.equal(redact("Proxy-Authorization: Bearer abcdef123456"), "Proxy-Authorization: ***");
  assert.equal(redact("Cookie: session=abcdef123"), "Cookie: ***");
  assert.equal(redact("Set-Cookie: session=abcdef123; HttpOnly"), "Set-Cookie: ***", "Cookie 是按行生效的");

  // Ordinary prose that merely contains the header names must stay readable.
  assert.equal(redact("authorization failed"), "authorization failed");
  assert.equal(redact("cookie monster"), "cookie monster");
});

await step("L5 sanitize：非字符串、不可见字符与按码位截断", () => {
  assert.equal(sanitize(42), "42");
  assert.equal(sanitize(null), "");
  assert.equal(sanitize(undefined), "");
  assert.equal(sanitize({ a: 1 }), "[object Object]");
  assert.equal(sanitize("a\tb"), "a b", "制表符归一为空格");
  assert.equal(sanitize("a\u0085b"), "ab", "C1 控制字符被删除");
  assert.equal(sanitize("a\u2028b"), "a\nb", "行分隔符归一为换行");
  assert.equal(sanitize("a\ufeffb"), "ab", "零宽 BOM 被删除");
  assert.equal(sanitize("a\rb"), "a\nb", "孤立回车归一为换行");
  assert.equal(sanitize("a  \n\n  b"), "a\nb", "连续空白与多余换行被压缩");

  assert.equal(sanitize("abcdef", 4), "abc…", "截断时补省略号");
  assert.equal(sanitize("abcdef", 100), "abcdef", "未超过上限时原样返回");
  assert.equal(sanitize("😀😀😀", 2), "😀…", "按码位截断，不切断代理对");
  // maxChars<=0 counts as unspecified and falls back to the default limit; with limit=1 the ellipsis
  // adds one more code point on top of the limit.
  assert.equal(sanitize("abcdef", 0), "abcdef");
  assert.equal(sanitize("abcdef", 1), "a…");
});

await step("L6 sanitizeError：先脱敏后清洗，并受长度上限约束", () => {
  assert.equal(sanitizeError("apiKey=secret123\nBearer abcdefgh", 200), "apiKey=***\nBearer ***");
  assert.equal(sanitizeError("\u001b]777;notify;evil\u0007done"), "done", "清洗仍然生效");
  const long = sanitizeError("ab ".repeat(40), 20);
  assert.ok([...long].length <= 20, `截断后不得超过上限: ${[...long].length}`);
  assert.ok(long.endsWith("…"));
});

await step("L7 createLogger：sink 只在设了 PI_NOTIFY_LOG_FILE 时开启，失败不冒泡", async () => {
  const sinkFile = path.join(TMP, "plugin.jsonl");
  const previous = { file: process.env.PI_NOTIFY_LOG_FILE, debug: process.env.PI_NOTIFY_DEBUG };
  const stderrWrites = [];
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    stderrWrites.push(String(chunk));
    return true;
  };
  try {
    delete process.env.PI_NOTIFY_LOG_FILE;
    delete process.env.PI_NOTIFY_DEBUG;
    const quiet = createLogger();
    quiet.log("info", "no sink configured");
    quiet.record({ event: "probe" });
    assert.equal(fs.existsSync(sinkFile), false, "未配置 sink 时不得创建文件");
    assert.deepEqual(stderrWrites, [], "未开 PI_NOTIFY_DEBUG 时不得写 stderr");

    process.env.PI_NOTIFY_LOG_FILE = sinkFile;
    process.env.PI_NOTIFY_DEBUG = "1";
    const sink = createLogger();
    sink.log("warning", "hello\u001b[31m world");
    sink.record({ event: "probe", value: 1 });
    const lines = fs.readFileSync(sinkFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].event, "log");
    assert.equal(lines[0].level, "warning");
    assert.equal(lines[0].message, "hello world", "写入前必须清洗控制字符");
    assert.equal(lines[1].event, "probe");
    assert.equal(typeof lines[0].t, "number");
    assert.equal(typeof lines[0].pid, "number", "每条记录都带时间与进程号，便于按进程归组");
    assert.equal(stderrWrites.length, 1, "开了 PI_NOTIFY_DEBUG 后人类可读日志走 stderr");
    assert.match(stderrWrites[0], /^\[pi-notify] warning hello world\n$/);

    // Sink failures must never bubble into a hook, and the sink must stop retrying afterwards.
    process.env.PI_NOTIFY_LOG_FILE = TMP;
    const broken = createLogger();
    broken.record({ event: "first" });
    broken.record({ event: "second" });
    assert.deepEqual(stderrWrites.length, 1, "sink 失败不产生额外输出");
  } finally {
    process.stderr.write = realStderrWrite;
    if (previous.file === undefined) delete process.env.PI_NOTIFY_LOG_FILE;
    else process.env.PI_NOTIFY_LOG_FILE = previous.file;
    if (previous.debug === undefined) delete process.env.PI_NOTIFY_DEBUG;
    else process.env.PI_NOTIFY_DEBUG = previous.debug;
  }

  const silent = createSilentLogger();
  assert.equal(silent.log("info", "ignored"), undefined);
  assert.equal(silent.record({ event: "ignored" }), undefined);
});

fs.rmSync(TMP, { recursive: true, force: true });

for (const item of failures) {
  console.error(`\n[FAIL] ${item.name}\n${item.error?.stack ?? item.error}`);
}

if (failures.length === 0) {
  console.log("\n通过：渠道降级 / Noop 与 Debug / 脱敏与清洗 / 日志 sink 纪律 全部断言成立。");
  process.exit(0);
} else {
  console.error(`\n失败：${failures.length} 项断言未通过。`);
  process.exit(1);
}
