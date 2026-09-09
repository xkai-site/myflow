import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getNodeValue, parseTree, type Node as JsonNode, type ParseError } from "jsonc-parser";

export type ImageAdapter = "openai-codex-images" | "ali-wan-images";
export type ImageTask = "generate" | "edit";
export interface Choice { value: string; label: string }
export interface ChoicePolicy { default: string; options: Choice[] }
export interface DimensionRules {
	separator: "x" | "*";
	minPixels: number;
	maxPixels: number;
	maxSide?: number;
	maxRatio: number;
	multipleOf: number;
}
export interface SizePolicy extends ChoicePolicy { custom?: DimensionRules }
export interface ImageLimits { maximum: number; maxBytes: number; mimeTypes: string[] }
export type ImageAuth =
	| { type: "provider"; providerId: "openai-codex" }
	| { type: "api-key"; env: string; fallbackProviderId: "qwen-token-plan-cn" };
export interface ImageProviderConfig {
	id: string; name: string; adapter: ImageAdapter; auth: ImageAuth; defaultModel: string;
}
export interface ImageModelConfig {
	key: string; id: string; name: string; provider: string; tasks: ImageTask[];
	enabled?: boolean;
	prompt: { maxChars: number };
	inputImages: ImageLimits;
	size: { generate: SizePolicy; edit?: SizePolicy };
	quality?: ChoicePolicy;
}
export interface ImageConfig { version: 1; providers: ImageProviderConfig[]; models: ImageModelConfig[] }
export const MODEL_CONFIG_PATH = fileURLToPath(new URL("../models.jsonc", import.meta.url));
const MAX_CONFIG_BYTES = 1024 * 1024;
const INPUT_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/bmp"]);

export async function readImageConfig(filePath = MODEL_CONFIG_PATH): Promise<ImageConfig> {
	let text: string;
	try {
		const file = await open(filePath, "r");
		try {
			const stats = await file.stat();
			if (!stats.isFile() || stats.size > MAX_CONFIG_BYTES) throw new Error("size");
			const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
			let count = 0;
			while (count < buffer.length) {
				const { bytesRead } = await file.read(buffer, count, buffer.length - count, null);
				if (!bytesRead) break;
				count += bytesRead;
			}
			if (count > MAX_CONFIG_BYTES) throw new Error("size");
			text = buffer.subarray(0, count).toString("utf8");
		} finally { await file.close(); }
	} catch {
		throw new Error(`Cannot read image config: ${filePath}. Restore a readable models.jsonc (max 1 MB), then /reload.`);
	}
	try { return parseImageConfig(text); }
	catch (error) {
		throw new Error(`Invalid image config: ${filePath}: ${(error as Error).message}. Fix it, then /reload.`);
	}
}

export function parseImageConfig(text: string): ImageConfig {
	if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) fail("config", "must not exceed 1 MB");
	const errors: ParseError[] = [];
	const tree = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
	if (errors.length || !tree) {
		const before = text.slice(0, errors[0]?.offset ?? 0);
		const lines = before.split("\n");
		fail("JSONC", `syntax error at line ${lines.length}, column ${lines.at(-1)!.length + 1}`);
	}
	checkTree(tree, 0);
	return validateImageConfig(getNodeValue(tree));
}

function checkTree(node: JsonNode, depth: number): void {
	if (depth > 24) fail("JSONC", "nesting is too deep");
	if (node.type === "object") {
		const names = new Set<string>();
		for (const property of node.children ?? []) {
			const key = property.children?.[0]?.value;
			if (names.has(key)) fail("JSONC", "duplicate property");
			names.add(key);
		}
	}
	for (const child of node.children ?? []) checkTree(child, depth + 1);
}

export function validateImageConfig(raw: unknown): ImageConfig {
	const root = record(raw, "config", ["version", "providers", "models"]);
	if (root.version !== 1) fail("config.version", "must be 1");
	const providers = array(root.providers, "providers").map((item, i): ImageProviderConfig => {
		const p = `providers[${i}]`;
		const v = record(item, p, ["id", "name", "adapter", "auth", "defaultModel"]);
		const adapter = string(v.adapter, `${p}.adapter`) as ImageAdapter;
		if (!["openai-codex-images", "ali-wan-images"].includes(adapter)) fail(`${p}.adapter`, "unsupported adapter");
		const auth = record(v.auth, `${p}.auth`, ["type", "providerId", "env", "fallbackProviderId"]);
		let parsedAuth: ImageAuth;
		if (adapter === "openai-codex-images") {
			if (auth.type !== "provider" || auth.providerId !== "openai-codex" || auth.env !== undefined || auth.fallbackProviderId !== undefined) {
				fail(`${p}.auth`, "requires provider authentication via openai-codex");
			}
			parsedAuth = { type: "provider", providerId: "openai-codex" };
		} else {
			if (auth.type !== "api-key" || auth.fallbackProviderId !== "qwen-token-plan-cn" || auth.providerId !== undefined) {
				fail(`${p}.auth`, "requires api-key with qwen-token-plan-cn fallback");
			}
			const env = string(auth.env, `${p}.auth.env`);
			if (!/^PI_IMAGE_[A-Z][A-Z0-9_]*$/.test(env)) fail(`${p}.auth.env`, "must be a PI_IMAGE_ environment variable name");
			parsedAuth = { type: "api-key", env, fallbackProviderId: "qwen-token-plan-cn" };
		}
		return { id: id(v.id, `${p}.id`), name: string(v.name, `${p}.name`), adapter, auth: parsedAuth, defaultModel: id(v.defaultModel, `${p}.defaultModel`) };
	});
	const models = array(root.models, "models").map((item, i): ImageModelConfig => {
		const p = `models[${i}]`;
		const v = record(item, p, ["key", "id", "name", "provider", "tasks", "prompt", "inputImages", "size", "quality", "enabled"]);
		const tasks = array(v.tasks, `${p}.tasks`).map((task): ImageTask => {
			if (task !== "generate" && task !== "edit") fail(`${p}.tasks`, "only generate and edit are supported");
			return task;
		});
		unique(tasks, `${p}.tasks`);
		const prompt = record(v.prompt, `${p}.prompt`, ["maxChars"]);
		const input = record(v.inputImages, `${p}.inputImages`, ["maximum", "maxBytes", "mimeTypes"]);
		const maximum = integer(input.maximum, `${p}.inputImages.maximum`, 0, 100);
		if (tasks.includes("edit") && maximum < 1) fail(`${p}.inputImages.maximum`, "editing requires reference images");
		const mimeTypes = array(input.mimeTypes, `${p}.inputImages.mimeTypes`).map((mime) => {
			if (typeof mime !== "string" || !INPUT_MIME.has(mime)) fail(`${p}.inputImages.mimeTypes`, "unsupported MIME type");
			return mime;
		});
		unique(mimeTypes, `${p}.inputImages.mimeTypes`);
		const sizes = record(v.size, `${p}.size`, ["generate", "edit"]);
		const model: ImageModelConfig = {
			key: id(v.key, `${p}.key`), id: id(v.id, `${p}.id`), name: string(v.name, `${p}.name`), provider: id(v.provider, `${p}.provider`), tasks,
			prompt: { maxChars: integer(prompt.maxChars, `${p}.prompt.maxChars`, 1, 1_000_000) },
			inputImages: { maximum, maxBytes: integer(input.maxBytes, `${p}.inputImages.maxBytes`, 1, 100 * 1024 * 1024), mimeTypes },
			size: { generate: sizePolicy(sizes.generate, `${p}.size.generate`) },
		};
		if (v.enabled !== undefined) {
			if (typeof v.enabled !== "boolean") fail(`${p}.enabled`, "must be a boolean");
			model.enabled = v.enabled;
		}
		if (sizes.edit !== undefined) model.size.edit = sizePolicy(sizes.edit, `${p}.size.edit`);
		if (v.quality !== undefined) model.quality = choices(v.quality, `${p}.quality`);
		return model;
	});
	unique(providers.map((p) => p.id), "providers.id");
	unique(models.map((m) => m.key), "models.key");
	unique(models.map((m) => `${m.provider}/${m.id}`), "models.provider/id");
	for (const model of models) {
		const provider = providers.find((p) => p.id === model.provider);
		if (!provider) fail("models.provider", "unknown provider reference");
		if (provider.adapter === "ali-wan-images" && model.quality) fail("models.quality", "this adapter does not send quality");
	}
	for (const provider of providers) {
		if (!models.some((m) => m.key === provider.defaultModel && m.provider === provider.id && m.enabled !== false)) fail("providers.defaultModel", "must reference an enabled model owned by this provider");
	}
	return { version: 1, providers, models };
}

export function assertModelEnabled(model: ImageModelConfig): void {
	if (model.enabled === false) {
		throw new Error(`Model ${model.key} (${model.id}) is disabled in models.jsonc. 请改选账户默认模型；确认当前认证后端支持后，才将 enabled 改为 true 并 /reload。未发送生图请求，也不会自动替换模型。`);
	}
}

export function sizeForTask(model: ImageModelConfig, task: ImageTask): SizePolicy {
	return task === "edit" ? model.size.edit ?? model.size.generate : model.size.generate;
}

export function normalizeModelSize(policy: SizePolicy, value = policy.default): string {
	const preset = policy.options.find((option) => option.value.toLowerCase() === value.toLowerCase());
	// Dimension presets must obey the same rules as custom dimensions.
	const candidate = preset?.value ?? value;
	if (preset && !/^\d+[xX*]\d+$/.test(candidate)) return candidate;
	const rules = policy.custom;
	if (!rules) {
		if (preset) return candidate;
		throw new Error("Size must be one of the configured options");
	}
	const match = /^(\d+)([xX*])(\d+)$/.exec(candidate);
	if (!match || (rules.separator === "x" && match[2].toLowerCase() !== "x")) throw new Error("Size must be a configured option or valid dimensions");
	const width = Number(match[1]);
	const height = Number(match[3]);
	const pixels = width * height;
	if (!Number.isSafeInteger(pixels) || width <= 0 || height <= 0 || width % rules.multipleOf || height % rules.multipleOf ||
		pixels < rules.minPixels || pixels > rules.maxPixels || Math.max(width, height) / Math.min(width, height) > rules.maxRatio ||
		(rules.maxSide !== undefined && Math.max(width, height) > rules.maxSide)) throw new Error("Dimensions exceed the configured model size constraints");
	return `${width}${rules.separator}${height}`;
}

function choices(value: unknown, p: string, extra: string[] = []): ChoicePolicy {
	const v = record(value, p, ["default", "options", ...extra]);
	const options = array(v.options, `${p}.options`).map((item, i) => {
		const option = record(item, `${p}.options[${i}]`, ["value", "label"]);
		return { value: string(option.value, `${p}.options[${i}].value`), label: string(option.label, `${p}.options[${i}].label`) };
	});
	unique(options.map((o) => o.value.toLowerCase()), `${p}.options`);
	const defaultValue = string(v.default, `${p}.default`);
	if (!options.some((o) => o.value === defaultValue)) fail(`${p}.default`, "must match a configured option");
	return { default: defaultValue, options };
}
function sizePolicy(value: unknown, p: string): SizePolicy {
	const result: SizePolicy = choices(value, p, ["custom"]);
	const raw = (value as Record<string, unknown>).custom;
	if (raw !== undefined) {
		const v = record(raw, `${p}.custom`, ["separator", "minPixels", "maxPixels", "maxSide", "maxRatio", "multipleOf"]);
		if (v.separator !== "x" && v.separator !== "*") fail(`${p}.custom.separator`, "must be x or *");
		const minPixels = integer(v.minPixels, `${p}.custom.minPixels`, 1, 100_000_000);
		const maxPixels = integer(v.maxPixels, `${p}.custom.maxPixels`, minPixels, 100_000_000);
		if (typeof v.maxRatio !== "number" || !Number.isFinite(v.maxRatio) || v.maxRatio < 1 || v.maxRatio > 100) fail(`${p}.custom.maxRatio`, "must be from 1 to 100");
		result.custom = { separator: v.separator, minPixels, maxPixels, maxRatio: v.maxRatio, multipleOf: integer(v.multipleOf, `${p}.custom.multipleOf`, 1, 10000) };
		if (v.maxSide !== undefined) result.custom.maxSide = integer(v.maxSide, `${p}.custom.maxSide`, 1, 100_000);
	}
	for (const option of result.options) {
		try { normalizeModelSize(result, option.value); }
		catch { fail(`${p}.options`, "dimension option violates custom size rules"); }
	}
	return result;
}
function fail(p: string, message: string): never { throw new Error(`${p}: ${message}`); }
function record(v: unknown, p: string, keys: string[]): Record<string, unknown> {
	if (!v || typeof v !== "object" || Array.isArray(v)) fail(p, "must be an object");
	if (Object.keys(v).some((k) => !keys.includes(k))) fail(p, "contains an unknown field");
	return v as Record<string, unknown>;
}
function array(v: unknown, p: string): unknown[] {
	if (!Array.isArray(v) || !v.length || v.length > 200) fail(p, "must contain 1 to 200 items");
	return v;
}
function string(v: unknown, p: string): string {
	if (typeof v !== "string" || !v.trim() || v.length > 200 || /[\x00-\x1f\x7f-\x9f]/u.test(v)) fail(p, "must be non-empty text without control characters (max 200)");
	return v.trim();
}
function id(v: unknown, p: string): string {
	const result = string(v, p);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result) || ["__proto__", "constructor", "prototype"].includes(result)) fail(p, "must be a safe identifier (max 128)");
	return result;
}
function integer(v: unknown, p: string, min: number, max: number): number {
	if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) fail(p, `must be an integer from ${min} to ${max}`);
	return v as number;
}
function unique(values: string[], p: string): void {
	if (new Set(values).size !== values.length) fail(p, "duplicate value");
}
