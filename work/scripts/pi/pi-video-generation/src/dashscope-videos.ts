import { mergeHeaders, providerError, readJsonResponse, sanitizeError } from "./http.ts";
import type {
	CompletedTask,
	RemoteTaskStatus,
	ResolvedVideoRequest,
	StoredVideoTask,
	SubmittedTask,
	VideoProviderConfig,
} from "./types.ts";

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const TERMINAL_STATUSES = new Set<RemoteTaskStatus>(["SUCCEEDED", "FAILED", "CANCELED", "UNKNOWN"]);

export interface DashscopeRequest {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
}

export interface AdapterRuntimeOptions {
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
	onSubmitted?: (task: SubmittedTask) => Promise<void> | void;
	onStatus?: (status: RemoteTaskStatus) => Promise<void> | void;
}

export class VideoTaskTimeoutError extends Error {
	readonly taskId: string;

	constructor(taskId: string) {
		super(`Video task ${taskId} exceeded its configured timeout`);
		this.name = "VideoTaskTimeoutError";
		this.taskId = taskId;
	}
}

export function buildDashscopeSubmitRequest(request: ResolvedVideoRequest): DashscopeRequest {
	const input: Record<string, unknown> = { prompt: request.prompt };
	if (request.model.task !== "t2v") {
		const mediaType = request.model.task === "i2v" ? "first_frame" : "reference_image";
		input.media = request.images.map((image) => ({
			type: mediaType,
			url: `data:${image.mimeType};base64,${image.data}`,
		}));
	}
	return {
		url: `${dashscopeApiRoot(request.provider.baseUrl)}/services/aigc/video-generation/video-synthesis`,
		headers: mergeHeaders(undefined, {
			Authorization: `Bearer ${request.provider.apiKey}`,
			Accept: "application/json",
			"Content-Type": "application/json",
			"X-DashScope-Async": "enable",
			"User-Agent": "pi-video-generation/0.1.0",
		}),
		body: { model: request.model.id, input, parameters: request.parameters },
	};
}

export async function submitDashscopeTask(
	request: ResolvedVideoRequest,
	options: AdapterRuntimeOptions = {},
): Promise<SubmittedTask> {
	const built = buildDashscopeSubmitRequest(request);
	const response = await (options.fetch ?? globalThis.fetch)(built.url, {
		method: "POST",
		headers: built.headers,
		body: JSON.stringify(built.body),
		signal: options.signal,
	});
	const payload = await readJsonResponse(response, MAX_JSON_BYTES);
	if (!response.ok) throw providerError(response, payload, [request.provider.apiKey]);
	const parsed = parseTaskPayload(payload, request.provider.apiKey);
	if (!parsed.taskId) throw new Error("DashScope task response is missing task_id");
	const submitted: SubmittedTask = {
		taskId: parsed.taskId,
		status: parsed.status,
		requestId: parsed.requestId,
	};
	await options.onSubmitted?.(submitted);
	return submitted;
}

export async function pollDashscopeTask(
	provider: VideoProviderConfig,
	taskId: string,
	options: AdapterRuntimeOptions = {},
): Promise<CompletedTask> {
	const startedAt = Date.now();
	let first = true;
	while (true) {
		options.signal?.throwIfAborted();
		if (!first) await sleep(provider.pollIntervalMs, options.signal);
		first = false;
		if (Date.now() - startedAt > provider.taskTimeoutMs) throw new VideoTaskTimeoutError(taskId);
		const response = await (options.fetch ?? globalThis.fetch)(
			`${dashscopeApiRoot(provider.baseUrl)}/tasks/${encodeURIComponent(taskId)}`,
			{
				headers: mergeHeaders(undefined, {
					Authorization: `Bearer ${provider.apiKey}`,
					Accept: "application/json",
					"User-Agent": "pi-video-generation/0.1.0",
				}),
				signal: options.signal,
			},
		);
		const payload = await readJsonResponse(response, MAX_JSON_BYTES);
		if (!response.ok) throw providerError(response, payload, [provider.apiKey]);
		const parsed = parseTaskPayload(payload, provider.apiKey);
		if (parsed.taskId && parsed.taskId !== taskId) throw new Error("DashScope returned a mismatched task_id");
		await options.onStatus?.(parsed.status);
		if (!TERMINAL_STATUSES.has(parsed.status)) continue;
		if (parsed.status === "SUCCEEDED") {
			if (!parsed.videoUrl) throw new Error("DashScope succeeded without video_url");
			return { taskId, videoUrl: parsed.videoUrl, requestId: parsed.requestId };
		}
		if (parsed.status === "FAILED") {
			throw new Error(`DashScope task failed: ${sanitizeError(parsed.message ?? parsed.code ?? "unknown error", [provider.apiKey])}`);
		}
		if (parsed.status === "CANCELED") throw new Error(`DashScope task ${taskId} was canceled`);
		throw new Error(`DashScope task ${taskId} is unknown or expired`);
	}
}

export async function cancelDashscopeTask(
	provider: VideoProviderConfig,
	taskId: string,
	options: Pick<AdapterRuntimeOptions, "signal" | "fetch"> = {},
): Promise<"cancelled" | "not-cancelled" | "unknown"> {
	try {
		const response = await (options.fetch ?? globalThis.fetch)(
			`${dashscopeApiRoot(provider.baseUrl)}/tasks/${encodeURIComponent(taskId)}/cancel`,
			{
				method: "POST",
				headers: mergeHeaders(undefined, {
					Authorization: `Bearer ${provider.apiKey}`,
					Accept: "application/json",
					"User-Agent": "pi-video-generation/0.1.0",
				}),
				signal: options.signal,
			},
		);
		const payload = await readJsonResponse(response, MAX_JSON_BYTES);
		if (response.ok) return "cancelled";
		if (response.status === 400) return "not-cancelled";
		throw providerError(response, payload, [provider.apiKey]);
	} catch (error) {
		if (options.signal?.aborted) return "unknown";
		throw error;
	}
}

export function storedTaskStatus(status: RemoteTaskStatus): StoredVideoTask["status"] | undefined {
	if (status === "PENDING" || status === "RUNNING" || status === "UNKNOWN") return status;
	return undefined;
}

function parseTaskPayload(payload: unknown, apiKey: string): {
	taskId?: string;
	status: RemoteTaskStatus;
	requestId?: string;
	videoUrl?: string;
	code?: string;
	message?: string;
} {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("DashScope returned an invalid task response");
	}
	const root = payload as Record<string, unknown>;
	const output = root.output;
	if (!output || typeof output !== "object" || Array.isArray(output)) {
		const message = typeof root.message === "string" ? root.message : "response is missing output";
		throw new Error(`DashScope task response is invalid: ${sanitizeError(message, [apiKey])}`);
	}
	const object = output as Record<string, unknown>;
	const rawStatus = object.task_status;
	if (typeof rawStatus !== "string" || !isTaskStatus(rawStatus)) {
		throw new Error("DashScope task response has an invalid task_status");
	}
	return {
		taskId: parseRemoteTaskId(object.task_id),
		status: rawStatus,
		requestId: typeof root.request_id === "string" ? root.request_id : undefined,
		videoUrl: typeof object.video_url === "string" ? object.video_url : undefined,
		code: typeof object.code === "string" ? object.code : undefined,
		message: typeof object.message === "string" ? object.message : undefined,
	};
}

function parseRemoteTaskId(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0 || value.length > 256) {
		throw new Error("DashScope task response has an invalid task_id");
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
		throw new Error("DashScope task response has an invalid task_id");
	}
	return value;
}

function isTaskStatus(value: string): value is RemoteTaskStatus {
	return ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED", "UNKNOWN"].includes(value);
}

function dashscopeApiRoot(baseUrl: string): string {
	const url = new URL(baseUrl);
	url.pathname = "/api/v1";
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/u, "");
}

async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (!signal) {
		await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
		return;
	}
	await new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(resolve, milliseconds);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}
