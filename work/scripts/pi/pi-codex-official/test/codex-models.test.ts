import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { codexModelsFile, parseCodexModels, readCodexModels } from "../extensions/codex-models.ts";

const SOURCE = "/synthetic-codex/models_cache.json";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
function model(overrides: Record<string, unknown> = {}) {
  return {
    slug: "fixture-model",
    display_name: "Fixture Model",
    visibility: "list",
    supported_in_api: true,
    input_modalities: ["text", "image"],
    context_window: 272_000,
    supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map((effort) => ({ effort })),
    ...overrides,
  };
}
function parse(models: unknown[]) {
  return parseCodexModels({ models }, [], SOURCE);
}
function fixture(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codex-models-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "models_cache.json");
}
function assertModelError(fn: () => unknown, field: RegExp, source = SOURCE) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(source));
    assert.match(error.message, field);
    assert.match(error.message, /本插件未注册模型/);
    assert.match(error.message, /Codex.*\/reload/);
    assert.doesNotMatch(error.message, /secret-sentinel/);
    return true;
  });
}

test("cache is the only catalog: filters strictly, preserves order and ignores hidden model fields", () => {
  const actual = parse([
    { visibility: "hide", supported_in_api: true },
    model({ slug: "first", priority: 100 }),
    model({ slug: "unavailable", supported_in_api: false }),
    model({ slug: "not-boolean", supported_in_api: "true" }),
    model({ slug: "not-visible", visibility: undefined }),
    model({ slug: "second", priority: 1 }),
  ]);
  assert.deepEqual(actual.map((item) => item.id), ["first", "second"]);
  assert.equal(actual[0].name, "Fixture Model");
  assert.deepEqual(actual[0].input, ["text", "image"]);
});

test("name falls back to slug and supported input modalities are intersected and deduplicated", () => {
  for (const display_name of [undefined, null, 123, "", "   "]) {
    const [actual] = parse([model({ slug: " trimmed ", display_name, input_modalities: ["audio", "text", "text"] })]);
    assert.equal(actual.id, "trimmed");
    assert.equal(actual.name, "trimmed");
    assert.deepEqual(actual.input, ["text"]);
  }
  assert.equal(parse([model({ display_name: " Name " })])[0].name, "Name");
});

test("cache fields win; only same-id output and three boolean compat flags are reused, never pricing", () => {
  const cache = { models: [model({
    max_context_window: 872_000,
    effective_context_window_percent: 95,
    truncation_policy: { limit: 10_000 },
    base_instructions: "secret-sentinel",
    cost: { input: 99 },
  })] };
  const builtin = {
    id: "fixture-model", maxTokens: 128_000, contextWindow: 1_000_000,
    input: ["text"], thinkingLevelMap: { max: "max" },
    cost: { input: 100, tiers: [{ inputTokensAbove: 1 }] },
    compat: {
      supportsOpenAIGrammarTools: true, supportsAdditionalTools: false, supportsToolSearch: true,
      supportsStrictMode: false,
    },
  };
  const snapshot = structuredClone({ cache, builtin });
  const [actual] = parseCodexModels(cache, [builtin, { id: "extra-builtin", maxTokens: 1 }], SOURCE);
  assert.equal(actual.contextWindow, 272_000);
  assert.equal(actual.maxTokens, 128_000);
  assert.equal(actual.thinkingLevelMap?.max, null);
  assert.deepEqual(actual.input, ["text", "image"]);
  assert.deepEqual(actual.compat, {
    supportsOpenAIGrammarTools: true, supportsAdditionalTools: false, supportsToolSearch: true,
  });
  assert.deepEqual(actual.cost, ZERO_COST);
  assert.equal("base_instructions" in actual, false);
  assert.equal(parseCodexModels(cache, [builtin], SOURCE).length, 1);
  actual.cost.input = 1;
  actual.compat!.supportsToolSearch = false;
  assert.deepEqual({ cache, builtin }, snapshot);
});

test("unknown models get bounded metadata placeholder, no inferred optional tool capabilities", () => {
  const [actual] = parseCodexModels({ models: [model({
    slug: "new-model", supports_search_tool: true, tool_mode: "code_mode_only",
  })] }, [{ id: "new-model-prefix", maxTokens: 128_000, compat: { supportsToolSearch: true } }], SOURCE);
  assert.equal(actual.maxTokens, 16_384);
  assert.equal(actual.compat, undefined);
  assert.deepEqual(actual.cost, ZERO_COST);
  assert.equal(parse([model({ context_window: 4096 })])[0].maxTokens, 4096);
  assert.equal(parseCodexModels({ models: [model({ context_window: 4096 })] }, [
    { id: "fixture-model", maxTokens: 128_000 },
  ], SOURCE)[0].maxTokens, 4096);
});

test("invalid built-in output limits use the metadata placeholder", () => {
  for (const maxTokens of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const [actual] = parseCodexModels({ models: [model()] }, [{ id: "fixture-model", maxTokens }], SOURCE);
    assert.equal(actual.maxTokens, 16_384);
  }
});

test("reasoning is an explicit map; ultra does not imply max", () => {
  const [actual] = parse([model({ supported_reasoning_levels: ["low", "high", "xhigh", "ultra"].map((effort) => ({ effort })) })]);
  assert.equal(actual.reasoning, true);
  assert.deepEqual(actual.thinkingLevelMap, {
    off: null, minimal: "low", low: "low", medium: null, high: "high", xhigh: "xhigh", max: null,
  });
  const [extended] = parse([model({ supported_reasoning_levels: ["none", "minimal", "low", "max"].map((effort) => ({ effort })) })]);
  assert.equal(extended.thinkingLevelMap?.off, "none");
  assert.equal(extended.thinkingLevelMap?.minimal, "minimal");
  assert.equal(extended.thinkingLevelMap?.max, "max");
  assert.equal(extended.thinkingLevelMap?.xhigh, null);
});

test("empty reasoning capabilities are non-reasoning; explicit off is honored", () => {
  for (const levels of [[], [{ effort: "none" }], [{ effort: "off" }]]) {
    const [actual] = parse([model({ supported_reasoning_levels: levels })]);
    assert.equal(actual.reasoning, false);
    assert.notEqual(actual.thinkingLevelMap?.off, null);
    assert.equal(actual.thinkingLevelMap?.low, null);
  }
});

test("all-zero cost objects are independent across models and repeated parses", () => {
  const models = [model(), model({ slug: "other" })];
  const actual = parse(models);
  actual[0].cost.input = 99;
  assert.deepEqual(actual[1].cost, ZERO_COST);
  assert.deepEqual(parse(models)[0].cost, ZERO_COST);
});

test("rejects invalid root structures and empty catalogs", () => {
  for (const data of [null, [], "secret-sentinel", {}, { models: null }, { models: {} }]) {
    assertModelError(() => parseCodexModels(data, [], SOURCE), /models 数组/);
  }
  for (const models of [[], [model({ visibility: "hide" })]]) {
    assertModelError(() => parse(models), /没有可见且 API 可用/);
  }
  for (const value of [null, [], "secret-sentinel", 1]) {
    assertModelError(() => parse([value]), /第 1 项.*对象/);
  }
});

test("rejects malformed candidate fields without echoing their contents", () => {
  const cases: Array<[string, unknown[]]> = [
    ["slug", [undefined, null, 1, "", "   "]],
    ["context_window", [undefined, null, "272000", 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]],
    ["input_modalities", [undefined, null, "text", [], ["audio"], [1], ["text", null]]],
    ["supported_reasoning_levels", [undefined, null, "low", ["low"], [null], [{}], [{ effort: 1 }], [{ effort: " " }], [{ effort: "secret-sentinel" }]]],
  ];
  for (const [field, invalidValues] of cases) {
    for (const value of invalidValues) {
      assertModelError(() => parse([model({ [field]: value })]), new RegExp(field));
    }
  }
});

test("rejects duplicate candidate IDs after trimming, rather than partially returning models", () => {
  assertModelError(() => parse([model(), model({ slug: " fixture-model " })]), /第 2 项.*重复/);
  assertModelError(() => parse([model(), model({ slug: "other", context_window: 0 })]), /第 2 项.*context_window/);
});

test("read errors and malformed JSON are actionable and do not leak JSON excerpts", (t) => {
  const cachePath = fixture(t);
  assertModelError(() => readCodexModels([], cachePath), /文件不存在或无法读取/, cachePath);
  assertModelError(() => readCodexModels([], path.dirname(cachePath)), /文件不存在或无法读取/, path.dirname(cachePath));
  fs.writeFileSync(cachePath, '{"secret-sentinel": invalid}');
  assertModelError(() => readCodexModels([], cachePath), /JSON 格式错误/, cachePath);
});

test("rereads A -> B -> broken -> repaired without writing files or retaining a snapshot", (t) => {
  const cachePath = fixture(t);
  const write = (models: unknown[]) => fs.writeFileSync(cachePath, JSON.stringify({ models }));
  write([model({ slug: "A" })]);
  const before = fs.readFileSync(cachePath, "utf8");
  assert.equal(readCodexModels([], cachePath)[0].id, "A");
  assert.equal(fs.readFileSync(cachePath, "utf8"), before);
  write([model({ slug: "B", context_window: 8192, input_modalities: ["text"] })]);
  const [second] = readCodexModels([], cachePath);
  assert.equal(second.id, "B");
  assert.equal(second.contextWindow, 8192);
  assert.deepEqual(second.input, ["text"]);
  fs.writeFileSync(cachePath, "broken");
  assertModelError(() => readCodexModels([], cachePath), /JSON 格式错误/, cachePath);
  write([model({ slug: "repaired" })]);
  assert.equal(readCodexModels([], cachePath)[0].id, "repaired");
});

test("default cache path follows CODEX_HOME without needing an auth file", (t) => {
  const previous = process.env.CODEX_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  });
  delete process.env.CODEX_HOME;
  assert.equal(codexModelsFile(), path.join(os.homedir(), ".codex", "models_cache.json"));
  process.env.CODEX_HOME = "  ";
  assert.equal(codexModelsFile(), path.join(os.homedir(), ".codex", "models_cache.json"));
  const cachePath = fixture(t);
  process.env.CODEX_HOME = ` ${path.dirname(cachePath)} `;
  fs.writeFileSync(cachePath, JSON.stringify({ models: [model()] }));
  assert.equal(codexModelsFile(), cachePath);
  assert.equal(readCodexModels()[0].id, "fixture-model");
  assert.equal(fs.existsSync(path.join(path.dirname(cachePath), "auth.json")), false);
  process.env.CODEX_HOME = "relative-codex-home";
  assert.equal(codexModelsFile(), path.join(path.resolve("relative-codex-home"), "models_cache.json"));
});
