import { assertModelEnabled, normalizeModelSize, sizeForTask, type ImageConfig, type ImageModelConfig } from "./model-config.ts";
import type { ParsedImageCommand, ResolvedImageCommand } from "./types.ts";

interface Token {
	value: string;
}

export function isImageCommand(text: string): boolean {
	return text === "/image" || text.startsWith("/image ") || text.startsWith("/image\t");
}

export function parseImageCommand(text: string, config: ImageConfig): ParsedImageCommand {
	if (!isImageCommand(text)) {
		throw new Error("Command must start with /image");
	}

	const tokens = tokenize(text.slice("/image".length).trim());
	let modelKey: string | undefined;
	let size: string | undefined;
	let quality: string | undefined;
	let help = false;
	const prompt: string[] = [];
	let parseOptions = true;

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index].value;
		if (index === 0 && config.models.some((model) => model.key === token)) {
			modelKey = token;
			continue;
		}
		if (parseOptions && token === "--") {
			parseOptions = false;
			continue;
		}
		if (parseOptions && (token === "--help" || token === "-h")) {
			help = true;
			continue;
		}
		if (parseOptions && (token === "--size" || token.startsWith("--size="))) {
			const value = token === "--size" ? tokens[++index]?.value : token.slice("--size=".length);
			if (!value) throw new Error("--size requires a value");
			size = value;
			continue;
		}
		if (parseOptions && (token === "--quality" || token.startsWith("--quality="))) {
			const value = token === "--quality" ? tokens[++index]?.value : token.slice("--quality=".length);
			if (!value) throw new Error("--quality requires a value");
			quality = value;
			continue;
		}
		if (parseOptions && token.startsWith("--")) {
			throw new Error("Unknown /image option; use /image --help");
		}
		prompt.push(token);
	}

	return { modelKey, prompt: prompt.join(" ").trim(), size, quality, help };
}

export function resolveImageCommand(
	command: ParsedImageCommand,
	model: ImageModelConfig,
	imageCount: number,
	config: ImageConfig,
): ResolvedImageCommand {
	if (command.help) throw new Error("Handle help before command resolution");
	assertModelEnabled(model);
	if (!command.prompt.trim()) throw new Error("Image prompt must not be empty");
	if (command.prompt.length > model.prompt.maxChars) throw new Error(`Prompt exceeds ${model.prompt.maxChars} characters`);
	if (!Number.isSafeInteger(imageCount) || imageCount < 0 || imageCount > model.inputImages.maximum) {
		throw new Error(`Model accepts at most ${model.inputImages.maximum} reference images`);
	}
	const task = imageCount > 0 ? "edit" : "generate";
	if (!model.tasks.includes(task)) throw new Error(`Model does not support ${task}`);
	const providerConfig = config.providers.find((provider) => provider.id === model.provider);
	if (!providerConfig) throw new Error("Model provider is not configured");
	if (!model.quality && command.quality !== undefined) throw new Error("--quality is not supported by this model");
	const quality = command.quality ?? model.quality?.default;
	if (quality !== undefined && !model.quality?.options.some((option) => option.value === quality)) {
		throw new Error("Quality must be one of the configured model options");
	}
	return { ...command, modelKey: model.key, provider: providerConfig.id, model: model.id, modelConfig: model, providerConfig,
		size: normalizeModelSize(sizeForTask(model, task), command.size), quality };
}

export function inferModelForSingleAccount(config: ImageConfig, availableProviderIds: readonly string[]): ImageModelConfig | undefined {
	if (availableProviderIds.length !== 1) return undefined;
	const provider = config.providers.find((p) => p.id === availableProviderIds[0]);
	return config.models.find((model) => model.key === provider?.defaultModel && model.enabled !== false);
}

export function usageText(config?: ImageConfig): string {
	return [
		"Interactive: /image — generate/edit or account settings",
		"Accounts: /image --settings (TUI only; never put a Key in command arguments)",
		"Non-interactive/RPC: /image [model-key] [--size VALUE] [--quality VALUE] <prompt>",
		"Omit model-key only when one image account is configured; its default model is used.",
		"Use -- before a prompt that starts with a model key or an option.",
		...(config ? config.models.map((model) => `  ${model.key}: ${model.name} (${model.id})${model.enabled === false ? " [disabled]" : ""}`) : []),
		"Models and options: models.jsonc next to the extension package; /reload after edits.",
	].join("\n");
}

function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	let value = "";
	let quote: '"' | "'" | undefined;
	let escaping = false;
	let active = false;

	for (const character of input) {
		if (escaping) {
			value += character;
			escaping = false;
			active = true;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaping = true;
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
		if (/\s/.test(character)) {
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

	if (escaping) throw new Error("Command ends with an incomplete escape");
	if (quote) throw new Error("Command contains an unterminated quote");
	if (active) tokens.push({ value });
	return tokens;
}
