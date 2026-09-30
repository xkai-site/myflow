import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { cancelVideoTask, pollVideoTask, submitVideoTask } from "../src/adapters.ts";
import { VideoTaskTimeoutError } from "../src/dashscope-videos.ts";
import type { ResolvedVideoRequest, VideoProviderConfig } from "../src/types.ts";

function provider(overrides: Partial<VideoProviderConfig> = {}): VideoProviderConfig {
	return {
		id: "dashscope",
		name: "DashScope",
		adapter: "dashscope",
		baseUrl: "https://dashscope.aliyuncs.com",
		apiKey: "sk-test-secret-value",
		pollIntervalMs: 1,
		taskTimeoutMs: 5_000,
		maxOutputBytes: 1024 * 1024,
		...overrides,
	};
}

const request: ResolvedVideoRequest = {
	provider: provider(),
	model: {
		id: "wan2.6-t2v",
		name: "Wan",
		provider: "dashscope",
		task: "t2v",
		prompt: { maxChars: 800 },
		inputImages: { minimum: 0, maximum: 0, maxBytes: 10 * 1024 * 1024, mimeTypes: ["image/png"] },
		parameters: [],
	},
	prompt: "a cat",
	images: [],
	parameters: {},
};

const json = (payload: unknown, status = 200): Response =>
	new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

test("an unknown adapter fails loudly instead of resolving undefined", async () => {
	// The union has one member today, so the cast stands in for a future adapter that was added to
	// the config schema but never wired into the dispatcher.
	const unknown = provider({ adapter: "not-an-adapter" as VideoProviderConfig["adapter"] });
	await assert.rejects(
		() => submitVideoTask({ ...request, provider: unknown }),
		/Unsupported video adapter: not-an-adapter/,
		"submit must reject rather than resolve undefined",
	);
	await assert.rejects(() => pollVideoTask(unknown, "task-1"), /Unsupported video adapter/);
	await assert.rejects(() => cancelVideoTask(unknown, "task-1"), /Unsupported video adapter/);
});

test("dashscope dispatch: submit parses the task, poll returns the video, cancel maps the status", async () => {
	const submitted = await submitVideoTask(request, {
		fetch: async () => json({ output: { task_id: "task-1", task_status: "PENDING" }, request_id: "req-1" }),
	});
	assert.deepEqual(submitted, { taskId: "task-1", status: "PENDING", requestId: "req-1" });

	const completed = await pollVideoTask(provider(), "task-1", {
		fetch: async () => json({ output: { task_id: "task-1", task_status: "SUCCEEDED", video_url: "https://cdn.example/v.mp4" } }),
	});
	assert.equal(completed.taskId, "task-1");
	assert.equal(completed.videoUrl, "https://cdn.example/v.mp4");

	assert.equal(await cancelVideoTask(provider(), "task-1", { fetch: async () => json({}, 200) }), "cancelled");
	assert.equal(
		await cancelVideoTask(provider(), "task-1", { fetch: async () => json({ code: "already finished" }, 400) }),
		"not-cancelled",
		"HTTP 400 means the task was already in a terminal state",
	);
});

test("submit surfaces a provider error without echoing the API key", async () => {
	const leaked = "sk-test-secret-value";
	await assert.rejects(
		() => submitVideoTask(request, { fetch: async () => json({ message: `invalid key ${leaked}` }, 401) }),
		(error: Error) => {
			assert.match(error.message, /HTTP 401|Provider request failed/);
			assert.ok(!error.message.includes(leaked), `错误消息泄漏了 API Key: ${error.message}`);
			return true;
		},
	);
});

test("submit rejects a success response without a task id", async () => {
	await assert.rejects(
		() => submitVideoTask(request, { fetch: async () => json({ output: { task_status: "PENDING" } }) }),
		/missing task_id/,
	);
});

const completedPayload = {
	output: { task_id: "task-1", task_status: "SUCCEEDED", video_url: "https://cdn.example/v.mp4" },
};

function isTaskTimeout(error: unknown): boolean {
	return error instanceof VideoTaskTimeoutError && error.taskId === "task-1";
}

test("poll timeout aborts an in-flight request even without a caller signal", async () => {
	let signal: AbortSignal | undefined;
	let calls = 0;
	await assert.rejects(() => pollVideoTask(provider({ taskTimeoutMs: 30 }), "task-1", {
		fetch: async (_url, init) => {
			calls++;
			signal = init?.signal ?? undefined;
			await delay(200, undefined, { signal });
			return json(completedPayload);
		},
	}), isTaskTimeout);
	assert.equal(calls, 1);
	assert.equal(signal?.aborted, true);
});

test("poll timeout also aborts a stalled response body", async () => {
	let signal: AbortSignal | undefined;
	let statuses = 0;
	await assert.rejects(() => pollVideoTask(provider({ taskTimeoutMs: 30 }), "task-1", {
		fetch: async (_url, init) => {
			signal = init?.signal ?? undefined;
			return new Response(new ReadableStream({
				start(controller) {
					void delay(200, undefined, { signal }).then(() => {
						controller.enqueue(new TextEncoder().encode(JSON.stringify(completedPayload)));
						controller.close();
					}, (error) => controller.error(error));
				},
			}));
		},
		onStatus: () => { statuses++; },
	}), isTaskTimeout);
	assert.equal(signal?.aborted, true);
	assert.equal(statuses, 0);
});

test("poll timeout interrupts the polling interval without aborting the caller", async () => {
	const caller = new AbortController();
	let signal: AbortSignal | undefined;
	let calls = 0;
	await assert.rejects(() => pollVideoTask(provider({ taskTimeoutMs: 30, pollIntervalMs: 200 }), "task-1", {
		signal: caller.signal,
		fetch: async (_url, init) => {
			calls++;
			signal = init?.signal ?? undefined;
			return json({ output: { task_id: "task-1", task_status: "RUNNING" } });
		},
	}), isTaskTimeout);
	assert.equal(calls, 1);
	assert.equal(signal?.aborted, true);
	assert.equal(caller.signal.aborted, false);
	assert.equal(getEventListeners(signal!, "abort").length, 0);
});

test("a response arriving after the deadline is not accepted as success", async () => {
	await assert.rejects(() => pollVideoTask(provider({ taskTimeoutMs: 30 }), "task-1", {
		// Deliberately non-cooperative mock: the post-response check must still reject it.
		fetch: async () => {
			await delay(80);
			return json(completedPayload);
		},
	}), isTaskTimeout);
});

test("caller cancellation remains distinguishable from the poll timeout", async () => {
	const caller = new AbortController();
	const reason = new Error("synthetic user cancellation");
	await assert.rejects(() => pollVideoTask(provider(), "task-1", {
		signal: caller.signal,
		fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
			const signal = init!.signal!;
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			queueMicrotask(() => caller.abort(reason));
		}),
	}), (error) => error === reason);
});

test("completed polling intervals leave no abort listeners", async () => {
	const caller = new AbortController();
	let signal: AbortSignal | undefined;
	let calls = 0;
	await pollVideoTask(provider(), "task-1", {
		signal: caller.signal,
		fetch: async (_url, init) => {
			signal = init?.signal ?? undefined;
			return json(++calls === 6 ? completedPayload : { output: { task_id: "task-1", task_status: "RUNNING" } });
		},
	});
	assert.equal(calls, 6);
	assert.equal(getEventListeners(signal!, "abort").length, 0);
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
});
