import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveImageCommand } from "../src/command.ts";
import { inputImageDataUrl, loadInputImages, validateInputImages } from "../src/image-files.ts";
import { validateImageConfig } from "../src/model-config.ts";
import { buildOpenAICodexRequest } from "../src/openai-codex-images.ts";

import { getModel, readTestConfig } from "./config-helpers.ts";

const config = await readTestConfig();
const models = config.models.filter((model) => config.providers.find((provider) => provider.id === model.provider)?.adapter === "openai-codex-images");
const limits = getModel(config, "openai").inputImages;
const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const png = { data: pngBytes.toString("base64"), mimeType: "image/png" };
const apiKey = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.signature`;

test("all OpenAI configurations align with Platform JSON reference limits and serialize 16 images", () => {
	assert.equal(models.length, 5);
	for (const model of models) {
		assert.equal(model.inputImages.maximum, 16);
		assert.equal(model.inputImages.maxDataUrlLength, 20971520);
		assert.equal(model.inputImages.maxBytes, 15728622);
		const images = Array.from({ length: 16 }, () => png);
		validateInputImages(images, model.inputImages);
		const command = resolveImageCommand({ prompt: "cat", help: false }, model, images.length, config);
		const request = buildOpenAICodexRequest({ ...command, apiKey, baseUrl: "https://chatgpt.com/backend-api/codex", images });
		assert.ok(request.url.endsWith("/edits"));
		assert.equal(request.body.model, model.id);
		assert.deepEqual(request.body.images, images.map((image) => ({ image_url: inputImageDataUrl(image) })));
		assert.throws(() => resolveImageCommand({ prompt: "cat", help: false }, model, 17, config), /at most 16/);
		assert.throws(() => validateInputImages([...images, png], model.inputImages), /at most 16/);
	}
});

test("data URL limits count the actual MIME prefix, Base64 padding and inclusive boundary", () => {
	const samples = [
		png,
		{ mimeType: "image/jpeg", data: Buffer.from([255, 216, 255]).toString("base64") },
		{ mimeType: "image/webp", data: Buffer.from("RIFF\0\0\0\0WEBP", "binary").toString("base64") },
		{ mimeType: "image/bmp", data: Buffer.from("BM").toString("base64") },
		{ ...png, mimeType: "image/png;charset=binary" },
	];
	for (const image of samples) {
		const length = inputImageDataUrl(image).length;
		assert.doesNotThrow(() => validateInputImages([image], { ...limits, maxDataUrlLength: length }));
		assert.throws(() => validateInputImages([image], { ...limits, maxDataUrlLength: length - 1 }), /data URL.*character limit/);
		const legacy = { ...limits }; delete legacy.maxDataUrlLength;
		assert.doesNotThrow(() => validateInputImages([image], legacy));
		assert.equal(Math.floor((20971520 - `data:${image.mimeType};base64,`.length) / 4) * 3, image.mimeType.includes(";") ? 15728610 : limits.maxBytes);
	}
});

test("real Platform Base64 boundary accepts the largest configured file and rejects one extra byte", () => {
	const bytes = Buffer.alloc(limits.maxBytes + 1);
	pngBytes.copy(bytes);
	const image = { mimeType: "image/png", data: bytes.subarray(0, limits.maxBytes).toString("base64") };
	assert.ok(inputImageDataUrl(image).length <= limits.maxDataUrlLength!);
	assert.doesNotThrow(() => validateInputImages([image], limits));
	const oversized = { ...image, data: bytes.toString("base64") };
	assert.ok(inputImageDataUrl(oversized).length > limits.maxDataUrlLength!);
	// Loosen raw-byte checking to prove the encoded-field check independently rejects it.
	assert.throws(() => validateInputImages([oversized], { ...limits, maxBytes: limits.maxBytes + 1 }), /data URL.*20971520 character limit/);
});

test("file loading applies count, byte and encoded limits before returning input images", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-input-limits-"));
	try {
		const file = path.join(dir, "reference.png");
		await writeFile(file, pngBytes);
		assert.deepEqual(await loadInputImages(dir, Array(16).fill(file), limits), Array(16).fill(png));
		await assert.rejects(loadInputImages(dir, Array(17).fill("missing.png"), limits), /at most 16/);
		const length = inputImageDataUrl(png).length;
		assert.deepEqual(await loadInputImages(dir, [file], { ...limits, maxBytes: pngBytes.length, maxDataUrlLength: length }), [png]);
		await assert.rejects(loadInputImages(dir, [file], { ...limits, maxDataUrlLength: length - 1 }), /data URL.*character limit/);
		await truncate(file, limits.maxBytes + 1);
		await assert.rejects(loadInputImages(dir, [file], limits), /15728622 byte limit/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("encoded-length configuration is optional, validated strictly, and leaves Wan unchanged", () => {
	const legacy = structuredClone(config);
	for (const model of legacy.models) delete model.inputImages.maxDataUrlLength;
	assert.doesNotThrow(() => validateImageConfig(legacy));
	for (const value of [0, -1, 1.5, "20971520", null, 104857601]) {
		const next: any = structuredClone(config);
		getModel(next, "openai").inputImages.maxDataUrlLength = value;
		assert.throws(() => validateImageConfig(next), /maxDataUrlLength/);
	}
	for (const key of ["wan", "wan-pro"]) {
		const model = config.models.find((model) => model.key === key)!;
		assert.equal(model.inputImages.maximum, 9);
		assert.equal(model.inputImages.maxBytes, 20 * 1024 * 1024);
		assert.equal(model.inputImages.maxDataUrlLength, undefined);
	}
});
