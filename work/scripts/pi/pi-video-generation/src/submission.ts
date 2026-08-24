import { cancelVideoTask, submitVideoTask } from "./adapters.ts";
import { removeStoredTask, upsertStoredTask } from "./task-store.ts";
import type { ResolvedVideoRequest, StoredVideoTask, SubmittedTask } from "./types.ts";

interface SubmissionDependencies {
	submit: typeof submitVideoTask;
	persist: typeof upsertStoredTask;
	cancel: typeof cancelVideoTask;
	submitTimeoutMs: number;
}

interface CancellationDependencies {
	persist: typeof upsertStoredTask;
	remove: typeof removeStoredTask;
	cancel: typeof cancelVideoTask;
}

export class SubmissionPersistenceError extends Error {
	readonly taskId: string;
	readonly cancellation: "cancelled" | "not-cancelled" | "unknown" | "not-attempted";

	constructor(taskId: string, cancellation: SubmissionPersistenceError["cancellation"], cause: unknown) {
		const causeMessage = cause instanceof Error ? cause.message : String(cause);
		super(
			`Provider accepted video task ${taskId}, but its recovery record could not be saved (${causeMessage}). ` +
				(cancellation === "cancelled"
					? "The pending remote task was cancelled."
					: "The remote task may still run; keep this task ID and check the Provider console."),
		);
		this.name = "SubmissionPersistenceError";
		this.taskId = taskId;
		this.cancellation = cancellation;
	}
}

export async function submitAndPersistVideoTask(
	request: ResolvedVideoRequest,
	cwd: string,
	dependencies: Partial<SubmissionDependencies> = {},
): Promise<StoredVideoTask> {
	const submit = dependencies.submit ?? submitVideoTask;
	const persist = dependencies.persist ?? upsertStoredTask;
	const cancel = dependencies.cancel ?? cancelVideoTask;
	const submitTimeoutMs = dependencies.submitTimeoutMs ?? Math.min(60_000, request.provider.taskTimeoutMs);
	const submitted = await submit(request, { signal: AbortSignal.timeout(submitTimeoutMs) });
	const stored = toStoredTask(request, submitted);
	try {
		await persist(cwd, stored);
	} catch (error) {
		let cancellation: SubmissionPersistenceError["cancellation"] = "not-attempted";
		if (stored.status === "PENDING") {
			cancellation = await cancel(request.provider, stored.taskId, { signal: AbortSignal.timeout(10_000) }).catch(
				() => "unknown" as const,
			);
		}
		throw new SubmissionPersistenceError(stored.taskId, cancellation, error);
	}
	return stored;
}

export async function cancelPersistedVideoTask(
	request: ResolvedVideoRequest["provider"],
	stored: StoredVideoTask,
	cwd: string,
	dependencies: Partial<CancellationDependencies> = {},
): Promise<"cancelled" | "retained"> {
	const persist = dependencies.persist ?? upsertStoredTask;
	const remove = dependencies.remove ?? removeStoredTask;
	const cancel = dependencies.cancel ?? cancelVideoTask;
	if (stored.status === "PENDING") {
		const result = await cancel(request, stored.taskId, { signal: AbortSignal.timeout(10_000) }).catch(
			() => "unknown" as const,
		);
		if (result === "cancelled") {
			await remove(cwd, stored.taskId);
			return "cancelled";
		}
	}
	await persist(cwd, stored);
	return "retained";
}

function toStoredTask(request: ResolvedVideoRequest, submitted: SubmittedTask): StoredVideoTask {
	return {
		taskId: submitted.taskId,
		providerId: request.provider.id,
		modelId: request.model.id,
		task: request.model.task,
		createdAt: Date.now(),
		status: submitted.status === "PENDING" ? "PENDING" : submitted.status === "RUNNING" ? "RUNNING" : "UNKNOWN",
		parameters: request.parameters,
	};
}
