import {
	createImagesModels, createImagesProvider,
	type AssistantImages, type ImageContent, type ImagesApi, type ImagesContext,
	type ImagesModel, type ImagesOptions, type TextContent,
} from "@earendil-works/pi-ai";
import { generateAliWanImages } from "./ali-wan-images.ts";
import { generateOpenAICodexImages } from "./openai-codex-images.ts";
import { saveGeneratedImages, validateInputImages } from "./image-files.ts";
import { sanitizeError } from "./http.ts";
import { createDiagnosticWriter, type DiagnosticWriter } from "./diagnostics.ts";
import { assertModelEnabled, type ImageConfig, type ImageProviderConfig } from "./model-config.ts";
import type { GenerationOutcome, ImageTransportOptions, ImageTransportResult, ResolvedImageCommand } from "./types.ts";

export interface RequestAuth { apiKey: string; baseUrl: string; headers?: Record<string, string | null> }
type Transport = (options: ImageTransportOptions) => Promise<ImageTransportResult>;
const TRANSPORTS: Record<ImageProviderConfig["adapter"], Transport> = {
	"openai-codex-images": generateOpenAICodexImages,
	"ali-wan-images": generateAliWanImages,
};

export function createRuntimeImagesModels(config: ImageConfig, provider: ImageProviderConfig, baseUrl: string, onDiagnostic?: DiagnosticWriter) {
	const models = createImagesModels();
	models.setProvider(createImagesProvider({
		id: provider.id,
		name: provider.name,
		auth: { apiKey: { name: "Credentials resolved by image account settings", resolve: async () => ({ auth: {} }) } },
		models: config.models.filter((model) => model.provider === provider.id && model.enabled !== false).map((model): ImagesModel<ImagesApi> => ({
			id: model.id, name: model.name, provider: provider.id, api: provider.adapter, baseUrl,
			input: model.tasks.includes("edit") ? ["text", "image"] : ["text"],
			output: ["image", "text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
		api: { generateImages: (model, context, options) => generateWithTransport(TRANSPORTS[provider.adapter], model, context, options, onDiagnostic) },
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
	validateInputImages(inputImages, command.modelConfig.inputImages);
	const auth = await resolveAuth();
	signal.throwIfAborted();
	try {
		const models = createRuntimeImagesModels(config, command.providerConfig, auth.baseUrl, createDiagnosticWriter(cwd));
		const model = models.getModel(command.provider, command.model);
		if (!model) throw new Error("Image model is not registered");
		const result = await models.generateImages(model, {
			input: [{ type: "text", text: command.prompt }, ...inputImages],
		}, {
			apiKey: auth.apiKey, headers: auth.headers, signal, fetch,
			metadata: { size: command.size, quality: command.quality },
		});
		if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? `Image generation ${result.stopReason}`);
		const images = result.output.filter((block): block is ImageContent => block.type === "image");
		const texts = result.output.filter((block): block is TextContent => block.type === "text").map((block) => block.text);
		const saved = await saveGeneratedImages(cwd, command.provider, command.model, images, signal);
		const createdAt = Date.now();
		return {
			entries: saved.map((image) => ({ ...image, provider: command.provider, model: command.model, prompt: command.prompt, createdAt })),
			texts,
		};
	} catch (error) {
		throw new Error(sanitizeError(error instanceof Error ? error.message : "Image generation failed", [auth.apiKey]));
	}
}

async function generateWithTransport(
	transport: Transport, model: ImagesModel<ImagesApi>, context: ImagesContext, options?: ImagesOptions, onDiagnostic?: DiagnosticWriter,
): Promise<AssistantImages> {
	const output: AssistantImages = { api: model.api, provider: model.provider, model: model.id, output: [], stopReason: "stop", timestamp: Date.now() };
	try {
		if (!options?.apiKey) throw new Error("No credential for image provider");
		const size = options.metadata?.size;
		if (typeof size !== "string") throw new Error("Image size must be resolved from model configuration");
		const quality = options.metadata?.quality;
		const result = await transport({
			apiKey: options.apiKey, baseUrl: model.baseUrl, model: model.id,
			prompt: context.input.filter((block): block is TextContent => block.type === "text").map((block) => block.text).join("\n").trim(),
			images: context.input.filter((block): block is ImageContent => block.type === "image"),
			size, quality: typeof quality === "string" ? quality : undefined,
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
