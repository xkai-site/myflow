/**
 * Run state machine: the only place that decides whether a run completed, failed,
 * was aborted or is unknown. It consumes plain data and emits plain data: no
 * delivery, no dedupe, no channel names and no `ctx` / `SessionManager` reference.
 *
 * Three semantics that are easy to get wrong:
 *  1. The only exit is `agent_settled`. `agent_end` fires again on automatic
 *     retries, compaction retries and queued continuations.
 *  2. `agent_settled` does not mean success: an Esc cancel and a provider error
 *     settle too, so `stopReason` decides.
 *  3. `reload` and session switches rebuild the instance, and an instance created
 *     before `session_shutdown` must never produce another conclusion.
 */

import type {
  AssistantStopReason,
  Logger,
  NotificationConfig,
  RunOutcome,
  RunStatus,
  ShutdownReason,
  ToolFailure,
  ToolFailureEvent,
} from "./types.ts";

export interface LifecycleOptions {
  config: NotificationConfig;
  log: Logger;
  now(): number;
  /** Instance id, so run ids from before and after a reload can never collide. */
  instanceToken: string;
}

export interface Lifecycle {
  onSessionStart(input: { sessionId: string; reason: string }): void;
  onAgentStart(input: { sessionId: string }): void;
  onAssistantMessage(input: {
    sessionId: string;
    stopReason: AssistantStopReason | undefined;
    errorMessage?: string;
    /** `usage.cost.total` of this assistant message; omitted when the provider reports none. */
    usageCostUsd?: number;
    /** Message text, already length-capped by the caller; this layer keeps the latest non-empty one. */
    text?: string;
  }): void;
  /**
   * One finished tool execution. `isError === false` only touches bookkeeping.
   * Returns the failure state accumulated in the current run, which `immediate`
   * mode uses to decide whether to notify now.
   */
  onToolExecutionEnd(input: {
    sessionId: string;
    toolName: string;
    isError: boolean;
  }): ToolFailureEvent | null;
  /** `session_compact_failed`. Returns the current run id, used to build the dedupe key. */
  onCompactFailed(input: { sessionId: string; reason: string; errorMessage?: string; aborted: boolean }): {
    sessionId: string;
    runId: string;
  } | null;
  /** `ui_prompt_start`: records "a user is being awaited". Allow-listing is rules/config work. */
  onUiPromptStart(input: { sessionId: string; kind: string; title?: string }): void;
  /** `ui_prompt_end`: resets. Nested prompts only emit the outer span, so `kind` is the outer one. */
  onUiPromptEnd(input: { sessionId: string; kind: string }): void;
  /** The only exit. `null` means a structural drop: stale instance, session mismatch or not idle. */
  onSettled(input: { sessionId: string; isIdle: boolean }): RunOutcome | null;
  onShutdown(reason: ShutdownReason): void;
  currentSessionId(): string | undefined;
  /** Cost accumulated for this session inside this instance. */
  sessionCostUsd(): number;
  /** True while a user prompt is open; shown by `/notify status`. */
  isWaitingForUser(): boolean;
  isStale(): boolean;
}

/**
 * stopReason to run status. `pending` and `deferred` are not final-state semantics and
 * map to unknown (silent by default), so an intermediate state is never reported as
 * completed.
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
    /** Assistant usage accumulated in this run; extra turns and retries stay in the same run. */
    costUsd?: number;
    /** Last non-empty assistant text of this run. */
    assistantText?: string;
    /** Tool failures in this run, deduplicated by tool name, in first-failure order. */
    toolFailures: Map<string, number>;
    compactFailed: boolean;
  } | undefined;
  /**
   * Session cost accumulated in instance memory only. A `/reload` or a session switch
   * rebuilds the instance and resets it. Reading it from the session store would mean
   * pulling session content into this layer, which breaks the plain-data boundary.
   */
  let sessionCostUsd = 0;
  /**
   * Depth of open user prompts.
   * Nested or overlapping prompts do not produce an inner span and `ui_prompt_end.kind`
   * reports the outer one, so start/end cannot be paired by kind: this is a plain
   * increment/decrement counter. `custom` is excluded because it does not mean the user
   * is typing (the loader and progress UI use it, possibly for a long-lived span) and
   * counting it would leave "waiting for you" stuck on.
   */
  let promptDepth = 0;

  function newRun(): NonNullable<typeof activeRun> {
    counter += 1;
    return {
      runId: `${instanceToken}-${counter}`,
      startedAt: now(),
      sawAssistant: false,
      toolFailures: new Map(),
      compactFailed: false,
    };
  }

  /** Lazily creates a run for events that need run context without an `agent_start`. */
  function ensureRun(sessionId: string): NonNullable<typeof activeRun> {
    if (!activeRun) {
      const created = newRun();
      activeRun = created;
      log.record({ event: "lifecycle_run_implicit", sessionId, runId: created.runId });
    }
    return activeRun;
  }

  const describe = (status: string, reason?: string): void => {
    log.record({ event: "settled_ignored", status, ...(reason ? { reason } : {}) });
    log.log("debug", `settled 已忽略: ${status}${reason ? ` (${reason})` : ""}`);
  };

  /**
   * Session binding. Normally `session_start` binds it; when the host never emits that
   * event (for example an SDK host without extension UI context), the first event binds
   * lazily so one optional event cannot disable the whole plugin.
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
      sessionCostUsd = 0;
      log.record({ event: "lifecycle_session_start", sessionId, reason });
    },

    onAgentStart({ sessionId }): void {
      if (!accept(sessionId)) return;
      const run = newRun();
      activeRun = run;
      log.record({ event: "lifecycle_run_start", sessionId, runId: run.runId });
    },

    onAssistantMessage({ sessionId, stopReason, errorMessage, usageCostUsd, text }): void {
      if (!accept(sessionId)) return;
      // Allowed without `agent_start` (the instance may take over mid-run), but never invents a start time.
      const run = ensureRun(sessionId);
      run.sawAssistant = true;
      run.stopReason = stopReason;
      if (errorMessage !== undefined) run.errorMessage = errorMessage;
      if (typeof usageCostUsd === "number" && Number.isFinite(usageCostUsd) && usageCostUsd > 0) {
        run.costUsd = (run.costUsd ?? 0) + usageCostUsd;
        sessionCostUsd += usageCostUsd;
      }
      // Keep only the latest non-empty text: at settle time it is the final assistant reply.
      if (typeof text === "string" && text !== "") run.assistantText = text;
    },

    onToolExecutionEnd({ sessionId, toolName, isError }): ToolFailureEvent | null {
      if (!accept(sessionId)) return null;
      if (!isError) return null;
      const run = ensureRun(sessionId);
      // One count per tool name per run: with parallel tools `tool_execution_end` arrives out of order.
      const count = (run.toolFailures.get(toolName) ?? 0) + 1;
      run.toolFailures.set(toolName, count);
      log.record({ event: "lifecycle_tool_failed", sessionId, runId: run.runId, toolName, count });
      const accumulated: ToolFailure[] = [...run.toolFailures].map(([name, times]) => ({ toolName: name, count: times }));
      return { sessionId, runId: run.runId, toolName, count, accumulated };
    },

    onCompactFailed({ sessionId, reason, errorMessage, aborted }): { sessionId: string; runId: string } | null {
      if (!accept(sessionId)) return null;
      const run = ensureRun(sessionId);
      run.compactFailed = true;
      log.record({
        event: "lifecycle_compact_failed",
        sessionId,
        runId: run.runId,
        reason,
        aborted,
        ...(errorMessage ? { error: errorMessage } : {}),
      });
      return { sessionId, runId: run.runId };
    },

    onUiPromptStart({ sessionId, kind, title }): void {
      if (!accept(sessionId)) return;
      if (kind !== "custom") promptDepth += 1;
      log.record({ event: "lifecycle_prompt_start", sessionId, kind, depth: promptDepth, ...(title ? { title } : {}) });
    },

    onUiPromptEnd({ sessionId, kind }): void {
      if (!accept(sessionId)) return;
      // Nested prompts emit only the outer span, so one end can drop the depth to 0; it must never go negative.
      if (kind !== "custom") promptDepth = Math.max(0, promptDepth - 1);
      log.record({ event: "lifecycle_prompt_end", sessionId, kind, depth: promptDepth });
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
        // Pi semantics: when another extension's run is still going at settle time,
        // reporting "completed" would be wrong.
        describe("not_idle");
        return null;
      }

      const run = activeRun;
      activeRun = undefined;
      const status = classify(run?.stopReason);
      const startedAt = run?.startedAt ?? now();
      const toolFailures = [...(run?.toolFailures ?? new Map<string, number>())].map(([toolName, count]) => ({
        toolName,
        count,
      }));
      const outcome: RunOutcome = {
        sessionId,
        runId: run?.runId ?? `${instanceToken}-orphan-${sessionId.slice(0, 8)}`,
        status,
        startedAt,
        durationMs: Math.max(0, now() - startedAt),
        stopReason: run?.stopReason,
        errorMessage: run?.errorMessage,
        toolFailures,
        ...(run?.compactFailed ? { compactFailed: true } : {}),
        ...(run?.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
        ...(run?.assistantText ? { assistantExcerpt: run.assistantText } : {}),
      };

      log.record({
        event: "run_settled",
        sessionId,
        runId: outcome.runId,
        status,
        stopReason: outcome.stopReason ?? null,
        durationMs: outcome.durationMs,
        sawAssistant: run?.sawAssistant ?? false,
        toolFailures: toolFailures.length,
        compactFailed: run?.compactFailed === true,
        costUsd: outcome.costUsd ?? null,
        sessionCostUsd,
      });
      return outcome;
    },

    onShutdown(reason: ShutdownReason): void {
      stale = true;
      activeRun = undefined;
      // A hard kill can skip the final `ui_prompt_end`, so the depth is reset defensively.
      promptDepth = 0;
      log.record({ event: "lifecycle_shutdown", reason, sessionId: boundSessionId ?? null });
    },

    currentSessionId(): string | undefined {
      return boundSessionId;
    },

    sessionCostUsd(): number {
      return sessionCostUsd;
    },

    isWaitingForUser(): boolean {
      return promptDepth > 0;
    },

    isStale(): boolean {
      return stale;
    },
  };
}
