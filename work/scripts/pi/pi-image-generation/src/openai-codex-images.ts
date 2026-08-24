import { decodeGeneratedImage } from "./image-files.ts";
import { mergeHeaders, providerError, readJsonResponse } from "./http.ts";
import type { GeneratedImage, ImageTransportOptions, ImageTransportResult } from "./types.ts";

const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;

interface OpenAICodexImageData {
	b64_json?: unknown;
	revised_prompt?: unknown;
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
	const accountId = extractChatGptAccountId(options.apiKey);
	const isEdit = options.images.length > 0;
	const baseUrl = normalizeCodexBaseUrl(options.baseUrl);
	const body: Record<string, unknown> = {
		prompt: options.prompt,
		background: "auto",
		model: options.model,
		n: 1,
		quality: options.quality ?? "auto",
		size: options.size,
	};
	if (isEdit) {
		body.images = options.images.map((image) => ({
			image_url: `data:${image.mimeType};base64,${image.data}`,
		}));
	}
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
	const request = buildOpenAICodexRequest(options);
	const response = await (options.fetch ?? globalThis.fetch)(request.url, {
		method: "POST",
		headers: request.headers,
		body: JSON.stringify(request.body),
		signal: options.signal,
	});
	const payload = await readJsonResponse(response, MAX_RESPONSE_BYTES);
	if (!response.ok) throw providerError(response, payload);
	if (!payload || typeof payload !== "object") throw new Error("OpenAI Codex returned an invalid image response");
	const object = payload as Record<string, unknown>;
	if (!Array.isArray(object.data) || object.data.length === 0) {
		throw new Error("OpenAI Codex returned no image data");
	}

	const images: GeneratedImage[] = [];
	const texts: string[] = [];
	for (const item of object.data as OpenAICodexImageData[]) {
		if (typeof item.b64_json !== "string" || !item.b64_json) continue;
		const decoded = decodeGeneratedImage({ data: item.b64_json, mimeType: "image/png" });
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

function normalizeCodexBaseUrl(baseUrl: string): string {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new Error("OpenAI Codex provider has an invalid base URL");
	}
	if (url.protocol !== "https:") throw new Error("OpenAI Codex image endpoint must use HTTPS");
	let pathname = url.pathname.replace(/\/+$/, "");
	if (!pathname.endsWith("/codex")) pathname += "/codex";
	url.pathname = pathname;
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}
