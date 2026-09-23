/**
 * Delivery service: threshold filtering, dedupe, quiet hours, coalescing window and
 * cooldown, bounded queue, concurrent delivery, timeout and idempotent dispose.
 * It only cares that a notification goes out; it does not know where events come from
 * and knows channels only by `providerId`.
 *
 * Hard constraints:
 *  - `submit()` is synchronous, never awaits the network and never throws; delivery
 *    runs as an independent task.
 *  - `flush(timeoutMs)` is only for shutdown paths and always has a budget.
 */

import { sanitizeError } from "./log.ts";
import { createNoopNotifier } from "./providers/noop.ts";
import type {
  DeliveryResult,
  Logger,
  NotificationConfig,
  NotificationRequest,
  NotificationService,
  Notifier,
  NotifierRegistry,
  NotifyLevel,
  ServiceSnapshot,
} from "./types.ts";

export interface ServiceOptions {
  config: NotificationConfig;
  registry: NotifierRegistry;
  log: Logger;
  now(): number;
}

const LEVEL_RANK: Record<NotifyLevel, number> = { info: 0, warning: 1, error: 2 };

/** Cap on remembered dedupe keys, so a long-lived process cannot grow without bound. */
const DEDUPE_LIMIT = 512;

export function createService(options: ServiceOptions): NotificationService {
  const { config, registry, log, now } = options;
  const notifiers = new Map<string, Notifier>();
  /**
   * Provider table, derived lazily: config can be merged again at `session_start`, so the
   * configuration must not be snapshotted in the constructor. A new `providers` array
   * reference means the config was refreshed, which also drops the cached channels.
   */
  let providersSource: NotificationConfig["providers"] | undefined;
  let providers = new Map<string, NotificationConfig["providers"][number]>();
  function providersById(): Map<string, NotificationConfig["providers"][number]> {
    if (providersSource !== config.providers) {
      providersSource = config.providers;
      providers = new Map(config.providers.map((provider) => [provider.id, provider]));
      notifiers.clear();
    }
    return providers;
  }

  const queue: NotificationRequest[] = [];
  const seen = new Map<string, true>();
  /**
   * Threshold filtering:
   *  - `coalesceUntil`: at most one notification per logical run (sessionId + runId);
   *  - `cooldownUntil`: minimum interval per kind.
   * Both tables advance only when a request is actually enqueued, so a dropped
   * notification never pushes the window further out for the next one.
   */
  const coalesceUntil = new Map<string, number>();
  const cooldownUntil = new Map<string, number>();
  let active = 0;
  let disposed = false;
  const stats: ServiceSnapshot = {
    queued: 0,
    active: 0,
    delivered: 0,
    failed: 0,
    skipped: 0,
    byProvider: {},
    deduped: 0,
    dropped: 0,
    coalesced: 0,
    cooled: 0,
  };
  let drainWaiters: Array<() => void> = [];
  const inFlight = new Set<AbortController>();

  const notifyDrained = (): void => {
    if (active > 0 || queue.length > 0) return;
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const resolve of waiters) resolve();
  };

  /** Keeps the window tables bounded: expired entries are dropped once the limit is exceeded. */
  function pruneWindow(table: Map<string, number>, nowMs: number): void {
    if (table.size <= DEDUPE_LIMIT) return;
    for (const [key, until] of table) {
      if (until <= nowMs) table.delete(key);
    }
  }

  /** Local-time half-open interval, may wrap past midnight; equal endpoints mean all day. */
  function isQuietHours(): boolean {
    const quiet = config.quietHours;
    if (!quiet.enabled) return false;
    const date = new Date(now());
    const minute = date.getHours() * 60 + date.getMinutes();
    const minutes = (value: string): number => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    const start = minutes(quiet.start);
    const end = minutes(quiet.end);
    return start === end || (start < end ? minute >= start && minute < end : minute >= start || minute < end);
  }

  /**
   * Quiet hours, then coalescing window, then cooldown. Returning true means the request
   * was dropped and the caller should return. Both windows advance only for requests that
   * were allowed through.
   */
  function filtered(req: NotificationRequest): boolean {
    if (isQuietHours() && !config.quietHours.exceptLevels.includes(req.level)) {
      log.record({ event: "quiet_hours_drop", kind: req.kind, dedupeKey: req.dedupeKey });
      return true; // Do not advance the coalescing or cooldown window.
    }
    const nowMs = now();
    // A request may carry its own window (immediate tool failures combine parallel failures),
    // but any key already inside a window is always coalesced: once a window is open, later
    // notifications of the same run belong in it regardless of their own window.
    const ownWindowMs = req.coalesceWindowMs !== undefined
      ? (Number.isFinite(req.coalesceWindowMs) ? Math.max(0, Math.floor(req.coalesceWindowMs)) : 0)
      : (Number.isFinite(config.coalesce?.windowMs) ? config.coalesce.windowMs : 0);
    const coalesceKey = `${req.meta.sessionId}:${req.meta.runId}`;
    const until = coalesceUntil.get(coalesceKey);
    if (until !== undefined && nowMs < until) {
      stats.coalesced += 1;
      log.record({ event: "coalesce_drop", kind: req.kind, dedupeKey: req.dedupeKey });
      log.log("debug", `同一运行已在合并窗口内，合并掉: kind=${req.kind}`);
      return true;
    }
    if (ownWindowMs > 0) {
      coalesceUntil.set(coalesceKey, Math.max(until ?? 0, nowMs + ownWindowMs));
      pruneWindow(coalesceUntil, nowMs);
    }
    const cooldownMs = Number.isFinite(config.coalesce?.cooldownMs) ? config.coalesce.cooldownMs : 0;
    if (cooldownMs > 0) {
      const until = cooldownUntil.get(req.kind);
      if (until !== undefined && nowMs < until) {
        stats.cooled += 1;
        log.record({ event: "cooldown_drop", kind: req.kind, dedupeKey: req.dedupeKey, cooldownMs });
        log.log("debug", `同 kind 冷却中，已拦下: kind=${req.kind}`);
        return true;
      }
      cooldownUntil.set(req.kind, nowMs + cooldownMs);
      pruneWindow(cooldownUntil, nowMs);
    }
    return false;
  }

  function notifierFor(providerId: string): Notifier {
    // Refresh the provider table before consulting the cache: `/notify reload` may keep the
    // same id while changing its type or enabled flag.
    const provider = providersById().get(providerId);
    const cached = notifiers.get(providerId);
    if (cached) return cached;
    let notifier: Notifier;
    if (!provider) {
      log.log("warning", `通知引用了未在配置中定义的渠道，已跳过: id=${providerId}`);
      notifier = createNoopNotifier(providerId, "unknown", "未在配置中定义的渠道");
    } else if (!provider.enabled) {
      log.log("debug", `渠道在配置中被禁用，已跳过: id=${providerId}`);
      notifier = createNoopNotifier(providerId, provider.type, "渠道已在配置中禁用");
    } else {
      notifier = registry.create(providerId, provider.type, provider.options);
    }
    notifiers.set(providerId, notifier);
    return notifier;
  }

  async function deliver(req: NotificationRequest): Promise<void> {
    const controller = new AbortController();
    inFlight.add(controller);
    const timeoutMs = Number.isFinite(config.delivery.timeoutMs) ? config.delivery.timeoutMs : 30000;
    const signal = timeoutMs > 0
      ? AbortSignal.any([AbortSignal.timeout(timeoutMs), controller.signal])
      : controller.signal;
    const startedAt = now();
    try {
      const maxParallel = Math.max(1, Math.min(8, Math.floor(config.delivery.channelConcurrency || 4)));
      // Bounded concurrent fan-out per notification: one slow channel cannot hold up the others.
      for (let offset = 0; offset < req.channels.length; offset += maxParallel) {
        const batch = req.channels.slice(offset, offset + maxParallel);
        const results = await Promise.all(batch.map(async (providerId): Promise<DeliveryResult> => {
          const notifier = notifierFor(providerId);
          const channelStarted = now();
          if (notifier.skipped) return { providerId, ok: false, skipped: true, attempts: 0, error: notifier.skipped, durationMs: 0 };
          try {
            await notifier.send(req, signal);
            return { providerId, ok: true, attempts: 1, durationMs: now() - channelStarted };
          } catch (error) {
            return {
              providerId, ok: false, attempts: 1,
              error: sanitizeError(error instanceof Error ? error.message : String(error)),
              durationMs: now() - channelStarted,
            };
          }
        }));
        for (const result of results) {
          const at = now();
          stats.lastAttemptAt = at;
          const perProvider = stats.byProvider[result.providerId] ??= { delivered: 0, failed: 0, skipped: 0 };
          if (result.skipped) {
            stats.skipped += 1;
            perProvider.skipped += 1;
          } else if (result.ok) {
            stats.delivered += 1;
            perProvider.delivered += 1;
            stats.lastOkAt = at;
          } else {
            stats.failed += 1;
            perProvider.failed += 1;
            perProvider.lastError = result.error;
            stats.lastError = result.error;
          }
          log.record({
            event: "delivery", kind: req.kind, level: req.level, dedupeKey: req.dedupeKey,
            sessionId: req.meta.sessionId, runId: req.meta.runId, providerId: result.providerId,
            ok: result.ok, skipped: result.skipped ?? false, attempts: result.attempts,
            durationMs: result.durationMs, ...(result.error ? { error: result.error } : {}),
          });
          if (!result.ok && !result.skipped) log.log("warning", `通知投递失败: id=${result.providerId} kind=${req.kind} ${result.error ?? ""}`);
        }
      }
    } finally {
      inFlight.delete(controller);
    }
  }

  function pump(): void {
    const concurrency = Number.isFinite(config.delivery.concurrency) && config.delivery.concurrency > 0
      ? Math.floor(config.delivery.concurrency)
      : 1;
    while (!disposed && active < concurrency && queue.length > 0) {
      const req = queue.shift();
      if (!req) break;
      active += 1;
      void deliver(req)
        .catch(() => {
          // deliver() already catches per channel; this is the last guard so no promise escapes.
        })
        .finally(() => {
          active -= 1;
          if (disposed) {
            notifyDrained();
            return;
          }
          pump();
          notifyDrained();
        });
    }
    notifyDrained();
  }

  function enqueue(req: NotificationRequest): void {
    const limit = Number.isFinite(config.delivery.queueLimit) && config.delivery.queueLimit > 0
      ? Math.floor(config.delivery.queueLimit)
      : 50;
    if (queue.length < limit) {
      queue.push(req);
      return;
    }
    // Queue full: drop the newest lowest-level entry instead of growing without bound.
    let victimIndex = -1;
    let victimRank = Number.POSITIVE_INFINITY;
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      const rank = LEVEL_RANK[queue[i].level];
      if (rank < victimRank) {
        victimRank = rank;
        victimIndex = i;
      }
    }
    const incomingRank = LEVEL_RANK[req.level];
    if (victimIndex === -1 || incomingRank < victimRank) {
      stats.dropped += 1;
      log.record({ event: "queue_drop", dropped: "incoming", kind: req.kind, dedupeKey: req.dedupeKey });
      log.log("warning", `队列已满，丢弃新通知: kind=${req.kind} limit=${limit}`);
      return;
    }
    const [dropped] = queue.splice(victimIndex, 1);
    queue.push(req);
    stats.dropped += 1;
    log.record({ event: "queue_drop", dropped: "existing", kind: dropped.kind, dedupeKey: dropped.dedupeKey });
    log.log("warning", `队列已满，丢弃低等级通知: kind=${dropped.kind} limit=${limit}`);
  }

  function discardPending(reason: string): void {
    const dropped = queue.length;
    queue.length = 0;
    for (const controller of inFlight) controller.abort();
    inFlight.clear();
    if (dropped > 0) {
      log.record({ event: "queue_discarded", reason, count: dropped });
      log.log("debug", `丢弃未投递通知: reason=${reason} count=${dropped}`);
    }
    notifyDrained();
  }

  return {
    submit(req: NotificationRequest, options?: { bypassFilters?: boolean }): void {
      try {
        if (disposed) return;
        if (!config.enabled) return;
        if (LEVEL_RANK[req.level] < LEVEL_RANK[config.minLevel]) return;
        if (req.channels.length === 0) return;
        if (seen.has(req.dedupeKey)) {
          stats.deduped += 1;
          log.record({ event: "dedupe_drop", kind: req.kind, dedupeKey: req.dedupeKey });
          return;
        }
        seen.set(req.dedupeKey, true);
        if (seen.size > DEDUPE_LIMIT) {
          const oldest = seen.keys().next();
          if (!oldest.done) seen.delete(oldest.value);
        }
        // Self-tests such as `/notify test` bypass quiet hours, coalescing and cooldown;
        // otherwise a missing test notification would be read as a broken channel.
        if (options?.bypassFilters !== true && filtered(req)) return;
        enqueue(req);
        log.record({
          event: "submit",
          kind: req.kind,
          level: req.level,
          dedupeKey: req.dedupeKey,
          channels: req.channels,
        });
        pump();
      } catch (error) {
        // No exception from the notification path may escape into a Pi hook.
        log.log("error", "提交通知时发生异常（已忽略）", {
          error: sanitizeError(error instanceof Error ? error.message : String(error)),
        });
      }
    },

    async flush(timeoutMs: number): Promise<void> {
      if (active === 0 && queue.length === 0) return;
      pump();
      const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        drainWaiters.push(resolve);
        timer = setTimeout(resolve, budget);
      });
      if (timer) clearTimeout(timer);
      if (active > 0 || queue.length > 0) {
        log.log("warning", `收尾投递超预算未完成: pending=${queue.length} active=${active} budgetMs=${budget}`);
      }
    },

    discardPending,
    isQuietHours,

    snapshot(): ServiceSnapshot {
      return { ...stats, queued: queue.length, active };
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      discardPending("dispose");
      for (const notifier of notifiers.values()) {
        try {
          await notifier.dispose();
        } catch (error) {
          log.log("debug", `渠道释放失败（已忽略）: id=${notifier.id}`, {
            error: sanitizeError(error instanceof Error ? error.message : String(error)),
          });
        }
      }
      notifiers.clear();
      log.record({ event: "service_disposed" });
    },
  };
}
