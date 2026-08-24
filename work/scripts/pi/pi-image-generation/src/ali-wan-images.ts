import { detectImage } from "./image-files.ts";
import { downloadImage, mergeHeaders, providerError, readJsonResponse } from "./http.ts";
import type { GeneratedImage, ImageTransportOptions, ImageTransportResult } from "./types.ts";

const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

export interface AliWanRequest {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
}

export function buildAliWanRequest(options: ImageTransportOptions): AliWanRequest {
	const content: Array<Record<string, string>> = options.images.map((image) => ({
		image: `data:${image.mimeType};base64,${image.data}`,
	}));
	content.push({ text: options.prompt });
	return {
		url: `${normalizeTokenPlanBaseUrl(options.baseUrl)}/services/aigc/multimodal-generation/generation`,
		headers: mergeHeaders(options.headers, {
			Authorization: `Bearer ${options.apiKey}`,
			Accept: "application/json",
			"Content-Type": "application/json",
			"User-Agent": "pi-image-generation/0.1.0",
		}),
		body: {
			model: options.model,
			input: {
				messages: [{ role: "user", content }],
			},
			parameters: {
				size: options.size,
				n: 1,
				watermark: false,
				enable_sequential: false,
			},
		},
	};
}

export async function generateAliWanImages(options: ImageTransportOptions): Promise<ImageTransportResult> {
	const request = buildAliWanRequest(options);
	const response = await (options.fetch ?? globalThis.fetch)(request.url, {
		method: "POST",
		headers: request.headers,
		body: JSON.stringify(request.body),
		signal: options.signal,
	});
	const payload = await readJsonResponse(response, MAX_JSON_RESPONSE_BYTES);
	if (!response.ok) throw providerError(response, payload);
	const { imageUrls, texts, responseId } = parseAliWanResponse(payload);
	if (imageUrls.length === 0) throw new Error("ALI Token Plan returned no image URLs");

	const images: GeneratedImage[] = [];
	for (const imageUrl of imageUrls) {
		options.signal?.throwIfAborted();
		const downloaded = await downloadImage(imageUrl, {
			signal: options.signal,
			fetch: options.fetch,
			maxBytes: MAX_IMAGE_BYTES,
		});
		const detected = detectImage(downloaded.bytes);
		if (!detected) throw new Error("ALI Token Plan returned an unsupported image format");
		if (downloaded.contentType && normalizeMimeType(downloaded.contentType) !== detected.mimeType) {
			throw new Error("ALI Token Plan image MIME type does not match its file signature");
		}
		images.push({ data: Buffer.from(downloaded.bytes).toString("base64"), mimeType: detected.mimeType });
	}
	return { images, texts, responseId };
}

export function parseAliWanResponse(payload: unknown): {
	imageUrls: string[];
	texts: string[];
	responseId?: string;
} {
	if (!payload || typeof payload !== "object") throw new Error("ALI Token Plan returned an invalid response");
	const root = payload as Record<string, unknown>;
	const output = root.output;
	if (!output || typeof output !== "object") throw new Error("ALI Token Plan response is missing output");
	const choices = (output as Record<string, unknown>).choices;
	if (!Array.isArray(choices)) throw new Error("ALI Token Plan response is missing choices");
	const imageUrls: string[] = [];
	const texts: string[] = [];

	for (const choice of choices) {
		if (!choice || typeof choice !== "object") continue;
		const message = (choice as Record<string, unknown>).message;
		if (!message || typeof message !== "object") continue;
		const content = (message as Record<string, unknown>).content;
		if (!Array.isArray(content)) continue;
		for (const item of content) {
			if (!item || typeof item !== "object") continue;
			const block = item as Record<string, unknown>;
			if (typeof block.image === "string" && block.image) imageUrls.push(block.image);
			if (typeof block.text === "string" && block.text.trim()) texts.push(block.text.trim());
		}
	}
	return {
		imageUrls,
		texts,
		responseId: typeof root.request_id === "string" ? root.request_id : undefined,
	};
}

function normalizeTokenPlanBaseUrl(baseUrl: string): string {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new Error("Qwen Token Plan provider has an invalid base URL");
	}
	if (url.protocol !== "https:") throw new Error("Qwen Token Plan image endpoint must use HTTPS");
	url.pathname = "/api/v1";
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}

function normalizeMimeType(mimeType: string): string {
	const normalized = mimeType.split(";", 1)[0].trim().toLowerCase();
	return normalized === "image/jpg" ? "image/jpeg" : normalized;
}
