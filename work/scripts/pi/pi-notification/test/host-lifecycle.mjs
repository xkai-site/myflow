/**
 * S1.5 / S3 / S5-min 回归脚本。
 *
 * 用真实宿主（`@earendil-works/pi-coding-agent` SDK）在**本进程内**驱动真实会话，断言四组不变量：
 *
 *   判定与去重（A–F）：纯命令不产生生命周期、一次运行只投递一条、settled 内不阻塞、
 *                      reload 后不重复投递、失败判定落地
 *   渠道纪律（H）：非 TTY 时一个字节都不写，且必须留下可审计的跳过记录
 *   配置读盘（I1–I11）：文件真的被读、门槛/规则/渠道真的生效、**非法配置降级而不是静默全关**、
 *                      项目级配置只在信任时读且不得定义渠道
 *   命令面（J1–J4）：`/notify status|test` 走 Pi 真实命令分发，且不产生 agent 生命周期
 *
 * 隔离设计（每个 host 独立）：
 *   - 自己的 `PI_CODING_AGENT_DIR`（用户级配置互不串味）
 *   - 自己的 `PI_NOTIFY_LOG_FILE` / `PROBE_LOG`（游标不会跨 host 漂移——上一版就是这么炸的）
 *   - 全程离线：假 provider 直接产出事件流，不发任何网络请求（挂 fetch 陷阱自证）
 *
 * Git Bash 下请这样跑（`MSYS_NO_PATHCONV=1` 是硬约束，见设计 §18.1 U0）：
 *   MSYS_NO_PATHCONV=1 node test/host-lifecycle.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveSdkEntry, sdkUrl } from "./sdk-path.mjs";

const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_ENTRY = path.join(PLUGIN_DIR, "extensions", "index.ts");
const PROBE_ENTRY = path.join(PLUGIN_DIR, "test", "fixtures", "probe-ext.ts");
const BLOCKING_ENTRY = path.join(PLUGIN_DIR, "test", "fixtures", "blocking-ext.ts");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-notify-host-"));
const BLOCK_MS = 1500;

// 进程级固定环境（per-host 的三个变量在 makeHost 里设置）
process.env.PI_OFFLINE = "1";
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.PROBE_BLOCK_MS = String(BLOCK_MS);
// 钉住终端机制：本机是 win32，auto 会走 Windows toast —— 自动化里绝不能真弹系统通知。
// 选择逻辑本身（含 win32→toast）由 test/terminal-channel.mjs 穷举断言。
process.env.PI_NOTIFY_CHANNEL = "osc777";
delete process.env.PI_NOTIFY_DISABLE;

// 网络陷阱：任何一次真实 fetch 都会让本次回归失败（证明"离线"不是靠运气）。
const networkAttempts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  networkAttempts.push(String(args[0]));
  throw new Error(`回归脚本禁止网络访问: ${String(args[0])}`);
};

// ---------------------------------------------------------------------------
// stdout：捕获通知序列（并阻止它们真的打到开发者终端上）
// ---------------------------------------------------------------------------

const stdoutChunks = [];
const realStdoutWrite = process.stdout.write.bind(process.stdout);
// 用 RegExp 构造函数写转义，避免源码里出现裸 ESC/BEL 控制字符（不可见且易被编辑器破坏）。
const OSC777_RE = new RegExp("\\u001b\\]777;notify;[^\\u0007]*\\u0007", "g");
const OSC99_RE = new RegExp("\\u001b\\]99;[^\\u0007]*\\u001b\\\\", "g");

process.stdout.write = (chunk, encoding, callback) => {
  if (typeof chunk !== "string") return realStdoutWrite(chunk, encoding, callback);
  stdoutChunks.push(chunk);
  const forwarded = chunk.replace(OSC777_RE, "").replace(OSC99_RE, "");
  if (forwarded.length === 0) {
    if (typeof encoding === "function") encoding();
    else if (typeof callback === "function") callback();
    return true;
  }
  return realStdoutWrite(forwarded, encoding, callback);
};

function setStdoutTTY(value) {
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true, writable: true });
}

let stdoutCursor = 0;
/** 取出自上次调用以来新写入的 OSC 通知（777 / 99）。 */
function nextOscNotifications() {
  const text = stdoutChunks.join("");
  const delta = text.slice(stdoutCursor);
  stdoutCursor = text.length;
  return {
    osc777: delta.match(OSC777_RE) ?? [],
    osc99: delta.match(OSC99_RE) ?? [],
  };
}

setStdoutTTY(true);

const sdk = await import(sdkUrl(resolveSdkEntry()));
const configModule = await import(pathToFileURL(path.join(PLUGIN_DIR, "src", "config.ts")).href);

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  if (text.trim() === "") return [];
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`日志不是合法 JSONL: ${line.slice(0, 200)}`);
      }
    });
}

function cursor(reader) {
  let index = 0;
  return () => {
    const all = reader();
    const delta = all.slice(index);
    index = all.length;
    return delta;
  };
}

const events = (list) => list.map((row) => row.ev);
const deliveries = (list) => list.filter((row) => row.event === "delivery");

/**
 * 等异步投递落地。
 *
 * 这不是"偷懒的 sleep"：`agent_settled` 的 handler 按硬约束**只入队**，投递发生在其后的独立任务里，
 * 所以读日志前必须先等投递完成。判据是"日志文件连续 100ms 没有增长"，最多等 3s。
 */
async function waitForFileQuiet(file) {
  let size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  let stableSince = Date.now();
  const deadline = Date.now() + 3000;
  for (;;) {
    await sleep(25);
    const next = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (next !== size) {
      size = next;
      stableSince = Date.now();
      continue;
    }
    if (Date.now() - stableSince >= 100) return;
    if (Date.now() > deadline) return;
  }
}

function findBy(list, predicate, describe) {
  const found = list.find(predicate);
  assert.ok(found, `未找到期望的记录: ${describe}`);
  return found;
}

let failures = 0;
async function step(name, run) {
  try {
    await run();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${error?.message ?? error}`);
  }
}

/** `ExtensionUIContext` 的最小桩：本插件只用 `notify`，但绑定 UI 才会触发 session_start。 */
function stubUiContext(notices) {
  return {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    editor: async () => undefined,
    notify: (message, type) => notices.push({ message: String(message), type: type ?? "info" }),
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined,
    pasteToEditor: () => {},
    getEditorText: () => "",
    setEditorText: () => {},
    getEditorComponent: () => undefined,
    setEditorComponent: () => {},
    getTheme: () => undefined,
    getAllThemes: () => [],
    setTheme: () => {},
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
    addAutocompleteProvider: () => {},
  };
}

async function makeHost({ label, extensions, projectTrusted = true }) {
  const root = path.join(TMP, label);
  const agentDir = path.join(root, "agent");
  const probeFile = path.join(root, "probe.jsonl");
  const pluginFile = path.join(root, "plugin.jsonl");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
  fs.writeFileSync(probeFile, "");
  fs.writeFileSync(pluginFile, "");

  // 每个 host 独立：用户级配置目录 + 两份日志（避免游标跨 host 漂移）
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(root, "sessions");
  process.env.PROBE_LOG = probeFile;
  process.env.PI_NOTIFY_LOG_FILE = pluginFile;

  const settingsManager = sdk.SettingsManager.inMemory(
    { retry: { enabled: false, maxRetries: 0 } },
    { projectTrusted },
  );
  const loader = new sdk.DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: extensions,
  });
  await loader.reload();
  const loadErrors = loader.getExtensions().errors;

  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    modelsStorePath: path.join(agentDir, "models-store.json"),
    allowModelNetwork: false,
  });

  const { session } = await sdk.createAgentSession({
    cwd: root,
    agentDir,
    resourceLoader: loader,
    settingsManager,
    modelRuntime,
    noTools: "all",
    sessionManager: sdk.SessionManager.inMemory(root),
  });

  const runtimeErrors = [];
  const notices = [];
  await session.bindExtensions({
    mode: "print",
    uiContext: stubUiContext(notices),
    onError: (error) => runtimeErrors.push(error),
  });

  const probe = cursor(() => readJsonl(probeFile));
  const plugin = cursor(() => readJsonl(pluginFile));

  const host = {
    label,
    root,
    agentDir,
    probeFile,
    pluginFile,
    session,
    modelRuntime,
    loadErrors,
    runtimeErrors,
    notices,
    probe,
    plugin,
    userConfigPath: configModule.userConfigPath(agentDir),
    projectConfigPath: configModule.projectConfigPath(root, ".pi"),

    async drain() {
      await waitForFileQuiet(pluginFile);
    },

    /** 清空所有游标，使下一次读取只包含"从现在开始"发生的事情。 */
    resetCursors() {
      probe();
      plugin();
      nextOscNotifications();
    },

    /** 跑一段逻辑，返回这段期间的探针/插件/OSC 增量。 */
    async during(run) {
      await host.drain();
      host.resetCursors();
      await run();
      await host.drain();
      const osc = nextOscNotifications();
      const pluginRecords = plugin();
      const probeRecords = probe();
      return {
        probe: probeRecords,
        plugin: pluginRecords,
        osc,
        notifies: osc.osc777.length + osc.osc99.length,
        deliveries: deliveries(pluginRecords),
      };
    },

    async useModel(provider, id) {
      const model = modelRuntime.getModel(provider, id);
      assert.ok(model, `假 provider 未注册成功: ${provider}/${id}`);
      await session.setModel(model);
      return model;
    },

    /** 发一条 prompt，返回该次运行的增量（含投递与 OSC）。 */
    async prompt(text = "hi") {
      return host.during(() => session.prompt(text));
    },

    /** 走 Pi 真实命令分发（纯命令不产生 agent 生命周期）。 */
    async command(text) {
      const delta = await host.during(() => session.prompt(text));
      return { ...delta, notice: notices.at(-1) };
    },

    writeUserConfig(raw) {
      fs.mkdirSync(path.dirname(host.userConfigPath), { recursive: true });
      fs.writeFileSync(host.userConfigPath, typeof raw === "string" ? raw : JSON.stringify(raw, null, 2));
    },

    writeProjectConfig(raw) {
      fs.mkdirSync(path.dirname(host.projectConfigPath), { recursive: true });
      fs.writeFileSync(host.projectConfigPath, typeof raw === "string" ? raw : JSON.stringify(raw, null, 2));
    },

    removeUserConfig() {
      try {
        fs.unlinkSync(host.userConfigPath);
      } catch {
        // 不存在即视为已清理
      }
    },

    async dispose() {
      await host.drain();
      await session.dispose();
    },
  };

  return host;
}

function assertNoPluginErrors(host) {
  const errors = readJsonl(host.pluginFile).filter((row) => row.event === "log" && row.level === "error");
  assert.deepEqual(errors, [], "插件自身记录了 error");
}

// ---------------------------------------------------------------------------
// Phase 0：清洗与脱敏（纯函数）
// ---------------------------------------------------------------------------

console.log("S1.5 / S3 / S5-min 回归：pi-notification");

const { sanitize, redact } = await import(pathToFileURL(path.join(PLUGIN_DIR, "src", "log.ts")).href);

await step("P0 控制字符清洗 / 脱敏", () => {
  // OSC 序列整段删除（含载荷）：只删控制字符会留下 `]777;notify;...` 作为可见正文。
  assert.equal(sanitize("\u001b]777;notify;a\u0007b"), "b");
  assert.equal(sanitize("done\u001b[31m!\u001b[0m"), "done!");
  assert.equal(sanitize("a\r\nb"), "a\nb");
  assert.equal(sanitize("  a   b  "), "a b");
  assert.equal(sanitize("\u202eevil"), "evil");
  assert.ok(!sanitize("a\u0007\u001b\u0008b").includes("\u0007"));
  assert.ok([...sanitize("z".repeat(400))].length <= 300);
  assert.doesNotMatch(redact("apiKey=sk-abcdefgh12345678"), /sk-abcdefgh12345678/);
  assert.doesNotMatch(redact("Authorization: Bearer supersecretvalue"), /supersecretvalue/);
  // 脱敏目标是「家目录」本身，文件名属于有效诊断信息，应当保留。
  assert.equal(redact(`open ${os.homedir()}/.pi/agent/auth.json`), "open ~/.pi/agent/auth.json");
});

// ---------------------------------------------------------------------------
// Host 1：判定 / 去重 / 阻塞 / reload
// ---------------------------------------------------------------------------

const host = await makeHost({ label: "main", extensions: [PROBE_ENTRY, PLUGIN_ENTRY] });
const session0 = host.session;

await step("P1 加载无错误，且 session_start 被绑定触发", () => {
  assert.deepEqual(host.loadErrors, []);
  const startup = findBy(readJsonl(host.pluginFile), (row) => row.event === "plugin_session_start", "plugin_session_start");
  assert.equal(startup.reason, "startup");
  assert.equal(startup.enabled, true);
  assert.deepEqual(startup.providers, ["terminal"]);
});

await step("A 纯 /probe-cmd 不产生 agent 生命周期，也不产生通知", async () => {
  const delta = await host.prompt("/probe-cmd");
  assert.ok(events(delta.probe).includes("CMD_HANDLER_ENTER"), "命令未被派发");
  for (const forbidden of ["agent_start", "agent_end", "assistant_stop", "settled_enter"]) {
    assert.ok(!events(delta.probe).includes(forbidden), `纯命令却出现了 ${forbidden}`);
  }
  assert.equal(delta.deliveries.length, 0, "纯命令不应产生投递");
  assert.equal(delta.notifies, 0, "纯命令不应产生通知");
});

let firstDedupeKey;
let bSettledMono;
await step("B 一次成功运行恰好投递 1 条 run_completed（并真的写出 1 条 OSC）", async () => {
  await host.useModel("probe-fake", "fake-model");
  const delta = await host.prompt("hi");
  assert.deepEqual(
    events(delta.probe).filter((ev) => ev !== "assistant_stop"),
    ["agent_start", "settled_enter", "settled_exit"],
  );
  assert.equal(findBy(delta.probe, (row) => row.ev === "assistant_stop", "assistant_stop").stopReason, "stop");
  assert.equal(findBy(delta.probe, (row) => row.ev === "settled_enter", "settled_enter").isIdle, true);

  assert.equal(delta.deliveries.length, 1, `期望 1 条投递，实际 ${delta.deliveries.length} 条`);
  assert.equal(delta.deliveries[0].kind, "run_completed");
  assert.equal(delta.deliveries[0].level, "info");
  assert.equal(delta.deliveries[0].ok, true);
  assert.equal(delta.deliveries[0].providerId, "terminal");
  assert.match(delta.deliveries[0].dedupeKey, /:run_completed$/);
  assert.equal(delta.notifies, 1, "应恰好写出 1 条终端通知");
  assert.ok(delta.osc.osc777[0].includes("任务完成"), "通知正文应含判定结果标题");
  firstDedupeKey = delta.deliveries[0].dedupeKey;
  bSettledMono = findBy(delta.probe, (row) => row.ev === "settled_enter", "settled_enter").mono;
});

await step("C settled 内不阻塞：下一次 run 在 250ms 内启动", async () => {
  // 刻意不用 host.prompt()：它会先 drain（等日志安静），那会把"settled→下一次 run"的间隔
  // 污染成一个等待周期，测出来的是等待而不是阻塞。
  host.resetCursors();
  await session0.prompt("hi");
  await host.drain();
  const probe = host.probe();
  const delta = { deliveries: deliveries(host.plugin()), notifies: (() => { const o = nextOscNotifications(); return o.osc777.length + o.osc99.length; })() };

  const started = findBy(probe, (row) => row.ev === "agent_start", "agent_start");
  const gap = started.mono - bSettledMono;
  assert.ok(gap < 250, `settled→下一次 run 间隔过大（${gap.toFixed(0)}ms），说明 handler 内有阻塞`);
  console.log(`    （实测间隔 ${gap.toFixed(0)}ms，对照见末尾）`);

  assert.equal(delta.deliveries.length, 1, "第二次运行也应当只有 1 条投递");
  assert.equal(delta.notifies, 1, "第二次运行也应恰好写出 1 条终端通知");
  assert.notEqual(delta.deliveries[0].dedupeKey, firstDedupeKey, "两次运行的去重键必须不同");
});

await step("D /reload 后不重复投递（旧实例失效、新实例不叠加）", async () => {
  const reloaded = await host.during(() => host.session.reload());
  const shutdowns = reloaded.plugin.filter((row) => row.event === "plugin_shutdown" && row.reason === "reload");
  const starts = reloaded.plugin.filter((row) => row.event === "plugin_session_start" && row.reason === "reload");
  assert.equal(shutdowns.length, 1, "reload 应恰好产生 1 次 shutdown(reload)");
  assert.equal(starts.length, 1, "reload 应恰好产生 1 次 session_start(reload)");
  assert.notEqual(shutdowns[0].instance, starts[0].instance, "reload 必须重建实例");

  const delta = await host.prompt("hi");
  assert.equal(delta.deliveries.length, 1, `reload 后一次运行应只投递 1 条，实际 ${delta.deliveries.length} 条`);
  assert.equal(delta.notifies, 1, "reload 后应恰好写出 1 条终端通知");

  const all = deliveries(readJsonl(host.pluginFile));
  assert.equal(new Set(all.map((row) => row.dedupeKey)).size, all.length, "出现重复 dedupeKey（重复投递）");
  assert.ok(all.length >= 3, "至少应有 3 次投递（成功×2 + reload 后×1）");
});

await step("F 失败运行投递 1 条 run_failed(error)", async () => {
  await host.useModel("probe-fail", "fail-model");
  const delta = await host.prompt("hi");
  assert.equal(delta.deliveries.length, 1, `期望 1 条投递，实际 ${delta.deliveries.length} 条`);
  assert.equal(delta.deliveries[0].kind, "run_failed");
  assert.equal(delta.deliveries[0].level, "error");
  assert.equal(delta.deliveries[0].ok, true);
  assert.equal(delta.notifies, 1, "失败运行也应恰好写出 1 条终端通知");

  const settled = findBy(
    readJsonl(host.pluginFile),
    (row) => row.event === "run_settled" && row.status === "failed",
    "run_settled(status=failed)",
  );
  assert.equal(settled.stopReason, "error");
  await host.useModel("probe-fake", "fake-model");
});

await step("H 非终端模式（stdout 非 TTY）不得写入任何字节，只记 channel_skipped", async () => {
  setStdoutTTY(false);
  try {
    const delta = await host.prompt("hi");
    assert.equal(delta.notifies, 0, "非 TTY 下写入转义序列会污染调用方输出");
    assert.equal(delta.deliveries.length, 1, "判定链路仍应记录一次投递（跳过不算失败）");
    assert.equal(
      delta.plugin.filter((row) => row.event === "channel_skipped").length,
      1,
      "跳过必须留下可审计的记录，而不是静默消失",
    );
  } finally {
    setStdoutTTY(true);
  }
});

await step("E 无扩展异常、无网络访问、未写入 agentDir", async () => {
  await host.dispose();
  assert.deepEqual(host.runtimeErrors, [], "扩展运行期出现异常");
  assertNoPluginErrors(host);
  assert.deepEqual(networkAttempts, [], "出现了真实网络访问");
  // SDK 自己会写 auth.json / models-store.json；这里断言的是**插件**没有写入任何东西。
  const sdkOwned = new Set(["models.json", "auth.json", "models-store.json"]);
  const unexpected = fs.readdirSync(host.agentDir).filter((name) => !sdkOwned.has(name));
  assert.deepEqual(unexpected, [], "插件在 agentDir 里留下了文件");
  assert.equal(fs.existsSync(host.userConfigPath), false, "插件不应创建/改写配置文件");
});

// ---------------------------------------------------------------------------
// Host 2：阻塞对照组（证明 C 的测量真的能识别阻塞）
// ---------------------------------------------------------------------------

const control = await makeHost({
  label: "control",
  extensions: [PROBE_ENTRY, PLUGIN_ENTRY, BLOCKING_ENTRY],
});

await step(`对照 settled 内阻塞 ${BLOCK_MS}ms → 下一次 run 显著推迟`, async () => {
  await control.useModel("probe-fake", "fake-model");
  const first = await control.prompt("hi");
  const settledAt = findBy(first.probe, (row) => row.ev === "settled_enter", "settled_enter").mono;
  assert.equal(first.deliveries.length, 1, "对照组的一次运行仍应只投递 1 条（阻塞发生在插件之后）");
  assert.equal(first.notifies, 1, "对照组也应恰好写出 1 条终端通知");

  const second = await control.prompt("hi");
  const started = findBy(second.probe, (row) => row.ev === "agent_start", "agent_start");
  const gap = started.mono - settledAt;
  assert.ok(gap > 1000, `对照组未体现阻塞（${gap.toFixed(0)}ms），说明"不阻塞"断言没有区分度`);
  console.log(`    （对照间隔 ${gap.toFixed(0)}ms，用于证明测量有效）`);

  await control.dispose();
});

// ---------------------------------------------------------------------------
// Host 3：配置读盘（S5 最小版）—— 文件真的被读、非法配置降级而不是静默全关
// ---------------------------------------------------------------------------

const configured = await makeHost({ label: "config", extensions: [PROBE_ENTRY, PLUGIN_ENTRY] });
await configured.useModel("probe-fake", "fake-model");

/** 改配置 → reload（reload 会重发 session_start，插件在那里重新读盘）→ 跑一次成功运行。 */
async function runWithConfig(raw) {
  if (raw === null) configured.removeUserConfig();
  else configured.writeUserConfig(raw);
  const reloaded = await configured.during(() => configured.session.reload());
  const delta = await configured.prompt("hi");
  return { ...delta, configRecords: reloaded.plugin.filter((row) => row.event === "config_loaded") };
}

async function runFailingOn(host) {
  await host.useModel("probe-fail", "fail-model");
  const delta = await host.prompt("hi");
  await host.useModel("probe-fake", "fake-model");
  return delta;
}

await step("I1 无配置文件 → 内置默认值生效", async () => {
  const run = await runWithConfig(null);
  assert.equal(run.deliveries.length, 1, "默认配置应投递 1 条");
  assert.equal(run.notifies, 1, "默认配置应写出 1 条 OSC");
  assert.equal(run.configRecords.length, 1);
  assert.deepEqual(run.configRecords[0].sources, ["defaults"], `意外的配置来源: ${JSON.stringify(run.configRecords[0].sources)}`);
  assert.equal(run.configRecords[0].degraded, false);
});

await step("I2 enabled=false → 一条都不发", async () => {
  const run = await runWithConfig({ version: 1, enabled: false });
  assert.equal(run.deliveries.length, 0, "已关闭却仍在投递");
  assert.equal(run.notifies, 0, "已关闭却仍在写 OSC");
  assert.ok(run.configRecords[0].sources.includes(configured.userConfigPath), "未记录用户级配置来源");
});

await step("I3 minLevel=error → info 级成功通知被门槛拦下", async () => {
  const run = await runWithConfig({ version: 1, minLevel: "error" });
  assert.equal(run.deliveries.length, 0, "minLevel 门槛未生效");
});

await step("I4 rules.runCompleted.enabled=false → 成功不通知，失败仍通知", async () => {
  const run = await runWithConfig({ version: 1, rules: { runCompleted: { enabled: false } } });
  assert.equal(run.deliveries.length, 0, "规则已关却仍在投递");
  const failed = await runFailingOn(configured);
  assert.equal(failed.deliveries.length, 1, "失败通知不应被 runCompleted 开关影响");
  assert.equal(failed.deliveries[0].kind, "run_failed");
});

await step("I5 配置损坏 → 降级为「仅失败/仅 error」，但绝不静默全关", async () => {
  const run = await runWithConfig('{ "version": 1, "enabled": true, ');
  assert.equal(run.configRecords.length, 1);
  assert.equal(run.configRecords[0].degraded, true, "非法配置必须标记为降级");
  assert.ok(run.configRecords[0].errors.length >= 1, "降级必须留下可查的原因");
  assert.match(JSON.stringify(run.configRecords[0].errors), /解析失败/);
  assert.equal(run.deliveries.length, 0, "降级后成功通知应关闭（只留失败）");

  const failed = await runFailingOn(configured);
  assert.equal(failed.deliveries.length, 1, "配置损坏后失败通知丢失了（等于静默全关）");
  assert.equal(failed.deliveries[0].kind, "run_failed");
  assert.equal(failed.deliveries[0].level, "error");
});

await step("I6 非法字段值 → 同样降级（不是只认 JSON 语法错误）", async () => {
  const run = await runWithConfig({ version: 1, minLevel: "loud", delivery: { timeoutMs: -5 } });
  assert.equal(run.configRecords[0].degraded, true);
  assert.match(JSON.stringify(run.configRecords[0].errors), /minLevel|timeoutMs/);
  assert.equal(run.deliveries.length, 0);
});

await step("I7 渠道可切换：配置换成 debug 渠道后不再写终端", async () => {
  const run = await runWithConfig({
    version: 1,
    providers: [{ id: "debug", type: "debug", enabled: true }],
    rules: { runCompleted: { enabled: true, level: "info", channels: ["debug"] } },
  });
  assert.equal(run.deliveries.length, 1, "换渠道后应仍投递 1 条");
  assert.equal(run.deliveries[0].providerId, "debug", "service 的渠道表没有跟上配置刷新");
  assert.equal(run.notifies, 0, "已切到 debug 却仍在写 OSC");
});

await step("I8 配置里引用未定义渠道 → 保留记录，不伪装成功", async () => {
  const run = await runWithConfig({
    version: 1,
    rules: { runCompleted: { enabled: true, level: "info", channels: ["nope"] } },
  });
  assert.equal(run.deliveries.length, 1);
  assert.equal(run.deliveries[0].providerId, "nope");
  assert.equal(run.notifies, 0);
});

await configured.dispose();

// ---------------------------------------------------------------------------
// Host 4–6：项目级配置 —— 只在项目被信任时读取，且不得定义渠道（§13 第 7 项）
// ---------------------------------------------------------------------------

async function projectHost(label, projectTrusted, projectConfig) {
  // 必须先写文件再建会话：插件在 session_start 读盘，写完再读就已经晚了。
  const configPath = configModule.projectConfigPath(path.join(TMP, label), ".pi");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(projectConfig, null, 2));
  return makeHost({ label, extensions: [PROBE_ENTRY, PLUGIN_ENTRY], projectTrusted });
}

/** 插件所有 config_loaded 记录（含 session_start 期间产生的，不只是某次运行的增量）。 */
function configLoads(host) {
  return readJsonl(host.pluginFile).filter((row) => row.event === "config_loaded");
}

await step("I9 项目被信任 → 项目级配置生效（minLevel=error）", async () => {
  const host = await projectHost("trusted", true, { version: 1, minLevel: "error" });
  await host.useModel("probe-fake", "fake-model");
  const delta = await host.prompt("hi");
  assert.equal(delta.deliveries.length, 0, "信任项目下项目级 minLevel 未生效");
  const loaded = configLoads(host);
  assert.ok(loaded.some((row) => row.sources.includes(host.projectConfigPath)), "未记录项目级配置来源");
  await host.dispose();
});

await step("I10 项目未信任 → 项目级配置整体被忽略", async () => {
  const host = await projectHost("untrusted", false, { version: 1, minLevel: "error" });
  await host.useModel("probe-fake", "fake-model");
  const delta = await host.prompt("hi");
  assert.equal(delta.deliveries.length, 1, "未信任项目不该读到项目级配置");
  const loaded = configLoads(host);
  assert.ok(loaded.every((row) => !row.sources.includes(host.projectConfigPath)), "未信任项目却读入了项目级配置");
  await host.dispose();
});

await step("I11 信任项目也不能定义渠道：providers 被忽略并告警", async () => {
  const host = await projectHost("trusted-providers", true, {
    version: 1,
    minLevel: "error",
    providers: [{ id: "evil", type: "debug", enabled: true }],
    rules: { runCompleted: { enabled: true, level: "info", channels: ["evil"] } },
  });
  await host.useModel("probe-fake", "fake-model");
  const delta = await host.prompt("hi");
  const loaded = configLoads(host).at(-1);
  assert.ok(loaded, "缺少 config_loaded 记录");
  assert.match(JSON.stringify(loaded.warnings), /不允许定义渠道/);
  // 项目级的 minLevel=error 仍生效，说明只剥掉了 providers（而不是整份丢弃）
  assert.equal(delta.deliveries.length, 0);
  assert.match(JSON.stringify(loaded.sources), /config\.json/);
  await host.dispose();
});

// ---------------------------------------------------------------------------
// Host 7：命令面 —— /notify status | test，全部走 Pi 的真实命令分发
// ---------------------------------------------------------------------------

const commander = await makeHost({ label: "command", extensions: [PROBE_ENTRY, PLUGIN_ENTRY] });
await commander.useModel("probe-fake", "fake-model");

await step("J1 /notify status：走真实命令分发，给出可读状态", async () => {
  const delta = await commander.command("/notify status");
  assert.ok(delta.notice, "命令没有回显");
  assert.match(delta.notice.message, /pi-notification: 开启/);
  assert.match(delta.notice.message, /投递统计/);
  assert.match(delta.notice.message, /终端机制/);
  assert.match(delta.notice.message, /配置来源/);

  assert.equal(delta.plugin.filter((row) => row.event === "notify_status").length, 1);
  // 纯命令不得产生 agent 生命周期（与断言 A 同一不变量）
  for (const forbidden of ["agent_start", "settled_enter"]) {
    assert.ok(!events(delta.probe).includes(forbidden), `/notify status 却出现了 ${forbidden}`);
  }
  assert.equal(delta.notifies, 0);
});

await step("J2 /notify test：真的走一遍投递链路", async () => {
  const delta = await commander.command("/notify test");
  assert.match(delta.notice.message, /已提交自检通知/);
  assert.equal(delta.deliveries.length, 1, `自检通知未投递: ${JSON.stringify(delta.deliveries)}`);
  assert.equal(delta.deliveries[0].kind, "run_completed");
  assert.ok(delta.plugin.some((row) => row.event === "notify_test"));
  assert.equal(delta.notifies, 1, "自检通知应真的写出 OSC");
});

await step("J3 /notify 未知子命令：给用法而不是抛异常", async () => {
  const delta = await commander.command("/notify nonsense");
  assert.match(delta.notice.message, /未知子命令/);
  assert.match(delta.notice.message, /用法/);
  assert.equal(delta.notice.type, "warning");
  assert.deepEqual(commander.runtimeErrors, []);
});

await step("J4 /notify status 不产生副作用，且错误/告警会露出", async () => {
  commander.writeUserConfig({ version: 1, minLevel: "loud" });
  const reloaded = await commander.during(() => commander.session.reload());
  assert.equal(reloaded.plugin.filter((row) => row.event === "config_loaded").at(-1).degraded, true);

  const delta = await commander.command("/notify status");
  assert.match(delta.notice.message, /已降级/);
  assert.match(delta.notice.message, /配置错误/);
  assert.equal(delta.deliveries.length, 0, "status 不应产生投递");
  assert.equal(delta.notifies, 0);
});

await commander.dispose();

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

globalThis.fetch = realFetch;

if (failures === 0) {
  console.log("\n通过：判定/去重/阻塞/reload（A–F,H）+ 配置读盘（I1–I11）+ 命令面（J1–J4）全部成立。");
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
} else {
  console.error(`\n失败：${failures} 项断言未通过。临时目录保留：${TMP}`);
  process.exit(1);
}
