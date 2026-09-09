import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";

export interface NetworkTrace {
	observation: "undici" | "fetch-only";
	events: { stage: string; elapsedMs: number }[];
	// Absence is unknown, not evidence that a connection was never established.
	socket?: { encrypted: boolean; reused?: boolean };
}

/** Passive, request-identity scoped observers. Never retain headers, URLs, socket addresses or bodies. */
export function createNetworkTrace(started: number) {
	const context = new AsyncLocalStorage<boolean>();
	const requests = new WeakSet<object>();
	const trace: NetworkTrace = { observation: "fetch-only", events: [] };
	let stopped = false;
	const mark = (stage: string) => {
		if (!stopped && trace.events.length < 32) trace.events.push({ stage, elapsedMs: Math.round(performance.now() - started) });
	};
	const subscriptions: { name: string; listener: (message: unknown) => void }[] = [];
	for (const [name, stage] of [
		["undici:request:create", "request-created"],
		["undici:client:sendHeaders", "socket-assigned-headers-sending"],
		["undici:request:bodySent", "request-body-sent"],
		["undici:request:headers", "wire-response-headers"],
		["undici:request:trailers", "wire-response-complete"],
		["undici:request:error", "wire-request-error"],
	]) {
		const listener = (message: unknown) => {
			// A diagnostics subscriber must never throw into Undici.
			try {
				const value = message as { request?: object; socket?: { encrypted?: boolean }; reusedSocket?: boolean };
				if (!value?.request || typeof value.request !== "object") return;
				if (stage === "request-created" && context.getStore()) requests.add(value.request);
				if (!requests.has(value.request)) return;
				trace.observation = "undici";
				if (value.socket) trace.socket = { encrypted: value.socket.encrypted === true };
				mark(stage);
			} catch { /* instrumentation is best effort */ }
		};
		channel(name).subscribe(listener);
		subscriptions.push({ name, listener });
	}
	mark("request-start");
	return {
		trace, mark,
		run<T>(fn: () => Promise<T>): Promise<T> { return context.run(true, fn); },
		stop() {
			stopped = true;
			for (const { name, listener } of subscriptions) channel(name).unsubscribe(listener);
			context.disable();
		},
	};
}
