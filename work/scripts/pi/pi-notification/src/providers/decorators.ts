/**
 * Reliability decorators: timeout, retry, circuit breaking and redaction are kept out of the
 * channel implementations, so a channel only has to send once and never contains a retry loop.
 *
 * Three deliberate choices:
 *  1. State per channel lives in a closure, so decorators can be stacked freely without a global
 *     table (breaker state is created and destroyed with the instance).
 *  2. Numeric options accept `number | (() => number)`, so the assembly point can change behaviour
 *     after re-reading the config at `session_start` without rebuilding channel instances.
 *  3. Every retry attempt gets its own deadline (`withTimeout`). Otherwise the first attempt could
 *     consume the outer `delivery.timeoutMs` and the retry would immediately fail on an already
 *     aborted signal, which is the same as having no retry at all.
 */

import { redact } from "../log.ts";
import type { Logger, Notifier } from "../types.ts";

type Numberish = number | (() => number);

function resolveNumber(value: Numberish | undefined, fallback: number): number {
  const raw = typeof value === "function" ? value() : value;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Keeps the inner channel's optional `format()`: wrapping must not silently drop it. */
function keepOptional(inner: Notifier): Pick<Notifier, "format"> {
  return inner.format ? { format: (req) => inner.format?.(req) } : {};
}

/**
 * Per-attempt deadline. An inner channel that ignores `signal` still cannot hang the caller.
 * A timeout is translated into an explicit message instead of a bare `AbortError`, so the status
 * view has something meaningful to show.
 */
export function withTimeout(
  inner: Notifier,
  options: { timeoutMs: Numberish; log?: Logger },
): Notifier {
  return {
    id: inner.id,
    type: inner.type,
    validate: (raw) => inner.validate(raw),
    ...keepOptional(inner),
    async send(req, signal) {
      const timeoutMs = resolveNumber(options.timeoutMs, 0);
      if (timeoutMs <= 0) {
        await inner.send(req, signal);
        return;
      }
      if (signal.aborted) throw new Error("投递已取消");
      const timer = new AbortController();
      const timerId = setTimeout(() => timer.abort(new Error("timeout")), timeoutMs);
      const combined = AbortSignal.any([signal, timer.signal]);
      const timedOut = () => timer.signal.aborted && !signal.aborted;
      try {
        await inner.send(req, combined);
        // If the inner channel swallowed the abort and returned normally, the timeout still
        // happened and must not be reported as a successful delivery.
        if (timedOut()) throw new Error("timeout");
      } catch (error) {
        if (timedOut()) throw new Error(`投递超时（${timeoutMs}ms）: ${inner.id}`);
        throw error;
      } finally {
        clearTimeout(timerId);
      }
    },
    dispose: () => inner.dispose(),
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Bounded retry with exponential backoff.
 *
 * An already aborted outer signal stops the loop immediately (the user is gone and waiting would
 * be pointless), and each failed attempt writes a structured record so "broken channel" can be
 * told apart from "transient network failure".
 */
export function withRetry(
  inner: Notifier,
  options: { maxRetries: Numberish; retryDelayMs?: Numberish; log?: Logger },
): Notifier {
  return {
    id: inner.id,
    type: inner.type,
    validate: (raw) => inner.validate(raw),
    ...keepOptional(inner),
    async send(req, signal) {
      const maxRetries = Math.floor(resolveNumber(options.maxRetries, 0));
      const baseDelay = resolveNumber(options.retryDelayMs, 250);
      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (signal.aborted) break;
        try {
          await inner.send(req, signal);
          return;
        } catch (error) {
          lastError = error;
          options.log?.record({
            event: "delivery_retry",
            providerId: inner.id,
            kind: req.kind,
            dedupeKey: req.dedupeKey,
            attempt: attempt + 1,
            maxRetries,
            error: redact(describe(error)),
          });
          if (attempt === maxRetries) break;
          await sleep(baseDelay * 2 ** attempt, signal);
        }
      }
      throw lastError ?? new Error("投递已取消");
    },
    dispose: () => inner.dispose(),
  };
}

/**
 * Circuit breaking after consecutive failures.
 *
 * `failures <= 0` disables it. While open it throws instead of skipping silently, because the
 * tripped state has to be visible in the status counters and the last error. One attempt is let
 * through after `cooldownMs` (half-open): success resets the breaker, failure trips it again.
 */
export function withCircuitBreaker(
  inner: Notifier,
  options: { failures: Numberish; cooldownMs?: Numberish; now?: () => number; log?: Logger },
): Notifier {
  let consecutiveFailures = 0;
  let openUntil = 0;
  const now = options.now ?? (() => Date.now());

  return {
    id: inner.id,
    type: inner.type,
    validate: (raw) => inner.validate(raw),
    ...keepOptional(inner),
    async send(req, signal) {
      const threshold = Math.floor(resolveNumber(options.failures, 0));
      const cooldownMs = resolveNumber(options.cooldownMs, 30000);
      const nowMs = now();
      if (threshold > 0 && openUntil > nowMs) {
        const waitMs = openUntil - nowMs;
        options.log?.record({
          event: "circuit_open_skip",
          providerId: inner.id,
          kind: req.kind,
          consecutiveFailures,
          waitMs,
        });
        throw new Error(`渠道已熔断（连续 ${consecutiveFailures} 次失败，${Math.ceil(waitMs / 1000)}s 后再试）`);
      }
      try {
        await inner.send(req, signal);
        consecutiveFailures = 0;
        openUntil = 0;
      } catch (error) {
        consecutiveFailures += 1;
        if (threshold > 0 && consecutiveFailures >= threshold) {
          openUntil = nowMs + cooldownMs;
          options.log?.record({
            event: "circuit_open",
            providerId: inner.id,
            consecutiveFailures,
            cooldownMs,
          });
        }
        throw error;
      }
    },
    dispose: () => inner.dispose(),
  };
}

/**
 * Outbound redaction.
 *
 * A channel may put URLs, response fragments or raw credentials into an error message; this is
 * the last gate, so any text crossing out of the provider layer passes `redact()` first.
 */
export function withRedaction(inner: Notifier, options: { log?: Logger } = {}): Notifier {
  return {
    id: inner.id,
    type: inner.type,
    validate: (raw) => inner.validate(raw),
    ...keepOptional(inner),
    async send(req, signal) {
      try {
        await inner.send(req, signal);
      } catch (error) {
        const safe = redact(describe(error));
        options.log?.record({ event: "delivery_error_redacted", providerId: inner.id, error: safe });
        throw new Error(safe);
      }
    },
    dispose: () => inner.dispose(),
  };
}

export interface ReliabilityOptions {
  /** Per-attempt deadline; must be smaller than the outer timeout or a retry never gets a chance. */
  attemptTimeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  breakerFailures: number;
  breakerCooldownMs: number;
}

/**
 * The stack used by the assembly point: `redaction(circuit(retry(timeout(inner))))`.
 *
 * Order matters: the breaker sits outside the retry so one fully failed delivery counts as one
 * failure instead of one per attempt, and redaction is outermost so every exception is processed
 * before it leaves the provider layer.
 */
export function withReliability(
  notifier: Notifier,
  resolve: () => ReliabilityOptions,
  log?: Logger,
): Notifier {
  const state: ReliabilityOptions = {
    attemptTimeoutMs: 0,
    maxRetries: 0,
    retryDelayMs: 250,
    breakerFailures: 0,
    breakerCooldownMs: 30000,
  };
  const stack = withRedaction(
    withCircuitBreaker(
      withRetry(withTimeout(notifier, { timeoutMs: () => state.attemptTimeoutMs, log }), {
        maxRetries: () => state.maxRetries,
        retryDelayMs: () => state.retryDelayMs,
        log,
      }),
      {
        failures: () => state.breakerFailures,
        cooldownMs: () => state.breakerCooldownMs,
        log,
      },
    ),
    { log },
  );

  return {
    id: notifier.id,
    type: notifier.type,
    validate: (raw) => notifier.validate(raw),
    ...keepOptional(notifier),
    async send(req, signal) {
      // Re-read the current options per delivery: `session_start` may have re-read the config.
      Object.assign(state, resolve());
      await stack.send(req, signal);
    },
    dispose: () => stack.dispose(),
  };
}
