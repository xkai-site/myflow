/**
 * 运行状态机（设计 §12.1 / §17.3）。
 *
 * **唯一**判定「一次运行是完成 / 失败 / 取消 / 无法判定」的地方。只吃纯数据、只吐纯数据：
 * 不投递、不去重、不认识任何渠道，也不持有 `ctx` / `SessionManager` 引用。
 *
 * 三个必须守住的语义（来自 §18 实测）：
 *  1. 出口只有 `agent_settled`。`agent_end` 会因为自动重试 / 压缩重试 / 排队续跑而多次触发。
 *  2. `agent_settled` 本身不等于成功：Esc 取消与 provider 报错也会 settle，必须看 `stopReason`。
 *  3. reload / 换会话会重建实例：旧实例在 `session_shutdown` 之后**不得**再产生任何结论。
 */

import type {
  AssistantStopReason,
  Logger,
  NotificationConfig,
  RunOutcome,
  RunStatus,
  ShutdownReason,
} from "./types.ts";

export interface LifecycleOptions {
  config: NotificationConfig;
  log: Logger;
  now(): number;
  /** 实例标识，保证 reload 后新旧实例的 runId 不冲突（去重键自包含）。 */
  instanceToken: string;
}

export interface Lifecycle {
  onSessionStart(input: { sessionId: string; reason: string }): void;
  onAgentStart(input: { sessionId: string }): void;
  onAssistantMessage(input: {
    sessionId: string;
    stopReason: AssistantStopReason | undefined;
    errorMessage?: string;
  }): void;
  /** 唯一出口。返回 null 表示结构性丢弃（陈旧实例 / 会话不匹配 / 非空闲）。 */
  onSettled(input: { sessionId: string; isIdle: boolean }): RunOutcome | null;
  onShutdown(reason: ShutdownReason): void;
  currentSessionId(): string | undefined;
  isStale(): boolean;
}

/**
 * stopReason → 运行状态。
 * `pending` / `deferred` 不是终态语义，归入 unknown（默认不通知），避免把中间态当完成。
 */
function classify(stopReason: AssistantStopReason | undefined): RunStatus {
  if (stopReason === "error") return "failed";
  if (stopReason === "aborted") return "aborted";
  if (stopReason === "stop" || stopReason === "length" || stopReason === "toolUse") return "completed";
  return "unknown";
}

export function createLifecycle(options: LifecycleOptions): Lifecycle {
  const { log, now, instanceToken } = options;

  let boundSessionId: string | undefined;
  let stale = false;
  let counter = 0;
  let activeRun: {
    runId: string;
    startedAt: number;
    stopReason?: AssistantStopReason;
    errorMessage?: string;
    sawAssistant: boolean;
  } | undefined;

  const describe = (status: string, reason?: string): void => {
    log.record({ event: "settled_ignored", status, ...(reason ? { reason } : {}) });
    log.log("debug", `settled 已忽略: ${status}${reason ? ` (${reason})` : ""}`);
  };

  /**
   * 会话绑定。
   * 正常路径由 `session_start` 绑定；若宿主未发出该事件（例如 SDK 未绑定扩展 UI 上下文），
   * 则在首个事件上惰性绑定，保证骨架不会因为一个可选事件而整体失效。
   */
  function accept(sessionId: string): boolean {
    if (stale) return false;
    if (boundSessionId === undefined) {
      boundSessionId = sessionId;
      return true;
    }
    return boundSessionId === sessionId;
  }

  return {
    onSessionStart({ sessionId, reason }): void {
      if (stale) return;
      boundSessionId = sessionId;
      activeRun = undefined;
      log.record({ event: "lifecycle_session_start", sessionId, reason });
    },

    onAgentStart({ sessionId }): void {
      if (!accept(sessionId)) return;
      counter += 1;
      activeRun = {
        runId: `${instanceToken}-${counter}`,
        startedAt: now(),
        sawAssistant: false,
      };
      log.record({ event: "lifecycle_run_start", sessionId, runId: activeRun.runId });
    },

    onAssistantMessage({ sessionId, stopReason, errorMessage }): void {
      if (!accept(sessionId)) return;
      // 没有 agent_start 也允许记录（实例可能在中途接管），但不会伪造开始时间。
      if (!activeRun) {
        counter += 1;
        activeRun = { runId: `${instanceToken}-${counter}`, startedAt: now(), sawAssistant: false };
      }
      activeRun.sawAssistant = true;
      activeRun.stopReason = stopReason;
      if (errorMessage !== undefined) activeRun.errorMessage = errorMessage;
    },

    onSettled({ sessionId, isIdle }): RunOutcome | null {
      if (stale) {
        describe("instance_stale");
        return null;
      }
      if (boundSessionId !== undefined && boundSessionId !== sessionId) {
        describe("session_mismatch", `${boundSessionId} != ${sessionId}`);
        return null;
      }
      if (!isIdle) {
        // 官方语义：settled 时若仍有其它扩展启动的 run 在跑，就不该报「完成了」。
        describe("not_idle");
        return null;
      }

      const run = activeRun;
      activeRun = undefined;
      const status = classify(run?.stopReason);
      const startedAt = run?.startedAt ?? now();
      const outcome: RunOutcome = {
        sessionId,
        runId: run?.runId ?? `${instanceToken}-orphan-${sessionId.slice(0, 8)}`,
        status,
        startedAt,
        durationMs: Math.max(0, now() - startedAt),
        stopReason: run?.stopReason,
        errorMessage: run?.errorMessage,
        toolFailures: [],
      };

      log.record({
        event: "run_settled",
        sessionId,
        runId: outcome.runId,
        status,
        stopReason: outcome.stopReason ?? null,
        durationMs: outcome.durationMs,
        sawAssistant: run?.sawAssistant ?? false,
      });
      return outcome;
    },

    onShutdown(reason: ShutdownReason): void {
      stale = true;
      activeRun = undefined;
      log.record({ event: "lifecycle_shutdown", reason, sessionId: boundSessionId ?? null });
    },

    currentSessionId(): string | undefined {
      return boundSessionId;
    },

    isStale(): boolean {
      return stale;
    },
  };
}
