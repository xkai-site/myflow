/**
 * 可靠性装饰器（设计 §17.2 / §17.3 规则 5）。
 *
 * 把「超时 / 重试 / 熔断 / 脱敏」从渠道实现里剥离：渠道只负责**发一次**，
 * 这里负责「发不出去怎么办」。因此渠道实现里看不到任何重试循环。
 *
 * 三个刻意的设计选择：
 *  1. **每个渠道实例的状态在闭包里**，装饰器可任意套用而不需要全局表（熔断状态随实例生灭）。
 *  2. 数值参数支持 `number | (() => number)`：组装点（`extensions/index.ts`）可以在
 *     `session_start` 重新读配置后改变行为，而不必重建渠道实例。
 *  3. 重试的每一次尝试都有**自己的** deadline（`withTimeout`），否则第一次尝试耗尽外层
 *     `delivery.timeoutMs` 后，重试会在「已经 abort 的 signal」上立刻失败，等于没有重试。
 *
 * 本文件不得 import `lifecycle` / `rules` / `config`（§17.3 规则 3）。
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

/** 保留内层渠道的可选 `format()`（包装后不应悄悄丢掉渠道特定格式化）。 */
function keepOptional(inner: Notifier): Pick<Notifier, "format"> {
  return inner.format ? { format: (req) => inner.format?.(req) } : {};
}

/**
 * 每次 `send()` 的独立 deadline。内层忽略 `signal` 也不会把外层卡死。
 * 超时被翻译成一个明确的中文错误（而不是裸的 `AbortError`），便于 `/notify status` 展示。
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
        // 内层即使"吃掉"了 abort 并正常返回，超时也仍然是事实——不能当作投递成功。
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
 * 有界重试（设计 §13 第 1 项）：`maxRetries` 次额外尝试 + 指数退避。
 *
 * - 外层 signal 已 abort 时**立刻停**（用户已经走了，重试只是白等）。
 * - 失败尝试会写一条结构化记录（`delivery_retry`），便于判断「是渠道坏了还是网络抖了」。
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
 * 连续失败熔断（设计 §13 第 1 项）。
 *
 * `failures <= 0` 关闭熔断。熔断期间直接抛错——**不静默跳过**：
 * 「渠道被熔断」必须能在 `/notify status` 的失败统计与上次错误里看到。
 * `cooldownMs` 之后放行一次（半开）：成功则复位，失败则重新熔断。
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
 * 出口脱敏（设计 §2.2 第 4 点 / §13 第 16 项）。
 *
 * 渠道实现可能把 URL、响应体片段或凭据原文塞进错误消息；这里是**最后一道**出口，
 * 任何跨出 provider 层的文本都要先过 `redact()`。
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
  /** 单次尝试的 deadline（必须小于外层 `delivery.timeoutMs`，否则重试永远来不及） */
  attemptTimeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  breakerFailures: number;
  breakerCooldownMs: number;
}

/**
 * 组装点用的组合：`redaction(circuit(retry(timeout(inner))))`。
 *
 * 顺序的理由：
 *  - 熔断在**重试之外**，所以「一次投递彻底失败」才计一次失败（而不是每次尝试都计）；
 *  - 脱敏在最外层，保证任何异常文本出 provider 层之前已经被处理过。
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
      // 每次投递读一次最新配置（`session_start` 可能重新读盘）
      Object.assign(state, resolve());
      await stack.send(req, signal);
    },
    dispose: () => stack.dispose(),
  };
}
