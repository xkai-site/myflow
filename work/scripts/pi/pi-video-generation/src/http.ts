const DEFAULT_ERROR_LIMIT = 800;

export function mergeHeaders(base: Record<string, string | null> | undefined, required: Record<string, string>): Headers {
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
	if (!response.body) throw new Error(`Provider returned an empty response body (HTTP ${response.status})`);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		total += chunk.value.length;
		if (total > maxBytes) {
			await reader.cancel().catch(() => undefined);
			throw new Error("Provider response is too large");
		}
		chunks.push(chunk.value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
	} catch {
		throw new Error(`Provider returned invalid JSON (HTTP ${response.status})`);
	}
}

export function providerError(response: Response, payload: unknown, secrets: readonly string[] = []): Error {
	const message = findErrorMessage(payload) ?? `HTTP ${response.status}`;
	return new Error(`Provider request failed: ${sanitizeError(message, secrets)}`);
}

export function sanitizeError(value: string, secrets: readonly string[] = [], maxLength = DEFAULT_ERROR_LIMIT): string {
	let sanitized = value
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]")
		.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/giu, "data:image/[redacted]")
		.replace(/sk-[A-Za-z0-9_-]{8,}/giu, "sk-[redacted]")
		.replace(/[A-Za-z0-9+/]{256,}={0,2}/gu, "[large-payload-redacted]");
	for (const secret of secrets) {
		if (secret.length >= 4) sanitized = sanitized.split(secret).join("[redacted]");
	}
	sanitized = sanitized.trim();
	return sanitized.length <= maxLength ? sanitized : `${sanitized.slice(0, maxLength)}…`;
}

export function requireHttpsUrl(value: string, description: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${description} is not a valid URL`);
	}
	if (url.protocol !== "https:") throw new Error(`${description} must use HTTPS`);
	if (url.username || url.password) throw new Error(`${description} must not contain URL credentials`);
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
	if (isPrivateHostname(hostname)) throw new Error(`${description} must not target a local or private address`);
	return url;
}

function isPrivateHostname(hostname: string): boolean {
	if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1") return true;
	if (hostname.startsWith("fc") || hostname.startsWith("fd") || /^fe[89ab]/u.test(hostname) || hostname.startsWith("::ffff:")) {
		return true;
	}
	const parts = hostname.split(".");
	if (parts.length !== 4 || !parts.every((part) => /^\d+$/u.test(part))) return false;
	const octets = parts.map(Number);
	if (octets.some((octet) => octet < 0 || octet > 255)) return true;
	const [first, second] = octets;
	return (
		first === 0 ||
		first === 10 ||
		first === 127 ||
		(first === 169 && second === 254) ||
		(first === 172 && second >= 16 && second <= 31) ||
		(first === 192 && second === 168) ||
		first >= 224
	);
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
