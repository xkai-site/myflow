/**
 * S1.5 / S3 / S5 / M3 回归脚本。
 *
 * 用真实宿主（`@earendil-works/pi-coding-agent` SDK）在**本进程内**驱动真实会话，断言四组不变量：
 *
 *   判定与去重（A–F）：纯命令不产生生命周期、一次运行只投递一条、settled 内不阻塞、
 *                      reload 后不重复投递、失败判定落地
 *   渠道纪律（H）：非 TTY 时一个字节都不写，且必须留下可审计的跳过记录
 *   配置读盘（I1–I11）：文件真的被读、门槛/规则/渠道真的生效、**非法配置降级而不是静默全关**、
 *                      项目级配置只在信任时读且不得定义渠道
 *   命令面（J1–J14）：真实命令分发、配置写盘/热读、静默状态、TUI 向导与模式守卫
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
import { createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
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

// 网络陷阱：任何一次**外部**网络访问都会让本次回归失败（证明"离线"不是靠运气）。
// 例外：回环地址（127.0.0.1）——S7 的 webhook 端到端断言需要本机 HTTP 服务，
// 它不经过任何外部网络，也不依赖互联网。
const networkAttempts = [];
const realFetch = globalThis.fetch;
const LOOPBACK_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (LOOPBACK_RE.test(url)) return realFetch(input, init);
  networkAttempts.push(url);
  throw new Error(`回归脚本禁止外部网络访问: ${url}`);
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

/** 从 OSC 777 原始序列里取出 body（正文内容字段的断言用）。 */
const OSC777_HEAD = new RegExp("^\\u001b\\]777;notify;");
const OSC777_TAIL = new RegExp("\\u0007$");
function oscBody(sequence) {
  const inner = sequence.replace(OSC777_HEAD, "").replace(OSC777_TAIL, "");
  return inner.includes(";") ? inner.slice(inner.indexOf(";") + 1) : "";
}

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

/**
 * 等某个探针事件出现。
 *
 * S6 的工具失败必须是"真的在运行中"发生的：先用 `PROBE_DELAY_MS` 让假 provider 晚一点回包，
 * 再等 `agent_start` 落地，然后把 `tool_execution_end` 送进插件（此刻 run 仍在进行中）。
 * 不靠 sleep 猜时机，靠探针文件的实际内容。
 */
async function waitForProbeEvent(host, ev, timeoutMs = 3000) {
  const count = () => readJsonl(host.probeFile).filter((row) => row.ev === ev).length;
  const before = count();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (count() > before) return;
    if (Date.now() > deadline) throw new Error(`等待探针事件超时: ${ev}`);
    await sleep(5);
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

async function makeHost({ label, extensions, projectTrusted = true, userConfig, mode = "print", ui = {} }) {
  const root = path.join(TMP, label);
  const agentDir = path.join(root, "agent");
  const probeFile = path.join(root, "probe.jsonl");
  const pluginFile = path.join(root, "plugin.jsonl");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
  fs.writeFileSync(probeFile, "");
  fs.writeFileSync(pluginFile, "");

  /** 用户级配置必须**在会话建立之前**写入：插件在工厂（loader.reload）与 session_start 两次读盘。 */
  const userConfigFile = configModule.userConfigPath(agentDir);
  const userConfigRaw = userConfig === undefined
    ? undefined
    : (typeof userConfig === "string" ? userConfig : JSON.stringify(userConfig, null, 2));
  if (userConfigRaw !== undefined) {
    fs.mkdirSync(path.dirname(userConfigFile), { recursive: true });
    fs.writeFileSync(userConfigFile, userConfigRaw);
  }

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
    mode,
    uiContext: { ...stubUiContext(notices), ...ui },
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
    /** 测试自己写下的用户级配置原文（用于断言插件未改写它） */
    userConfigRaw,
    projectConfigPath: configModule.projectConfigPath(root, ".pi"),

    /** 把事件直接送进真实的扩展 runner（S6 的 hook 回归就靠它）。 */
    emit(event) {
      return session.extensionRunner.emit(event);
    },

    /** 让假 provider 下次回包晚 `ms` 毫秒（给"运行中"留出一个可观测窗口）。 */
    setModelDelay(ms) {
      if (ms === undefined) delete process.env.PROBE_DELAY_MS;
      else process.env.PROBE_DELAY_MS = String(ms);
    },

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

    /**
     * 发一条 prompt，并在**运行中**注入一次工具失败（真实 `tool_execution_end`）。
     * 注入点由探针的 `agent_start` 事件定位，不靠猜测的 sleep。
     */
    async promptWithToolFailures(toolNames = ["bash"], text = "hi") {
      return host.during(async () => {
        const started = session.prompt(text);
        await waitForProbeEvent(host, "agent_start");
        let index = 0;
        for (const toolName of toolNames) {
          index += 1;
          await host.emit({
            type: "tool_execution_end",
            toolCallId: `call_${label}_${index}`,
            toolName,
            result: { content: [{ type: "text", text: "boom" }], isError: true },
            isError: true,
          });
        }
        await started;
      });
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

console.log("S1.5 / S3 / S5 / M3 回归：pi-notification");

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

/**
 * 判定/去重/阻塞/reload 四组断言关心的是**判定语义**，不是冷却策略：
 * 关掉 S4 的合并/冷却（两个 0），否则“两次运行 → 两次通知”会被冷却吃掉。
 * S4 自己的行为由后面的 `coalesce` 宿主（默认值）与 `test/service-coalesce.mjs` 负责。
 */
const NO_COALESCE = { version: 1, coalesce: { windowMs: 0, cooldownMs: 0 } };

const host = await makeHost({ label: "main", extensions: [PROBE_ENTRY, PLUGIN_ENTRY], userConfig: NO_COALESCE });
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

await step("C settled 内不阻塞：下一次 run 在 250ms 内启动（取 3 次最小值）", async () => {
  // 刻意不用 host.prompt()：它会先 drain（等日志安静），那会把"settled→下一次 run"的间隔
  // 污染成一个等待周期，测出来的是等待而不是阻塞。
  // 取多次最小值：单次采样会被 GC/调度抖动影响（曾经出现过 265ms 的假失败）。
  const samples = [];
  const deliveriesPerRun = [];
  for (let i = 0; i < 3; i += 1) {
    host.resetCursors();
    await session0.prompt("hi");
    await host.drain();
    const probe = host.probe();
    const osc = nextOscNotifications();
    const started = findBy(probe, (row) => row.ev === "agent_start", "agent_start");
    samples.push(started.mono - bSettledMono);
    deliveriesPerRun.push(deliveries(host.plugin()).length);
    assert.equal(osc.osc777.length, 1, "每次运行都应恰好写出 1 条终端通知");
  }
  const best = Math.min(...samples);
  assert.ok(
    best < 250,
    `settled→下一次 run 间隔过大（最小 ${best.toFixed(0)}ms，样本 [${samples.map((n) => n.toFixed(0))}]），说明 handler 内有阻塞`,
  );
  console.log(`    （实测最小间隔 ${best.toFixed(0)}ms，样本 [${samples.map((n) => n.toFixed(0)).join(", ")}]）`);

  assert.deepEqual(deliveriesPerRun, [1, 1, 1], "每次运行都应恰好投递 1 条");
  const keys = deliveries(readJsonl(host.pluginFile)).map((row) => row.dedupeKey);
  assert.equal(new Set(keys).size, keys.length, "两次运行的去重键必须不同");
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

await step("E 无扩展异常、无网络访问、未改写配置文件", async () => {
  await host.dispose();
  assert.deepEqual(host.runtimeErrors, [], "扩展运行期出现异常");
  assertNoPluginErrors(host);
  assert.deepEqual(networkAttempts, [], "出现了外部网络访问");
  // SDK 自己会写 auth.json / models-store.json；这里断言的是**插件**没有写入任何东西。
  // `pi-notification/` 目录是测试自己预置的配置目录（不再是插件写入的迹象）。
  const sdkOwned = new Set(["models.json", "auth.json", "models-store.json", "pi-notification"]);
  const unexpected = fs.readdirSync(host.agentDir).filter((name) => !sdkOwned.has(name));
  assert.deepEqual(unexpected, [], "插件在 agentDir 里留下了文件");
  if (host.userConfigRaw !== undefined) {
    assert.equal(
      fs.readFileSync(host.userConfigPath, "utf8"),
      host.userConfigRaw,
      "插件改写了配置文件（本轮不应写盘）",
    );
  }
});

// ---------------------------------------------------------------------------
// Host 2：阻塞对照组（证明 C 的测量真的能识别阻塞）
// ---------------------------------------------------------------------------

const control = await makeHost({
  label: "control",
  extensions: [PROBE_ENTRY, PLUGIN_ENTRY, BLOCKING_ENTRY],
  userConfig: NO_COALESCE,
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
  assert.match(delta.notice.message, /合并\/冷却/, "status 应展示 S4 的合并/冷却参数");

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

// M3 配置写盘/热读：同一宿主，不借助扩展 reload 掩盖内存态问题。
const writer = await makeHost({ label: "writer", extensions: [PROBE_ENTRY, PLUGIN_ENTRY], userConfig: NO_COALESCE });
await writer.useModel("probe-fake", "fake-model");

await step("J5 /notify off/on 原子写盘，下一次运行立即生效", async () => {
  assert.equal((await writer.prompt()).deliveries.length, 1);
  const off = await writer.command("/notify off");
  assert.match(off.notice.message, /已保存/);
  assert.equal(JSON.parse(fs.readFileSync(writer.userConfigPath, "utf8")).enabled, false);
  assert.equal((await writer.prompt()).deliveries.length, 0);
  assert.equal(off.plugin.filter((r) => r.event === "plugin_shutdown").length, 0);
  await writer.command("/notify on");
  assert.equal(JSON.parse(fs.readFileSync(writer.userConfigPath, "utf8")).enabled, true);
  assert.equal((await writer.prompt()).deliveries.length, 1);
});
await step("J6 非法写入被拒：磁盘、输入对象与运行内存态不变", async () => {
  const before = fs.readFileSync(writer.userConfigPath, "utf8");
  const invalid = { enabled: false, quietHours: { start: "25:00" } };
  const copy = structuredClone(invalid);
  const result = configModule.writeUserConfig(writer.agentDir, invalid);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.path === "quietHours.start"));
  assert.deepEqual(invalid, copy);
  assert.equal(fs.readFileSync(writer.userConfigPath, "utf8"), before);
  assert.equal((await writer.prompt()).deliveries.length, 1);
});
await step("J7 临时文件无残留 / 0o600；rename 失败保留原目标", () => {
  assert.deepEqual(fs.readdirSync(path.dirname(writer.userConfigPath)), ["config.json"]);
  // Windows 不支持 POSIX 权限位，退化为实际创建/替换不报错；不声称验证了 ACL。
  if (process.platform !== "win32") assert.equal(fs.statSync(writer.userConfigPath).mode & 0o777, 0o600);
  const dir = path.join(TMP, "rename-failure");
  const target = configModule.userConfigPath(dir);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "sentinel"), "unchanged");
  const result = configModule.writeUserConfig(dir, { enabled: false });
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(path.join(target, "sentinel"), "utf8"), "unchanged");
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ["config.json"]);
});
await step("J8 agentDir 不可写：命令报错不抛异常，内存与原文件不变", async () => {
  const before = fs.readFileSync(writer.userConfigPath, "utf8");
  // Windows chmod 无法可靠模拟不可写；用真实文件占据目录路径制造 ENOTDIR。
  const blocked = path.join(writer.root, "blocked-agent-dir");
  fs.writeFileSync(blocked, "unchanged");
  process.env.PI_CODING_AGENT_DIR = blocked;
  try {
    assert.equal(configModule.writeUserConfig(blocked, { enabled: false }).ok, false);
    const delta = await writer.command("/notify off");
    assert.equal(delta.notice.type, "error");
    // OS 可能在读盘阶段就报 ENOTDIR，或在 mkdir 阶段才报；都必须拒绝更新内存。
    assert.match(delta.notice.message, /保存失败|拒绝覆盖/);
    assert.deepEqual(writer.runtimeErrors, []);
    assert.equal(fs.readFileSync(blocked, "utf8"), "unchanged");
  } finally { process.env.PI_CODING_AGENT_DIR = writer.agentDir; }
  assert.equal(fs.readFileSync(writer.userConfigPath, "utf8"), before);
  assert.equal((await writer.prompt()).deliveries.length, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(writer.userConfigPath)), ["config.json"]);
});
await step("J9 /notify reload 重新读盘（不重载扩展），相同渠道 id 缓存刷新", async () => {
  writer.writeUserConfig({ ...NO_COALESCE, enabled: false });
  const delta = await writer.command("/notify reload");
  assert.equal(delta.plugin.filter((r) => r.event === "config_loaded").length, 1);
  assert.equal(delta.plugin.filter((r) => ["plugin_shutdown", "plugin_session_start"].includes(r.event)).length, 0);
  assert.equal((await writer.prompt()).deliveries.length, 0);
  writer.writeUserConfig({ ...NO_COALESCE, providers: [{ id: "terminal", type: "debug", enabled: true }] });
  await writer.command("/notify reload");
  const run = await writer.prompt();
  assert.equal(run.deliveries.length, 1);
  assert.equal(run.notifies, 0, "同 id 的旧渠道缓存未刷新");
  writer.writeUserConfig(NO_COALESCE);
  await writer.command("/notify reload");
  assert.equal((await writer.prompt()).notifies, 1);
});
await step("J10 静默状态可见；test 绕过全天静默并提示，reload 坏配置降级", async () => {
  writer.writeUserConfig({ ...NO_COALESCE, quietHours: { enabled: true, start: "00:00", end: "00:00" } });
  await writer.command("/notify reload");
  assert.match((await writer.command("/notify status")).notice.message, /静默时段: 00:00–00:00（当前生效/);
  assert.equal((await writer.prompt()).deliveries.length, 0);
  const test = await writer.command("/notify test");
  assert.equal(test.notifies, 1);
  assert.match(test.notice.message, /当前处于静默时段/);
  writer.writeUserConfig({ quietHours: { end: "8:00" } });
  assert.match((await writer.command("/notify reload")).notice.message, /已降级/);
  const bad = fs.readFileSync(writer.userConfigPath, "utf8");
  assert.equal((await writer.command("/notify on")).notice.type, "error");
  assert.equal(fs.readFileSync(writer.userConfigPath, "utf8"), bad, "不得把安全降级配置覆盖原文件");
});
await writer.dispose();

await step("J11 非 TUI config 只展示路径/值，RPC hasUI 不得弹向导且隐藏凭据", async () => {
  for (const mode of ["print", "json", "rpc"]) {
    const host = await makeHost({ label: `config-${mode}`, extensions: [PROBE_ENTRY, PLUGIN_ENTRY], mode,
      userConfig: { providers: [{ id: "debug", type: "debug", options: { headers: { "X-Private": "private-value-123" } } }] },
      ui: { select: () => { throw new Error("非 TUI 不得 select"); }, confirm: () => { throw new Error("非 TUI 不得 confirm"); } },
    });
    const before = fs.readFileSync(host.userConfigPath, "utf8");
    const result = await host.command("/notify config");
    assert.ok(result.notice.message.includes(host.userConfigPath));
    assert.match(result.notice.message, /当前生效值/);
    assert.doesNotMatch(result.notice.message, /private-value-123/);
    assert.equal(fs.readFileSync(host.userConfigPath, "utf8"), before);
    assert.deepEqual(host.runtimeErrors, []);
    await host.dispose();
  }
});
await step("J12 TUI 规则向导保存后立即生效，保留其它规则字段", async () => {
  const selections = ["runCompleted", "warning"];
  const confirms = [true, true];
  const host = await makeHost({ label: "wizard-save", extensions: [PROBE_ENTRY, PLUGIN_ENTRY], mode: "tui", userConfig: NO_COALESCE,
    ui: { select: async () => selections.shift(), confirm: async () => confirms.shift() },
  });
  await host.useModel("probe-fake", "fake-model");
  const result = await host.command("/notify config");
  assert.match(result.notice.message, /已保存/);
  const saved = JSON.parse(fs.readFileSync(host.userConfigPath, "utf8"));
  assert.equal(saved.rules.runCompleted.level, "warning");
  assert.deepEqual(saved.rules.runCompleted.channels, ["terminal"]);
  assert.equal(saved.rules.toolFailed.mode, "aggregate");
  assert.equal((await host.prompt()).deliveries[0].level, "warning");
  assert.deepEqual(host.runtimeErrors, []);
  await host.dispose();
});
await step("J13 TUI 向导取消不改磁盘与内存（选择、等级、最终确认）", async () => {
  for (const [index, picks, confirmations] of [[0, [], []], [1, ["runCompleted"], [false]], [2, ["runCompleted", "error"], [false, false]]]) {
    const host = await makeHost({ label: `wizard-cancel-${index}`, extensions: [PROBE_ENTRY, PLUGIN_ENTRY], mode: "tui", userConfig: NO_COALESCE,
      ui: { select: async () => picks.shift(), confirm: async () => confirmations.shift() },
    });
    await host.useModel("probe-fake", "fake-model");
    const before = fs.readFileSync(host.userConfigPath, "utf8");
    assert.match((await host.command("/notify config")).notice.message, /已取消/);
    assert.equal(fs.readFileSync(host.userConfigPath, "utf8"), before);
    assert.equal((await host.prompt()).deliveries[0].level, "info");
    await host.dispose();
  }
});
await step("J14 保存不固化项目/环境覆盖；reload 保持信任边界", async () => {
  const host = await makeHost({ label: "write-layers", extensions: [PROBE_ENTRY, PLUGIN_ENTRY], userConfig: NO_COALESCE });
  await host.useModel("probe-fake", "fake-model");
  host.writeProjectConfig({ minLevel: "error", enabled: true });
  const projectBefore = fs.readFileSync(host.projectConfigPath, "utf8");
  process.env.PI_NOTIFY_DISABLE = "1";
  try {
    await host.command("/notify on");
    const saved = JSON.parse(fs.readFileSync(host.userConfigPath, "utf8"));
    assert.equal(saved.enabled, true, "环境静默不应写盘");
    assert.equal(saved.minLevel, "info", "项目门槛不应写入用户层");
    assert.equal((await host.prompt()).deliveries.length, 0);
  } finally { delete process.env.PI_NOTIFY_DISABLE; }
  await host.command("/notify off");
  assert.equal(JSON.parse(fs.readFileSync(host.userConfigPath, "utf8")).enabled, false);
  assert.match((await host.command("/notify status")).notice.message, /pi-notification: 开启/); // 项目仍优先
  assert.equal(fs.readFileSync(host.projectConfigPath, "utf8"), projectBefore);
  assert.equal((await host.prompt()).deliveries.length, 0); // 项目门槛
  await host.dispose();
});

// ---------------------------------------------------------------------------
// Host：内容字段（M4 / 设计 §19）—— 会话名 / 成本 / 上下文占比 / assistant 摘录
// ---------------------------------------------------------------------------

const CONTENT_CONFIG = {
  version: 1,
  coalesce: { windowMs: 0, cooldownMs: 0 },
  content: { includeAssistantExcerpt: true },
};

const contentHost = await makeHost({
  label: "content",
  extensions: [PROBE_ENTRY, PLUGIN_ENTRY],
  userConfig: CONTENT_CONFIG,
});
await contentHost.useModel("probe-fake", "fake-model");

/** 每个内容字段断言都要控制假 provider 的输出，用完必清（否则会泄漏到后面的 host）。 */
async function withEnv(values, run) {
  const saved = new Map();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** 跑一次成功运行，返回该次终端通知的正文。 */
async function runBody(toolFailures = []) {
  const delta = toolFailures.length > 0
    ? await contentHost.promptWithToolFailures(toolFailures)
    : await contentHost.prompt("hi");
  assert.equal(delta.osc.osc777.length, 1, `应恰好写出 1 条终端通知，实际 ${delta.osc.osc777.length} 条`);
  return oscBody(delta.osc.osc777[0]);
}

await step("R1 内容字段默认值与字段替换：no-op 字段已删，新字段仍严格校验", () => {
  const content = configModule.defaultConfig().content;
  assert.equal(content.includeSessionLabel, true);
  assert.equal(content.includeAssistantExcerpt, false);
  assert.equal(content.includeCost, true);
  assert.ok(!("includeSessionName" in content), "首段标识已更名为 includeSessionLabel（语义含项目目录名回退）");
  assert.ok(!("includePromptExcerpt" in content), "已删除的 no-op 字段不得复活（它会静默失效）");
  // 旧配置里残留这个字段：不再是“有效字段”，但也不该因为一个已删字段而整份降级。
  assert.deepEqual(
    configModule.mergeConfig(configModule.defaultConfig(), { version: 1, content: { includePromptExcerpt: true } }, "test").errors,
    [],
  );
  // 新字段的类型错误必须照旧降级（严格校验不得因为新增字段而放松）。
  for (const content of [{ includeAssistantExcerpt: "yes" }, { includeSessionLabel: 1 }, { includeCost: null }]) {
    assert.ok(configModule.mergeConfig(configModule.defaultConfig(), { content }, "test").errors.length > 0, JSON.stringify(content));
  }
});

await step("R2 首段标识：未命名时回退项目目录名，`/name` 后会话名优先，可整栏关闭", async () => {
  // 本 host 的 cwd 是 TMP/content，所以未命名时应回退成 [content]。
  const fallback = await runBody();
  assert.ok(fallback.startsWith(`[${contentHost.label}]`), `未命名时应回退到项目目录名: ${fallback}`);

  contentHost.session.setSessionName("重构登录");
  await contentHost.drain(); // `session_info_changed` 是 void 发出的，先等 handler 落盘
  assert.ok(await runBody().then((body) => body.startsWith("[重构登录]")), "会话名应优先于项目目录名");
  const changed = findBy(readJsonl(contentHost.pluginFile), (row) => row.event === "session_name_changed", "session_name_changed");
  assert.equal(changed.hasName, true);
  assert.ok(!JSON.stringify(changed).includes("重构登录"), "日志不得记下会话名本身");

  // 两个来源都不想要时，整栏关掉。
  contentHost.writeUserConfig({ ...CONTENT_CONFIG, content: { includeAssistantExcerpt: true, includeSessionLabel: false } });
  await contentHost.command("/notify reload");
  const off = await runBody();
  assert.ok(!off.startsWith("["), `关掉 includeSessionLabel 后不该再有标识: ${off}`);
  contentHost.writeUserConfig(CONTENT_CONFIG);
  await contentHost.command("/notify reload");
});

await step("R3 assistant 摘录：默认关闭；开启后 10 字截断 + 截断标记 + 悬空标点去除", async () => {
  // 默认关闭：用 M3 的 `/notify reload` 换成不含该字段的配置，而不是另建 host。
  contentHost.writeUserConfig({ version: 1, coalesce: { windowMs: 0, cooldownMs: 0 } });
  await contentHost.command("/notify reload");
  await withEnv({ PROBE_ASSISTANT_TEXT: "0123456789ABCDEF" }, async () => {
    assert.ok(!(await runBody()).includes("0123456789"), "摘录默认关闭，绝不能因为消息里存在模型回复就带出去");
  });

  contentHost.writeUserConfig(CONTENT_CONFIG);
  await contentHost.command("/notify reload");
  await withEnv({ PROBE_ASSISTANT_TEXT: "0123456789ABCDEF" }, async () => {
    const body = await runBody();
    assert.ok(body.includes("0123456789…"), `应带出前 10 个字符并标出截断: ${body}`);
    assert.ok(!body.includes("0123456789A"), `摘录超过 10 个字符: ${body}`);
  });
  // 恰好 10 字：没有截断，就不该补 `…`（不能把模型的完整句子说成被截断）。
  await withEnv({ PROBE_ASSISTANT_TEXT: "0123456789" }, async () => {
    const body = await runBody();
    assert.ok(body.includes("0123456789") && !body.includes("…"), `完整短句不该补截断标记: ${body}`);
  });
  // 悬空标点：第 10 个字符恰好是标点时要去掉（“已修复，改”这种尾巴读起来像坏了）。
  await withEnv({ PROBE_ASSISTANT_TEXT: "abcdefghi。后面还有更多内容" }, async () => {
    const body = await runBody();
    assert.ok(body.includes("abcdefghi…"), `截断处的悬空标点应去掉: ${body}`);
  });
  await withEnv({ PROBE_ASSISTANT_TEXT: "a\nb" }, async () => {
    assert.ok((await runBody()).includes("a b"), "换行应归一为空格（否则会撑破单行通知）");
  });
  // 注入面：模型回复可能包含伪造通知的序列，摘录必须先经 sanitize 再入正文。
  await withEnv({ PROBE_ASSISTANT_TEXT: "x\u001b]777;notify;evil\u0007y" }, async () => {
    const body = await runBody();
    assert.ok(body.includes("xy"), `转义序列应整段删除（含载荷）: ${JSON.stringify(body)}`);
    assert.ok(!body.includes("evil"), "摘录里不得出现转义序列的载荷");
  });
});

await step("R4 成本：本次 + 会话累计；includeCost=false 时两者一起消失", async () => {
  await withEnv({ PROBE_COST_USD: "0.0123" }, async () => {
    // 第一次运行：本次与累计相同，只显示一次（避免“累计”重复同一数字）。
    const first = await runBody();
    assert.ok(first.includes("成本 $0.0123"), `缺少本次成本: ${first}`);
    assert.ok(!first.includes("累计"), `首次运行不该重复累计值: ${first}`);
    // 第二次运行：累计跨 run 累加（同一实例会话内）。
    const second = await runBody();
    assert.ok(second.includes("成本 $0.0123（累计 $0.0246）"), `累计口径不对: ${second}`);
  });
  // 关闭后成本与上下文占比一起消失（同一开关管两个字段）。
  contentHost.writeUserConfig({ ...CONTENT_CONFIG, content: { includeAssistantExcerpt: true, includeCost: false } });
  await contentHost.command("/notify reload");
  await withEnv({ PROBE_COST_USD: "0.0123", PROBE_CONTEXT_TOKENS: "42000" }, async () => {
    const body = await runBody();
    assert.ok(!body.includes("成本") && !body.includes("上下文"), `关闭 includeCost 后仍有成本信息: ${body}`);
  });
  contentHost.writeUserConfig(CONTENT_CONFIG);
  await contentHost.command("/notify reload");
});

await step("R5 上下文占比：拿得到才算，低于 1% 不显示", async () => {
  await withEnv({ PROBE_CONTEXT_TOKENS: "42000" }, async () => {
    assert.ok((await runBody()).includes("上下文 42%"), "应显示与 model.contextWindow 换比例后的百分比");
  });
  const tiny = await runBody(); // 默认 input=1 token / window=100000 → 0%，属于噪声
  assert.ok(!tiny.includes("上下文"), `低于 1% 时不该显示“上下文 0%”: ${tiny}`);
});

await contentHost.dispose();

// ---------------------------------------------------------------------------
// Host 8：S4 合并窗口 / 冷却 —— 默认值在真实宿主下真的生效
// ---------------------------------------------------------------------------

await step("L0 默认参数的合并/冷却与设计 §10.2 一致", () => {
  const config = configModule.defaultConfig();
  assert.equal(config.coalesce.windowMs, 1500);
  assert.equal(config.coalesce.cooldownMs, 3000);
  assert.equal(config.coalesce.toolFailureWindowMs, 10000);
  assert.equal(config.rules.toolFailed.mode, "aggregate");
  assert.deepEqual(config.rules.waitingForUser.kinds, ["select", "confirm", "input", "editor"]);
  assert.equal(config.delivery.circuitBreakerFailures, 3);
});

const coalesceHost = await makeHost({ label: "coalesce", extensions: [PROBE_ENTRY, PLUGIN_ENTRY] });
await coalesceHost.useModel("probe-fake", "fake-model");

await step("L1 默认配置：极短时间内的两次运行只发一条（同 kind 冷却）", async () => {
  const first = await coalesceHost.prompt("hi");
  assert.equal(first.deliveries.length, 1, "第一次运行应当投递");
  assert.equal(first.notifies, 1);

  const second = await coalesceHost.prompt("hi");
  assert.equal(second.deliveries.length, 0, "冷却窗口内的第二次运行不应再发一条");
  assert.equal(second.notifies, 0, "冷却窗口内不得再写 OSC");
  assert.equal(second.plugin.filter((row) => row.event === "cooldown_drop").length, 1, "被拦下必须留痕（否则等于静默丢失）");
});

await step("L2 cooldownMs=0 后恢复「每次运行各发一条」（参数真的被读取）", async () => {
  coalesceHost.writeUserConfig({ version: 1, coalesce: { windowMs: 0, cooldownMs: 0 } });
  await coalesceHost.during(() => coalesceHost.session.reload());
  const first = await coalesceHost.prompt("hi");
  const second = await coalesceHost.prompt("hi");
  assert.equal(first.deliveries.length, 1);
  assert.equal(second.deliveries.length, 1, "冷却已关闭却仍被拦下");
  assert.notEqual(first.deliveries[0].dedupeKey, second.deliveries[0].dedupeKey);
});

await coalesceHost.dispose();

// ---------------------------------------------------------------------------
// Host 9：S6 工具失败 / 压缩失败 / 等待输入
//
// 工具失败是在**运行中**注入真实 `tool_execution_end`（靠探针 `agent_start` 定位注入点，
// 不靠 sleep 猜时机）：`PROBE_DELAY_MS` 让假 provider 晚 250ms 回包，窗口足够大。
// ---------------------------------------------------------------------------

const S6_BASE = {
  version: 1,
  // 关掉冷却/合并，先把“hook 行为”本身测清楚（冷却由 L1/L2 与 K3 负责）
  coalesce: { windowMs: 0, cooldownMs: 0 },
  rules: {
    toolFailed: { enabled: true, level: "warning", channels: ["terminal"] },
    compactFailed: { enabled: true, level: "error", channels: ["terminal"] },
    waitingForUser: { enabled: true, level: "info", channels: ["terminal"] },
  },
};

const s6 = await makeHost({ label: "s6", extensions: [PROBE_ENTRY, PLUGIN_ENTRY], userConfig: S6_BASE });
await s6.useModel("probe-fake", "fake-model");
s6.setModelDelay(250);

/** 改配置 → reload（重新读盘）→ 返回 reload 期间的插件增量。 */
async function reconfigure(host, raw) {
  host.writeUserConfig(raw);
  return host.during(() => host.session.reload());
}

await step("K1 聚合模式：工具失败并入运行结果，一次运行仍然只发一条", async () => {
  const delta = await s6.promptWithToolFailures(["bash"]);
  assert.equal(delta.deliveries.length, 1, `期望 1 条投递，实际 ${delta.deliveries.length} 条`);
  assert.equal(delta.deliveries[0].kind, "run_completed");
  assert.equal(delta.notifies, 1, "工具失败不得另发一条");
  assert.ok(delta.osc.osc777[0].includes("1 个工具失败: bash"), `结果通知应包含失败工具名: ${delta.osc.osc777[0]}`);
  const settled = findBy(readJsonl(s6.pluginFile), (row) => row.event === "run_settled", "run_settled");
  assert.equal(settled.toolFailures, 1, "lifecycle 未累积工具失败");
});

await step("K2 运行结果不通知时，聚合的工具失败自己发一条（去重后按工具名列出）", async () => {
  await reconfigure(s6, { ...S6_BASE, rules: { ...S6_BASE.rules, runCompleted: { enabled: false } } });
  const delta = await s6.promptWithToolFailures(["bash", "read"]);
  assert.equal(delta.deliveries.length, 1);
  assert.equal(delta.deliveries[0].kind, "tool_failed");
  assert.equal(delta.deliveries[0].level, "warning");
  assert.ok(delta.osc.osc777[0].includes("2 个工具失败: bash, read"), `聚合文案不对: ${delta.osc.osc777[0]}`);
});

await step("K3 immediate 模式：工具一失败就提醒，同 run 的后续事件被合并窗口吸收", async () => {
  await reconfigure(s6, {
    ...S6_BASE,
    // 同一 run 的后续事件（第二个工具、运行结果）靠默认 1500ms 窗口吸收
    coalesce: { windowMs: 1500, cooldownMs: 0 },
    rules: {
      ...S6_BASE.rules,
      runCompleted: { enabled: true },
      toolFailed: { enabled: true, level: "warning", channels: ["terminal"], mode: "immediate", threshold: 1 },
    },
  });
  const delta = await s6.promptWithToolFailures(["bash", "read"]);
  assert.equal(delta.deliveries.length, 1, `immediate 模式下只应有一条（后续被合并），实际 ${delta.deliveries.length}`);
  assert.equal(delta.deliveries[0].kind, "tool_failed");
  assert.match(delta.deliveries[0].dedupeKey, /:tool_failed:bash$/);
  assert.ok(
    delta.plugin.filter((row) => row.event === "coalesce_drop").length >= 1,
    "同一 run 的后续事件应被合并窗口拦下并留痕",
  );
  assert.equal(delta.notifies, 1);
});

await step("K4 压缩失败立即提醒（error）；用户自己取消（aborted）不发", async () => {
  const failed = await s6.during(() =>
    s6.emit({
      type: "session_compact_failed",
      reason: "overflow",
      errorMessage: "context overflow recovery failed",
      aborted: false,
      willRetry: true,
      fromExtension: false,
    }));
  assert.equal(failed.deliveries.length, 1, "压缩失败必须能发出去（手工 /compact 没有 settled 可等）");
  assert.equal(failed.deliveries[0].kind, "compact_failed");
  assert.equal(failed.deliveries[0].level, "error");
  assert.equal(failed.notifies, 1);

  const aborted = await s6.during(() =>
    s6.emit({
      type: "session_compact_failed",
      reason: "manual",
      aborted: true,
      willRetry: false,
      fromExtension: false,
    }));
  assert.equal(aborted.deliveries.length, 0, "用户自己取消的压缩不应发通知");
  assert.equal(aborted.notifies, 0);
});

await step("K5 等待输入：真 select 触发一条；custom 永久排除；end 能复位", async () => {
  const delta = await s6.command("/probe-prompt");
  assert.equal(delta.deliveries.length, 1, `等待输入未通知: ${JSON.stringify(delta.deliveries)}`);
  assert.equal(delta.deliveries[0].kind, "waiting_for_user");
  assert.equal(delta.deliveries[0].level, "info");
  assert.ok(delta.osc.osc777[0].includes("选择 A"), `标题应带过来: ${delta.osc.osc777[0]}`);

  const starts = delta.plugin.filter((row) => row.event === "lifecycle_prompt_start");
  const ends = delta.plugin.filter((row) => row.event === "lifecycle_prompt_end");
  assert.equal(starts.length, 1, "真实 select 应产生 1 个 start span");
  assert.equal(starts[0].kind, "select");
  assert.equal(ends.length, 1, "select 返回后应产生 1 个 end span");
  assert.equal(ends[0].depth, 0, "end 应把等待计数复位");

  // §18.5 修订 1：custom 与用户输入无关（加载器/进度 UI 也会用它），永久排除
  const custom = await s6.during(() => s6.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" }));
  assert.equal(custom.deliveries.length, 0, "custom 提示不得产生通知");
  assert.equal(custom.notifies, 0);

  // 嵌套 prompt 不会产生内层 span，end 报的是外层 kind：不得靠 kind 配对
  await s6.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "确认 X" });
  const waiting = await s6.command("/notify status");
  assert.match(waiting.notice.message, /正在等你输入/, "status 应反映 waiting 状态");
  await s6.emit({ type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm", title: "确认 X" });
  const afterEnd = await s6.command("/notify status");
  assert.doesNotMatch(afterEnd.notice.message, /正在等你输入/, "end 之后应复位");
});

await step("K6 shutdown/reload 兜底复位 waiting（强杀时可能收不到 end）", async () => {
  await s6.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "input", title: "输入 Y" });
  const before = await s6.command("/notify status");
  assert.match(before.notice.message, /正在等你输入/);

  await s6.during(() => s6.session.reload());
  const after = await s6.command("/notify status");
  assert.doesNotMatch(after.notice.message, /正在等你输入/, "reload 后不得还挂着等待状态");
});

s6.setModelDelay(undefined);
await s6.dispose();

// ---------------------------------------------------------------------------
// Host 10：S7 Webhook —— 验收 §17.3：「新增 1 个文件 + registry 1 行 + 配置 1 条」
// ---------------------------------------------------------------------------

const hookRequests = [];
const hookServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    hookRequests.push({ url: req.url, method: req.method, headers: req.headers, body });
    res.writeHead(202, { "content-type": "text/plain" });
    res.end("accepted");
  });
});
await new Promise((resolve) => hookServer.listen(0, "127.0.0.1", resolve));
const hookPort = hookServer.address().port;
const WEBHOOK_SECRET = "regression-secret-do-not-log";
process.env.PI_NOTIFY_TEST_WEBHOOK_SECRET = WEBHOOK_SECRET;

const webhookHost = await makeHost({
  label: "webhook",
  extensions: [PROBE_ENTRY, PLUGIN_ENTRY],
  userConfig: {
    version: 1,
    coalesce: { windowMs: 0, cooldownMs: 0 },
    providers: [
      { id: "terminal", type: "terminal", enabled: true },
      {
        id: "hook",
        type: "webhook",
        enabled: true,
        options: {
          url: `http://127.0.0.1:${hookPort}/hook?token=in-query`,
          secretEnv: "PI_NOTIFY_TEST_WEBHOOK_SECRET",
        },
      },
    ],
    rules: { runFailed: { enabled: true, level: "error", channels: ["hook"] } },
  },
});
await webhookHost.useModel("probe-fail", "fail-model");

await step("M1 webhook 端到端：真实 POST + HMAC 签名 + 日志不复现 query/密钥", async () => {
  const delta = await webhookHost.prompt("hi");
  assert.equal(delta.deliveries.length, 1, `期望 1 条投递，实际 ${JSON.stringify(delta.deliveries)}`);
  assert.equal(delta.deliveries[0].providerId, "hook");
  assert.equal(delta.deliveries[0].ok, true);
  assert.equal(hookRequests.length, 1, "本机服务未收到 webhook 请求");

  const sent = hookRequests[0];
  assert.equal(sent.method, "POST");
  assert.equal(sent.url, "/hook?token=in-query");
  assert.equal(sent.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(sent.headers["x-pi-notify-event"], "run_failed");
  const expected = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(sent.body, "utf8").digest("hex")}`;
  assert.equal(sent.headers["x-pi-notify-signature"], expected, "HMAC 签名必须能被子方重现");

  const payload = JSON.parse(sent.body);
  assert.equal(payload.source, "pi-notification");
  assert.equal(payload.event, "run_failed");
  assert.equal(payload.level, "error");
  assert.ok(payload.sessionId, "载荷应带会话标识（跨会话防御需要）");
  assert.ok(!sent.body.includes(WEBHOOK_SECRET), "载荷里不得出现密钥明文");

  const record = findBy(readJsonl(webhookHost.pluginFile), (row) => row.event === "webhook_sent", "webhook_sent");
  assert.equal(record.signed, true);
  assert.equal(record.url, `http://127.0.0.1:${hookPort}/hook`, "日志应丢弃 query（常被用来传 token）");
  assert.ok(!JSON.stringify(readJsonl(webhookHost.pluginFile)).includes(WEBHOOK_SECRET), "日志里出现了密钥明文");

  await webhookHost.useModel("probe-fake", "fake-model");
});

await step("M2 非法 webhook 配置降级为 noop，绝不发到错地方", async () => {
  webhookHost.writeUserConfig({
    version: 1,
    coalesce: { windowMs: 0, cooldownMs: 0 },
    providers: [
      { id: "bad", type: "webhook", enabled: true, options: { url: "ftp://example.invalid/x" } },
      {
        id: "nosecret",
        type: "webhook",
        enabled: true,
        options: { url: "https://example.invalid/hook", secretEnv: "PI_NOTIFY_TEST_MISSING_SECRET" },
      },
    ],
    rules: { runCompleted: { enabled: true, level: "info", channels: ["bad", "nosecret"] } },
  });
  await webhookHost.during(() => webhookHost.session.reload());

  const requestsBefore = hookRequests.length;
  const delta = await webhookHost.prompt("hi");
  const degraded = delta.plugin.filter((row) => row.event === "channel_degraded");
  assert.equal(degraded.length, 2, `期望 2 条降级记录，实际 ${JSON.stringify(degraded)}`);
  const reasons = JSON.stringify(degraded.map((row) => row.reason));
  assert.match(reasons, /协议/);
  assert.match(reasons, /环境变量/);
  assert.equal(delta.deliveries.length, 2, "降级渠道仍应记录投递（noop 成功），不能静默消失");
  assert.equal(hookRequests.length, requestsBefore, "降级渠道不得真的发出去");
  assert.deepEqual(networkAttempts, [], "出现了外部网络访问");
});

await step("M3 §17.3 反回退：lifecycle/rules 不碰渠道名，service 不认识 webhook", () => {
  const read = (rel) => fs.readFileSync(path.join(PLUGIN_DIR, rel), "utf8");
  // 只看真正的 import 语句：注释里提到 `providers/*` 是在说明这条约束，不算违规。
  const importsProviders = /from\s+"[^"]*providers\//;
  for (const rel of ["src/lifecycle.ts", "src/rules.ts"]) {
    const source = read(rel);
    assert.doesNotMatch(source, importsProviders, `${rel} 不得 import providers/*（§17.3 规则 1）`);
    assert.doesNotMatch(source, /terminal|webhook/, `${rel} 不得出现渠道名（§17.3 规则 2）`);
  }
  // `debug` 只是日志级别名，不作为渠道名检查
  assert.doesNotMatch(read("src/service.ts"), /terminal|webhook/, "service 不得出现渠道名");
  assert.doesNotMatch(read("extensions/index.ts"), /pi\.on\(\s*"agent_end"/, "不得注册 agent_end（硬约束 1）");
  assert.doesNotMatch(
    read("src/providers/webhook.ts"),
    /from "\.\.\/(lifecycle|rules|config)\.ts"/,
    "渠道不得 import 判定/配置层（§17.3 规则 3）",
  );
});

await webhookHost.dispose();
await new Promise((resolve) => hookServer.close(resolve));
delete process.env.PI_NOTIFY_TEST_WEBHOOK_SECRET;

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

globalThis.fetch = realFetch;

if (failures === 0) {
  console.log(
    "\n通过：判定/去重/阻塞/reload（A–F,H）+ 配置读盘（I1–I11）+ 命令与写盘（J1–J14）"
    + " + 合并/冷却（L0–L2）+ 工具失败/压缩失败/等待输入（K1–K6）+ Webhook（M1–M3）全部成立。",
  );
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
} else {
  console.error(`\n失败：${failures} 项断言未通过。临时目录保留：${TMP}`);
  process.exit(1);
}
