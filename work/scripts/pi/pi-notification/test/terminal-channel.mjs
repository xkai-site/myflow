/**
 * Terminal channel regression: mechanism selection, rendered bytes, injection surface and
 * stdout discipline.
 *
 * Needs no SDK: selection and rendering in `terminal.ts` are pure functions with injectable IO,
 * so the whole security surface is verified quickly and deterministically anywhere.
 * Whether a notification is actually displayed depends on the terminal emulator and can only be
 * confirmed by hand.
 *
 *   MSYS_NO_PATHCONV=1 node test/terminal-channel.mjs
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url));
const terminal = await import(pathToFileURL(path.join(PLUGIN_DIR, "src", "providers", "terminal.ts")).href);

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

const env = (overrides = {}) => ({
  platform: "linux",
  env: {},
  stdoutIsTTY: true,
  ...overrides,
});

/** Hostile or malformed payloads: none may add ESC/BEL to the rendered output or reach the toast script or argv. */
const HOSTILE = [
  "\u001b]777;notify;hack\u0007",
  "a\u0007b",
  "x\u001b\\y",
  "line1\nline2",
  "\u009bz",
  "</text><script>alert(1)</script>",
  '"; Remove-Item -Recurse C:\\ ; "',
  "$(whoami)",
  "`id`",
  "%TEMP%",
];

function withIo({ writes = [], toasts = [], ...overrides }) {
  const records = [];
  const io = {
    environment: () => env(),
    write: (text) => writes.push(text),
    runToast: async (invocation) => {
      toasts.push(invocation);
    },
    ...overrides,
  };
  const log = { log: () => {}, record: (entry) => records.push(entry) };
  return { io, log, writes, toasts, records };
}

console.log("S3 终端渠道回归：pi-notification");

await step("机制选择表：kitty→OSC99 / win32→toast / 其它 TTY→OSC777 / 非 TTY→none", () => {
  const pick = (o) => terminal.selectTerminalChannel(env(o)).channel;
  assert.equal(pick(), "osc777");
  assert.equal(pick({ env: { TERM_PROGRAM: "WezTerm" } }), "osc777");
  assert.equal(pick({ env: { KITTY_WINDOW_ID: "1" } }), "osc99");
  assert.equal(pick({ env: { TERM_PROGRAM: "kitty" } }), "osc99");
  assert.equal(pick({ platform: "win32" }), "toast");
  assert.equal(pick({ platform: "win32", env: { WT_SESSION: "abc" } }), "toast");
  // Kitty outranks win32: it renders OSC 99, which stays inside the terminal.
  assert.equal(pick({ platform: "win32", env: { KITTY_WINDOW_ID: "1" } }), "osc99");
  // Hard rule: without a TTY (`pi -p`, `--mode json`, redirected output) not a single byte is written.
  assert.equal(pick({ stdoutIsTTY: false }), "none");
  assert.equal(pick({ platform: "win32", stdoutIsTTY: false }), "none");
  assert.equal(pick({ env: { WT_SESSION: "abc" }, stdoutIsTTY: false }), "none");
  const skipped = terminal.selectTerminalChannel(env({ stdoutIsTTY: false }));
  assert.match(skipped.reason, /TTY/);
});

await step("PI_NOTIFY_CHANNEL 覆盖：off 全局静默、显式机制优先，但 TTY 纪律优先于一切", () => {
  const pick = (o) => terminal.selectTerminalChannel(env(o)).channel;
  assert.equal(pick({ env: { PI_NOTIFY_CHANNEL: "off" } }), "none");
  assert.equal(pick({ env: { PI_NOTIFY_CHANNEL: "off" }, platform: "win32" }), "none");
  assert.equal(pick({ env: { PI_NOTIFY_CHANNEL: "OSC99" } }), "osc99");
  assert.equal(pick({ platform: "win32", env: { PI_NOTIFY_CHANNEL: "osc777" } }), "osc777");
  assert.equal(pick({ env: { PI_NOTIFY_CHANNEL: "toast" } }), "toast");
  // Mechanisms that write to stdout are gated on a TTY, otherwise the caller's data is corrupted.
  assert.equal(pick({ env: { PI_NOTIFY_CHANNEL: "osc777" }, stdoutIsTTY: false }), "none");
  assert.equal(pick({ env: { PI_NOTIFY_CHANNEL: "osc99" }, stdoutIsTTY: false }), "none");
  // A toast never touches stdout, so an explicit request skips the TTY gate (`auto` still needs it).
  assert.equal(pick({ env: { PI_NOTIFY_CHANNEL: "toast" }, platform: "win32", stdoutIsTTY: false }), "toast");
  assert.equal(pick({ platform: "win32", stdoutIsTTY: false }), "none");
});

await step("OSC 777 渲染：字节精确、换行归一、空 body 不留分隔符", () => {
  assert.equal(terminal.renderOsc777("任务完成", "用时 21ms"), "\u001b]777;notify;任务完成;用时 21ms\u0007");
  assert.equal(terminal.renderOsc777("任务完成", ""), "\u001b]777;notify;任务完成\u0007");
  assert.equal(terminal.renderOsc777("a\nb", "c\r\nd"), "\u001b]777;notify;a b;c d\u0007");
});

await step("OSC 99 渲染：两段同 id、末段 d=1、ST 结尾", () => {
  const text = terminal.renderOsc99("7", "标题", "正文");
  assert.ok(text.startsWith("\u001b]99;i=7:d=0:p=title;标题\u001b\\"));
  assert.ok(text.endsWith("\u001b]99;i=7:d=1:p=body;正文\u001b\\"));
  assert.equal((text.match(/\u001b\\/g) ?? []).length, 2, "两段都必须以 ST 结束");
});

await step("注入面：载荷不能让通知提前终止或夹带新序列", () => {
  for (const hostile of HOSTILE) {
    const osc777 = terminal.renderOsc777(hostile, hostile);
    assert.equal((osc777.match(/\u001b/g) ?? []).length, 1, `OSC777 出现额外 ESC: ${JSON.stringify(hostile)}`);
    assert.equal((osc777.match(/\u0007/g) ?? []).length, 1, `OSC777 出现额外 BEL: ${JSON.stringify(hostile)}`);
    assert.ok(osc777.startsWith("\u001b]777;notify;"));
    assert.ok(osc777.endsWith("\u0007"));

    const osc99 = terminal.renderOsc99("1", hostile, hostile);
    assert.equal((osc99.match(/\u001b/g) ?? []).length, 4, `OSC99 出现额外 ESC: ${JSON.stringify(hostile)}`);

    for (const text of [osc777, osc99]) {
      // Apart from our own introducers, no C0/C1 control character may appear.
      const body = text.replace(/[\u001b\u0007]/g, "").replace(/\\/g, "");
      assert.doesNotMatch(body, /[\u0000-\u001f\u007f-\u009f]/, `残留控制字符: ${JSON.stringify(hostile)}`);
    }
  }
  // The OSC payload is removed as a whole, so it cannot become visible text used to forge a notification.
  assert.ok(!terminal.renderOsc777("\u001b]777;notify;hack\u0007", "").includes("hack"));
});

await step("Windows toast：脚本静态零插值，载荷只走环境变量 base64", () => {
  const invocation = terminal.buildToastInvocation("标题", "正文");
  assert.equal(invocation.command, "powershell.exe");
  assert.ok(invocation.args.includes("-NonInteractive"));
  const argv = invocation.args.join(" ");
  assert.equal(
    Buffer.from(invocation.env.PI_NOTIFY_TOAST_TITLE, "base64").toString("utf8"),
    "标题",
  );
  assert.equal(
    Buffer.from(invocation.env.PI_NOTIFY_TOAST_BODY, "base64").toString("utf8"),
    "正文",
  );
  assert.ok(!/\$\(|`|Invoke-Expression/.test(terminal.TOAST_SCRIPT), "脚本不得包含可执行插值");
  assert.ok(terminal.TOAST_SCRIPT.includes("CreateTextNode"), "toast 文本必须走 DOM 文本节点，而不是拼 XML");

  for (const hostile of HOSTILE) {
    const built = terminal.buildToastInvocation(hostile, hostile);
    assert.ok(!terminal.TOAST_SCRIPT.includes(hostile), "脚本里出现了用户数据（插值注入面）");
    assert.ok(!built.args.join(" ").includes(hostile), "argv 里出现了用户数据");
    const decoded = Buffer.from(built.env.PI_NOTIFY_TOAST_BODY, "base64").toString("utf8");
    assert.doesNotMatch(decoded, /[\u0000-\u001f\u007f-\u009f]/, "环境变量里残留控制字符");
  }
});

await step("未认证/不可用：非 TTY 下 send() 跳过而非失败，且一个字节都不写", async () => {
  const { io, log, writes, records } = withIo({ environment: () => env({ stdoutIsTTY: false }) });
  const notifier = terminal.createTerminalNotifier("terminal", { log, maxChars: 300, io });
  assert.match(notifier.validate(), /TTY/);
  await notifier.send(request("run_completed"), new AbortController().signal);
  assert.deepEqual(writes, []);
  assert.equal(records.filter((entry) => entry.event === "channel_skipped").length, 1);
});

await step("TTY 下真的写出 OSC；win32 下走 toast；toast 失败会冒泡为投递失败", async () => {
  const linux = withIo({});
  await terminal
    .createTerminalNotifier("terminal", { log: linux.log, maxChars: 300, io: linux.io })
    .send(request("run_completed"), new AbortController().signal);
  assert.equal(linux.writes.length, 1);
  assert.ok(linux.writes[0].startsWith("\u001b]777;notify;"));
  assert.ok(linux.writes[0].includes("任务完成"));

  const windows = withIo({ environment: () => env({ platform: "win32" }) });
  await terminal
    .createTerminalNotifier("terminal", { log: windows.log, maxChars: 300, io: windows.io })
    .send(request("run_failed"), new AbortController().signal);
  assert.equal(windows.toasts.length, 1);
  assert.deepEqual(windows.writes, [], "win32 不应写 OSC");

  const failing = withIo({
    environment: () => env({ platform: "win32" }),
    runToast: async () => {
      throw new Error("Windows toast 失败: powershell.exe not found");
    },
  });
  await assert.rejects(
    terminal
      .createTerminalNotifier("terminal", { log: failing.log, maxChars: 300, io: failing.io })
      .send(request("run_completed"), new AbortController().signal),
    /toast/,
  );
});

await step("取消信号：已 abort 时不得写出任何字节", async () => {
  const { io, log, writes } = withIo({});
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    terminal.createTerminalNotifier("terminal", { log, maxChars: 300, io }).send(request("run_completed"), controller.signal),
    /取消/,
  );
  assert.deepEqual(writes, []);
});

await step("长文案截断：以 maxMessageChars 为界，且不切断代理对", async () => {
  const { io, log, writes } = withIo({});
  const long = "😀".repeat(400);
  await terminal
    .createTerminalNotifier("terminal", { log, maxChars: 50, io })
    .send({ ...request("run_completed"), body: long }, new AbortController().signal);
  const body = writes[0];
  assert.ok(body.includes("…"));
  assert.ok([...body].length < 120, `未截断: ${[...body].length}`);
  // `for...of` iterates code points, which is what detecting a lone surrogate needs; a regex
  // character class matches per UTF-16 unit and gets it wrong.
  for (const ch of body) {
    const code = ch.codePointAt(0) ?? 0;
    assert.ok(code < 0xd800 || code > 0xdfff, `孤立代理对: 0x${code.toString(16)}`);
  }
});

function request(kind) {
  return {
    level: "info",
    kind,
    title: "任务完成",
    body: "用时 21ms",
    dedupeKey: `s:1:${kind}`,
    channels: ["terminal"],
    meta: { sessionId: "s", runId: "1", level: "info" },
  };
}

for (const item of failures) {
  console.error(`\n[FAIL] ${item.name}\n${item.error?.stack ?? item.error}`);
}

if (failures.length === 0) {
  console.log("\n通过：终端渠道选择 / 渲染 / 注入面 / TTY 纪律 全部断言成立。");
  process.exit(0);
} else {
  console.error(`\n失败：${failures.length} 项断言未通过。`);
  process.exit(1);
}
