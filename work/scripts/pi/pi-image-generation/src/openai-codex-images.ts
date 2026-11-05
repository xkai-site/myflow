import { decodeGeneratedArtifact, imageAlphaChannel, inputImageDataUrl } from "./image-files.ts";
import { assertNoUnimplementedNativeOptions, normalizeImageOutput, normalizeModelSize, normalizeNativeOutput, sizeForOutput, type NativeOutputOptions } from "./model-config.ts";
import { validateAnimatedGif } from "./gif.ts";
import { assertPreparedMarkup, prepareMarkupEdit } from "./markup.ts";
import { requireImageEndpoint } from "./credentials.ts";
import { mergeHeaders, requestImageJson } from "./http.ts";
import type { GeneratedImage, ImageTransportOptions, ImageTransportResult } from "./types.ts";

const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;

interface OpenAICodexImageData {
	b64_json?: unknown;
	revised_prompt?: unknown;
	mime_type?: unknown;
}

export interface OpenAICodexRequest {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
}

export function extractChatGptAccountId(accessToken: string): string {
	const parts = accessToken.split(".");
	if (parts.length !== 3) throw new Error("OpenAI Codex OAuth access token is not a JWT");
	let payload: unknown;
	try {
		payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
	} catch {
		throw new Error("OpenAI Codex OAuth access token has an invalid JWT payload");
	}
	if (!payload || typeof payload !== "object") throw new Error("OpenAI Codex OAuth token payload is invalid");
	const auth = (payload as Record<string, unknown>)[JWT_CLAIM_PATH];
	if (!auth || typeof auth !== "object") throw new Error("OpenAI Codex OAuth token lacks account metadata");
	const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
	if (typeof accountId !== "string" || !accountId.trim()) {
		throw new Error("OpenAI Codex OAuth token lacks chatgpt_account_id");
	}
	return accountId;
}

export function buildOpenAICodexRequest(options: ImageTransportOptions): OpenAICodexRequest {
	if (options.modelConfig && options.modelConfig.id !== options.model) throw new Error("Image model configuration does not match the requested model");
	assertNoUnimplementedNativeOptions(options, true);
	if (["markupPath", "referencePaths"].some(key => (options as unknown as Record<string, unknown>)[key] !== undefined)) throw new Error("Local image paths must be loaded/validated by runtime before transport");
	const isEdit = options.images.length > 0;
	const task = isEdit ? "edit" : "generate";
	if (!options.modelConfig && (options.frameCount !== undefined || options.frameDurationMs !== undefined)) throw new Error("GIF frame controls require model configuration");
	const imageOutput: NativeOutputOptions = options.modelConfig ? normalizeNativeOutput(options.modelConfig, options, task) : normalizeImageOutput({}, options, task);
	if (options.markup !== undefined) {
		if (!options.modelConfig) throw new Error("Markup is not enabled without model configuration");
		assertPreparedMarkup(options.images, options.markup);
	}
	const size = options.modelConfig && (imageOutput.outputFormat === "gif" || imageOutput.outputFormat === "svg" || options.markup !== undefined)
		? normalizeModelSize(sizeForOutput(options.modelConfig, task, imageOutput.outputFormat), options.size) : options.size;
	const accountId = extractChatGptAccountId(options.apiKey);
	const baseUrl = requireImageEndpoint(options.baseUrl, "openai-codex-images");
	const body: Record<string, unknown> = {
		prompt: options.prompt,
		background: imageOutput.background ?? "auto",
		model: options.model,
		n: 1,
		quality: options.quality ?? "auto",
		size,
	};
	// PNG is the protocol default: preserve the original omission of output_format.
	if (imageOutput.outputFormat !== undefined && imageOutput.outputFormat !== "png") body.output_format = imageOutput.outputFormat;
	if (options.complexity !== undefined) body.complexity = options.complexity;
	if (imageOutput.outputFormat === "gif") {
		body.frame_count = imageOutput.frameCount;
		body.frame_duration_ms = imageOutput.frameDurationMs;
	}
	if (isEdit) {
		body.images = options.images.map((image) => ({
			image_url: inputImageDataUrl(image),
		}));
	}
	if (options.markup !== undefined) body.markup = { image_url: inputImageDataUrl(options.markup) };
	return {
		url: `${baseUrl}/images/${isEdit ? "edits" : "generations"}`,
		headers: mergeHeaders(options.headers, {
			Authorization: `Bearer ${options.apiKey}`,
			"chatgpt-account-id": accountId,
			originator: "pi",
			"User-Agent": "pi-image-generation/0.1.0",
			Accept: "application/json",
			"Content-Type": "application/json",
		}),
		body,
	};
}

export async function generateOpenAICodexImages(options: ImageTransportOptions): Promise<ImageTransportResult> {
	options.signal?.throwIfAborted();
	if (options.markup !== undefined) {
		if (!options.modelConfig) throw new Error("Markup is not enabled without model configuration");
		normalizeNativeOutput(options.modelConfig, options, options.images.length ? "edit" : "generate");
		options = { ...options, ...await prepareMarkupEdit(options.modelConfig, options.images, options.markup, options.signal) };
	}
	options.signal?.throwIfAborted();
	const request = buildOpenAICodexRequest(options);
	const payload = await requestImageJson(request.url, {
		method: "POST",
		redirect: "error",
		headers: request.headers,
		body: JSON.stringify(request.body),
		signal: options.signal,
	}, MAX_RESPONSE_BYTES, {
		fetch: options.fetch, operation: options.images.length ? "edit" : "generate",
		secrets: [options.apiKey, options.prompt, ...options.images.map((image) => image.data), ...(options.markup ? [options.markup.data] : [])],
		onDiagnostic: options.onDiagnostic, model: options.model,
		settings: { size: String(request.body.size), quality: String(request.body.quality), referenceCount: options.images.length },
	});
	if (!payload || typeof payload !== "object") throw new Error("OpenAI Codex returned an invalid image response");
	const object = payload as Record<string, unknown>;
	if (!Array.isArray(object.data) || object.data.length === 0) {
		throw new Error("OpenAI Codex returned no image data");
	}

	const images: GeneratedImage[] = [];
	const texts: string[] = [];
	const requestedFormat = String(request.body.output_format ?? "png");
	const mimeByFormat: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", ...(requestedFormat === "gif" ? { gif: "image/gif" } : {}), ...(requestedFormat === "svg" ? { svg: "image/svg+xml" } : {}) };
	if ((requestedFormat === "gif" || requestedFormat === "svg") && object.data.length !== 1) throw new Error("OpenAI Codex returned an unexpected native result count; no automatic retry");
	for (const item of object.data as OpenAICodexImageData[]) {
		if (!item || typeof item !== "object" || typeof item.b64_json !== "string" || !item.b64_json) continue;
		// No invented MIME declaration: decode/size/signature checks are owned by image-files.
		const decoded = decodeGeneratedArtifact({ data: item.b64_json, mimeType: requestedFormat === "svg" ? "image/svg+xml" : "" });
		if (!Object.values(mimeByFormat).includes(decoded.mimeType)) throw new Error("OpenAI Codex returned an unsupported output image format");
		if (object.output_format !== undefined &&
			(typeof object.output_format !== "string" || !Object.hasOwn(mimeByFormat, object.output_format) || mimeByFormat[object.output_format] !== decoded.mimeType)) {
			throw new Error("OpenAI Codex output_format declaration does not match the actual image format; image not saved. No automatic retry.");
		}
		if (item.mime_type !== undefined && item.mime_type !== decoded.mimeType) {
			throw new Error("OpenAI Codex image MIME declaration does not match its file signature; image not saved. No automatic retry.");
		}
		if (decoded.mimeType !== mimeByFormat[requestedFormat]) {
			throw new Error(`OpenAI Codex returned ${decoded.extension === "jpg" ? "jpeg" : decoded.extension} instead of requested ${requestedFormat}; image not saved. No automatic retry.`);
		}
		if (requestedFormat === "gif") {
			const gif = validateAnimatedGif(decoded.bytes);
			if (gif.frames !== request.body.frame_count || gif.delaysMs.some((delay) => Math.abs(delay - Number(request.body.frame_duration_ms)) > 5)) {
				throw new Error("OpenAI Codex GIF frame count or delay does not match the request; file not saved. No automatic retry.");
			}
			if (request.body.size !== "auto" && request.body.size !== `${gif.width}x${gif.height}`) throw new Error("OpenAI Codex GIF dimensions do not match the request; file not saved");
		}
		if (request.body.background === "transparent" && imageAlphaChannel(decoded) === false) {
			throw new Error("OpenAI Codex returned an image without an alpha channel for --background transparent; image not saved. No automatic retry.");
		}
		images.push({ data: item.b64_json, mimeType: decoded.mimeType });
		if (typeof item.revised_prompt === "string" && item.revised_prompt.trim()) texts.push(item.revised_prompt.trim());
	}
	if (images.length === 0) throw new Error("OpenAI Codex returned no valid image data");
	return {
		images,
		texts,
		responseId: typeof object.id === "string" ? object.id : undefined,
	};
}
