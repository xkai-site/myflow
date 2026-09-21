/**
 * 真实 CLI 冒烟（设计 §15 S1 完成判据：`pi -e` 能加载 / 退出无报错）。
 *
 * 用**真的 `pi` 可执行文件**跑两条最便宜的路径，全部离线、零 LLM 调用：
 *
 *   G 纯 `/probe-cmd`：证明「纯命令不进入 agent 生命周期」在真实 CLI 下同样成立，
 *     因此配置了通知插件也不会为这类任务投递任何东西（§18.5 修订 2 的覆盖边界）。
 *   H 假 provider + 真实 prompt：证明真实 CLI 下判定链路端到端可用，
 *     且 quit 收尾（`session_shutdown(reason=quit)` 的短超时 flush）能落盘。
 *
 * 与插件相关的两条硬断言：
 *   - **stdout 是管道时一个转义字节都不许写**（`pi -p` 的输出是调用方的数据，不是终端）。
 *   - 非 TTY 下本地渠道降级为 noop，但必须留下 `channel_degraded` 记录说明原因。
 * 也因此本脚本**不会**弹出真实系统通知。
 *
 * Git Bash 是硬约束环境：子进程一律带 `MSYS_NO_PATHCONV=1`，
 * 否则 `/probe-cmd` 会被 MSYS 改写成 Windows 路径而静默退化成普通 prompt（§18.1 U0）。
 *
 * 跳过方式：`PI_SKIP_CLI=1`。指定可执行文件：`PI_BIN=/path/to/pi`。
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

/** 一次真实 CLI 运行。返回 stdout/stderr/exit code 与两份 JSONL。 */
function runPi({ label, args, userConfig, preserveConfig = false }) {
  const configDir = path.join(AGENT_DIR, "pi-notification");
  const configFile = path.join(configDir, "config.json");
  if (preserveConfig) {
    // M3 跨进程持久化验收：保留上一进程实际写下的文件，不重新造配置。
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
    // Git Bash 硬约束：避免 `/cmd` 被 MSYS 改写成 Windows 路径。
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
 * provider 失败时，print 模式**自己**会 exit 1 并把错误打到 stderr（`print-mode.js` 的行为）。
 * 这不是插件的问题，所以分开断言：退出码允许 1，但插件自身不得记录 error、不得崩溃。
 */
function assertFailedRunExit(label, run) {
  assert.equal(run.error, undefined, `${label}: 启动失败 ${run.error?.message ?? ""}`);
  assert.equal(run.status, 1, `${label}: provider 失败时 print 模式应以 1 退出，实际 ${run.status}`);
  assert.doesNotMatch(run.stderr, /(TypeError|RangeError|AssertionError|Unhandled)/, `${label}: stderr 出现崩溃
${run.stderr}`);
  // 配置损坏时插件**应该**记 error 说明原因；不该出现的是"投递失败"这类自身故障。
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
  // 硬纪律：stdout 是管道时绝不能写入 OSC/转义序列，否则会污染 `pi -p` 的输出
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
  assert.equal(sent[0].ok, true);
  assert.equal(sent[0].level, "info");

  // stdout 是被调用方读走的（这里是管道），不得混入任何终端控制序列。
  assert.ok(!run.stdout.includes("\u001b"), "H: stdout 被转义序列污染");
  assert.ok(!run.stdout.includes("]777"), "H: stdout 出现了 OSC 777");
  assert.ok(run.stdout.includes("OK"), "H: stdout 应保持干净的模型输出");

  // 非将本地通知降级为 noop，而是要在日志里说明原因，且不能报错
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
  // 状态与配置路径走 stderr（stdout 归调用方）
  assert.match(run.stderr, /投递统计/);
  assert.match(run.stderr, /配置来源/);
  assert.match(run.stderr, /用户默认: /);
  assert.match(run.stderr, /设置界面仅 TUI 可用/);

  // 纯命令不进入 agent 生命周期（与 G 同一不变量，只是换成了插件自己的命令）
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
    // 这就是 Ctrl+S 写出来的形状：只有用户固化过的字段
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
