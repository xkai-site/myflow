import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
	AdapterId,
	BooleanParameterDefinition,
	InputImageLimits,
	IntegerParameterDefinition,
	ParameterDefinition,
	PromptLimits,
	SelectParameterDefinition,
	VideoGenerationConfig,
	VideoModelConfig,
	VideoProviderConfig,
	VideoTaskType,
} from "./types.ts";

const MAX_CONFIG_BYTES = 1024 * 1024;
export const KEEP_API_KEY = "__PI_VIDEO_KEEP_EXISTING_API_KEY__";
const TASKS = new Set<VideoTaskType>(["t2v", "i2v", "r2v"]);
const ADAPTERS = new Set<AdapterId>(["dashscope"]);
const PARAMETER_TYPES = new Set(["select", "integer", "boolean"]);

export function getVideoConfigPath(agentDir: string): string {
	return path.join(agentDir, "pi-video-generation", "model.json");
}

export async function readVideoConfig(filePath: string): Promise<VideoGenerationConfig | undefined> {
	let text: string;
	try {
		text = await readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw new Error("Video model config exceeds 1 MB");
	let raw: unknown;
	try {
		raw = JSON.parse(text) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Video model config is invalid JSON: ${message}`);
	}
	return validateVideoConfig(raw);
}

export async function readTemplateConfig(filePath: string): Promise<VideoGenerationConfig> {
	const config = await readVideoConfig(filePath);
	if (!config) throw new Error(`Video model template does not exist: ${filePath}`);
	return config;
}

export async function writeVideoConfig(filePath: string, config: VideoGenerationConfig): Promise<void> {
	const validated = validateVideoConfig(config);
	const directory = path.dirname(filePath);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700).catch(() => undefined);
	const temporaryPath = path.join(directory, `.model.json.${randomUUID()}.tmp`);
	try {
		await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		await chmod(temporaryPath, 0o600).catch(() => undefined);
		await rename(temporaryPath, filePath);
		await chmod(filePath, 0o600).catch(() => undefined);
	} catch (error) {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

export function sanitizeConfigForEditing(config: VideoGenerationConfig): string {
	return `${JSON.stringify(
		{
			...config,
			providers: config.providers.map((provider) => ({
				...provider,
				apiKey: provider.apiKey ? KEEP_API_KEY : "",
			})),
		},
		null,
		2,
	)}\n`;
}

export function mergeEditedConfig(text: string, current: VideoGenerationConfig): VideoGenerationConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(text) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Edited video config is invalid JSON: ${message}`);
	}
	const root = expectRecord(raw, "config");
	const providers = expectArray(root.providers, "providers").map((value, index) => {
		const provider = expectRecord(value, `providers[${index}]`);
		if (provider.apiKey !== KEEP_API_KEY) return provider;
		const id = expectString(provider.id, `providers[${index}].id`);
		const existing = current.providers.find((item) => item.id === id);
		if (!existing) {
			throw new Error(`providers[${index}].apiKey cannot keep a key for new provider ${id}`);
		}
		return { ...provider, apiKey: existing.apiKey };
	});
	return validateVideoConfig({ ...root, providers });
}

export function isProviderConfigured(provider: VideoProviderConfig): boolean {
	return provider.baseUrl.trim().length > 0 && provider.apiKey.trim().length > 0;
}

export function validateVideoConfig(raw: unknown): VideoGenerationConfig {
	const root = expectRecord(raw, "config");
	if (root.version !== 1) throw new Error("config.version must be 1");
	const providers = expectArray(root.providers, "providers").map(parseProvider);
	const models = expectArray(root.models, "models").map(parseModel);
	if (providers.length === 0) throw new Error("providers must contain at least one provider");
	if (models.length === 0) throw new Error("models must contain at least one model");

	const providerIds = new Set<string>();
	for (const provider of providers) {
		if (providerIds.has(provider.id)) throw new Error(`Duplicate provider id: ${provider.id}`);
		providerIds.add(provider.id);
	}
	const modelKeys = new Set<string>();
	for (const model of models) {
		if (!providerIds.has(model.provider)) {
			throw new Error(`Model ${model.id} references unknown provider ${model.provider}`);
		}
		const key = `${model.provider}\0${model.id}\0${model.task}`;
		if (modelKeys.has(key)) {
			throw new Error(`Duplicate model/task: ${model.provider}/${model.id}/${model.task}`);
		}
		modelKeys.add(key);
	}
	return { version: 1, providers, models };
}

function parseProvider(value: unknown, index: number): VideoProviderConfig {
	const location = `providers[${index}]`;
	const object = expectRecord(value, location);
	const id = expectId(object.id, `${location}.id`);
	const name = expectNonEmptyString(object.name, `${location}.name`);
	const adapter = expectString(object.adapter, `${location}.adapter`) as AdapterId;
	if (!ADAPTERS.has(adapter)) throw new Error(`${location}.adapter is unsupported: ${adapter}`);
	const baseUrl = expectString(object.baseUrl, `${location}.baseUrl`).trim();
	if (baseUrl) validateBaseUrl(baseUrl, `${location}.baseUrl`);
	const apiKey = expectString(object.apiKey, `${location}.apiKey`).trim();
	const pollIntervalMs = expectInteger(object.pollIntervalMs, `${location}.pollIntervalMs`, 1000, 300_000);
	const taskTimeoutMs = expectInteger(object.taskTimeoutMs, `${location}.taskTimeoutMs`, 30_000, 86_400_000);
	const maxOutputBytes = expectInteger(object.maxOutputBytes, `${location}.maxOutputBytes`, 1024, 4 * 1024 * 1024 * 1024);
	return { id, name, adapter, baseUrl, apiKey, pollIntervalMs, taskTimeoutMs, maxOutputBytes };
}

function parseModel(value: unknown, index: number): VideoModelConfig {
	const location = `models[${index}]`;
	const object = expectRecord(value, location);
	const id = expectId(object.id, `${location}.id`);
	const name = expectNonEmptyString(object.name, `${location}.name`);
	const provider = expectId(object.provider, `${location}.provider`);
	const task = expectString(object.task, `${location}.task`) as VideoTaskType;
	if (!TASKS.has(task)) throw new Error(`${location}.task must be t2v, i2v, or r2v`);
	const prompt = parsePromptLimits(object.prompt, `${location}.prompt`);
	const inputImages = parseImageLimits(object.inputImages, `${location}.inputImages`);
	if (task === "t2v" && (inputImages.minimum !== 0 || inputImages.maximum !== 0)) {
		throw new Error(`${location}.inputImages must be 0..0 for t2v`);
	}
	if (task === "i2v" && (inputImages.minimum !== 1 || inputImages.maximum !== 1)) {
		throw new Error(`${location}.inputImages must be 1..1 for i2v`);
	}
	if (task === "r2v" && inputImages.minimum < 1) {
		throw new Error(`${location}.inputImages.minimum must be at least 1 for r2v`);
	}
	const parameters = expectArray(object.parameters, `${location}.parameters`).map((item, parameterIndex) =>
		parseParameter(item, `${location}.parameters[${parameterIndex}]`),
	);
	const parameterKeys = new Set<string>();
	for (const parameter of parameters) {
		if (parameterKeys.has(parameter.key)) throw new Error(`${location} has duplicate parameter ${parameter.key}`);
		parameterKeys.add(parameter.key);
	}
	const referenceLabelTemplate = optionalString(object.referenceLabelTemplate, `${location}.referenceLabelTemplate`);
	if (referenceLabelTemplate !== undefined && !referenceLabelTemplate.includes("{index}")) {
		throw new Error(`${location}.referenceLabelTemplate must contain {index}`);
	}
	return { id, name, provider, task, prompt, inputImages, parameters, referenceLabelTemplate };
}

function parsePromptLimits(value: unknown, location: string): PromptLimits {
	const object = expectRecord(value, location);
	const maxChars = expectInteger(object.maxChars, `${location}.maxChars`, 1, 1_000_000);
	const maxCjkChars = optionalInteger(object.maxCjkChars, `${location}.maxCjkChars`, 1, maxChars);
	return { maxChars, maxCjkChars };
}

function parseImageLimits(value: unknown, location: string): InputImageLimits {
	const object = expectRecord(value, location);
	const minimum = expectInteger(object.minimum, `${location}.minimum`, 0, 100);
	const maximum = expectInteger(object.maximum, `${location}.maximum`, minimum, 100);
	const maxBytes = expectInteger(object.maxBytes, `${location}.maxBytes`, 1, 1024 * 1024 * 1024);
	const mimeTypes = expectArray(object.mimeTypes, `${location}.mimeTypes`).map((mime, index) =>
		expectNonEmptyString(mime, `${location}.mimeTypes[${index}]`).toLowerCase(),
	);
	if (mimeTypes.length === 0) throw new Error(`${location}.mimeTypes must not be empty`);
	const minWidth = optionalInteger(object.minWidth, `${location}.minWidth`, 1, 100_000);
	const minHeight = optionalInteger(object.minHeight, `${location}.minHeight`, 1, 100_000);
	const minShortSide = optionalInteger(object.minShortSide, `${location}.minShortSide`, 1, 100_000);
	const minAspectRatio = optionalNumber(object.minAspectRatio, `${location}.minAspectRatio`, 0.01, 100);
	const maxAspectRatio = optionalNumber(object.maxAspectRatio, `${location}.maxAspectRatio`, minAspectRatio ?? 0.01, 100);
	return { minimum, maximum, maxBytes, mimeTypes, minWidth, minHeight, minShortSide, minAspectRatio, maxAspectRatio };
}

function parseParameter(value: unknown, location: string): ParameterDefinition {
	const object = expectRecord(value, location);
	const key = expectId(object.key, `${location}.key`);
	const label = expectNonEmptyString(object.label, `${location}.label`);
	const type = expectString(object.type, `${location}.type`);
	if (!PARAMETER_TYPES.has(type)) throw new Error(`${location}.type is unsupported: ${type}`);
	const hidden = optionalBoolean(object.hidden, `${location}.hidden`);
	if (type === "select") {
		const values = expectArray(object.values, `${location}.values`).map((item, index) =>
			expectNonEmptyString(item, `${location}.values[${index}]`),
		);
		if (values.length === 0) throw new Error(`${location}.values must not be empty`);
		const defaultValue = expectString(object.default, `${location}.default`);
		if (!values.includes(defaultValue)) throw new Error(`${location}.default must be one of values`);
		const result: SelectParameterDefinition = { key, label, type, values, default: defaultValue };
		if (hidden !== undefined) result.hidden = hidden;
		return result;
	}
	if (type === "integer") {
		const minimum = expectInteger(object.minimum, `${location}.minimum`, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
		const maximum = expectInteger(object.maximum, `${location}.maximum`, minimum, Number.MAX_SAFE_INTEGER);
		const step = optionalInteger(object.step, `${location}.step`, 1, Number.MAX_SAFE_INTEGER);
		const defaultValue = optionalInteger(object.default, `${location}.default`, minimum, maximum);
		const optional = optionalBoolean(object.optional, `${location}.optional`);
		if (hidden && defaultValue === undefined) throw new Error(`${location}.default is required when hidden`);
		if (defaultValue !== undefined && (defaultValue - minimum) % (step ?? 1) !== 0) {
			throw new Error(`${location}.default must align with step ${step ?? 1} from ${minimum}`);
		}
		const result: IntegerParameterDefinition = { key, label, type, minimum, maximum };
		if (step !== undefined) result.step = step;
		if (defaultValue !== undefined) result.default = defaultValue;
		if (optional !== undefined) result.optional = optional;
		if (hidden !== undefined) result.hidden = hidden;
		return result;
	}
	const defaultValue = expectBoolean(object.default, `${location}.default`);
	const result: BooleanParameterDefinition = { key, label, type: "boolean", default: defaultValue };
	if (hidden !== undefined) result.hidden = hidden;
	return result;
}

function validateBaseUrl(value: string, location: string): void {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${location} must be an absolute URL`);
	}
	const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
	if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
		throw new Error(`${location} must use HTTPS (HTTP is allowed only for localhost)`);
	}
	if (url.username || url.password) throw new Error(`${location} must not contain URL credentials`);
}

function expectRecord(value: unknown, location: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} must be an object`);
	return value as Record<string, unknown>;
}

function expectArray(value: unknown, location: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${location} must be an array`);
	return value;
}

function expectString(value: unknown, location: string): string {
	if (typeof value !== "string") throw new Error(`${location} must be a string`);
	return value;
}

function expectNonEmptyString(value: unknown, location: string): string {
	const result = expectString(value, location).trim();
	if (!result) throw new Error(`${location} must not be empty`);
	return result;
}

function expectId(value: unknown, location: string): string {
	const result = expectNonEmptyString(value, location);
	if (result.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result)) {
		throw new Error(`${location} contains unsupported characters or exceeds 128 characters`);
	}
	return result;
}

function expectInteger(value: unknown, location: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`${location} must be an integer from ${minimum} to ${maximum}`);
	}
	return value as number;
}

function optionalInteger(value: unknown, location: string, minimum: number, maximum: number): number | undefined {
	return value === undefined ? undefined : expectInteger(value, location, minimum, maximum);
}

function optionalNumber(value: unknown, location: string, minimum: number, maximum: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${location} must be a number from ${minimum} to ${maximum}`);
	}
	return value;
}

function expectBoolean(value: unknown, location: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${location} must be a boolean`);
	return value;
}

function optionalBoolean(value: unknown, location: string): boolean | undefined {
	return value === undefined ? undefined : expectBoolean(value, location);
}

function optionalString(value: unknown, location: string): string | undefined {
	return value === undefined ? undefined : expectNonEmptyString(value, location);
}
