// Real Pi SDK/tool pipeline, entirely offline; responses are deterministic fixtures, not LLM calls.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveSdk } from "./sdk.mjs";
import { EDIT_RECOVERY } from "../extensions/index.ts";

const source = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
const packageRoot = path.dirname(path.dirname(source));
const installed = process.env.PI_EDIT_FALLBACK_INSTALLED ?? path.join(
  process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent"), "extensions", "pi-edit-fallback.ts",
);
const temporary = mkdtempSync(path.join(tmpdir(), "pi-edit-fallback-host-"));
const agentDir = path.join(temporary, "agent");
const cwd = path.join(temporary, "workspace");
mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
mkdirSync(cwd);

const networkAttempts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  networkAttempts.push(String(args[0]));
  throw new Error("Network is forbidden in this offline test");
};
process.env.PI_OFFLINE = "1";
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(temporary, "sessions");

const sessions = [];
try {
  const sdkEntry = resolveSdk();
  const sdk = await import(pathToFileURL(sdkEntry).href);
  const ai = await import(pathToFileURL(path.resolve(path.dirname(sdkEntry), "../../pi-ai/dist/index.js")).href);
  const hostPackage = JSON.parse(readFileSync(path.join(path.dirname(sdkEntry), "..", "package.json"), "utf8"));
  console.log(`Host: Pi ${hostPackage.version}, ${process.version}, ${process.platform}`);
  assert.equal(hostPackage.version, "1.5.0", "Host regression tests require the exact Pi 1.5.0 SDK");

  if (existsSync(installed)) {
    assert.equal(readFileSync(installed, "utf8"), readFileSync(source, "utf8"));
    console.log("PASS installed entry is byte-identical to source");
  } else {
    console.log("SKIP personal single-file entry check; package install is verified below");
  }

  // Also retain coverage for the alternative single-file auto-discovery mode.
  const autoEntry = path.join(agentDir, "extensions", "pi-edit-fallback.ts");
  copyFileSync(source, autoEntry);
  const autoLoader = new sdk.DefaultResourceLoader({
    cwd, agentDir, settingsManager: sdk.SettingsManager.inMemory({}, { projectTrusted: false }),
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await autoLoader.reload();
  assert.deepEqual(autoLoader.getExtensions().errors, []);
  assert.equal(autoLoader.getExtensions().extensions.length, 1);
  rmSync(autoEntry);
  console.log("PASS alternative single-file auto-discovery (removed before package install)");

  const cliEntry = path.join(path.dirname(sdkEntry), "cli.js");
  function cli(...args) {
    const output = execFileSync(process.execPath, [cliEntry, ...args], {
      cwd, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    console.log(`CLI ${args[0]}: ${output.trim()}`);
    return output;
  }
  const readSettings = () => JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8"));
  assert.match(cli("list"), /No packages installed/);
  cli("install", packageRoot);
  assert.equal(readSettings().packages.length, 1);
  assert.match(cli("list").replaceAll("\\\\", "/"), /pi-edit-fallback/);
  assert.ok(!existsSync(autoEntry), "Package and single-file installations must not coexist");
  console.log("PASS isolated CLI install → list: one persisted local package, no copied entry");

  const runtime = await sdk.ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(agentDir, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerProvider("edit-recovery-test", {
    baseUrl: "http://offline.invalid/v1",
    apiKey: "offline-test-not-a-real-key",
    api: "openai-completions",
    models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
  });
  const model = runtime.getModel("edit-recovery-test", "fixture");
  assert.ok(model);
  const errors = [];

  async function makeSession(enabled) {
    const settingsManager = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    settingsManager.setRetryEnabled(false);
    settingsManager.setCompactionEnabled(false);
    const loader = new sdk.DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      noExtensions: !enabled, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions.length, enabled ? 1 : 0);
    const { session } = await sdk.createAgentSession({
      cwd, agentDir, model, modelRuntime: runtime, thinkingLevel: "off", settingsManager,
      resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(cwd),
    });
    sessions.push(session);
    await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
    return { session, loader };
  }

  const baseline = await makeSession(false);
  const host = await makeSession(true);
  const session = host.session;
  const declarations = (target) => target.agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const initialDeclarations = structuredClone(declarations(baseline.session));
  const initialPrompt = baseline.session.systemPrompt;
  assert.deepEqual(declarations(session), initialDeclarations);
  assert.equal(session.systemPrompt, initialPrompt);
  assert.deepEqual(session.getActiveToolNames(), baseline.session.getActiveToolNames());
  const extension = host.loader.getExtensions().extensions[0];
  assert.equal(path.resolve(extension.path), source, "Installed manifest must load the expected source entry");
  assert.ok(extension.handlers.has("tool_result"));
  assert.deepEqual([...extension.handlers.keys()], ["tool_result"]);
  assert.equal(extension.toolRenderers?.length, 1);
  assert.equal(extension.tools.size, 0);
  assert.equal(extension.commands.size, 0);
  console.log("PASS auto-discovery/Jiti, unchanged tools, schemas and system prompt");

  let callNumber = 0;
  const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const messages = (content, stopReason) => ({ role: "assistant", content, stopReason,
    api: model.api, provider: model.provider, model: model.id, usage: structuredClone(zeroUsage), timestamp: Date.now() });

  let modelRequest = [];
  async function execute(toolName, args) {
    const id = `fixture-${++callNumber}`;
    const responses = [
      messages([{ type: "toolCall", id, name: toolName, arguments: args }], "toolUse"),
      messages([{ type: "text", text: "Fixture complete." }], "stop"),
    ];
    let responseCount = 0;
    session.agent.streamFunction = (_model, context) => {
      // Capture what the model actually receives for this request.
      modelRequest = context?.messages ?? [];
      const message = responses[responseCount++];
      assert.ok(message, "Extension must not trigger extra model turns");
      const stream = ai.createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
      return stream;
    };
    await session.prompt("Execute the deterministic offline tool fixture.");
    assert.equal(responseCount, 2, "Only the tool turn and normal final response are expected");
    const result = session.messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
    assert.ok(result, `Missing result for ${toolName}: ${session.getLastAssistantText()}`);
    return result;
  }
  const textOf = (result) => result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const countHints = (result) => textOf(result).split("Edit recovery:").length - 1;
  const toolResultSeenByModel = (toolCallId) => modelRequest
    .filter((message) => message.role === "toolResult" && message.toolCallId === toolCallId)
    .flatMap((message) => message.content.filter((block) => block.type === "text").map((block) => block.text))
    .join("\n");

  const target = path.join(cwd, "sample.txt");
  const original = "header\nfirst\nvalue=old\nkeep first\nsecond\nvalue=old\nkeep second\nfooter\n";
  writeFileSync(target, original);
  execFileSync("git", ["init", "--quiet"], { cwd });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd });
  execFileSync("git", ["add", "sample.txt"], { cwd });
  let result = await execute("edit", { path: "sample.txt", edits: [{ oldText: "header", newText: "updated header" }] });
  assert.equal(result.isError, false);
  assert.equal(countHints(result), 0);
  assert.ok(result.details.diff);
  assert.ok(result.details.patch);
  assert.equal(readFileSync(target, "utf8"), original.replace("header", "updated header"));
  console.log("PASS real native edit success: no hint, normal result/diff preserved");

  const beforeDuplicate = readFileSync(target, "utf8");
  result = await execute("edit", { path: "sample.txt", edits: [{ oldText: "value=old", newText: "value=new" }] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Found 2 occurrences of the text in sample\.txt\./);
  assert.equal(countHints(result), 1);
  assert.equal(readFileSync(target, "utf8"), beforeDuplicate);
  console.log("PASS real single-edit ambiguity: original error plus one hint, isError=true, no writes");

  // The hint must reach the model even though the display keeps the native rendering.
  assert.match(toolResultSeenByModel(result.toolCallId ?? ""), /Edit recovery:/);
  assert.equal(toolResultSeenByModel(result.toolCallId ?? "").split("Edit recovery:").length - 1, 1);
  console.log("PASS the model request carries the hint exactly once");

  // Pi 1.5.0's real resolver chain must preserve native output at multiple TUI widths.
  const renderersEntry = path.join(path.dirname(sdkEntry), "core", "tools", "renderers", "index.js");
  assert.ok(existsSync(renderersEntry), "Pi 1.5.0 must expose built-in renderers");
  assert.equal(typeof sdk.ToolExecutionComponent, "function", "Pi 1.5.0 must export ToolExecutionComponent");
  const { withBuiltInRenderers } = await import(pathToFileURL(renderersEntry).href);
  sdk.initTheme("dark", false);
  const resolved = session.extensionRunner.resolveToolRenderers("edit", () => withBuiltInRenderers("edit", session.getToolDefinition("edit")));
  const native = withBuiltInRenderers("edit", session.getToolDefinition("edit"));
  assert.ok(resolved?.renderResult && native?.renderResult);
  const strip = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");
  const drawEdit = (content, definition, width, expanded) => {
    const component = new sdk.ToolExecutionComponent(
      "edit",
      "render-check",
      { path: "sample.txt", edits: [{ oldText: "value=old", newText: "value=new" }] },
      { outputPad: 1 },
      definition,
      { requestRender() {} },
      cwd,
    );
    component.setExpanded(expanded);
    component.setArgsComplete();
    component.updateResult({ content, details: undefined, isError: true }, false);
    return component.render(width).map(strip).join("\n");
  };
  const rawContent = result.content.filter((block) => !(block.type === "text" && block.text === EDIT_RECOVERY));
  assert.equal(result.content.length - rawContent.length, 1, "Fixture must have one added hint");
  for (const width of [40, 70, 110]) {
    for (const expanded of [false, true]) {
      const drawn = drawEdit(result.content, resolved, width, expanded);
      const baselineDrawn = drawEdit(rawContent, native, width, expanded);
      assert.equal(drawn, baselineDrawn, `Pi 1.5 native TUI layout diverged at width=${width}, expanded=${expanded}`);
      assert.ok(!drawn.includes("Edit recovery:") && !drawn.includes("Patch safety:"));
    }
  }
  assert.match(textOf(result), /Edit recovery:/, "the model-facing result retains the hint");
  console.log("PASS Pi 1.5.0 real renderer chain: native TUI output at 40/70/110 columns, collapsed/expanded");
  const bashRenderers = session.extensionRunner.resolveToolRenderers("bash", () => withBuiltInRenderers("bash", session.getToolDefinition("bash")));
  assert.ok(bashRenderers?.renderResult, "Unrelated bash renderer must remain available");

  result = await execute("edit", { path: "sample.txt", edits: [
    { oldText: "updated header", newText: "should not be written" },
    { oldText: "value=old", newText: "value=new" },
  ] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Found 2 occurrences of edits\[1\]/);
  assert.equal(countHints(result), 1);
  assert.equal(readFileSync(target, "utf8"), beforeDuplicate);
  console.log("PASS real batch ambiguity: correct diagnostic and atomic native failure");

  result = await execute("edit", { path: "sample.txt", edits: [{ oldText: "second\nvalue=old\nkeep second", newText: "second\nvalue=new\nkeep second" }] });
  assert.equal(result.isError, false);
  assert.equal(countHints(result), 0);
  assert.equal(readFileSync(target, "utf8"), beforeDuplicate.replace("second\nvalue=old", "second\nvalue=new"));
  console.log("PASS retry with unique context uses native edit and changes only the target");

  for (const [name, args] of [
    ["not-found", { path: "sample.txt", edits: [{ oldText: "absent", newText: "x" }] }],
    ["missing-file", { path: "missing.txt", edits: [{ oldText: "x", newText: "y" }] }],
    ["empty-oldText", { path: "sample.txt", edits: [{ oldText: "", newText: "x" }] }],
    ["overlap", { path: "sample.txt", edits: [{ oldText: "first\nvalue=old", newText: "x" }, { oldText: "value=old", newText: "y" }] }],
  ]) {
    let nativeError;
    try { await sdk.createEditTool(cwd).execute(`raw-${name}`, args); }
    catch (error) { nativeError = error.message; }
    assert.ok(nativeError);
    const before = readFileSync(target, "utf8");
    result = await execute("edit", args);
    assert.equal(result.isError, true);
    assert.equal(textOf(result), nativeError);
    assert.equal(countHints(result), 0);
    assert.equal(readFileSync(target, "utf8"), before);
  }
  console.log("PASS other native edit failures are byte-identical to native diagnostics");

  // Exercise the real chained runner, including the Pi 1.4 structuredContent drop rule.
  const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
  const synthetic = {
    type: "tool_result", toolName: "edit", toolCallId: "structured", parentToolCallId: "parent",
    input: {}, isError: true, content: [{ type: "text", text: "Each oldText must be unique." }, image],
    details: { keep: "details" }, structuredContent: { keep: "structured" }, usage: zeroUsage,
  };
  const enhanced = await session.extensionRunner.emitToolResult(synthetic);
  assert.equal(enhanced.isError, true);
  assert.equal(enhanced.details, synthetic.details);
  assert.equal(enhanced.structuredContent, synthetic.structuredContent);
  assert.equal(enhanced.usage, synthetic.usage);
  assert.equal(enhanced.content[1], image);
  assert.equal(await session.extensionRunner.emitToolResult({ ...synthetic, ...enhanced }), undefined);
  assert.equal(synthetic.content.length, 2);
  console.log("PASS real runner preserves structuredContent/details/usage/images and deduplicates");

  const oldRunner = session.extensionRunner;
  await session.reload(); // Same SDK reload implementation used by interactive /reload.
  assert.notEqual(session.extensionRunner, oldRunner);
  assert.deepEqual(host.loader.getExtensions().errors, []);
  assert.equal(host.loader.getExtensions().extensions.length, 1);
  assert.equal(host.loader.getExtensions().extensions[0]?.toolRenderers?.length, 1);
  assert.deepEqual(declarations(session), initialDeclarations);
  assert.equal(session.systemPrompt, initialPrompt);
  result = await execute("edit", { path: "sample.txt", edits: [{ oldText: "keep", newText: "changed" }] });
  assert.equal(result.isError, true);
  assert.equal(countHints(result), 1);
  console.log("PASS SDK reload: fresh runtime, one hint, unchanged prompt and tool schemas");

  // Test-owned fallback: standard patch through native bash. The extension never runs it.
  const beforePatch = readFileSync(target, "utf8");
  const patch = "diff --git a/sample.txt b/sample.txt\n--- a/sample.txt\n+++ b/sample.txt\n@@ -1,6 +1,6 @@\n updated header\n first\n-value=old\n+value=patched\n keep first\n second\n value=new\n";
  writeFileSync(path.join(cwd, "recovery.patch"), patch);
  result = await execute("bash", { command: "git apply --check recovery.patch && git apply recovery.patch && git diff --check && git diff -- sample.txt" });
  assert.equal(result.isError, false, textOf(result));
  assert.equal(countHints(result), 0);
  assert.equal(readFileSync(target, "utf8"), beforePatch.replace("first\nvalue=old", "first\nvalue=patched"));
  assert.match(textOf(result), /\+value=patched/);
  assert.ok(readFileSync(target, "utf8").startsWith("updated header\n"));
  assert.ok(readFileSync(target, "utf8").includes("second\nvalue=new\n"));
  const afterPatch = readFileSync(target, "utf8");
  result = await execute("bash", { command: "git apply --check recovery.patch && git apply recovery.patch" });
  assert.equal(result.isError, true);
  assert.equal(countHints(result), 0);
  assert.equal(readFileSync(target, "utf8"), afterPatch);
  console.log("PASS test-owned native bash fallback: checked standard patch, unrelated edits retained, failed check does not apply");

  result = await execute("edit", { path: "sample.txt", edits: [{ oldText: "footer", newText: "updated footer" }] });
  assert.equal(result.isError, false);
  assert.equal(countHints(result), 0);
  console.log("PASS subsequent edits still use unmodified native edit");

  cli("remove", packageRoot);
  assert.deepEqual(readSettings().packages, []);
  assert.match(cli("list"), /No packages installed/);
  await session.reload();
  assert.deepEqual(host.loader.getExtensions().errors, []);
  assert.equal(host.loader.getExtensions().extensions.length, 0);
  assert.deepEqual(declarations(session), initialDeclarations);
  result = await execute("edit", { path: "sample.txt", edits: [{ oldText: "keep", newText: "changed" }] });
  assert.equal(result.isError, true);
  assert.equal(countHints(result), 0);
  assert.ok(existsSync(source), "Removing a local package must not delete its source");
  console.log("PASS isolated CLI remove → list → SDK reload: no extension or hint, source retained");
  assert.deepEqual(errors, []);
  assert.deepEqual(networkAttempts, []);
  console.log("PASS zero external network requests and zero extension runtime errors");
} finally {
  for (const session of sessions.reverse()) session.dispose();
  globalThis.fetch = realFetch;
  rmSync(temporary, { recursive: true, force: true });
}
