/** Best-effort bounded HTTP publisher: one worker, stable bytes, finite retries, no replay. */
import { sanitizeError } from "./log.ts";
import { HttpDeliveryError, sendHttpBody, validateHttpOptions } from "./providers/http.ts";
import type { ApiSnapshot, Logger, MessageApiConfig, MessageEnvelope, MessagePublisher } from "./types.ts";

export type MessageSender = (body: string, headers: Record<string, string>, signal: AbortSignal) => Promise<void>;

/** An injected sender cannot hold up shutdown even if it ignores cancellation. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener("abort", aborted); reject(signal.reason ?? new Error("API 请求已取消")); };
    if (signal.aborted) { work.catch(() => {}); aborted(); return; }
    signal.addEventListener("abort", aborted, { once: true });
    work.then((value) => { signal.removeEventListener("abort", aborted); resolve(value); },
      (error) => { signal.removeEventListener("abort", aborted); reject(error); });
  });
}
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await abortable(new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }), signal); }
  finally { clearTimeout(timer); }
}

export function createMessagePublisher(options: { config: MessageApiConfig; log: Logger; sender?: MessageSender }): MessagePublisher {
  const config = structuredClone(options.config);
  const { log } = options;
  const problem = config.enabled ? validateHttpOptions(config) : undefined;
  const stats: ApiSnapshot = { enabled: config.enabled && !problem, queued: 0, active: 0, delivered: 0, failed: 0, dropped: 0,
    ...(problem ? { lastError: sanitizeError(problem) } : {}) };
  if (problem) log.record({ event: "api_unavailable", error: stats.lastError });
  const sender: MessageSender = options.sender ?? (async (body, headers, signal) => { await sendHttpBody(config, body, headers, signal, { log, event: "api" }); });
  const queue: Array<{ body: string; headers: Record<string, string>; eventId: string }> = [];
  const idleWaiters = new Set<() => void>();
  let pumping = false;
  let closed = false;
  let activeController: AbortController | undefined;
  const queueLimit = config.queueLimit ?? 100;
  const timeoutMs = config.timeoutMs ?? 5000;
  const maxRetries = config.maxRetries ?? 1;
  const idle = () => { if (!queue.length && !stats.active) for (const done of [...idleWaiters]) done(); };

  async function deliver(item: typeof queue[number]): Promise<void> {
    const total = new AbortController(); activeController = total;
    const deadline = performance.now() + timeoutMs;
    const totalTimer = setTimeout(() => total.abort(new HttpDeliveryError("API 总投递预算耗尽", false)), timeoutMs);
    try {
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        total.signal.throwIfAborted();
        const controller = new AbortController();
        const relay = () => controller.abort(total.signal.reason);
        total.signal.addEventListener("abort", relay, { once: true });
        const remaining = Math.max(1, deadline - performance.now());
        const timer = setTimeout(() => controller.abort(new HttpDeliveryError("API 单次请求超时", true)),
          Math.max(1, Math.floor(remaining / (maxRetries - attempt + 1))));
        let retry = false;
        try {
          await abortable(Promise.resolve().then(() => { controller.signal.throwIfAborted(); return sender(item.body, item.headers, controller.signal); }), controller.signal);
          return;
        } catch (error) {
          if (closed || total.signal.aborted || attempt === maxRetries || (error instanceof HttpDeliveryError && !error.retryable)) throw error;
          retry = true;
          log.record({ event: "api_retry", eventId: item.eventId, attempt: attempt + 1, error: sanitizeError(error instanceof Error ? error.message : error) });
        } finally { clearTimeout(timer); total.signal.removeEventListener("abort", relay); }
        if (retry) await pause(250, total.signal);
      }
    } finally { clearTimeout(totalTimer); if (activeController === total) activeController = undefined; }
  }
  async function drain(): Promise<void> {
    try {
      while (!closed && queue.length) {
        const item = queue.shift()!;
        stats.queued = queue.length; stats.active = 1;
        try {
          await deliver(item);
          if (!closed) { stats.delivered += 1; log.record({ event: "api_delivered", eventId: item.eventId }); }
        } catch (error) {
          if (!closed) {
            stats.failed += 1; stats.lastError = sanitizeError(error instanceof Error ? error.message : error);
            log.record({ event: "api_failed", eventId: item.eventId, error: stats.lastError });
          }
        } finally { stats.active = 0; }
      }
    } finally { pumping = false; idle(); }
  }

  return {
    publish(envelope) {
      if (closed || !stats.enabled) return;
      const item = { body: JSON.stringify(envelope), eventId: envelope.eventId,
        headers: { "X-Pi-Message-Event": envelope.type, "X-Pi-Message-Id": envelope.eventId } };
      if (queue.length >= queueLimit) {
        const dropped = queue.shift()!; stats.dropped += 1;
        log.record({ event: "api_dropped", eventId: dropped.eventId, reason: "queue_full" });
      }
      queue.push(item); stats.queued = queue.length;
      if (!pumping) { pumping = true; queueMicrotask(() => { void drain(); }); }
    },
    async flush(budgetMs) {
      if (!queue.length && !stats.active) return;
      if (budgetMs <= 0) return;
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); idleWaiters.delete(done); resolve(); };
        const timer = setTimeout(done, budgetMs);
        idleWaiters.add(done);
      });
    },
    dispose() {
      if (closed) return;
      closed = true; stats.enabled = false;
      stats.dropped += queue.length + stats.active;
      queue.length = 0; stats.queued = 0; stats.active = 0;
      activeController?.abort(new Error("API 已关闭"));
      idle();
    },
    snapshot: () => ({ ...stats }),
  };
}
