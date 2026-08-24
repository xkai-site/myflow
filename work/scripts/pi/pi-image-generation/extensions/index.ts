import { readFileSync } from "node:fs";
import path from "node:path";
import {
	createImagesModels,
	createImagesProvider,
	type AssistantImages,
	type ImageContent,
	type ImagesApi,
	type ImagesContext,
	type ImagesModel,
	type ImagesOptions,
	type ProviderAuth,
	type ProviderImages,
	type TextContent,
} from "@earendil-works/pi-ai";
import { BorderedLoader, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Image, Spacer, Text } from "@earendil-works/pi-tui";
import { generateAliWanImages } from "../src/ali-wan-images.ts";
import { isImageCommand, parseImageCommand, resolveImageCommand, usageText } from "../src/command.ts";
import {
	detectImage,
	isGeneratedImagePath,
	loadInputImages,
	parseReferenceImagePaths,
	saveGeneratedImages,
	validateInputImages,
} from "../src/image-files.ts";
import { sanitizeError } from "../src/http.ts";
import { generateOpenAICodexImages } from "../src/openai-codex-images.ts";
import type {
	GeneratedImageEntryData,
	GenerationOutcome,
	ImageProviderChoice,
	ImageTransportOptions,
	OpenAIImageQuality,
	ImageTransportResult,
	ParsedImageCommand,
	ResolvedImageCommand,
} from "../src/types.ts";

const ENTRY_TYPE = "pi-image-generation";
const OPENAI_AUTH_PROVIDER = "openai-codex";
const ALI_AUTH_PROVIDER = "qwen-token-plan-cn";
const OPENAI_IMAGES_PROVIDER = "openai-codex-images";
const ALI_IMAGES_PROVIDER = "qwen-token-plan-cn-images";
const OPENAI_IMAGES_API = "openai-codex-images";
const ALI_IMAGES_API = "ali-wan-images";

interface GenerationUiError {
	error: string;
}

type GenerationUiResult = GenerationOutcome | GenerationUiError;
type ImageTransport = (options: ImageTransportOptions) => Promise<ImageTransportResult>;

const PROVIDER_LABELS: Record<ImageProviderChoice, string> = {
	openai: "OpenAI — gpt-image-2 (Codex OAuth)",
	wan: "Wan — wan2.7-image (Token Plan CN)",
	"wan-pro": "Wan Pro — wan2.7-image-pro (Token Plan CN)",
};

export default function imageGenerationExtension(pi: ExtensionAPI) {
	pi.registerEntryRenderer<GeneratedImageEntryData>(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		const container = new Container();
		if (!data || !isGeneratedImagePath(data.path)) {
			container.addChild(new Text(theme.fg("error", "Generated image entry has an invalid path"), 0, 0));
			return container;
		}
		container.addChild(
			new Text(
				theme.fg("success", `${data.provider}/${data.model}`) + "\n" + theme.fg("dim", data.path),
				0,
				0,
			),
		);
		try {
			const bytes = readFileSync(data.path);
			const detected = detectImage(bytes);
			if (!detected || detected.mimeType !== data.mimeType) throw new Error("stored image format mismatch");
			container.addChild(new Spacer(1));
			container.addChild(
				new Image(
					bytes.toString("base64"),
					detected.mimeType,
					{ fallbackColor: (text) => theme.fg("dim", text) },
					{
						filename: path.basename(data.path),
						maxWidthCells: 72,
						maxHeightCells: 28,
					},
				),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			container.addChild(new Text(theme.fg("warning", `Image preview unavailable: ${message}`), 0, 0));
		}
		return container;
	});

	pi.registerCommand("image", {
		description: "Generate or edit an image through an interactive setup flow",
		handler: async (args, ctx) => {
			if (ctx.mode === "tui") await runImageWizard(pi, args, ctx);
			else await runRawImageRequest(pi, `/image ${args}`.trimEnd(), [], ctx);
		},
	});

	pi.on("input", async (event, ctx) => {
		if (!isImageCommand(event.text)) return { action: "continue" };
		await runRawImageRequest(pi, event.text, event.images ?? [], ctx);
		return { action: "handled" };
	});
}

async function runImageWizard(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
	if (!ctx.isIdle()) {
		ctx.ui.notify("Wait for the current agent operation to finish before using /image", "warning");
		return;
	}
	if (["--help", "-h"].includes(args.trim())) {
		ctx.ui.notify(usageText(), "info");
		return;
	}

	const availableProviders = getAvailableProviders(ctx);
	if (availableProviders.length === 0) {
		ctx.ui.notify(noConfiguredProviderMessage(), "warning");
		return;
	}

	const promptInput = await ctx.ui.editor("Image prompt", args.trim());
	if (promptInput === undefined) {
		notifyCancelled(ctx);
		return;
	}
	const prompt = promptInput.trim();
	if (!prompt) {
		ctx.ui.notify("Image prompt must not be empty", "warning");
		return;
	}

	const mode = await selectGenerationMode((title, options) => ctx.ui.select(title, options));
	if (!mode) {
		notifyCancelled(ctx);
		return;
	}
	const provider = await selectProvider(availableProviders, (title, options) => ctx.ui.select(title, options));
	if (!provider) {
		notifyCancelled(ctx);
		return;
	}

	let inputImages: ImageContent[] = [];
	if (mode === "edit") {
		const pathInput = await ctx.ui.editor(
			"Reference image files — one path per line; drag files here",
			"",
		);
		if (pathInput === undefined) {
			notifyCancelled(ctx);
			return;
		}
		const referencePaths = parseReferenceImagePaths(pathInput);
		if (referencePaths.length === 0) {
			ctx.ui.notify("Reference-image editing requires at least one image file", "warning");
			return;
		}
		try {
			inputImages = await loadInputImages(ctx.cwd, referencePaths, provider);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}
	}

	const size = await selectImageSize(
		provider,
		inputImages.length > 0,
		(title, options) => ctx.ui.select(title, options),
	);
	if (!size) {
		notifyCancelled(ctx);
		return;
	}
	let quality: OpenAIImageQuality | undefined;
	if (provider === "openai") {
		quality = await selectOpenAIQuality((title, options) => ctx.ui.select(title, options));
		if (!quality) {
			notifyCancelled(ctx);
			return;
		}
	}

	let command: ResolvedImageCommand;
	try {
		const parsed: ParsedImageCommand = { provider, prompt, size, quality, help: false };
		command = resolveImageCommand(parsed, provider, inputImages.length);
		validateInputImages(inputImages, provider);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}
	await runImageGeneration(pi, command, inputImages, ctx);
}

async function runRawImageRequest(
	pi: ExtensionAPI,
	text: string,
	inputImages: readonly ImageContent[],
	ctx: ExtensionContext,
): Promise<void> {
	if (!ctx.isIdle()) {
		ctx.ui.notify("Wait for the current agent operation to finish before using /image", "warning");
		return;
	}

	let parsed: ParsedImageCommand;
	try {
		parsed = parseImageCommand(text);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}
	if (parsed.help || !parsed.prompt) {
		ctx.ui.notify(usageText(), parsed.help ? "info" : "warning");
		return;
	}

	const availableProviders = getAvailableProviders(ctx);
	if (availableProviders.length === 0) {
		ctx.ui.notify(noConfiguredProviderMessage(), "warning");
		return;
	}

	let provider = parsed.provider;
	if (provider && !availableProviders.includes(provider)) {
		ctx.ui.notify(unavailableProviderMessage(provider), "warning");
		return;
	}
	if (!provider && ctx.mode === "tui") {
		provider = await selectProvider(availableProviders, (title, options) => ctx.ui.select(title, options));
	} else if (!provider) {
		provider = inferProviderForSingleAccount(availableProviders);
	}
	if (!provider) {
		ctx.ui.notify(
			ctx.mode === "tui"
				? "Image generation cancelled"
				: "Multiple image accounts are configured; specify openai, wan, or wan-pro",
			ctx.mode === "tui" ? "info" : "error",
		);
		return;
	}

	let command: ResolvedImageCommand;
	try {
		command = resolveImageCommand(parsed, provider, inputImages.length);
		validateInputImages(inputImages, provider);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}
	await runImageGeneration(pi, command, inputImages, ctx);
}

async function runImageGeneration(
	pi: ExtensionAPI,
	command: ResolvedImageCommand,
	inputImages: readonly ImageContent[],
	ctx: ExtensionContext,
): Promise<void> {
	if (ctx.mode !== "tui") {
		try {
			const outcome = await generateAndSave(command, inputImages, ctx, AbortSignal.timeout(300_000));
			publishOutcome(pi, ctx, outcome);
		} catch (error) {
			ctx.ui.notify(sanitizeError(error instanceof Error ? error.message : String(error)), "error");
		}
		return;
	}

	const result = await ctx.ui.custom<GenerationUiResult | null>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, `Generating with ${command.model}...`);
		let settled = false;
		const finish = (value: GenerationUiResult | null) => {
			if (settled) return;
			settled = true;
			done(value);
		};
		loader.onAbort = () => finish(null);
		void generateAndSave(command, inputImages, ctx, loader.signal)
			.then((outcome) => finish(outcome))
			.catch((error: unknown) => {
				if (loader.signal.aborted) finish(null);
				else finish({ error: sanitizeError(error instanceof Error ? error.message : String(error)) });
			});
		return loader;
	});

	if (result === null) {
		notifyCancelled(ctx);
		return;
	}
	if ("error" in result) {
		ctx.ui.notify(result.error, "error");
		return;
	}
	publishOutcome(pi, ctx, result);
}

function notifyCancelled(ctx: ExtensionContext): void {
	ctx.ui.notify("Image generation cancelled", "info");
}

function publishOutcome(pi: ExtensionAPI, ctx: ExtensionContext, outcome: GenerationOutcome): void {
	for (const entry of outcome.entries) pi.appendEntry(ENTRY_TYPE, entry);
	ctx.ui.notify(
		`Saved ${outcome.entries.length} image(s):\n${outcome.entries.map((entry) => entry.path).join("\n")}`,
		"info",
	);
}

async function selectProvider(
	availableProviders: readonly ImageProviderChoice[],
	select: (title: string, options: string[]) => Promise<string | undefined>,
): Promise<ImageProviderChoice | undefined> {
	if (availableProviders.length === 1) return availableProviders[0];
	const labels = availableProviders.map((provider) => PROVIDER_LABELS[provider]);
	const choice = await select("Image provider", labels);
	const index = choice === undefined ? -1 : labels.indexOf(choice);
	return index >= 0 ? availableProviders[index] : undefined;
}

function getAvailableProviders(ctx: ExtensionContext): ImageProviderChoice[] {
	const providers: ImageProviderChoice[] = [];
	if (hasConfiguredProvider(ctx, OPENAI_AUTH_PROVIDER)) providers.push("openai");
	if (hasConfiguredProvider(ctx, ALI_AUTH_PROVIDER)) providers.push("wan", "wan-pro");
	return providers;
}

function hasConfiguredProvider(ctx: ExtensionContext, providerId: string): boolean {
	return ctx.modelRegistry.getProvider(providerId) !== undefined &&
		ctx.modelRegistry.getProviderAuthStatus(providerId).configured;
}

function inferProviderForSingleAccount(
	availableProviders: readonly ImageProviderChoice[],
): ImageProviderChoice | undefined {
	const hasOpenAI = availableProviders.includes("openai");
	const hasAli = availableProviders.includes("wan");
	if (hasOpenAI === hasAli) return undefined;
	return hasOpenAI ? "openai" : "wan";
}

function noConfiguredProviderMessage(): string {
	return "No image account is configured. Log in to openai-codex or configure qwen-token-plan-cn, then retry.";
}

function unavailableProviderMessage(provider: ImageProviderChoice): string {
	return provider === "openai"
		? "OpenAI Codex is unavailable or not logged in. Configure openai-codex first."
		: "Qwen Token Plan CN is unavailable or not configured. Configure qwen-token-plan-cn first.";
}

async function selectGenerationMode(
	select: (title: string, options: string[]) => Promise<string | undefined>,
): Promise<"generate" | "edit" | undefined> {
	const choice = await select("Image task", [
		"Generate a new image",
		"Edit using reference image files",
	]);
	if (choice === "Generate a new image") return "generate";
	if (choice === "Edit using reference image files") return "edit";
	return undefined;
}

async function selectImageSize(
	provider: ImageProviderChoice,
	hasImages: boolean,
	select: (title: string, options: string[]) => Promise<string | undefined>,
): Promise<string | undefined> {
	if (provider === "openai") {
		const choice = await select("Image size", [
			"Automatic — provider chooses",
			"Square — 1024x1024",
			"Landscape — 1536x1024",
			"Portrait — 1024x1536",
		]);
		if (choice === "Automatic — provider chooses") return "auto";
		if (choice === "Square — 1024x1024") return "1024x1024";
		if (choice === "Landscape — 1536x1024") return "1536x1024";
		if (choice === "Portrait — 1024x1536") return "1024x1536";
		return undefined;
	}

	const choices = ["1K", "2K"];
	if (provider === "wan-pro" && !hasImages) choices.push("4K");
	return select("Image size", choices);
}

async function selectOpenAIQuality(
	select: (title: string, options: string[]) => Promise<string | undefined>,
): Promise<OpenAIImageQuality | undefined> {
	const choice = await select("Image quality", [
		"Automatic — provider chooses",
		"Low — fastest",
		"Medium — balanced",
		"High — highest detail",
	]);
	if (choice === "Automatic — provider chooses") return "auto";
	if (choice === "Low — fastest") return "low";
	if (choice === "Medium — balanced") return "medium";
	if (choice === "High — highest detail") return "high";
	return undefined;
}

async function generateAndSave(
	command: ResolvedImageCommand,
	inputImages: readonly ImageContent[],
	ctx: ExtensionContext,
	signal: AbortSignal,
): Promise<GenerationOutcome> {
	const authProviderId = command.provider === "openai" ? OPENAI_AUTH_PROVIDER : ALI_AUTH_PROVIDER;
	const authProvider = ctx.modelRegistry.getProvider(authProviderId);
	if (!authProvider) {
		throw new Error(
			command.provider === "openai"
				? "OpenAI Codex provider is unavailable. Install and log in through pi-codex-official first."
				: "Qwen Token Plan CN provider is unavailable.",
		);
	}
	const resolution = await ctx.modelRegistry.getProviderAuth(authProviderId);
	signal.throwIfAborted();
	const apiKey = resolution?.auth.apiKey;
	if (!apiKey) throw new Error(`Provider ${authProviderId} has no configured credential`);
	const providerBaseUrl = resolution.auth.baseUrl ?? authProvider.baseUrl;
	if (!providerBaseUrl) throw new Error(`Provider ${authProviderId} has no base URL`);

	const models = createRuntimeImagesModels(providerBaseUrl, command.provider === "openai");
	const imageProviderId = command.provider === "openai" ? OPENAI_IMAGES_PROVIDER : ALI_IMAGES_PROVIDER;
	const model = models.getModel(imageProviderId, command.model);
	if (!model) throw new Error(`Image model is not registered: ${command.model}`);
	const context: ImagesContext = {
		input: [
			{ type: "text", text: command.prompt },
			...inputImages.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
		],
	};
	const result = await models.generateImages(model, context, {
		apiKey,
		headers: resolution.auth.headers,
		signal,
		metadata: { size: command.size, quality: command.quality },
	});
	if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? `Image generation ${result.stopReason}`);
	const generatedImages = result.output.filter((block): block is ImageContent => block.type === "image");
	const texts = result.output.filter((block): block is TextContent => block.type === "text").map((block) => block.text);
	const saved = await saveGeneratedImages(ctx.cwd, command.provider, command.model, generatedImages, signal);
	const createdAt = Date.now();
	return {
		entries: saved.map((image) => ({
			provider: command.provider,
			model: command.model,
			prompt: command.prompt,
			path: image.path,
			mimeType: image.mimeType,
			bytes: image.bytes,
			createdAt,
		})),
		texts,
	};
}

function createRuntimeImagesModels(baseUrl: string, includeOpenAI: boolean) {
	const models = createImagesModels();
	if (includeOpenAI) {
		const model = openAIImageModel(baseUrl);
		models.setProvider(
			createImagesProvider({
				id: OPENAI_IMAGES_PROVIDER,
				name: "OpenAI Codex Images",
				auth: keylessImageAuth(),
				models: [model],
				api: imageApi(generateOpenAICodexImages),
			}),
		);
	} else {
		const wan = aliImageModel("wan2.7-image", baseUrl);
		const wanPro = aliImageModel("wan2.7-image-pro", baseUrl);
		models.setProvider(
			createImagesProvider({
				id: ALI_IMAGES_PROVIDER,
				name: "Qwen Token Plan CN Images",
				auth: keylessImageAuth(),
				models: [wan, wanPro],
				api: imageApi(generateAliWanImages),
			}),
		);
	}
	return models;
}

function imageApi(transport: ImageTransport): ProviderImages {
	return {
		generateImages: async (model, context, options) => generateWithTransport(transport, model, context, options),
	};
}

async function generateWithTransport(
	transport: ImageTransport,
	model: ImagesModel<ImagesApi>,
	context: ImagesContext,
	options?: ImagesOptions,
): Promise<AssistantImages> {
	const output: AssistantImages = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};
	try {
		if (!options?.apiKey) throw new Error(`No credential for image provider: ${model.provider}`);
		const prompt = context.input
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		const images = context.input.filter((block): block is ImageContent => block.type === "image");
		const metadata = options.metadata ?? {};
		const size = typeof metadata.size === "string" ? metadata.size : model.id === "gpt-image-2" ? "auto" : "2K";
		const quality =
			typeof metadata.quality === "string" && ["auto", "low", "medium", "high"].includes(metadata.quality)
				? (metadata.quality as "auto" | "low" | "medium" | "high")
				: undefined;
		const result = await transport({
			apiKey: options.apiKey,
			baseUrl: model.baseUrl,
			prompt,
			images,
			model: model.id,
			size,
			quality,
			headers: options.headers,
			signal: options.signal,
			fetch: options.fetch,
		});
		output.output.push(...result.texts.map((text) => ({ type: "text" as const, text })), ...result.images.map((image) => ({ type: "image" as const, ...image })));
		if (result.responseId !== undefined) output.responseId = result.responseId;
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = sanitizeError(error instanceof Error ? error.message : String(error));
	}
	return output;
}

function keylessImageAuth(): ProviderAuth {
	return {
		apiKey: {
			name: "Credential supplied by the owning pi provider",
			resolve: async () => ({ auth: {} }),
		},
	};
}

function openAIImageModel(baseUrl: string): ImagesModel<ImagesApi> {
	return {
		id: "gpt-image-2",
		name: "GPT Image 2 (Codex OAuth)",
		api: OPENAI_IMAGES_API,
		provider: OPENAI_IMAGES_PROVIDER,
		baseUrl,
		input: ["text", "image"],
		output: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function aliImageModel(id: "wan2.7-image" | "wan2.7-image-pro", baseUrl: string): ImagesModel<ImagesApi> {
	return {
		id,
		name: id === "wan2.7-image" ? "Wan 2.7 Image" : "Wan 2.7 Image Pro",
		api: ALI_IMAGES_API,
		provider: ALI_IMAGES_PROVIDER,
		baseUrl,
		input: ["text", "image"],
		output: ["image", "text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}
