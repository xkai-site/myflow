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
	let complexity: string | undefined;
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
		if (parseOptions && (token === "--complexity" || token.startsWith("--complexity="))) {
			const value = token === "--complexity" ? tokens[++index]?.value : token.slice("--complexity=".length);
			if (!value) throw new Error("--complexity requires a value");
			complexity = value;
			continue;
		}
		if (parseOptions && token.startsWith("--")) {
			throw new Error("Unknown /image option; use /image --help");
		}
		prompt.push(token);
	}

	return { modelKey, prompt: prompt.join(" ").trim(), size, quality, complexity, help };
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
	if (!model.complexity && command.complexity !== undefined) throw new Error("--complexity is not supported by this model");
	const complexity = command.complexity ?? model.complexity?.default;
	if (complexity !== undefined && !model.complexity?.options.some((option) => option.value === complexity)) {
		throw new Error("Complexity must be one of the configured model options");
	}
	return { ...command, modelKey: model.key, provider: providerConfig.id, model: model.id, modelConfig: model, providerConfig,
		size: normalizeModelSize(sizeForTask(model, task), command.size), quality, complexity };
}

export function inferModelForSingleAccount(config: ImageConfig, availableProviderIds: readonly string[]): ImageModelConfig | undefined {
	if (availableProviderIds.length !== 1) return undefined;
	const provider = config.providers.find((p) => p.id === availableProviderIds[0]);
	return config.models.find((model) => model.key === provider?.defaultModel && model.enabled !== false);
}

export function usageText(config?: ImageConfig): string {
	return [
		"交互：/image 或 /image <prompt>（整段文本预填提示词，不解析 RPC 选项）",
		"流程：任务 → 提示词 → 账户 → 模型 → 参数；单账户或单模型自动选择。",
		"参数菜单默认开始生成，需要时再调整尺寸、画质和复杂度；仅显示模型支持的选项。",
		"编辑任务需填写参考图路径，每行一个；Escape 取消，参数选项内 Escape 返回菜单。",
		"OpenAI 参考图限制按 Platform JSON 编辑接口配置，含 data URL 前缀与 Base64 编码开销；张数和大小见 models.jsonc，并非 Codex 通道实测上限。",
		"账户：/image --settings（秘密输入仅支持 TUI，不要将 Key 写入命令）",
		"非交互/RPC：/image [model-key] [--size VALUE] [--quality VALUE] [--complexity VALUE] [--] <prompt>",
		"只有一个已配置图片账户时可省略 model-key，使用该账户默认模型。",
		"提示词以模型 key 或选项开头时，先写 --。标准 RPC 仅支持生成，不处理图片附件。",
		...(config ? [
			...config.providers.map((provider) => `默认模型：${provider.name} → ${provider.defaultModel}`),
			...config.models.map((model) => `  ${model.key}: ${model.name}${model.description ? ` - ${model.description}` : ""}${model.enabled === false ? " [已禁用]" : ""}`),
		] : []),
		"参数值和输入限制见插件目录 models.jsonc；修改后执行 /reload。复杂度控制布局规划，画质控制渲染细节。",
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
