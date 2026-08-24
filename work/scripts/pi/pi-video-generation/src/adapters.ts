import {
	cancelDashscopeTask,
	pollDashscopeTask,
	submitDashscopeTask,
	type AdapterRuntimeOptions,
} from "./dashscope-videos.ts";
import type { CompletedTask, ResolvedVideoRequest, SubmittedTask, VideoProviderConfig } from "./types.ts";

export async function submitVideoTask(
	request: ResolvedVideoRequest,
	options: AdapterRuntimeOptions = {},
): Promise<SubmittedTask> {
	switch (request.provider.adapter) {
		case "dashscope":
			return submitDashscopeTask(request, options);
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
	}
}
