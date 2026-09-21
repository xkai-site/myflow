/**
 * 投递服务（设计 §8 / §12.1 第 5、6 步 / §17.2）。
 *
 * 职责：门槛过滤 → 去重 → **合并窗口 + 冷却（S4）** → 有界队列 → 并发投递 → 超时 → 幂等 dispose。
 * 只关心「通知要发出去」，**不关心事件从哪来**，也不认识任何具体渠道（只认 `providerId`）。
 *
 * 硬约束（§18.4）：
 *  - `submit()` 是**同步**函数，绝不 await 网络、绝不抛异常；投递在独立任务里跑。
 *  - `flush(timeoutMs)` 只在 quit 收尾使用（有预算）。
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

/** 去重键保留上限：避免长时间进程内无界增长。 */
const DEDUPE_LIMIT = 512;

export function createService(options: ServiceOptions): NotificationService {
  const { config, registry, log, now } = options;
  const notifiers = new Map<string, Notifier>();
  /**
   * 渠道表惰性派生：配置可能在 session_start 时被重新合并（项目级覆盖），
   * 所以不能在构造时把配置快照死。数组引用变化即视为配置已刷新，顺便清掉渠道缓存。
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
   * S4 门槛过滤（§12.1 第 5 步，设计 §10.2 的 `coalesce`）：
   *  - `coalesceUntil`：「同一逻辑运行（sessionId+runId）只放行一条」；
   *  - `cooldownUntil`：「同一 kind 的最小间隔」。
   * 两个表只在**真正入队**时推进，所以被拦下的通知不会把窗口越推越远。
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

  /** 窗口表的有界性：过期项直接剔除，保留量超过上限时整表重建。 */
  function pruneWindow(table: Map<string, number>, nowMs: number): void {
    if (table.size <= DEDUPE_LIMIT) return;
    for (const [key, until] of table) {
      if (until <= nowMs) table.delete(key);
    }
  }

  /**
   * 合并窗口 + 冷却。返回 true 表示被拦下（调用方直接 return）。
   * 两个窗口都只在**已放行**时推进：被拦下的通知不应延长别人的等待。
   */
  function filtered(req: NotificationRequest): boolean {
    const nowMs = now();
    // 通知自带的窗口优先（工具失败 immediate 模式用 `toolFailureWindowMs` 聚合并行失败），
    // 但**已在窗口内的 key 一律合并**：窗口一旦被（任一条通知）打开，同一运行的后续通知
    // 都应该被吸进去，而不是取决于它自己带没带窗口。
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
    const cached = notifiers.get(providerId);
    if (cached) return cached;
    const provider = providersById().get(providerId);
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
    const timeoutMs = Number.isFinite(config.delivery.timeoutMs) ? config.delivery.timeoutMs : 8000;
    const signal = timeoutMs > 0
      ? AbortSignal.any([AbortSignal.timeout(timeoutMs), controller.signal])
      : controller.signal;
    const startedAt = now();
    try {
      // S1 只投递一次；重试/熔断留给 S4 的 decorator（§17.5）。
      for (const providerId of req.channels) {
        const notifier = notifierFor(providerId);
        let result: DeliveryResult;
        try {
          await notifier.send(req, signal);
          result = { providerId, ok: true, attempts: 1, durationMs: now() - startedAt };
        } catch (error) {
          result = {
            providerId,
            ok: false,
            attempts: 1,
            error: sanitizeError(error instanceof Error ? error.message : String(error)),
            durationMs: now() - startedAt,
          };
        }
        stats.lastAttemptAt = now();
        if (result.ok) {
          stats.delivered += 1;
          stats.lastOkAt = stats.lastAttemptAt;
        } else {
          stats.failed += 1;
          stats.lastError = result.error;
        }
        log.record({
          event: "delivery",
          kind: req.kind,
          level: req.level,
          dedupeKey: req.dedupeKey,
          sessionId: req.meta.sessionId,
          runId: req.meta.runId,
          providerId: result.providerId,
          ok: result.ok,
          attempts: result.attempts,
          durationMs: result.durationMs,
          ...(result.error ? { error: result.error } : {}),
        });
        if (!result.ok) {
          log.log("warning", `通知投递失败: id=${providerId} kind=${req.kind} ${result.error ?? ""}`);
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
          // deliver() 内部已逐渠道 try/catch；这里只是最后一道保险，绝不让 Promise 逃逸。
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
    // 队列满：丢弃等级最低的**最新**一项（§13 第 4 项），不无限增长。
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
        // `/notify test` 这类自检绕过合并/冷却，否则「测试通知没来」会被误读成渠道坏了。
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
        // 通知链路的任何异常都不得冒泡回 Pi 的 hook（§13 第 11 项）。
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
