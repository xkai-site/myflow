import {
	cancelDashscopeTask,
	pollDashscopeTask,
	submitDashscopeTask,
	type AdapterRuntimeOptions,
} from "./dashscope-videos.ts";
import type { CompletedTask, ResolvedVideoRequest, SubmittedTask, VideoProviderConfig } from "./types.ts";

/**
 * Config validation only allows the known adapter ids, so reaching this means the type and the
 * implementation drifted apart. Throwing beats a promise that silently resolves to `undefined`.
 */
function unsupportedAdapter(adapter: never): never {
	throw new Error(`Unsupported video adapter: ${String(adapter)}`);
}

export async function submitVideoTask(
	request: ResolvedVideoRequest,
	options: AdapterRuntimeOptions = {},
): Promise<SubmittedTask> {
	switch (request.provider.adapter) {
		case "dashscope":
			return submitDashscopeTask(request, options);
		default:
			throw unsupportedAdapter(request.provider.adapter);
	}
}

export async function pollVideoTask(
	provider: VideoProviderConfig,
	taskId: string,
	options: AdapterRuntimeOptions = {},
): Promise<CompletedTask> {
	switch (provider.adapter) {
		case "dashscope":
			return pollDashscopeTask(provider, taskId, options);
		default:
			throw unsupportedAdapter(provider.adapter);
	}
}

export async function cancelVideoTask(
	provider: VideoProviderConfig,
	taskId: string,
	options: Pick<AdapterRuntimeOptions, "signal" | "fetch"> = {},
): Promise<"cancelled" | "not-cancelled" | "unknown"> {
	switch (provider.adapter) {
		case "dashscope":
			return cancelDashscopeTask(provider, taskId, options);
		default:
			throw unsupportedAdapter(provider.adapter);
	}
}
