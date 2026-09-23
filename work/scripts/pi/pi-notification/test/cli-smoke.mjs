/**
 * Real-CLI smoke test: `pi -e` loads the extension and exits without errors.
 *
 * Two cheapest possible paths are run with the **real `pi` executable**, fully offline and with no
 * LLM call:
 *
 *   G bare `/probe-cmd`: proves that a pure command enters no agent lifecycle under the real CLI,
 *     so a configured notification plugin delivers nothing for such a task.
 *   H fake provider plus a real prompt: proves the judgement chain works end to end under the real
 *     CLI and that the quit path really flushes (short-timeout flush in `session_shutdown`).
 *
 * Two hard assertions related to the plugin:
 *   - With stdout piped not a single escape byte may be written: under `pi -p` that stream is the
 *     caller's data, not a display.
 *   - Outside a TTY the local channel degrades to noop but must leave a `channel_degraded`
 *     record stating why.
 * For the same reason this script never raises a real system notification.
 *
 * Git Bash requires `MSYS_NO_PATHCONV=1` on every child process, otherwise `/probe-cmd` is
 * rewritten into a Windows path and silently degrades into an ordinary prompt.
 *
 * Skip with `PI_SKIP_CLI=1`. Choose the executable with `PI_BIN=/path/to/pi`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePiLaunch } from "./sdk-path.mjs";

const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_ENTRY = path.join(PLUGIN_DIR, "extensions", "index.ts");
const PROBE_ENTRY = path.join(PLUGIN_DIR, "test", "fixtures", "probe-ext.ts");

if (process.env.PI_SKIP_CLI === "1") {
  console.log("已按 PI_SKIP_CLI=1 跳过真实 CLI 冒烟。");
  process.exit(0);
}

const piLaunch = resolvePiLaunch();
if (!piLaunch) {
  console.error(
    "找不到 `pi` 可执行文件。请把它装进 PATH，或用 PI_BIN 指定路径，"
    + "或设置 PI_SKIP_CLI=1 只跑 SDK 回归。",
  );
  process.exit(1);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-notify-cli-"));
const AGENT_DIR = path.join(TMP, "agent");
fs.mkdirSync(AGENT_DIR, { recursive: true });
fs.writeFileSync(path.join(AGENT_DIR, "settings.json"), "{}\n");
fs.writeFileSync(path.join(AGENT_DIR, "models.json"), JSON.stringify({ providers: {} }));

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

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  if (text.trim() === "") return [];
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/** Runs the real CLI once; returns stdout/stderr/exit code plus both JSONL logs. */
function runPi({ label, args, userConfig, preserveConfig = false }) {
  const configDir = path.join(AGENT_DIR, "pi-notification");
  const configFile = path.join(configDir, "config.json");
  if (preserveConfig) {
    // Cross-process persistence: keep the file the previous process actually wrote.
  } else if (userConfig === undefined) {
    fs.rmSync(configDir, { recursive: true, force: true });
  } else {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(userConfig, null, 2));
  }
  const probeLog = path.join(TMP, `${label}-probe.jsonl`);
  const pluginLog = path.join(TMP, `${label}-plugin.jsonl`);
  fs.writeFileSync(probeLog, "");
  fs.writeFileSync(pluginLog, "");
  const env = {
    ...process.env,
    // Git Bash requirement: stop MSYS from rewriting `/cmd` as a Windows path.
    MSYS_NO_PATHCONV: "1",
    PI_CODING_AGENT_DIR: AGENT_DIR,
    PI_CODING_AGENT_SESSION_DIR: path.join(TMP, "sessions"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PROBE_LOG: probeLog,
    PI_NOTIFY_LOG_FILE: pluginLog,
  };
  const result = spawnSync(piLaunch.command, [...piLaunch.args, ...args], {
    cwd: TMP, // 刻意不用仓库目录：避免加载项目级 .pi 资源与 trust 交互
    env,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
    shell: piLaunch.shell,
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    probe: readJsonl(probeLog),
    plugin: readJsonl(pluginLog),
  };
}

const EXTENSIONS = ["-e", PROBE_ENTRY, "-e", PLUGIN_ENTRY];

/**
 * When the provider fails, print mode exits 1 by itself and writes the error to stderr. That is
 * not a plugin problem, so the assertions are kept separate: exit code 1 is allowed, but the
 * plugin must not log an error or crash.
 */
function assertFailedRunExit(label, run) {
  assert.equal(run.error, undefined, `${label}: 启动失败 ${run.error?.message ?? ""}`);
  assert.equal(run.status, 1, `${label}: provider 失败时 print 模式应以 1 退出，实际 ${run.status}`);
  assert.doesNotMatch(run.stderr, /(TypeError|RangeError|AssertionError|Unhandled)/, `${label}: stderr 出现崩溃
${run.stderr}`);
  // A broken config **should** be logged as an error; what must not appear is a plugin fault
  // such as a failed delivery.
  const pluginErrors = run.plugin.filter((row) => row.event === "log" && row.level === "error");
  assert.ok(pluginErrors.length >= 1, `${label}: 降级必须留下可查的错误记录`);
  const deliveryErrors = pluginErrors.filter((row) => /投递/.test(String(row.message)));
  assert.deepEqual(deliveryErrors, [], `${label}: 投递失败被记为插件错误`);
}

function assertCleanExit(label, run) {
  assert.equal(run.error, undefined, `${label}: 启动失败 ${run.error?.message ?? ""}`);
  assert.equal(run.status, 0, `${label}: exit=${run.status} signal=${run.signal}\n${run.stderr}`);
  assert.doesNotMatch(
    run.stderr,
    /(^|\n)\s*(Error|TypeError|RangeError|AssertionError)\b/,
    `${label}: stderr 出现错误\n${run.stderr}`,
  );
  const pluginErrors = run.plugin.filter((row) => row.event === "log" && row.level === "error");
  assert.deepEqual(pluginErrors, [], `${label}: 插件自身记录了错误`);
}

console.log(`S1.5 真实 CLI 冒烟（pi = ${piLaunch.piBin}，launcher = ${piLaunch.launcher}）`);

await step("G 纯 /probe-cmd：可加载、零 agent 生命周期、零投递", async () => {
  const run = runPi({
    label: "pure-command",
    args: ["--no-session", "--approve", ...EXTENSIONS, "-p", "/probe-cmd"],
  });
  assertCleanExit("G", run);

  const probeEvents = run.probe.map((row) => row.ev);
  assert.ok(probeEvents.includes("CMD_HANDLER_ENTER"), `G: 命令未派发（MSYS 路径改写？）[${probeEvents}]`);
  for (const forbidden of ["agent_start", "agent_end", "assistant_stop", "settled_enter"]) {
    assert.ok(!probeEvents.includes(forbidden), `G: 纯命令却出现了 ${forbidden}`);
  }

  const pluginEvents = run.plugin.map((row) => row.event);
  assert.ok(pluginEvents.includes("plugin_session_start"), "G: 插件未被加载");
  assert.ok(
    run.plugin.some((row) => row.event === "plugin_shutdown" && row.reason === "quit"),
    "G: 未走 quit 收尾",
  );
  assert.equal(run.plugin.filter((row) => row.event === "delivery").length, 0, "G: 纯命令不应投递");
  // Hard rule: with stdout piped, no OSC or escape sequence may be written into it.
  assert.ok(!run.stdout.includes("\u001b"), "G: stdout 被转义序列污染");
  assert.ok(!run.stdout.includes("]777"), "G: stdout 出现了 OSC 777");
});

await step("H 假 provider + 真实 prompt：投递 1 条 run_completed", async () => {
  const run = runPi({
    label: "full-run",
    args: [
      "--no-session", "--approve", "--no-tools",
      "--model", "probe-fake/fake-model",
      ...EXTENSIONS,
      "-p", "只回复 OK",
    ],
  });
  assertCleanExit("H", run);
  assert.match(run.stdout, /OK/, `H: stdout 未出现模型输出\n${run.stdout}`);

  const probeEvents = run.probe.map((row) => row.ev);
  assert.ok(probeEvents.includes("settled_enter"), `H: 未出现 agent_settled [${probeEvents}]`);

  const sent = run.plugin.filter((row) => row.event === "delivery");
  assert.equal(sent.length, 1, `H: 期望 1 条投递，实际 ${sent.length} 条`);
  assert.equal(sent[0].kind, "run_completed");
  assert.equal(sent[0].ok, false, "noop 不得伪装为已送达成功");
  assert.equal(sent[0].skipped, true, "非 TTY 本地渠道应统计为跳过");
  assert.equal(sent[0].level, "info");

  // stdout belongs to the caller (here a pipe), so no terminal control sequence may enter it.
  assert.ok(!run.stdout.includes("\u001b"), "H: stdout 被转义序列污染");
  assert.ok(!run.stdout.includes("]777"), "H: stdout 出现了 OSC 777");
  assert.ok(run.stdout.includes("OK"), "H: stdout 应保持干净的模型输出");

  // The local channel must degrade to noop and say why in the log, without reporting an error.
  const degraded = run.plugin.filter((row) => row.event === "channel_degraded");
  assert.equal(degraded.length, 1, "H: 非 TTY 下应记录一次渠道降级");
  assert.match(degraded[0].reason, /TTY/);
});

await step("I /notify（单一入口）：真实 CLI 下可派发、退出干净、stdout 未被污染", async () => {
  const run = runPi({
    label: "notify-settings",
    args: ["--no-session", "--approve", ...EXTENSIONS, "-p", "/notify"],
  });
  assertCleanExit("I", run);

  const viewRecords = run.plugin.filter((row) => row.event === "notify_settings_view");
  assert.equal(viewRecords.length, 1, `I: /notify 未执行 [${run.plugin.map((r) => r.event)}]`);
  assert.equal(viewRecords[0].mode, "print", "I: 非 TUI 应记录模式而不是打开组件");
  // Status and config paths go to stderr; stdout stays with the caller.
  assert.match(run.stderr, /投递统计/);
  assert.match(run.stderr, /配置来源/);
  assert.match(run.stderr, /用户默认: /);
  assert.match(run.stderr, /设置界面仅 TUI 可用/);

  // A pure command enters no agent lifecycle: same invariant as G, for the plugin's own command.
  const probeEvents = run.probe.map((row) => row.ev);
  assert.ok(probeEvents.includes("session_start"), "I: 探针未加载");
  for (const forbidden of ["agent_start", "settled_enter"]) {
    assert.ok(!probeEvents.includes(forbidden), `I: 纯命令却出现了 ${forbidden}`);
  }
  assert.equal(run.plugin.filter((row) => row.event === "delivery").length, 0, "I: 纯命令不应投递");
  assert.ok(!run.stdout.includes(""), "I: stdout 被转义序列污染");
  assert.ok(!fs.existsSync(path.join(AGENT_DIR, "pi-notification", "config.json")), "I: 非 TUI 的 /notify 不得写盘");
});

await step("I2 旧子命令在真实 CLI 下已移除：只给指路，不执行、不写盘", async () => {
  const run = runPi({
    label: "notify-old-subcommand",
    args: ["--no-session", "--approve", ...EXTENSIONS, "-p", "/notify status"],
  });
  assertCleanExit("I2", run);
  const usage = run.plugin.filter((row) => row.event === "notify_usage");
  assert.equal(usage.length, 1, "I2: /notify status 未被识别为旧子命令");
  assert.equal(usage[0].args, "status");
  assert.match(run.stderr, /单一入口/);
  assert.equal(run.plugin.filter((row) => row.event === "delivery").length, 0);
  assert.ok(!fs.existsSync(path.join(AGENT_DIR, "pi-notification", "config.json")), "I2: 旧子命令不得写盘");
});

await step("J 用户级配置 enabled=false 在真实 CLI 下生效（一条通知都不发）", async () => {
  const run = runPi({
    label: "config-disabled",
    userConfig: { version: 1, enabled: false },
    args: [
      "--no-session", "--approve", "--no-tools",
      "--model", "probe-fake/fake-model",
      ...EXTENSIONS,
      "-p", "只回复 OK",
    ],
  });
  assertCleanExit("J", run);
  assert.ok(run.probe.map((row) => row.ev).includes("settled_enter"), "J: 这轮根本没跑起来");
  assert.equal(
    run.plugin.filter((row) => row.event === "delivery").length,
    0,
    "J: 配置已关闭却仍在投递（配置没被读到？）",
  );
  const loaded = run.plugin.filter((row) => row.event === "config_loaded").at(-1);
  assert.ok(loaded, "J: 缺少 config_loaded 记录");
  assert.equal(loaded.enabled, false);
  assert.ok(loaded.sources.some((item) => item.endsWith("config.json")), `J: 未记录配置来源 ${JSON.stringify(loaded.sources)}`);
});

await step("K 配置损坏时降级，但失败通知仍能发出（不静默全关）", async () => {
  const run = runPi({
    label: "config-broken",
    userConfig: "这不是 JSON",
    args: [
      "--no-session", "--approve", "--no-tools",
      "--model", "probe-fail/fail-model",
      ...EXTENSIONS,
      "-p", "只回复 OK",
    ],
  });
  assertFailedRunExit("K", run);
  const loaded = run.plugin.filter((row) => row.event === "config_loaded").at(-1);
  assert.equal(loaded.degraded, true, "K: 非法配置未标记降级");
  const sent = run.plugin.filter((row) => row.event === "delivery");
  assert.equal(sent.length, 1, `K: 降级后失败通知丢失: ${JSON.stringify(sent)}`);
  assert.equal(sent[0].kind, "run_failed");
  assert.equal(sent[0].level, "error");
});

await step("L --no-notify：本会话静默，一条都不发（且不改写配置文件）", async () => {
  const run = runPi({
    label: "no-notify",
    userConfig: { version: 1 },
    args: [
      "--no-session", "--approve", "--no-tools", "--no-notify",
      "--model", "probe-fake/fake-model",
      ...EXTENSIONS,
      "-p", "只回复 OK",
    ],
  });
  assertCleanExit("L", run);
  assert.ok(run.probe.map((row) => row.ev).includes("settled_enter"), "L: 这轮根本没跑起来");
  assert.equal(
    run.plugin.filter((row) => row.event === "delivery").length,
    0,
    "L: --no-notify 下仍在投递",
  );
  const startup = run.plugin.filter((row) => row.event === "plugin_session_start").at(-1);
  assert.equal(startup.silenced, true, "L: 插件未记录静默标志");
});

await step("M 旧 /notify off 不再写盘（写盘只发生在设置界面的 Ctrl+S）", async () => {
  const seeded = { version: 1, coalesce: { windowMs: 0, cooldownMs: 0 } };
  const off = runPi({ label: "off-removed", userConfig: seeded, args: ["--no-session", "--approve", ...EXTENSIONS, "-p", "/notify off"] });
  assertCleanExit("M off", off);
  assert.match(off.stderr, /单一入口/);
  assert.ok(!off.probe.some((r) => r.ev === "agent_start"));
  const file = path.join(AGENT_DIR, "pi-notification", "config.json");
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(seeded, null, 2), "M: 旧子命令改写了用户文件");
});

await step("M2 稀疏用户默认跨进程生效：预置的单项默认决定下一个进程的行为", async () => {
  const run = runPi({
    label: "sparse-default",
    // This is the shape Ctrl+S writes: only the fields the user froze.
    userConfig: { rules: { runCompleted: { enabled: false } } },
    args: ["--no-session", "--approve", "--no-tools", "--model", "probe-fake/fake-model", ...EXTENSIONS, "-p", "只回复 OK"],
  });
  assertCleanExit("M2", run);
  assert.ok(run.probe.map((row) => row.ev).includes("settled_enter"), "M2: 这轮根本没跑起来");
  assert.equal(run.plugin.filter((row) => row.event === "delivery").length, 0, "M2: 稀疏用户默认未生效");
  const loaded = run.plugin.filter((row) => row.event === "config_loaded").at(-1);
  assert.equal(loaded.enabled, true, "M2: 未保存的字段应继续跟随出厂默认");
  assert.ok(loaded.sources.some((item) => item.endsWith("config.json")), `M2: 未记录配置来源 ${JSON.stringify(loaded.sources)}`);
});

await step("N 非 TUI 的 /notify 在 stderr 输出路径/值，stdout 保持干净", async () => {
  const run = runPi({ label: "config-view", args: ["--no-session", "--approve", ...EXTENSIONS, "-p", "/notify"] });
  assertCleanExit("N", run);
  assert.ok(run.stderr.includes(path.join(AGENT_DIR, "pi-notification", "config.json")));
  assert.match(run.stderr, /当前生效值/);
  assert.match(run.stderr, /quietHours/);
  assert.doesNotMatch(run.stdout, /用户级配置|quietHours|\u001b/);
  assert.ok(!run.probe.some((r) => r.ev === "agent_start"));
  assert.ok(!fs.existsSync(path.join(AGENT_DIR, "pi-notification", "config.json")));
});

// ---------------------------------------------------------------------------

for (const item of failures) {
  console.error(`\n[FAIL] ${item.name}\n${item.error?.stack ?? item.error}`);
}

if (failures.length === 0) {
  console.log("\n通过：真实 CLI 下 G/H（判定与管道纪律）+ I（单一入口命令面）+ J/K（配置真实生效）+ L（--no-notify）+ M/N（旧子命令不写盘、稀疏默认跨进程生效、非 TUI 展示）全部成立。");
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
} else {
  console.error(`\n失败：${failures.length} 项断言未通过。临时目录保留：${TMP}`);
  process.exit(1);
}
