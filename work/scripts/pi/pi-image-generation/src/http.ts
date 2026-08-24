const DEFAULT_ERROR_LIMIT = 800;

export function mergeHeaders(
	base: Record<string, string | null> | undefined,
	required: Record<string, string>,
): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(base ?? {})) {
		if (value !== null) headers.set(name, value);
	}
	for (const [name, value] of Object.entries(required)) headers.set(name, value);
	return headers;
}

export async function readJsonResponse(response: Response, maxBytes: number): Promise<unknown> {
	const contentLength = response.headers.get("content-length");
	if (contentLength !== null) {
		const declared = Number(contentLength);
		if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Provider response is too large");
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length > maxBytes) throw new Error("Provider response is too large");
	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
	} catch {
		throw new Error(`Provider returned invalid JSON (HTTP ${response.status})`);
	}
}

export function providerError(response: Response, payload: unknown): Error {
	const message = findErrorMessage(payload) ?? `HTTP ${response.status}`;
	return new Error(`Provider request failed: ${sanitizeError(message)}`);
}

export function sanitizeError(value: string, maxLength = DEFAULT_ERROR_LIMIT): string {
	const sanitized = value
		.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
		.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "data:image/[redacted]")
		.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
		.replace(/[A-Za-z0-9+/]{256,}={0,2}/g, "[large-payload-redacted]")
		.trim();
	return sanitized.length <= maxLength ? sanitized : `${sanitized.slice(0, maxLength)}…`;
}

export async function downloadImage(
	url: string,
	options: { signal?: AbortSignal; fetch?: typeof globalThis.fetch; maxBytes: number },
): Promise<{ bytes: Uint8Array; contentType: string }> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("Provider returned an invalid image URL");
	}
	if (parsed.protocol !== "https:") throw new Error("Provider returned a non-HTTPS image URL");
	const response = await (options.fetch ?? globalThis.fetch)(parsed, { signal: options.signal });
	if (!response.ok) throw new Error(`Generated image download failed: HTTP ${response.status}`);
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
		throw new Error("Generated image download exceeds the size limit");
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length === 0) throw new Error("Generated image download is empty");
	if (bytes.length > options.maxBytes) throw new Error("Generated image download exceeds the size limit");
	return { bytes, contentType: response.headers.get("content-type")?.split(";", 1)[0].trim() ?? "" };
}

function findErrorMessage(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const object = payload as Record<string, unknown>;
	if (typeof object.message === "string") return object.message;
	if (typeof object.error === "string") return object.error;
	if (object.error && typeof object.error === "object") {
		const nested = object.error as Record<string, unknown>;
		if (typeof nested.message === "string") return nested.message;
		if (typeof nested.code === "string") return nested.code;
	}
	if (typeof object.code === "string") return object.code;
	return undefined;
}
