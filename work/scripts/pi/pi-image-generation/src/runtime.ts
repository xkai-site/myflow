import {
	createModels, createProvider,
	type AssistantImages, type ImageContent, type ImageApi, type ImagesContext,
	type ImageModel, type ImagesOptions, type TextContent,
} from "@earendil-works/pi-ai";
import { generateAliWanImages } from "./ali-wan-images.ts";
import { generateOpenAICodexImages } from "./openai-codex-images.ts";
import { loadInputImages, saveGeneratedImages, validateInputImages } from "./image-files.ts";
import { loadMarkupImage, prepareMarkupEdit } from "./markup.ts";
import { sanitizeError } from "./http.ts";
import { createDiagnosticWriter, type DiagnosticWriter } from "./diagnostics.ts";
import { assertModelEnabled, assertNoUnimplementedNativeOptions, normalizeImageOutput, normalizeModelSize, normalizeNativeOutput, sizeForOutput, type ImageConfig, type ImageModelConfig, type ImageProviderConfig } from "./model-config.ts";
import type { GenerationOutcome, ImageTransportOptions, ImageTransportResult, InputImage, ResolvedImageCommand } from "./types.ts";

export interface RequestAuth { apiKey: string; baseUrl: string; headers?: Record<string, string | null> }
type Transport = (options: ImageTransportOptions) => Promise<ImageTransportResult>;
const TRANSPORTS: Record<ImageProviderConfig["adapter"], Transport> = {
	"openai-codex-images": generateOpenAICodexImages,
	"ali-wan-images": generateAliWanImages,
};

export function createRuntimeImagesModels(config: ImageConfig, provider: ImageProviderConfig, baseUrl: string, onDiagnostic?: DiagnosticWriter) {
	// Keep this image-only collection local; account settings still resolve auth per request.
	const models = createModels();
	models.setProvider(createProvider({
		id: provider.id,
		name: provider.name,
		auth: { apiKey: { name: "Credentials resolved by image account settings", resolve: async () => ({ auth: {} }) } },
		models: config.models.filter((model) => model.provider === provider.id && model.enabled !== false).map((model): ImageModel<ImageApi> => ({
			type: "image",
			id: model.id, name: model.name, provider: provider.id, api: provider.adapter, baseUrl,
			input: model.tasks.includes("edit") ? ["text", "image"] : ["text"],
			output: ["image", "text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
		images: {
			[provider.adapter]: {
				generateImages: (model, context, options) => generateWithTransport(TRANSPORTS[provider.adapter], model, context, options, config.models.find((item) => item.provider === model.provider && item.id === model.id)!, onDiagnostic),
			},
		},
	}));
	return models;
}

export async function generateAndSave(
	config: ImageConfig,
	command: ResolvedImageCommand,
	inputImages: readonly ImageContent[],
	cwd: string,
	resolveAuth: () => Promise<RequestAuth>,
	signal: AbortSignal,
	fetch?: typeof globalThis.fetch,
): Promise<GenerationOutcome> {
	assertModelEnabled(command.modelConfig);
	signal.throwIfAborted();
	if (inputImages.length && command.referencePaths?.length) throw new Error("Do not combine image attachments with --image paths");
	const task = inputImages.length || command.referencePaths?.length ? "edit" : "generate";
	const imageOutput = normalizeNativeOutput(command.modelConfig, command, task);
	const fileOnly = imageOutput.outputFormat === "gif" || imageOutput.outputFormat === "svg";
	const hasMarkup = command.markup !== undefined || command.markupPath !== undefined;
	if (fileOnly || hasMarkup) {
		if (command.providerConfig.adapter !== "openai-codex-images" || command.model !== command.modelConfig.id || command.provider !== command.modelConfig.provider) throw new Error("Native image model/provider configuration mismatch");
		normalizeModelSize(sizeForOutput(command.modelConfig, task, imageOutput.outputFormat), command.size);
	}
	if (command.referencePaths?.length) inputImages = (await loadInputImages(cwd, command.referencePaths, command.modelConfig.inputImages)).map(image => ({ type: "image", ...image }));
	validateInputImages(inputImages, command.modelConfig.inputImages);
	let markup = command.markup;
	let transportImages: readonly InputImage[] = inputImages;
	if (hasMarkup) {
		markup ??= await loadMarkupImage(cwd, command.markupPath!, signal);
		const prepared = await prepareMarkupEdit(command.modelConfig, inputImages, markup, signal);
		transportImages = prepared.images;
		markup = prepared.markup;
	}
	signal.throwIfAborted();
	const auth = await resolveAuthUnlessAborted(resolveAuth, signal);
	signal.throwIfAborted();
	try {
		let result: ImageTransportResult;
		if (fileOnly || hasMarkup) {
			// Files and independent overlay data must not pass through static SDK ImageContent.
			const { markupPath: _path, referencePaths: _references, ...transportCommand } = command;
			result = await TRANSPORTS[command.providerConfig.adapter]({ ...transportCommand, ...imageOutput, ...auth, images: transportImages, markup,
				signal, fetch, onDiagnostic: createDiagnosticWriter(cwd) });
		} else {
			const models = createRuntimeImagesModels(config, command.providerConfig, auth.baseUrl, createDiagnosticWriter(cwd));
			const model = models.getModelOfType("image", command.provider, command.model);
			if (!model) throw new Error("Image model is not registered");
			const response = await models.generateImages(model, {
				input: [{ type: "text", text: command.prompt }, ...inputImages],
			}, {
				apiKey: auth.apiKey, headers: auth.headers, signal, fetch,
				metadata: { size: command.size, quality: command.quality, complexity: command.complexity, ...imageOutput },
			});
			if (response.stopReason !== "stop") throw new Error(response.errorMessage ?? `Image generation ${response.stopReason}`);
			result = { images: response.output.filter((block): block is ImageContent => block.type === "image"),
				texts: response.output.filter((block): block is TextContent => block.type === "text").map((block) => block.text) };
		}
		signal.throwIfAborted();
		const saved = await saveGeneratedImages(cwd, command.provider, command.model, result.images, signal);
		const createdAt = Date.now();
		return {
			entries: saved.map((image) => ({ ...image, provider: command.provider, model: command.model, prompt: command.prompt, createdAt })),
			texts: result.texts,
		};
	} catch (error) {
		throw new Error(sanitizeError(error instanceof Error ? error.message : "Image generation failed", [auth.apiKey]));
	}
}

/** Only detach credential waiting: no image request has started, and late auth cannot resume this pipeline. */
async function resolveAuthUnlessAborted(resolveAuth: () => Promise<RequestAuth>, signal: AbortSignal): Promise<RequestAuth> {
	signal.throwIfAborted();
	let onAbort!: () => void;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([
			Promise.resolve().then(() => { signal.throwIfAborted(); return resolveAuth(); }),
			aborted,
		]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

async function generateWithTransport(
	transport: Transport, model: ImageModel<ImageApi>, context: ImagesContext, options: ImagesOptions | undefined, modelConfig: ImageModelConfig, onDiagnostic?: DiagnosticWriter,
): Promise<AssistantImages> {
	const output: AssistantImages = { api: model.api, provider: model.provider, model: model.id, output: [], stopReason: "stop", timestamp: Date.now() };
	try {
		if (!options?.apiKey) throw new Error("No credential for image provider");
		assertNoUnimplementedNativeOptions(options.metadata ?? {});
		if (options.metadata?.outputFormat === "gif" || options.metadata?.frameCount !== undefined || options.metadata?.frameDurationMs !== undefined) throw new Error("GIF is a file-only output; use generateAndSave, not Pi ImageContent");
		if (options.metadata?.outputFormat === "svg") throw new Error("SVG is a file-only output; use generateAndSave, not Pi ImageContent");
		const size = options.metadata?.size;
		if (typeof size !== "string") throw new Error("Image size must be resolved from model configuration");
		const quality = options.metadata?.quality;
		const complexity = options.metadata?.complexity;
		const imageOutput = normalizeImageOutput(modelConfig, {
			background: metadataString(options.metadata?.background, "--background"),
			outputFormat: metadataString(options.metadata?.outputFormat, "--format"),
		});
		const result = await transport({
			apiKey: options.apiKey, baseUrl: model.baseUrl, model: model.id,
			prompt: context.input.filter((block): block is TextContent => block.type === "text").map((block) => block.text).join("\n").trim(),
			images: context.input.filter((block): block is ImageContent => block.type === "image"),
			size, quality: typeof quality === "string" ? quality : undefined,
			complexity: typeof complexity === "string" ? complexity : undefined,
			modelConfig, ...imageOutput,
			headers: options.headers, signal: options.signal, fetch: options.fetch, onDiagnostic,
		});
		output.output.push(...result.texts.map((text) => ({ type: "text" as const, text })), ...result.images.map((image) => ({ type: "image" as const, ...image })));
		if (result.responseId !== undefined) output.responseId = result.responseId;
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = sanitizeError(error instanceof Error ? error.message : "Image generation failed", options?.apiKey ? [options.apiKey] : []);
	}
	return output;
}

function metadataString(value: unknown, flag: string): string | undefined {
	if (value !== undefined && typeof value !== "string") throw new Error(`${flag} must be a configured string value`);
	return value as string | undefined;
}
