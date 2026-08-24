import type {
	ImageProviderChoice,
	OpenAIImageQuality,
	ParsedImageCommand,
	ResolvedImageCommand,
} from "./types.ts";

const PROVIDERS = new Set<ImageProviderChoice>(["openai", "wan", "wan-pro"]);
const QUALITIES = new Set<OpenAIImageQuality>(["auto", "low", "medium", "high"]);

interface Token {
	value: string;
}

export function isImageCommand(text: string): boolean {
	return text === "/image" || text.startsWith("/image ") || text.startsWith("/image\t");
}

export function parseImageCommand(text: string): ParsedImageCommand {
	if (!isImageCommand(text)) {
		throw new Error("Command must start with /image");
	}

	const tokens = tokenize(text.slice("/image".length).trim());
	let provider: ImageProviderChoice | undefined;
	let size: string | undefined;
	let quality: OpenAIImageQuality | undefined;
	let help = false;
	const prompt: string[] = [];
	let parseOptions = true;

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index].value;
		if (index === 0 && PROVIDERS.has(token as ImageProviderChoice)) {
			provider = token as ImageProviderChoice;
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
			if (!value || !QUALITIES.has(value as OpenAIImageQuality)) {
				throw new Error("--quality must be one of: auto, low, medium, high");
			}
			quality = value as OpenAIImageQuality;
			continue;
		}
		if (parseOptions && token.startsWith("--")) {
			throw new Error(`Unknown option: ${token}`);
		}
		prompt.push(token);
	}

	return { provider, prompt: prompt.join(" ").trim(), size, quality, help };
}

export function resolveImageCommand(
	command: ParsedImageCommand,
	provider: ImageProviderChoice,
	imageCount: number,
): ResolvedImageCommand {
	if (command.help) {
		throw new Error("Help requests must be handled before command resolution");
	}
	if (!command.prompt) throw new Error("Image prompt must not be empty");

	const model =
		provider === "openai" ? "gpt-image-2" : provider === "wan-pro" ? "wan2.7-image-pro" : "wan2.7-image";
	const maxPromptLength = provider === "openai" ? 32_000 : 5_000;
	if (command.prompt.length > maxPromptLength) {
		throw new Error(`${model} prompt exceeds ${maxPromptLength} characters`);
	}

	const maxImages = provider === "openai" ? 5 : 9;
	if (imageCount > maxImages) {
		throw new Error(`${model} accepts at most ${maxImages} reference images`);
	}
	if (provider !== "openai" && command.quality !== undefined) {
		throw new Error("--quality is supported only by the OpenAI provider");
	}

	return {
		...command,
		provider,
		model,
		size: normalizeSize(provider, command.size, imageCount > 0),
		quality: provider === "openai" ? (command.quality ?? "auto") : undefined,
	};
}

export function usageText(): string {
	return [
		"Interactive usage:",
		"  /image",
		"  Enter the prompt, then select the task, model, size, and quality.",
		"  Reference-image editing accepts one dragged or pasted file path per line.",
		"Only configured image accounts are offered; a single account is selected automatically.",
		"Non-interactive/RPC usage:",
		"  /image openai [--size auto|WIDTHxHEIGHT] [--quality auto|low|medium|high] <prompt>",
		"  /image wan [--size 1K|2K|WIDTH*HEIGHT] <prompt>",
		"  /image wan-pro [--size 1K|2K|4K|WIDTH*HEIGHT] <prompt>",
		"  Provider may be omitted when exactly one account is configured (Ali defaults to wan).", 
	].join("\n");
}

function normalizeSize(provider: ImageProviderChoice, rawSize: string | undefined, hasImages: boolean): string {
	if (provider === "openai") {
		const size = rawSize ?? "auto";
		if (size === "auto") return size;
		const dimensions = parseDimensions(size, "x");
		if (!dimensions) throw new Error("OpenAI size must be auto or WIDTHxHEIGHT");
		const { width, height } = dimensions;
		const pixels = width * height;
		const ratio = Math.max(width, height) / Math.min(width, height);
		if (width % 16 !== 0 || height % 16 !== 0) throw new Error("OpenAI dimensions must be multiples of 16");
		if (Math.max(width, height) > 3840 || ratio > 3 || pixels < 655_360 || pixels > 8_294_400) {
			throw new Error("OpenAI dimensions exceed gpt-image-2 size constraints");
		}
		return `${width}x${height}`;
	}

	const size = (rawSize ?? "2K").toUpperCase();
	if (size === "1K" || size === "2K") return size;
	if (size === "4K") {
		if (provider !== "wan-pro") throw new Error("4K requires wan2.7-image-pro");
		if (hasImages) throw new Error("wan2.7-image-pro supports 4K only for text-to-image generation");
		return size;
	}

	const dimensions = parseDimensions(size, "*") ?? parseDimensions(size, "X");
	if (!dimensions) throw new Error("Wan size must be 1K, 2K, 4K, or WIDTH*HEIGHT");
	const { width, height } = dimensions;
	const maxPixels = provider === "wan-pro" && !hasImages ? 4096 * 4096 : 2048 * 2048;
	const pixels = width * height;
	const ratio = Math.max(width, height) / Math.min(width, height);
	if (pixels < 768 * 768 || pixels > maxPixels || ratio > 8) {
		throw new Error("Wan dimensions exceed the selected model's size constraints");
	}
	return `${width}*${height}`;
}

function parseDimensions(value: string, separator: "x" | "X" | "*"): { width: number; height: number } | undefined {
	const parts = value.split(separator);
	if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return undefined;
	const width = Number(parts[0]);
	const height = Number(parts[1]);
	if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return undefined;
	return { width, height };
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
