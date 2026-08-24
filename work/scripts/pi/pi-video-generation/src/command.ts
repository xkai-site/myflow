import type {
	InputImage,
	ParameterDefinition,
	ParsedVideoCommand,
	ResolvedVideoRequest,
	VideoGenerationConfig,
	VideoModelConfig,
	VideoTaskType,
} from "./types.ts";
import { isProviderConfigured } from "./config.ts";

const TASKS = new Set<VideoTaskType>(["t2v", "i2v", "r2v"]);

interface Token {
	value: string;
}

export function isVideoCommand(text: string): boolean {
	return text === "/video" || text.startsWith("/video ") || text.startsWith("/video\t");
}

export function parseVideoCommand(text: string): ParsedVideoCommand {
	if (!isVideoCommand(text)) throw new Error("Command must start with /video");
	const tokens = tokenize(text.slice("/video".length).trim());
	if (tokens.length === 0) return emptyGenerateCommand();
	if (["--help", "-h", "help"].includes(tokens[0].value)) return { ...emptyGenerateCommand(), operation: "help" };
	if (tokens[0].value === "config") return { ...emptyGenerateCommand(), operation: "config" };
	if (tokens[0].value === "tasks") return { ...emptyGenerateCommand(), operation: "tasks" };
	if (tokens[0].value === "resume") {
		const taskId = tokens[1]?.value;
		if (!taskId || tokens.length !== 2) throw new Error("Usage: /video resume <task-id>");
		return { ...emptyGenerateCommand(), operation: "resume", taskId };
	}

	let task: VideoTaskType | undefined;
	let model: string | undefined;
	const images: string[] = [];
	const parameters: Record<string, string> = {};
	const prompt: string[] = [];
	let parseOptions = true;

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index].value;
		if (index === 0 && TASKS.has(token as VideoTaskType)) {
			task = token as VideoTaskType;
			continue;
		}
		if (parseOptions && token === "--") {
			parseOptions = false;
			continue;
		}
		if (parseOptions && (token === "--model" || token.startsWith("--model="))) {
			model = optionValue(token, "--model", tokens, () => ++index);
			continue;
		}
		if (parseOptions && (token === "--image" || token.startsWith("--image="))) {
			images.push(optionValue(token, "--image", tokens, () => ++index));
			continue;
		}
		if (parseOptions && (token === "--param" || token.startsWith("--param="))) {
			const assignment = optionValue(token, "--param", tokens, () => ++index);
			const separator = assignment.indexOf("=");
			if (separator <= 0) throw new Error("--param requires KEY=VALUE");
			const key = assignment.slice(0, separator);
			if (Object.hasOwn(parameters, key)) throw new Error(`Duplicate parameter: ${key}`);
			parameters[key] = assignment.slice(separator + 1);
			continue;
		}
		if (parseOptions && token.startsWith("--")) throw new Error(`Unknown option: ${token}`);
		prompt.push(token);
	}
	return { operation: "generate", task, model, prompt: prompt.join(" ").trim(), images, parameters };
}

export function resolveVideoRequest(
	parsed: ParsedVideoCommand,
	config: VideoGenerationConfig,
	images: InputImage[],
): ResolvedVideoRequest {
	if (parsed.operation !== "generate") throw new Error("Only generation commands can be resolved");
	if (!parsed.prompt) throw new Error("Video prompt must not be empty");
	let candidates = config.models.filter((model) => {
		const provider = config.providers.find((item) => item.id === model.provider);
		return provider !== undefined && isProviderConfigured(provider);
	});
	if (parsed.task) candidates = candidates.filter((model) => model.task === parsed.task);
	if (parsed.model) candidates = candidates.filter((model) => model.id === parsed.model);
	if (candidates.length === 0) throw new Error("No configured video model matches the requested task/model");
	if (candidates.length > 1) {
		throw new Error("Multiple video models match; specify task and --model explicitly");
	}
	const model = candidates[0];
	const provider = config.providers.find((item) => item.id === model.provider);
	if (!provider) throw new Error(`Video provider is missing: ${model.provider}`);
	validatePrompt(parsed.prompt, model);
	validateImageCount(images.length, model);
	return {
		provider,
		model,
		prompt: parsed.prompt,
		images,
		parameters: resolveParameters(model.parameters, parsed.parameters),
	};
}

export function resolveParameters(
	definitions: readonly ParameterDefinition[],
	raw: Readonly<Record<string, string>>,
): Record<string, string | number | boolean> {
	const known = new Set(definitions.map((definition) => definition.key));
	for (const key of Object.keys(raw)) {
		if (!known.has(key)) throw new Error(`Unknown model parameter: ${key}`);
	}
	const result: Record<string, string | number | boolean> = {};
	for (const definition of definitions) {
		const supplied = raw[definition.key];
		if (definition.type === "select") {
			const value = supplied ?? definition.default;
			if (!definition.values.includes(value)) {
				throw new Error(`${definition.key} must be one of: ${definition.values.join(", ")}`);
			}
			result[definition.key] = value;
			continue;
		}
		if (definition.type === "boolean") {
			if (supplied === undefined) result[definition.key] = definition.default;
			else if (supplied === "true" || supplied === "false") result[definition.key] = supplied === "true";
			else throw new Error(`${definition.key} must be true or false`);
			continue;
		}
		if (supplied === undefined && definition.default === undefined && definition.optional) continue;
		const value = supplied === undefined ? definition.default : Number(supplied);
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < definition.minimum || value > definition.maximum) {
			throw new Error(`${definition.key} must be an integer from ${definition.minimum} to ${definition.maximum}`);
		}
		const step = definition.step ?? 1;
		if ((value - definition.minimum) % step !== 0) {
			throw new Error(`${definition.key} must use step ${step} from ${definition.minimum}`);
		}
		result[definition.key] = value;
	}
	return result;
}

export function validatePrompt(prompt: string, model: VideoModelConfig): void {
	const hasCjk = /[\u3400-\u9fff\uf900-\ufaff]/u.test(prompt);
	const maximum = hasCjk && model.prompt.maxCjkChars ? model.prompt.maxCjkChars : model.prompt.maxChars;
	if (prompt.length > maximum) throw new Error(`${model.id} prompt exceeds ${maximum} characters`);
}

export function validateImageCount(count: number, model: VideoModelConfig): void {
	const limits = model.inputImages;
	if (count < limits.minimum || count > limits.maximum) {
		if (limits.minimum === limits.maximum) {
			throw new Error(`${model.id} requires exactly ${limits.minimum} input image(s)`);
		}
		throw new Error(`${model.id} requires ${limits.minimum} to ${limits.maximum} input images`);
	}
}

export function usageText(): string {
	return [
		"Interactive usage:",
		"  /video",
		"  /video config",
		"  /video tasks",
		"  /video resume <task-id>",
		"Non-interactive/RPC usage:",
		"  /video t2v --model MODEL [--param key=value] <prompt>",
		"  /video i2v --model MODEL --image PATH [--param key=value] <prompt>",
		"  /video r2v --model MODEL --image PATH [--image PATH...] [--param key=value] <prompt>",
	].join("\n");
}

function emptyGenerateCommand(): ParsedVideoCommand {
	return { operation: "generate", prompt: "", images: [], parameters: {} };
}

function optionValue(token: string, name: string, tokens: Token[], advance: () => number): string {
	const value = token === name ? tokens[advance()]?.value : token.slice(name.length + 1);
	if (!value) throw new Error(`${name} requires a value`);
	return value;
}

function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	let value = "";
	let quote: '"' | "'" | undefined;
	let active = false;
	for (let index = 0; index < input.length; index++) {
		const character = input[index];
		if (character === "\\" && quote !== "'") {
			const next = input[index + 1];
			const escapesNext =
				next !== undefined &&
				(quote === '"' ? next === '"' : /\s/u.test(next) || next === '"' || next === "'");
			if (escapesNext) {
				value += next;
				index++;
			} else {
				value += character;
			}
			active = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else value += character;
			active = true;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			active = true;
			continue;
		}
		if (/\s/u.test(character)) {
			if (active) {
				tokens.push({ value });
				value = "";
				active = false;
			}
			continue;
		}
		value += character;
		active = true;
	}
	if (quote) throw new Error("Command contains an unterminated quote");
	if (active) tokens.push({ value });
	return tokens;
}
