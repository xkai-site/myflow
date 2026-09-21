/**
 * Host regression: drives a real session in-process through the `@earendil-works/pi-coding-agent` SDK
 * and asserts five groups of invariants:
 *
 *   judgement and dedupe (A-F): a pure command produces no lifecycle, one run delivers exactly one
 *     notification, settle does not block the next run, a reload never duplicates a delivery, and a
 *     failing run is reported
 *   channel discipline (H): outside a TTY not a single byte is written, and every skip leaves an
 *     auditable record
 *   config loading (I1-I9): the file really is read, thresholds, rules and channels really take
 *     effect, a broken config degrades instead of silently disabling everything, and the removed
 *     project-level layer is never read even when the file exists
 *   single entry point and three value layers (J1-J14): `/notify` only opens the settings UI, Enter
 *     only changes the current conversation, Ctrl+S writes one sparse field, an overlay survives a
 *     reload but never a fork, and forced silence cannot be bypassed
 *
 * Isolation, per host:
 *   - its own `PI_CODING_AGENT_DIR`, so user-level config never bleeds across hosts;
 *   - its own `PI_NOTIFY_LOG_FILE` and `PROBE_LOG`, so log cursors cannot drift between hosts;
 *   - fully offline: the fake provider emits events directly and a fetch trap proves it.
 *
 * Under Git Bash this script requires `MSYS_NO_PATHCONV=1`:
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

// Process-wide fixed environment (the three per-host variables are set inside makeHost).
process.env.PI_OFFLINE = "1";
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.PROBE_BLOCK_MS = String(BLOCK_MS);
// Pin the terminal mechanism: this machine is win32, where `auto` would raise a Windows toast, and
// an automated run must never pop a real system notification. The selection logic itself, including
// win32 to toast, is asserted exhaustively by test/terminal-channel.mjs.
process.env.PI_NOTIFY_CHANNEL = "osc777";
delete process.env.PI_NOTIFY_DISABLE;

// Network trap: any **external** access fails the regression, so being offline is enforced rather
// than assumed. Loopback is the exception: the webhook end-to-end assertion needs a local HTTP
// server, which uses no external network.
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
// stdout: capture the notification sequences and keep them off the developer's screen
// ---------------------------------------------------------------------------

const stdoutChunks = [];
const realStdoutWrite = process.stdout.write.bind(process.stdout);
// Escapes are built with the RegExp constructor so no raw ESC/BEL control byte appears in this
// source file, where it would be invisible and easily damaged by an editor.
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
/** OSC notifications written since the previous call (777 and 99). */
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
// Helpers
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

/** Extracts the body from a raw OSC 777 sequence, used to assert on body content. */
const OSC777_HEAD = new RegExp("^\\u001b\\]777;notify;");
const OSC777_TAIL = new RegExp("\\u0007$");
function oscBody(sequence) {
  const inner = sequence.replace(OSC777_HEAD, "").replace(OSC777_TAIL, "");
  return inner.includes(";") ? inner.slice(inner.indexOf(";") + 1) : "";
}

/**
 * Waits for asynchronous delivery to land.
 *
 * This is not a lazy sleep: the `agent_settled` handler only enqueues, and delivery happens in a
 * separate task afterwards, so the log has to be given time to settle. The criterion is "the log
 * file has not grown for 100ms", with a 3s ceiling.
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
 * Waits for a probe event to appear.
 *
 * A tool failure has to happen while the run is still going: `PROBE_DELAY_MS` makes the fake provider
 * answer later, then `agent_start` is awaited and `tool_execution_end` is fed to the plugin while the
 * run is still active. Timing comes from the probe file, never from a sleep.
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

/** Minimal `ExtensionUIContext` stub: the plugin only uses `notify`, but binding a UI is what triggers session_start. */
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
    // Default: nobody waits for the component unless a test drives it through `ui.custom`.
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

/**
 * Drives `ctx.ui.custom()` headlessly: the settings UI is treated as an ordinary component fed with
 * real terminal bytes.
 *
 * The command layer hands `custom()` an `{ render, handleInput, invalidate }` wrapper, so only the
 * rendered result is observable here, which is exactly what is asserted. Key matching uses a minimal
 * stub; the real `matchesKey` behaviour is covered with the actual library in test/settings-ui.mjs.
 */
const KEY_SEQUENCES = {
  "tui.select.up": ["\x1b[A", "\x1bOA"],
  "tui.select.down": ["\x1b[B", "\x1bOB"],
  "tui.select.confirm": ["\r", "\n"],
  "tui.select.cancel": ["\x1b"],
  "tui.select.pageUp": ["\x1b[5~"],
  "tui.select.pageDown": ["\x1b[6~"],
};

function createUiDriver() {
  const driver = {
    keys: [],
    renders: [],
    opened: false,
    setKeys(keys) { driver.keys = [...keys]; driver.renders = []; },
    get lastLines() { return driver.renders.at(-1) ?? []; },
    custom(factory) {
      driver.opened = true;
      const tui = { requestRender: () => {} };
      const theme = { fg: (_color, text) => text, bold: (text) => text };
      const keybindings = {
        matches: (data, id) => (KEY_SEQUENCES[id] ?? []).includes(data),
      };
      let result;
      const component = factory(tui, theme, keybindings, (value) => { result = value; });
      for (const key of driver.keys) {
        component.handleInput(key);
        driver.renders.push(component.render(80));
      }
      return Promise.resolve(result);
    },
  };
  return driver;
}

async function makeHost({ label, extensions, projectTrusted = true, userConfig, mode = "print", ui = {}, driver }) {
  const root = path.join(TMP, label);
  const agentDir = path.join(root, "agent");
  const probeFile = path.join(root, "probe.jsonl");
  const pluginFile = path.join(root, "plugin.jsonl");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
  fs.writeFileSync(probeFile, "");
  fs.writeFileSync(pluginFile, "");

  /** User-level config must be written **before** the session starts: the plugin reads it twice, in the factory and at session_start. */
  const userConfigFile = configModule.userConfigPath(agentDir);
  const userConfigRaw = userConfig === undefined
    ? undefined
    : (typeof userConfig === "string" ? userConfig : JSON.stringify(userConfig, null, 2));
  if (userConfigRaw !== undefined) {
    fs.mkdirSync(path.dirname(userConfigFile), { recursive: true });
    fs.writeFileSync(userConfigFile, userConfigRaw);
  }

  // Per host: its own user config directory plus two log files, so cursors cannot drift between hosts.
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
    uiContext: { ...stubUiContext(notices), ...(driver ? { custom: (factory) => driver.custom(factory) } : {}), ...ui },
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
    /** Raw user-level config written by the test, used to assert the plugin did not rewrite it. */
    userConfigRaw,
    /** Resolves the project-level config path so a test can prove the plugin never reads it. */
    projectConfigPath(...segments) {
      return path.join(root, ".pi", "pi-notification", ...segments);
    },
    driver,

    /** Feeds an event straight into the real extension runner; used by the hook regressions. */
    emit(event) {
      return session.extensionRunner.emit(event);
    },

    /** Delays the fake provider's next reply, opening a window in which the run is still active. */
    setModelDelay(ms) {
      if (ms === undefined) delete process.env.PROBE_DELAY_MS;
      else process.env.PROBE_DELAY_MS = String(ms);
    },

    async drain() {
      await waitForFileQuiet(pluginFile);
    },

    /** Clears every cursor so the next read contains only what happens from now on. */
    resetCursors() {
      probe();
      plugin();
      nextOscNotifications();
    },

    /** Runs a block and returns the probe, plugin and OSC deltas it produced. */
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

    /** Sends a prompt and returns that run's delta, deliveries and OSC included. */
    async prompt(text = "hi") {
      return host.during(() => session.prompt(text));
    },

    /**
     * Sends a prompt and injects one tool failure while the run is still going, through a real
     * `tool_execution_end`. The injection point is located by the probe's `agent_start` event, not
     * by a guessed sleep.
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

    /** Goes through Pi's real command dispatch; a pure command produces no agent lifecycle. */
    async command(text) {
      const delta = await host.during(() => session.prompt(text));
      return { ...delta, notice: notices.at(-1) };
    },

    writeUserConfig(raw) {
      fs.mkdirSync(path.dirname(host.userConfigPath), { recursive: true });
      fs.writeFileSync(host.userConfigPath, typeof raw === "string" ? raw : JSON.stringify(raw, null, 2));
    },

    /** Reads back the user-level default file, used for the sparse-write assertions. */
    readUserConfigRaw() {
      const raw = configModule.readUserConfigRaw(host.agentDir);
      return raw.ok ? raw.raw : undefined;
    },

    /** Writes the project-level config file to prove it is ignored: the layer was removed but the file still gets created. */
    writeProjectConfig(raw) {
      const file = path.join(host.root, ".pi", "pi-notification", "config.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof raw === "string" ? raw : JSON.stringify(raw, null, 2));
      return file;
    },

    removeUserConfig() {
      try {
        fs.unlinkSync(host.userConfigPath);
      } catch {
        // A missing file counts as already cleaned up.
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
// Phase 0: sanitizing and redaction (pure functions)
// ---------------------------------------------------------------------------

console.log("S1.5 / S3 / S5 / M3 回归：pi-notification");

const { sanitize, redact } = await import(pathToFileURL(path.join(PLUGIN_DIR, "src", "log.ts")).href);

await step("P0 控制字符清洗 / 脱敏", () => {
  // Whole OSC sequences are deleted, payload included: removing only the control bytes would leave
  // `]777;notify;...` behind as visible text.
  assert.equal(sanitize("\u001b]777;notify;a\u0007b"), "b");
  assert.equal(sanitize("done\u001b[31m!\u001b[0m"), "done!");
  assert.equal(sanitize("a\r\nb"), "a\nb");
  assert.equal(sanitize("  a   b  "), "a b");
  assert.equal(sanitize("\u202eevil"), "evil");
  assert.ok(!sanitize("a\u0007\u001b\u0008b").includes("\u0007"));
  assert.ok([...sanitize("z".repeat(400))].length <= 300);
  assert.doesNotMatch(redact("apiKey=sk-abcdefgh12345678"), /sk-abcdefgh12345678/);
  assert.doesNotMatch(redact("Authorization: Bearer supersecretvalue"), /supersecretvalue/);
  // The target is the home directory itself; the file name is useful diagnostic information and stays.
  assert.equal(redact(`open ${os.homedir()}/.pi/agent/auth.json`), "open ~/.pi/agent/auth.json");
});

// ---------------------------------------------------------------------------
// Host 1: judgement, dedupe, blocking and reload
// ---------------------------------------------------------------------------

/**
 * These four groups are about judgement semantics, not cooldown policy: coalescing and cooldown are
 * switched off (both zero), otherwise "two runs, two notifications" would be eaten by the cooldown.
 * Cooldown behaviour itself is covered by the `coalesce` host below and by test/service-coalesce.mjs.
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
  // `host.prompt()` is deliberately avoided because it drains first, which would turn the
  // "settle to next run" interval into a waiting period and measure the wait instead of blocking.
  // The minimum of several samples is taken because a single sample is skewed by GC and scheduling
  // jitter, which once produced a false failure at 265ms.
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
  // The SDK writes auth.json and models-store.json itself; what is asserted here is that the
  // **plugin** wrote nothing. The `pi-notification/` directory is the config directory this test
  // pre-seeded, so it is no longer a sign of a plugin write.
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
// Host 2: blocking control group, proving the measurement in C can detect blocking
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
// Host 3: config loading - the file is really read, and a broken config degrades instead of
// silently disabling everything
// ---------------------------------------------------------------------------

const configured = await makeHost({ label: "config", extensions: [PROBE_ENTRY, PLUGIN_ENTRY] });
await configured.useModel("probe-fake", "fake-model");

/** Rewrites the config, reloads (which re-emits session_start where the plugin re-reads) and runs one successful run. */
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
// Host 4: the project-level config layer was removed, so an existing file is still not read
// ---------------------------------------------------------------------------

/** Every config_loaded record of the plugin, including those from session_start rather than just one run. */
function configLoads(host) {
  return readJsonl(host.pluginFile).filter((row) => row.event === "config_loaded");
}

await step("I9 项目级配置已删除：即使项目被信任、文件就在那里，也不读它", async () => {
  const label = "project-ignored";
  const host = await makeHost({ label, extensions: [PROBE_ENTRY, PLUGIN_ENTRY], projectTrusted: true });
  await host.useModel("probe-fake", "fake-model");
  // First write a project-level config that ought to change behaviour: minLevel=error would make a
  // successful notification disappear.
  const file = host.writeProjectConfig({ version: 1, minLevel: "error", enabled: false });
  const delta = await host.during(() => host.session.reload());
  assert.ok(configLoads(host).length >= 1, "缺少 config_loaded 记录");
  assert.ok(
    configLoads(host).every((row) => !JSON.stringify(row.sources).includes(".pi")),
    "配置来源里出现了项目级路径，说明该层没被删掉",
  );
  // The project file exists on disk but the plugin never reads it, so the success notification still
  // follows the user-level and factory defaults.
  assert.equal(fs.existsSync(file), true);
  const run = await host.prompt("hi");
  assert.equal(run.deliveries.length, 1, "项目级配置被读了（成功通知应该还在）");
  assert.equal(delta.runtimeErrors ?? 0, 0);
  await host.dispose();
});

// ---------------------------------------------------------------------------
// Host 5: single entry point and the three value layers - `/notify` only opens the settings UI,
// Enter only changes this conversation, Ctrl+S writes one sparse field
// ---------------------------------------------------------------------------

/** Real terminal bytes, used to drive the component inside `ui.custom`. */
const K = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  esc: "\x1b",
  ctrlS: "\x13",
  ctrlT: "\x14",
  ctrlR: "\x12",
  ctrlO: "\x0f",
};

/** Keys pressed in order; the trailing Escapes close the component, since Esc in a detail view only goes one level up. */
const CLOSE = [K.esc, K.esc];

/**
 * Navigates to one setting and opens its detail view. The item order is the `buildSettingItems()`
 * order, which settings.ts owns, so the number of key presses is deterministic.
 */
async function keysToItem(id, after = []) {
  const settingsModule = await import(pathToFileURL(path.join(PLUGIN_DIR, "src", "settings.ts")).href);
  const items = settingsModule.buildSettingItems(configModule.defaultConfig());
  const index = items.findIndex((item) => item.id === id);
  assert.ok(index >= 0, `未知配置项: ${id}`);
  return [...Array.from({ length: index }, () => K.down), K.enter, ...after, ...CLOSE];
}

/** Moves the focus to one setting without opening it: on the list Ctrl+S applies to the focused item. */
async function keysToList(id, after = []) {
  const keys = await keysToItem(id, []);
  return [...keys.slice(0, keys.length - CLOSE.length), ...after, K.esc];
}

/**
 * Reads the sparse content of the user default file, stripping the NO_COALESCE fields the tests
 * pre-seeded, so an assertion can simply state "Ctrl+S wrote only this one item".
 */
function readSparse(host) {
  const raw = host.readUserConfigRaw();
  if (!raw) return raw;
  const clone = structuredClone(raw);
  delete clone.version;
  if (clone.coalesce) {
    delete clone.coalesce.windowMs;
    delete clone.coalesce.cooldownMs;
    if (Object.keys(clone.coalesce).length === 0) delete clone.coalesce;
  }
  return clone;
}

/**
 * The two actions folded into the settings UI, formerly `/notify reload` and `/notify status`.
 * They are driven with the real Ctrl+R and Ctrl+O to keep the "exercise the real path" constraint.
 */
async function reloadViaUi(host) {
  host.driver.setKeys([K.ctrlR, K.esc]);
  return host.during(() => host.session.prompt("/notify"));
}

async function statusViaUi(host) {
  host.driver.setKeys([K.ctrlO, K.esc]);
  await host.during(() => host.session.prompt("/notify"));
  return (host.driver.renders[0] ?? []).join("\n");
}

const commandDriver = createUiDriver();
const commander = await makeHost({
  label: "command",
  extensions: [PROBE_ENTRY, PLUGIN_ENTRY],
  driver: commandDriver,
});
await commander.useModel("probe-fake", "fake-model");

await step("J1 非 TUI：/notify 只打印状态与配置路径（凭据隐藏），不写盘不投递", async () => {
  const before = fs.existsSync(commander.userConfigPath) ? fs.readFileSync(commander.userConfigPath, "utf8") : undefined;
  const delta = await commander.command("/notify");
  assert.ok(delta.notice, "命令没有回显");
  assert.match(delta.notice.message, /pi-notification: 开启/);
  assert.match(delta.notice.message, /用户默认: /, "状态里应给出用户默认文件路径");
  assert.match(delta.notice.message, /设置界面仅 TUI 可用/);
  assert.match(delta.notice.message, /当前生效值/);
  assert.equal(delta.deliveries.length, 0, "/notify 不应产生投递");
  assert.equal(delta.notifies, 0);
  assert.ok(delta.plugin.some((row) => row.event === "notify_settings_view"));
  const after = fs.existsSync(commander.userConfigPath) ? fs.readFileSync(commander.userConfigPath, "utf8") : undefined;
  assert.equal(after, before, "非 TUI 的 /notify 不该写盘");
  // A pure command must not produce an agent lifecycle; same invariant as assertion A.
  for (const forbidden of ["agent_start", "settled_enter"]) {
    assert.ok(!events(delta.probe).includes(forbidden), `/notify 却出现了 ${forbidden}`);
  }
});

await step("J2 旧子命令已移除：/notify status 只给单一入口指路，不执行动作", async () => {
  for (const args of ["status", "test", "on", "off", "config", "reload"]) {
    const delta = await commander.command(`/notify ${args}`);
    assert.equal(delta.notice.type, "warning", `${args} 应给 warning 指路`);
    assert.match(delta.notice.message, /单一入口/);
    assert.equal(delta.deliveries.length, 0, `${args} 不该产生投递`);
    assert.ok(delta.plugin.some((row) => row.event === "notify_usage" && row.args === args));
  }
  assert.deepEqual(commander.runtimeErrors, []);
  await commander.dispose();
});

const settingsDriver = createUiDriver();
const settings = await makeHost({
  label: "settings",
  extensions: [PROBE_ENTRY, PLUGIN_ENTRY],
  mode: "tui",
  userConfig: NO_COALESCE,
  driver: settingsDriver,
});
await settings.useModel("probe-fake", "fake-model");

/** Opens the settings UI with a key sequence, through real command dispatch and the real component. */
async function driveSettings(keys) {
  settingsDriver.setKeys(keys);
  settingsDriver.opened = false;
  const delta = await settings.command("/notify");
  assert.equal(settingsDriver.opened, true, "TUI 下 /notify 应打开设置组件");
  return delta;
}

await step("J3 TUI：/notify 打开设置；Esc 关闭不改磁盘与内存", async () => {
  const before = fs.readFileSync(settings.userConfigPath, "utf8");
  const delta = await driveSettings([K.esc]);
  assert.equal(delta.deliveries.length, 0);
  assert.equal(fs.readFileSync(settings.userConfigPath, "utf8"), before, "取消/关闭不得写盘");
  assert.equal((await settings.prompt()).deliveries.length, 1, "关闭设置后行为应回到原样");
  assert.ok(delta.plugin.some((row) => row.event === "notify_settings_closed"));
  assert.deepEqual(settings.runtimeErrors, []);
});

await step("J4 footer 常驻：每一帧末尾都有 `Ctrl+S  save as default` 与折叠的三个快捷键", async () => {
  const delta = await driveSettings([K.down, K.esc]);
  const frames = settingsDriver.renders;
  assert.ok(frames.length >= 2, "应有按键后的渲染快照");
  for (const frame of frames) {
    const tail = frame.slice(-4).join("\n");
    assert.match(tail, /Ctrl\+S  save as default/, `footer 丢了 Ctrl+S 提示:\n${tail}`);
    assert.match(tail, /Ctrl\+T test/, `footer 丢了 test 快捷键:\n${tail}`);
    assert.match(tail, /Ctrl\+O status/, `footer 丢了状态总览快捷键:\n${tail}`);
  }
  assert.equal(delta.deliveries.length, 0);
});

await step("J5 Enter 只改本对话：立即生效，但用户文件一个字节都不写", async () => {
  const before = fs.readFileSync(settings.userConfigPath, "utf8");
  // runCompleted enabled: true to false; entering the detail view focuses the current-value row, so one
  // press of down reaches false.
  const keys = await keysToItem("rules.runCompleted.enabled", [K.down, K.enter]);
  const delta = await driveSettings(keys);
  assert.match(settingsDriver.renders.at(-3).join("\n"), /已应用（仅本对话）/, "缺少轻量确认");
  assert.equal(fs.readFileSync(settings.userConfigPath, "utf8"), before, "Enter 不得写用户文件");
  const run = await settings.prompt();
  assert.equal(run.deliveries.length, 0, "本对话选择未立即生效");
  assert.ok(
    delta.plugin.some((row) => row.event === "config_loaded" && row.overlay === true),
    `未记录本对话覆盖已生效: ${JSON.stringify(delta.plugin.map((row) => [row.event, row.overlay]))}`,
  );
  assert.equal(delta.runtimeErrors ?? 0, 0);
});

await step("J6 本对话覆盖跨 /reload 保留（同一 sessionId 恢复）", async () => {
  const reloaded = await settings.during(() => settings.session.reload());
  assert.ok(reloaded.plugin.some((row) => row.event === "config_loaded"), "reload 应重新读盘");
  const run = await settings.prompt();
  assert.equal(run.deliveries.length, 0, "reload 后本对话选择丢了");
  assert.deepEqual(settings.runtimeErrors, []);
});

await step("J7 Ctrl+S：只写这一项到用户默认文件，且标记与状态行同时给出反馈", async () => {
  // Ctrl+S on the list applies to the focused item; the current value in this conversation is already
  // false, which is what should be frozen.
  const saved = await driveSettings(await keysToList("rules.runCompleted.enabled", [K.ctrlS]));
  assert.ok(
    saved.plugin.some((row) => row.event === "notify_default_saved" && row.item === "rules.runCompleted.enabled"),
    "缺少 notify_default_saved 记录",
  );
  const frame = settingsDriver.renders.at(-1).join("\n");
  assert.match(frame, /已保存为默认/, "缺少保存确认");
  assert.deepEqual(
    readSparse(settings),
    { rules: { runCompleted: { enabled: false } } },
    `用户文件应只多出这一项: ${JSON.stringify(settings.readUserConfigRaw())}`,
  );
  assert.equal((await settings.prompt()).deliveries.length, 0);
});

await step("J8 Ctrl+S 再保存另一项：两项并存，其余字段不出现", async () => {
  const delta = await driveSettings(await keysToList("content.includeCost", [K.ctrlS]));
  assert.equal(delta.deliveries.length, 0);
  assert.deepEqual(readSparse(settings), {
    rules: { runCompleted: { enabled: false } },
    content: { includeCost: true },
  });
});

await step("J9 Ctrl+R 重读配置、Ctrl+O 状态总览可用且不产生副作用", async () => {
  const reload = await driveSettings([K.ctrlR, K.esc]);
  assert.ok(reload.plugin.some((row) => row.event === "notify_reload"));
  assert.match(settingsDriver.renders[0].join("\n"), /已重新读取配置/);
  assert.equal(reload.deliveries.length, 0);

  const status = await driveSettings([K.ctrlO, K.down, K.esc]);
  const frame = settingsDriver.renders[1].join("\n");
  assert.match(frame, /配置来源/, `状态总览应显示状态文本:\n${frame}`);
  assert.match(frame, /投递统计/);
  assert.equal(status.deliveries.length, 0, "状态总览只读，不得产生投递");
  assert.equal(status.notifies, 0);
  assert.deepEqual(settings.runtimeErrors, []);
});

await step("J10 Ctrl+T 真的走一遍投递链路（折叠的旧 /notify test）", async () => {
  const delta = await driveSettings([K.ctrlT, K.esc]);
  assert.match(settingsDriver.renders[0].join("\n"), /已提交自检通知/);
  assert.equal(delta.deliveries.length, 1, `自检通知未投递: ${JSON.stringify(delta.deliveries)}`);
  assert.equal(delta.deliveries[0].kind, "run_completed");
  assert.equal(delta.notifies, 1, "自检通知应真的写出 OSC");
  assert.ok(delta.plugin.some((row) => row.event === "notify_test"));
});

await step("J11 渠道开关：Ctrl+S 写整个 providers 数组，下一次运行零投递", async () => {
  const before = fs.readFileSync(settings.userConfigPath, "utf8");
  // Turn the channel off with Enter first, then freeze it with Ctrl+S from the list.
  const delta = await driveSettings(await keysToItem("provider:terminal", [K.down, K.enter, K.ctrlS]));
  assert.equal(delta.deliveries.length, 0);
  const raw = settings.readUserConfigRaw();
  assert.equal(Array.isArray(raw.providers), true, `providers 应落盘为数组: ${JSON.stringify(raw.providers)}`);
  assert.equal(raw.providers[0].id, "terminal");
  assert.equal(raw.providers[0].enabled, false);
  assert.equal((await settings.prompt()).deliveries.length, 0, "渠道已关却仍在投递");
  assert.deepEqual(settings.runtimeErrors, []);
  // Restore the file so later assertions are unaffected, and clear the key queue so no leftover key
  // is replayed when the UI is opened again.
  fs.writeFileSync(settings.userConfigPath, before);
  settingsDriver.setKeys([]);
});

await step("J12 写盘失败：状态行报错、标记不迁移、内存里当前值不回滚", async () => {
  const before = fs.readFileSync(settings.userConfigPath, "utf8");
  fs.writeFileSync(settings.userConfigPath, "{ 坏掉的 JSON");
  const delta = await driveSettings([K.ctrlS, K.esc]);
  const frame = settingsDriver.renders.at(-1).join("\n");
  assert.match(frame, /保存失败/, `状态行应报错:\n${frame}`);
  assert.ok(!frame.includes(" · default") || !frame.includes("已保存为默认"));
  assert.deepEqual(settings.runtimeErrors, []);
  fs.writeFileSync(settings.userConfigPath, before);
  // After the broken file is repaired the behaviour is normal again.
  assert.equal((await settings.prompt()).deliveries.length, 0);
});

await step("J13 强制静默不可被界面绕过：不允许把 enabled 打开，也不写盘", async () => {
  process.env.PI_NOTIFY_DISABLE = "1";
  try {
    const keys = await keysToItem("enabled", [K.up, K.enter, K.ctrlS, K.esc]);
    const delta = await driveSettings(keys);
    assert.equal(delta.deliveries.length, 0);
    const frames = settingsDriver.renders.map((frame) => frame.join("\n"));
    assert.ok(
      frames.some((frame) => /强制静默/.test(frame)),
      `应给出被强制静默的原因:\n${frames.at(-2)}`,
    );
    const raw = settings.readUserConfigRaw();
    assert.equal(raw?.enabled, undefined, "强制关闭不得被写成用户默认");
  } finally {
    delete process.env.PI_NOTIFY_DISABLE;
  }
  assert.deepEqual(settings.runtimeErrors, []);
});

await step("J14 非 TUI 模式守卫：print/json/rpc 都不打开组件、不写盘、凭据不外泄", async () => {
  for (const mode of ["print", "json", "rpc"]) {
    const host = await makeHost({
      label: `settings-${mode}`,
      extensions: [PROBE_ENTRY, PLUGIN_ENTRY],
      mode,
      userConfig: { providers: [{ id: "debug", type: "debug", options: { headers: { "X-Private": "private-value-123" } } }] },
      ui: {
        custom: () => { throw new Error("非 TUI 不得打开 ctx.ui.custom"); },
        select: () => { throw new Error("非 TUI 不得 select"); },
        confirm: () => { throw new Error("非 TUI 不得 confirm"); },
      },
    });
    const before = fs.readFileSync(host.userConfigPath, "utf8");
    const result = await host.command("/notify");
    assert.ok(result.notice.message.includes(host.userConfigPath), `${mode}: 应打印用户默认文件路径`);
    assert.match(result.notice.message, /当前生效值/);
    assert.doesNotMatch(result.notice.message, /private-value-123/, `${mode}: 不得输出渠道凭据`);
    assert.equal(fs.readFileSync(host.userConfigPath, "utf8"), before, `${mode}: 非 TUI 不得写盘`);
    assert.deepEqual(host.runtimeErrors, []);
    await host.dispose();
  }
});

await settings.dispose();


// ---------------------------------------------------------------------------
// Host: content fields - session label, cost, context usage and assistant excerpt
// ---------------------------------------------------------------------------

const CONTENT_CONFIG = {
  version: 1,
  coalesce: { windowMs: 0, cooldownMs: 0 },
  content: { includeAssistantExcerpt: true },
};

const contentHost = await makeHost({
  label: "content",
  extensions: [PROBE_ENTRY, PLUGIN_ENTRY],
  mode: "tui",
  userConfig: CONTENT_CONFIG,
  driver: createUiDriver(),
});
await contentHost.useModel("probe-fake", "fake-model");

/** Every content-field assertion controls the fake provider's output and must clean up afterwards, otherwise it leaks into later hosts. */
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

/** Runs one successful run and returns the body of that run's terminal notification. */
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
  // A leftover field from an older config: it is no longer meaningful, but one removed field must not
  // degrade the whole config.
  assert.deepEqual(
    configModule.mergeConfig(configModule.defaultConfig(), { version: 1, content: { includePromptExcerpt: true } }, "test").errors,
    [],
  );
  // A wrong type in a new field must still degrade: strict validation must not loosen as fields are added.
  for (const content of [{ includeAssistantExcerpt: "yes" }, { includeSessionLabel: 1 }, { includeCost: null }]) {
    assert.ok(configModule.mergeConfig(configModule.defaultConfig(), { content }, "test").errors.length > 0, JSON.stringify(content));
  }
});

await step("R2 首段标识：未命名时回退项目目录名，`/name` 后会话名优先，可整栏关闭", async () => {
  // This host's cwd is TMP/content, so an unnamed session must fall back to [content].
  const fallback = await runBody();
  assert.ok(fallback.startsWith(`[${contentHost.label}]`), `未命名时应回退到项目目录名: ${fallback}`);

  contentHost.session.setSessionName("重构登录");
  await contentHost.drain(); // `session_info_changed` 是 void 发出的，先等 handler 落盘
  assert.ok(await runBody().then((body) => body.startsWith("[重构登录]")), "会话名应优先于项目目录名");
  const changed = findBy(readJsonl(contentHost.pluginFile), (row) => row.event === "session_name_changed", "session_name_changed");
  assert.equal(changed.hasName, true);
  assert.ok(!JSON.stringify(changed).includes("重构登录"), "日志不得记下会话名本身");

  // Turning both sources off removes the whole column.
  contentHost.writeUserConfig({ ...CONTENT_CONFIG, content: { includeAssistantExcerpt: true, includeSessionLabel: false } });
  await reloadViaUi(contentHost);
  const off = await runBody();
  assert.ok(!off.startsWith("["), `关掉 includeSessionLabel 后不该再有标识: ${off}`);
  contentHost.writeUserConfig(CONTENT_CONFIG);
  await reloadViaUi(contentHost);
});

await step("R3 assistant 摘录：默认关闭；开启后 10 字截断 + 截断标记 + 悬空标点去除", async () => {
  // Off by default: the folded Ctrl+R re-reads a config without that field instead of building another host.
  contentHost.writeUserConfig({ version: 1, coalesce: { windowMs: 0, cooldownMs: 0 } });
  await reloadViaUi(contentHost);
  await withEnv({ PROBE_ASSISTANT_TEXT: "0123456789ABCDEF" }, async () => {
    assert.ok(!(await runBody()).includes("0123456789"), "摘录默认关闭，绝不能因为消息里存在模型回复就带出去");
  });

  contentHost.writeUserConfig(CONTENT_CONFIG);
  await reloadViaUi(contentHost);
  await withEnv({ PROBE_ASSISTANT_TEXT: "0123456789ABCDEF" }, async () => {
    const body = await runBody();
    assert.ok(body.includes("0123456789…"), `应带出前 10 个字符并标出截断: ${body}`);
    assert.ok(!body.includes("0123456789A"), `摘录超过 10 个字符: ${body}`);
  });
  // Exactly 10 characters: nothing was cut, so no ellipsis may be added; a complete short sentence
  // must not be reported as truncated.
  await withEnv({ PROBE_ASSISTANT_TEXT: "0123456789" }, async () => {
    const body = await runBody();
    assert.ok(body.includes("0123456789") && !body.includes("…"), `完整短句不该补截断标记: ${body}`);
  });
  // Dangling punctuation: when the tenth character is punctuation it is dropped, because a tail like
  // "fixed login, changed" reads as if something broke.
  await withEnv({ PROBE_ASSISTANT_TEXT: "abcdefghi。后面还有更多内容" }, async () => {
    const body = await runBody();
    assert.ok(body.includes("abcdefghi…"), `截断处的悬空标点应去掉: ${body}`);
  });
  await withEnv({ PROBE_ASSISTANT_TEXT: "a\nb" }, async () => {
    assert.ok((await runBody()).includes("a b"), "换行应归一为空格（否则会撑破单行通知）");
  });
  // Injection surface: a model reply can contain sequences that forge a notification, so the excerpt
  // is sanitized before it enters the body.
  await withEnv({ PROBE_ASSISTANT_TEXT: "x\u001b]777;notify;evil\u0007y" }, async () => {
    const body = await runBody();
    assert.ok(body.includes("xy"), `转义序列应整段删除（含载荷）: ${JSON.stringify(body)}`);
    assert.ok(!body.includes("evil"), "摘录里不得出现转义序列的载荷");
  });
});

await step("R4 成本：本次 + 会话累计；includeCost=false 时两者一起消失", async () => {
  await withEnv({ PROBE_COST_USD: "0.0123" }, async () => {
    // First run: this run and the cumulative total are equal, so the value is shown once instead of
    // repeating the same number as "cumulative".
    const first = await runBody();
    assert.ok(first.includes("成本 $0.0123"), `缺少本次成本: ${first}`);
    assert.ok(!first.includes("累计"), `首次运行不该重复累计值: ${first}`);
    // Second run: the total accumulates across runs inside one instance.
    const second = await runBody();
    assert.ok(second.includes("成本 $0.0123（累计 $0.0246）"), `累计口径不对: ${second}`);
  });
  // With the switch off, cost and context usage disappear together: one switch governs both fields.
  contentHost.writeUserConfig({ ...CONTENT_CONFIG, content: { includeAssistantExcerpt: true, includeCost: false } });
  await reloadViaUi(contentHost);
  await withEnv({ PROBE_COST_USD: "0.0123", PROBE_CONTEXT_TOKENS: "42000" }, async () => {
    const body = await runBody();
    assert.ok(!body.includes("成本") && !body.includes("上下文"), `关闭 includeCost 后仍有成本信息: ${body}`);
  });
  contentHost.writeUserConfig(CONTENT_CONFIG);
  await reloadViaUi(contentHost);
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
// Host 8: coalescing window and cooldown - the defaults really take effect under a real host
// ---------------------------------------------------------------------------

await step("L0 默认参数的合并/冷却与出厂默认一致", () => {
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
// Host 9: tool failures, compaction failure and waiting for user input
//
// A tool failure is injected as a real `tool_execution_end` **while the run is still active** (located
// by the probe's `agent_start`, not by a guessed sleep): `PROBE_DELAY_MS` makes the fake provider
// answer 250ms later, which leaves a wide enough window.
// ---------------------------------------------------------------------------

const S6_BASE = {
  version: 1,
  // Cooldown and coalescing off, so hook behaviour itself is what gets pinned down; cooldown is covered
  // by L1/L2 and K3.
  coalesce: { windowMs: 0, cooldownMs: 0 },
  rules: {
    toolFailed: { enabled: true, level: "warning", channels: ["terminal"] },
    compactFailed: { enabled: true, level: "error", channels: ["terminal"] },
    waitingForUser: { enabled: true, level: "info", channels: ["terminal"] },
  },
};

const s6 = await makeHost({
  label: "s6",
  extensions: [PROBE_ENTRY, PLUGIN_ENTRY],
  mode: "tui",
  userConfig: S6_BASE,
  driver: createUiDriver(),
});
await s6.useModel("probe-fake", "fake-model");
s6.setModelDelay(250);

/** Rewrites the config, reloads (re-reading from disk) and returns the plugin delta produced by the reload. */
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
    // Later events of the same run, a second tool and the run result, are absorbed by the default
    // 1500ms window.
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

  // `custom` says nothing about user input because the loader and progress UI emit it too, so it is
  // excluded permanently.
  const custom = await s6.during(() => s6.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" }));
  assert.equal(custom.deliveries.length, 0, "custom 提示不得产生通知");
  assert.equal(custom.notifies, 0);

  // A nested prompt produces no inner span and the end reports the outer kind, so the two cannot be
  // paired by kind.
  await s6.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "确认 X" });
  const waiting = await statusViaUi(s6);
  assert.match(waiting, /正在等你输入/, "status 应反映 waiting 状态");
  await s6.emit({ type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm", title: "确认 X" });
  const afterEnd = await statusViaUi(s6);
  assert.doesNotMatch(afterEnd, /正在等你输入/, "end 之后应复位");
});

await step("K6 shutdown/reload 兜底复位 waiting（强杀时可能收不到 end）", async () => {
  await s6.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "input", title: "输入 Y" });
  const before = await statusViaUi(s6);
  assert.match(before, /正在等你输入/);

  await s6.during(() => s6.session.reload());
  const after = await statusViaUi(s6);
  assert.doesNotMatch(after, /正在等你输入/, "reload 后不得还挂着等待状态");
});

s6.setModelDelay(undefined);
await s6.dispose();

// ---------------------------------------------------------------------------
// Host 10: webhook end to end - adding a channel means one new file, one registry line and one config entry
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

await step("M3 反回退：lifecycle/rules 不碰渠道名，service 不认识 webhook", () => {
  const read = (rel) => fs.readFileSync(path.join(PLUGIN_DIR, rel), "utf8");
  // Only real import statements are inspected: a comment mentioning `providers/*` documents this
  // constraint and is not a violation.
  const importsProviders = /from\s+"[^"]*providers\//;
  for (const rel of ["src/lifecycle.ts", "src/rules.ts"]) {
    const source = read(rel);
    assert.doesNotMatch(source, importsProviders, `${rel} 不得 import providers/*`);
    assert.doesNotMatch(source, /terminal|webhook/, `${rel} 不得出现渠道名`);
  }
  // `debug` is also a log level name, so it is not checked as a channel name.
  assert.doesNotMatch(read("src/service.ts"), /terminal|webhook/, "service 不得出现渠道名");
  assert.doesNotMatch(read("extensions/index.ts"), /pi\.on\(\s*"agent_end"/, "不得注册 agent_end（硬约束 1）");
  assert.doesNotMatch(
    read("src/providers/webhook.ts"),
    /from "\.\.\/(lifecycle|rules|config)\.ts"/,
    "渠道不得 import 判定/配置层",
  );
});

await webhookHost.dispose();
await new Promise((resolve) => hookServer.close(resolve));
delete process.env.PI_NOTIFY_TEST_WEBHOOK_SECRET;

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

globalThis.fetch = realFetch;

if (failures === 0) {
  console.log(
    "\n通过：判定/去重/阻塞/reload（A–F,H）+ 配置读盘（I1–I9）+ 单一入口与三层值（J1–J14）"
    + " + 合并/冷却（L0–L2）+ 工具失败/压缩失败/等待输入（K1–K6）+ Webhook（M1–M3）全部成立。",
  );
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
} else {
  console.error(`\n失败：${failures} 项断言未通过。临时目录保留：${TMP}`);
  process.exit(1);
}
