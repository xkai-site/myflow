import assert from "node:assert/strict";
import { readImageConfig, type ImageConfig } from "../src/model-config.ts";

export function getModel<C extends ImageConfig>(config: C, key: string): C["models"][number] {
	const model = config.models.find((model) => model.key === key);
	assert.ok(model, `Missing test model: ${key}`);
	return model;
}

export function getProvider<C extends ImageConfig>(config: C, id: string): C["providers"][number] {
	const provider = config.providers.find((provider) => provider.id === id);
	assert.ok(provider, `Missing test provider: ${id}`);
	return provider;
}

export async function readTestConfig(): Promise<ImageConfig> {
	const config = await readImageConfig();
	// Re-run the same assertions against a reordered in-memory catalog without changing models.jsonc.
	if (process.env.PI_IMAGE_TEST_REVERSE_MODELS === "1") config.models.reverse();
	return config;
}
