import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeModelSize, parseImageConfig, readImageConfig, sizeForTask, validateImageConfig } from "../src/model-config.ts";

const config = await readImageConfig();

test("shipped config preserves current models and defaults", () => {
	const legacy = config.models.slice(0, 3);
	assert.deepEqual(legacy.map((m) => m.key), ["openai", "wan", "wan-pro"]);
	assert.ok(legacy.every((m) => m.enabled !== false));
	assert.deepEqual(legacy.map((m) => m.id), ["gpt-image-2", "wan2.7-image", "wan2.7-image-pro"]);
	assert.deepEqual(legacy.map((m) => m.prompt.maxChars), [32000, 5000, 5000]);
	assert.deepEqual(legacy.map((m) => m.inputImages.maximum), [5, 9, 9]);
	assert.deepEqual(legacy.map((m) => m.inputImages.maxBytes), [50, 20, 20].map((n) => n * 1024 * 1024));
	assert.deepEqual(legacy.map((m) => normalizeModelSize(sizeForTask(m, "generate"))), ["auto", "2K", "2K"]);
	assert.equal(legacy[0].quality?.default, "auto");
	assert.deepEqual(legacy[0].quality?.options.map((o) => o.value), ["auto", "low", "medium", "high"]);
	assert.deepEqual(config.providers, [
		{ id: "openai", name: "OpenAI Codex", adapter: "openai-codex-images", auth: { type: "provider", providerId: "openai-codex" }, defaultModel: "openai" },
		{ id: "qwen", name: "Qwen Token Plan CN", adapter: "ali-wan-images", auth: { type: "api-key", env: "PI_IMAGE_QWEN_API_KEY", fallbackProviderId: "qwen-token-plan-cn" }, defaultModel: "wan" },
	]);
});

test("GPT Image 2.5 models are enabled with configured quality and dimension rules", () => {
	const added = config.models.slice(3);
	assert.deepEqual(added.map((m) => m.key), ["openai-sunburst", "openai-flare"]);
	assert.deepEqual(added.map((m) => m.id), ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"]);
	for (const model of added) {
		assert.equal(model.provider, "openai");
		assert.notEqual(model.enabled, false);
		assert.deepEqual(model.tasks, ["generate", "edit"]);
		assert.deepEqual(model.prompt, config.models[0].prompt);
		assert.deepEqual(model.inputImages, config.models[0].inputImages);
		assert.equal(model.quality?.default, "auto");
		assert.deepEqual(model.quality?.options.map((o) => o.value), ["auto", "low", "medium", "high", "xhigh", "max"]);
		for (const task of model.tasks) {
			const policy = sizeForTask(model, task);
			assert.equal(normalizeModelSize(policy), "auto");
			for (const size of ["1024x1024", "1536x1024", "1024x1536", "1536x864", "1024x640", "3840x2160"]) {
				assert.equal(normalizeModelSize(policy, size), size);
			}
			for (const size of ["1000x1000", "16x16", "4096x1024", "3072x3072", "3072x768"]) {
				assert.throws(() => normalizeModelSize(policy, size), /constraints/);
			}
		}
	}
});

test("either GPT Image 2.5 model can be configured as the OpenAI default", () => {
	for (const key of ["openai-sunburst", "openai-flare"]) {
		const next = structuredClone(config);
		next.providers.find((provider) => provider.id === "openai")!.defaultModel = key;
		assert.equal(validateImageConfig(next).providers.find((provider) => provider.id === "openai")!.defaultModel, key);
	}
});

test("dimension boundaries and edit-specific policies", () => {
	const [openai, wan, pro] = config.models;
	assert.equal(normalizeModelSize(sizeForTask(openai, "edit"), "1024x1024"), "1024x1024");
	assert.throws(() => normalizeModelSize(openai.size.generate, "1000x1000"), /constraints/);
	assert.throws(() => normalizeModelSize(openai.size.generate, "16x16"), /constraints/);
	assert.equal(normalizeModelSize(wan.size.generate, "1024x1024"), "1024*1024");
	assert.equal(normalizeModelSize(pro.size.generate, "4k"), "4K");
	assert.throws(() => normalizeModelSize(sizeForTask(pro, "edit"), "4K"));
	assert.throws(() => normalizeModelSize(wan.size.generate, "4096*4096"));
	assert.equal(normalizeModelSize(pro.size.generate, "4096*4096"), "4096*4096");
});

test("JSONC permits comments/trailing commas, rejects duplicate properties and syntax without echo", () => {
	const text = JSON.stringify(config).replace('"version":1', '/* version */ "version":1');
	assert.deepEqual(parseImageConfig(text.replace(/}$/, ",}")), config);
	assert.throws(() => parseImageConfig(text.replace('"version":1', '"version":1,"version":1')), /duplicate property/);
	try { parseImageConfig('{"secret":"never-echo-me" INVALID}'); assert.fail(); }
	catch (error) { assert.match((error as Error).message, /line.*column/); assert.doesNotMatch((error as Error).message, /never-echo-me/); }
});

test("schema rejects unknown fields, duplicate models, bad auth/defaults/references/ranges", () => {
	const mutations = [
		(c: any) => { c.apiKey = "never-echo-me"; },
		(c: any) => { c.models.push(c.models[0]); },
		(c: any) => { c.models[0].provider = "missing"; },
		(c: any) => { c.providers[0].defaultModel = "missing"; },

		(c: any) => { c.models[0].enabled = false; },
		(c: any) => { c.models[0].enabled = "false"; },
		(c: any) => { c.providers[0].auth.providerId = "other-oauth"; },
		(c: any) => { c.models[0].quality.default = "missing"; },
		(c: any) => { c.models[0].size.generate.custom.maxPixels = 1; },
		(c: any) => { c.models[0].inputImages.mimeTypes = ["image/svg+xml"]; },
		(c: any) => { c.models[1].quality = c.models[0].quality; },
	];
	for (const mutate of mutations) {
		const next = structuredClone(config); mutate(next);
		assert.throws(() => validateImageConfig(next));
	}
});

test("single config file reload A -> B -> invalid -> repaired -> missing", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-images-config-"));
	const file = path.join(dir, "models.jsonc");
	try {
		await writeFile(file, JSON.stringify(config));
		assert.deepEqual(await readImageConfig(file), config);
		const next = structuredClone(config); next.models[0].id = "future-image"; next.models[0].name = "Future";
		await writeFile(file, JSON.stringify(next));
		assert.equal((await readImageConfig(file)).models[0].id, "future-image");
		await writeFile(file, "{broken}");
		await assert.rejects(readImageConfig(file), /Fix it, then \/reload/);
		await writeFile(file, JSON.stringify(next));
		assert.deepEqual(await readImageConfig(file), next);
		await rm(file);
		await assert.rejects(readImageConfig(file), /Restore a readable models.jsonc/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
