import assert from "node:assert/strict";
import test from "node:test";
import { inferModelForSingleAccount, parseImageCommand, resolveImageCommand, usageText } from "../src/command.ts";
import { readImageConfig, validateImageConfig } from "../src/model-config.ts";
import { validateInputImages } from "../src/image-files.ts";
import { buildOpenAICodexRequest } from "../src/openai-codex-images.ts";
import { buildAliWanRequest } from "../src/ali-wan-images.ts";

const config = await readImageConfig();
const key = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.signature`;
const png = { data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"), mimeType: "image/png" };

test("legacy command selectors and current request defaults", () => {
	for (const model of config.models.filter((model) => model.enabled !== false)) {
		const parsed = parseImageCommand(`/image ${model.key} "a cat"`, config);
		assert.equal(parsed.modelKey, model.key);
		const command = resolveImageCommand(parsed, model, 0, config);
		const options = { ...command, apiKey: key, images: [], baseUrl: model.provider === "openai" ? "https://chatgpt.com/backend-api/codex" : "https://token-plan.cn-beijing.maas.aliyuncs.com" };
		const request = model.provider === "openai" ? buildOpenAICodexRequest(options) : buildAliWanRequest(options);
		assert.equal(request.body.model, model.id);
		assert.equal(command.size, model.size.generate.default);
	}
	assert.equal(inferModelForSingleAccount(config, ["openai"])?.key, "openai");
	assert.equal(inferModelForSingleAccount(config, ["qwen"])?.key, "wan");
	assert.equal(inferModelForSingleAccount(config, ["openai", "qwen"]), undefined);
	assert.equal(parseImageCommand("/image -- wan is a word", config).modelKey, undefined);
});

test("GPT Image 2.5 commands serialize generation/edit parameters from the actual config", () => {
	for (const selector of ["openai-sunburst", "openai-flare"]) {
		const model = config.models.find((m) => m.key === selector)!;
		assert.ok(usageText(config).includes(model.name));
		for (const quality of ["auto", "low", "medium", "high", "xhigh", "max"]) {
			for (const images of [[], [png]]) {
				const parsed = parseImageCommand(`/image ${selector} --size 1536x864 --quality ${quality} a cat`, config);
				assert.equal(parsed.modelKey, selector);
				const command = resolveImageCommand(parsed, model, images.length, config);
				const request = buildOpenAICodexRequest({ ...command, apiKey: key, baseUrl: "https://chatgpt.com/backend-api/codex", images });
				assert.equal(request.url, `https://chatgpt.com/backend-api/codex/images/${images.length ? "edits" : "generations"}`);
				assert.equal(request.body.model, model.id);
				assert.equal(request.body.quality, quality);
				assert.equal(request.body.size, "1536x864");
				assert.equal(request.body.n, 1);
				assert.equal(request.headers.get("chatgpt-account-id"), "synthetic-account");
				assert.equal(request.headers.get("Authorization"), `Bearer ${key}`);
				assert.deepEqual(request.body.images, images.length ? [{ image_url: `data:image/png;base64,${png.data}` }] : undefined);
			}
		}
	}
	for (const quality of ["xhigh", "max"]) {
		const parsed = parseImageCommand(`/image openai --quality ${quality} cat`, config);
		assert.throws(() => resolveImageCommand(parsed, config.models[0], 0, config), /quality/i);
	}
});

test("disabled models are recognized as selectors but rejected, never silently sent as default-model prompts", () => {
	const fixture = structuredClone(config);
	const model = { ...structuredClone(fixture.models[0]), key: "disabled-test-model", id: "disabled-test-id", name: "Disabled test model", enabled: false };
	fixture.models.push(model);
	const validated = validateImageConfig(fixture);
	const parsed = parseImageCommand(`/image ${model.key} cat`, validated);
	assert.equal(parsed.modelKey, model.key);
	assert.equal(parsed.prompt, "cat");
	assert.throws(() => resolveImageCommand(parsed, model, 0, validated), /disabled/);
	assert.match(usageText(validated).split("\n").find((line) => line.includes(model.key))!, /disabled/);
});

test("direct OpenAI adapter preserves the default quality", () => {
	const legacy = config.models[0];
	const request = buildOpenAICodexRequest({ apiKey: key, baseUrl: "https://chatgpt.com/backend-api", model: legacy.id, size: "auto", images: [], prompt: "cat" });
	assert.equal(request.body.quality, "auto");
});

test("config-only model upgrade/addition changes parsing, request and validation", () => {
	const changed = structuredClone(config);
	const model = changed.models[0];
	model.key = "future"; model.id = "future-image-id"; model.name = "Future Image";
	model.prompt.maxChars = 10; model.inputImages.maximum = 1; model.inputImages.maxBytes = 8;
	model.quality!.options.push({ value: "ultra", label: "Ultra" }); model.quality!.default = "ultra";
	model.size.generate.default = "1024x1024";
	changed.providers[0].defaultModel = "future";
	changed.models.push({ ...structuredClone(model), key: "future-2", id: "future-image-id-2", name: "Second Future" });
	const validated = validateImageConfig(changed);
	assert.match(usageText(validated), /Second Future/);
	const parsed = parseImageCommand("/image future cat", validated);
	const command = resolveImageCommand(parsed, validated.models[0], 1, validated);
	assert.equal(command.quality, "ultra");
	assert.equal(command.size, "1024x1024");
	const request = buildOpenAICodexRequest({ ...command, apiKey: key, baseUrl: "https://chatgpt.com/backend-api/codex", images: [png] });
	assert.equal(request.body.model, "future-image-id");
	assert.equal(request.body.quality, "ultra");
	assert.throws(() => resolveImageCommand(parsed, model, 2, validated), /at most 1/);
	assert.throws(() => resolveImageCommand({ ...parsed, prompt: "longer than ten" }, model, 0, validated), /10 characters/);
	validateInputImages([png], model.inputImages);
	assert.throws(() => validateInputImages([png], { ...model.inputImages, maxBytes: 7 }), /size limit|MB limit/);
	assert.throws(() => validateInputImages([png], { ...model.inputImages, mimeTypes: ["image/jpeg"] }), /MIME/);
	assert.equal(parseImageCommand("/image future-2 cat", validated).modelKey, "future-2");
});

test("task, quality, prompt, reference and CLI validation", () => {
	const wan = config.models[1];
	const parsed = parseImageCommand("/image wan --size=2K cat", config);
	assert.throws(() => resolveImageCommand({ ...parsed, quality: "high" }, wan, 0, config), /not supported/);
	assert.throws(() => resolveImageCommand(parsed, wan, 10, config), /at most 9/);
	assert.throws(() => resolveImageCommand(parsed, { ...wan, tasks: ["generate"] }, 1, config), /does not support edit/);
	assert.throws(() => resolveImageCommand({ ...parsed, size: "4K" }, config.models[2], 1, config));
	assert.throws(() => parseImageCommand("/image --quality", config), /requires/);
	assert.throws(() => parseImageCommand("/image --api-key=never-echo", config), (error: Error) => !error.message.includes("never-echo"));
	assert.throws(() => parseImageCommand('/image "unclosed', config), /unterminated/);
});
