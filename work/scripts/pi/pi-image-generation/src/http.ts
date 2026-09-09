import { collectErrorCauses, diagnosticHint, formatRequestDiagnostic, newDiagnosticId, type DiagnosticWriter, type ImageRequestDiagnostic } from "./diagnostics.ts";
import { sanitizeDiagnosticText, sanitizeError } from "./errors.ts";
import { createNetworkTrace } from "./network-trace.ts";
export { sanitizeError } from "./errors.ts";

export interface ImageHttpOptions {
	fetch?: typeof globalThis.fetch;
	operation: ImageRequestDiagnostic["operation"];
	secrets?: readonly string[];
	onDiagnostic?: DiagnosticWriter;
	model?: string;
	settings?: { size: string; quality: string; referenceCount: number };
}

/** Covers both fetch() rejection and failures while consuming its response body. Never retries. */
async function imageHttpRequest<T>(
	url: string | URL, init: RequestInit, options: ImageHttpOptions,
	consume: (response: Response) => Promise<T>,
): Promise<T> {
	const started = performance.now();
	const id = newDiagnosticId();
	const timestamp = new Date().toISOString();
	let response: Response | undefined;
	const secrets = [...(options.secrets ?? [])];
	new Headers(init.headers).forEach((value, name) => {
		if (!["accept", "content-type", "user-agent", "originator"].includes(name)) secrets.push(value);
	});
	const settings = options.settings ? {
		size: /^(auto|\d{1,4}x\d{1,4})$/.test(options.settings.size) ? options.settings.size : "other",
		quality: ["auto", "low", "medium", "high", "xhigh", "max"].includes(options.settings.quality) ? options.settings.quality : "other",
		referenceCount: Number.isSafeInteger(options.settings.referenceCount) && options.settings.referenceCount >= 0 ? options.settings.referenceCount : 0,
	} : undefined;
	const network = createNetworkTrace(started);
	try {
		init.signal?.throwIfAborted();
		response = await network.run(() => (options.fetch ?? globalThis.fetch)(url, init));
		network.mark("fetch-response-headers");
		const result = await consume(response);
		network.mark("response-consumed");
		network.stop();
		if (options.onDiagnostic) {
			try {
				await options.onDiagnostic({
					version: 1, id, timestamp, settings, outcome: "success", operation: options.operation, phase: "response",
					host: sanitizeDiagnosticText(new URL(url).host, secrets, 120), method: init.method ?? "GET",
					elapsedMs: Math.round(performance.now() - started), status: response.status,
					...(options.model ? { model: sanitizeDiagnosticText(options.model, secrets, 120) } : {}),
					...responseIds(response, secrets), network: network.trace, causes: [], hint: "HTTP 响应读取完成；不代表后续图片解析/保存成功。",
				});
			} catch { /* Logging must never turn a completed generation into a retryable failure. */ }
		}
		return result;
	} catch (error) {
		network.mark(init.signal?.aborted ? "signal-aborted" : "request-failed");
		network.stop();
		const reason = init.signal?.reason;
		const timedOut = init.signal?.aborted && reason instanceof Error && reason.name === "TimeoutError";
		if (init.signal?.aborted && !timedOut) throw new DOMException("Image generation cancelled", "AbortError");
		const causes = collectErrorCauses(timedOut ? reason : error, secrets);
		const payloadRequestId = error && typeof error === "object" && "requestId" in error && typeof error.requestId === "string" ? error.requestId : undefined;
		const requestId = response?.headers.get("x-request-id") ?? response?.headers.get("request-id") ?? response?.headers.get("x-amzn-requestid") ?? response?.headers.get("cf-ray") ?? payloadRequestId;
		const diagnostic: ImageRequestDiagnostic = {
			version: 1, id, timestamp, settings, outcome: "error", network: network.trace,
			...responseIds(response, secrets),
			operation: options.operation, phase: response ? "response" : "connect",
			host: sanitizeDiagnosticText(new URL(url).host, secrets, 120),
			method: init.method ?? "GET", elapsedMs: Math.round(performance.now() - started),
			...(options.model ? { model: sanitizeDiagnosticText(options.model, secrets, 120) } : {}),
			...(response ? { status: response.status } : {}),
			...(requestId ? { requestId: sanitizeDiagnosticText(requestId, secrets, 120) } : {}),
			causes, hint: diagnosticHint(causes, response?.status),
		};
		let log = "";
		if (options.onDiagnostic) {
			try { log = `\n诊断日志（当前项目）：${await options.onDiagnostic(diagnostic)}`; }
			catch { log = "\n诊断日志写入失败；请检查当前项目 .pi 目录的权限和磁盘空间。"; }
		}
		// Only sanitized details cross the Pi runtime's message-only error boundary.
		throw new Error(`${formatRequestDiagnostic(diagnostic)}${log}`);
	} finally {
		network.stop();
	}
}

function responseIds(response: Response | undefined, secrets: readonly string[]) {
	const requestId = response?.headers.get("x-request-id") ?? response?.headers.get("request-id") ?? response?.headers.get("cf-ray");
	const imagegenRequestId = response?.headers.get("x-codex-imagegen-request-id");
	return {
		...(requestId ? { requestId: sanitizeDiagnosticText(requestId, secrets, 120) } : {}),
		...(imagegenRequestId ? { imagegenRequestId: sanitizeDiagnosticText(imagegenRequestId, secrets, 120) } : {}),
	};
}

export async function requestImageJson(url: string, init: RequestInit, maxBytes: number, options: ImageHttpOptions): Promise<unknown> {
	return imageHttpRequest(url, init, options, async (response) => {
		const payload = await readJsonResponse(response, maxBytes);
		if (!response.ok) {
			const secrets = [...(options.secrets ?? [])];
			new Headers(init.headers).forEach((value) => secrets.push(value));
			throw providerError(response, payload, secrets);
		}
		return payload;
	});
}

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

export function providerError(response: Response, payload: unknown, secrets: readonly string[] = []): Error {
	const message = findErrorMessage(payload) ?? `HTTP ${response.status}`;
	const error: Error & { requestId?: string } = new Error(`Provider request failed (HTTP ${response.status}): ${sanitizeError(message, secrets)}`);
	if (payload && typeof payload === "object" && "request_id" in payload && typeof payload.request_id === "string") {
		error.requestId = sanitizeDiagnosticText(payload.request_id, secrets, 120);
	}
	return error;
}

export async function downloadImage(
	url: string,
	options: { signal?: AbortSignal; fetch?: typeof globalThis.fetch; maxBytes: number; secrets?: readonly string[]; onDiagnostic?: DiagnosticWriter; model?: string },
): Promise<{ bytes: Uint8Array; contentType: string }> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("Provider returned an invalid image URL");
	}
	if (parsed.protocol !== "https:") throw new Error("Provider returned a non-HTTPS image URL");
	if (parsed.username || parsed.password) throw new Error("Provider returned an image URL with embedded credentials");
	return imageHttpRequest(parsed, { signal: options.signal, redirect: "error" }, { ...options, operation: "download" }, async (response) => {
		if (!response.ok) throw new Error(`Generated image download failed: HTTP ${response.status}`);
		const contentLength = Number(response.headers.get("content-length"));
		if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
			throw new Error("Generated image download exceeds the size limit");
		}
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.length === 0) throw new Error("Generated image download is empty");
		if (bytes.length > options.maxBytes) throw new Error("Generated image download exceeds the size limit");
		return { bytes, contentType: response.headers.get("content-type")?.split(";", 1)[0].trim() ?? "" };
	});
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
