// Run separately from pure unit tests. Uses an installed Pi SDK, never installs it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("real Pi startup/reload: cache replacement, failure cleanup, recovery and zero prices", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codex-host-test-"));
  const agentDir = path.join(root, "agent");
  const codex = path.join(root, "codex");
  fs.mkdirSync(agentDir);
  fs.mkdirSync(codex);
  const previous = {};
  for (const [key, value] of Object.entries({
    PI_CODING_AGENT_DIR: agentDir, CODEX_HOME: codex, PI_OFFLINE: "1", PI_TELEMETRY: "0",
  })) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  let session;
  t.after(() => {
    session?.dispose();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const authPath = path.join(agentDir, "auth.json");
  const auth = JSON.stringify({ "openai-codex": {
    type: "oauth", access: "synthetic", refresh: "synthetic", expires: 4e12, accountId: "fixture",
  } });
  fs.writeFileSync(authPath, auth);
  const cache = path.join(codex, "models_cache.json");
  function writeModel(id, contextWindow = 272000) {
    fs.writeFileSync(cache, JSON.stringify({ models: [{
      slug: id, visibility: "list", supported_in_api: true, input_modalities: ["text"],
      context_window: contextWindow, supported_reasoning_levels: [{ effort: "low" }],
    }] }));
  }
  const {
    createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  } = await import(process.argv[2] ?? "@earendil-works/pi-coding-agent");
  const settingsManager = SettingsManager.inMemory({ defaultProvider: "openai-codex", defaultModel: "fixture-A" });
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../extensions/index.ts", import.meta.url))],
  });
  writeModel("fixture-A");
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath, modelsPath: path.join(agentDir, "models.json"),
    modelsStorePath: path.join(agentDir, "models-store.json"), allowModelNetwork: false,
  });
  ({ session } = await createAgentSession({
    cwd: root, agentDir, resourceLoader: loader, settingsManager, modelRuntime,
    noTools: "all", sessionManager: SessionManager.inMemory(root),
  }));
  function check(expected, failure = false) {
    const models = modelRuntime.getModels("openai-codex");
    const errors = loader.getExtensions().errors;
    if (failure) {
      assert.equal(models.some((model) => model.id.startsWith("fixture-")), false);
      assert.equal(errors.length, 1);
      assert.match(errors[0].error, /本插件未注册模型/);
      assert.doesNotMatch(errors[0].error, /secret-sentinel/);
      assert.notEqual(modelRuntime.getProvider("openai-codex")?.name, "OpenAI Codex (Codex 本地凭据)");
    } else {
      assert.deepEqual(models.map((model) => model.id), [expected]);
      assert.equal(errors.length, 0);
      assert.deepEqual(models[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      assert.equal(modelRuntime.getProvider("openai-codex")?.name, "OpenAI Codex (Codex 本地凭据)");
    }
    assert.equal(fs.readFileSync(authPath, "utf8"), auth);
    assert.equal(fs.existsSync(path.join(codex, "auth.json")), false);
    assert.equal(settingsManager.getDefaultModel(), "fixture-A");
  }
  check("fixture-A");
  writeModel("fixture-B", 8192);
  await session.reload();
  check("fixture-B");
  assert.equal(modelRuntime.getModel("openai-codex", "fixture-B").contextWindow, 8192);
  fs.writeFileSync(cache, '{"secret-sentinel": invalid}');
  await session.reload();
  check(null, true);
  writeModel("fixture-repaired");
  await session.reload();
  check("fixture-repaired");
  // A second failure after recovery proves cleanup was registered again.
  fs.unlinkSync(cache);
  await session.reload();
  check(null, true);
});
