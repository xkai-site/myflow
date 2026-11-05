import { assertModelEnabled, normalizeNativeOutput, normalizeModelSize, sizeForOutput, type ImageConfig, type ImageModelConfig } from "./model-config.ts";
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
	let outputFormat: string | undefined;
	let background: string | undefined;
	let markupPath: string | undefined;
	const referencePaths: string[] = [];
	const animation: { frameCount?: number; frameDurationMs?: number } = {};
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
		if (parseOptions && (token === "--format" || token.startsWith("--format="))) {
			if (outputFormat !== undefined) throw new Error("--format must not be repeated");
			const value = token === "--format" ? tokens[++index]?.value : token.slice("--format=".length);
			if (!value || value.startsWith("--")) throw new Error("--format requires a value");
			outputFormat = value;
			continue;
		}
		if (parseOptions && (token === "--background" || token.startsWith("--background="))) {
			if (background !== undefined) throw new Error("--background must not be repeated");
			const value = token === "--background" ? tokens[++index]?.value : token.slice("--background=".length);
			if (!value || value.startsWith("--")) throw new Error("--background requires a value");
			background = value;
			continue;
		}
		if (parseOptions && ["--frame-count", "--frame-duration-ms"].some((flag) => token === flag || token.startsWith(`${flag}=`))) {
			const flag = token.split("=", 1)[0];
			const key = flag === "--frame-count" ? "frameCount" : "frameDurationMs";
			if (animation[key] !== undefined) throw new Error(`${flag} must not be repeated`);
			const value = token === flag ? tokens[++index]?.value : token.slice(flag.length + 1);
			if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${flag} requires an integer value`);
			animation[key] = Number(value);
			continue;
		}
		if (parseOptions && ["--markup", "--image"].some((flag) => token === flag || token.startsWith(`${flag}=`))) {
			const flag = token.split("=", 1)[0];
			const value = token === flag ? tokens[++index]?.value : token.slice(flag.length + 1);
			if (!value?.trim() || value.startsWith("--")) throw new Error(`${flag} requires a file path`);
			if (flag === "--markup") {
				if (markupPath !== undefined) throw new Error("--markup must not be repeated");
				markupPath = value;
			} else {
				if (referencePaths.length >= 100) throw new Error("Too many reference image paths");
				referencePaths.push(value);
			}
			continue;
		}
		if (parseOptions && token.startsWith("--")) {
			throw new Error("Unknown /image option; use /image --help");
		}
		prompt.push(token);
	}

	return { modelKey, prompt: prompt.join(" ").trim(), size, quality, complexity, outputFormat, background, ...animation,
		...(referencePaths.length ? { referencePaths } : {}), ...(markupPath !== undefined ? { markupPath } : {}), help };
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
	if (imageCount && command.referencePaths?.length) throw new Error("Do not combine image attachments with --image paths");
	imageCount += command.referencePaths?.length ?? 0;
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
	const imageOutput = normalizeNativeOutput(model, command, task);
	return { ...command, modelKey: model.key, provider: providerConfig.id, model: model.id, modelConfig: model, providerConfig,
		size: normalizeModelSize(sizeForOutput(model, task, imageOutput.outputFormat), command.size), quality, complexity, ...imageOutput };
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
		"参数菜单默认开始生成，需要时再调整尺寸、画质、复杂度、输出格式和背景；仅显示模型支持的选项。",
		"编辑任务需填写参考图路径，每行一个；Escape 取消，参数选项内 Escape 返回菜单。",
		"OpenAI 参考图限制按 Platform JSON 编辑接口配置，含 data URL 前缀与 Base64 编码开销；张数和大小见 models.jsonc，并非 Codex 通道实测上限。",
		"账户：/image --settings（秘密输入仅支持 TUI，不要将 Key 写入命令）",
		"非交互/RPC：/image [model-key] [--size VALUE] [--quality VALUE] [--complexity VALUE] [--format VALUE] [--background VALUE] [--image PATH ...] [--markup PATH] [--] <prompt>",
		"支持时可选 --format png|jpeg|webp（默认 png）、--background auto|opaque|transparent（默认 auto）；transparent 与 jpeg 不兼容。新参数不可重复，支持 --option=value。",
		"格式按真实字节校验，与请求或服务端声明不符则不保存、不重试。透明背景是请求意图，不代表已验证存在透明像素。Codex 新参数尚未在线验证。",
		"高级能力默认关闭，Codex 尚未在线验证。可按模型显式开启实验性 GIF、SVG 或 Markup；Streaming 只有独立离线适配器，不开放生产入口。",
		"实验 SVG：--format svg，仅生成，安全静态 XML 校验后保存原文件，不支持编辑、流式、压缩或自选作者模型。",
		"RPC 编辑：--image PATH 可重复，第一张是原图；实验 Markup：--markup PATH，独立透明 PNG，方向归一化后与原图同尺寸，不计入普通参考图。",
		"实验 GIF：--format gif [--frame-count N] [--frame-duration-ms N]；默认 9 帧、200ms，范围见配置（保守 2～16 帧、20～2000ms），仅生成，不支持透明背景、流式或压缩参数。终端不播放动画。",
		"只有一个已配置图片账户时可省略 model-key，使用该账户默认模型。",
		"提示词以模型 key 或选项开头时，先写 --。标准 RPC 不处理图片附件，编辑请显式提供本地 --image 路径。Windows 路径请用正斜杠或单引号。",
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
