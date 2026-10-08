/** Single plain-data state machine. Only agent_settled concludes a logical run. */
import { sanitizeError } from "./log.ts";
import { projectRun } from "./messages.ts";
import type {
  AssistantStopReason, BlockingPromptKind, CompactionReason, LifecycleUpdate, Logger,
  MachineRun, NotificationConfig, RunOutcome, RunStatus, RuntimeFact, RuntimeSnapshot,
  ShutdownReason, SignalEvent, ToolFailureEvent,
} from "./types.ts";

export interface LifecycleOptions {
  config: NotificationConfig;
  log: Logger;
  now(): number;
  instanceToken: string;
}
export interface Lifecycle {
  observe(signal: SignalEvent): LifecycleUpdate;
  snapshot(): RuntimeSnapshot;
  onSessionStart(input: { sessionId: string; reason: string }): void;
  onAgentStart(input: { sessionId: string }): void;
  onAssistantMessage(input: { sessionId: string; stopReason: AssistantStopReason | undefined; errorMessage?: string; usageCostUsd?: number; text?: string }): void;
  onToolExecutionEnd(input: { sessionId: string; toolName: string; isError: boolean; toolCallId?: string }): ToolFailureEvent | null;
  onCompactFailed(input: { sessionId: string; reason: string; errorMessage?: string; aborted: boolean }): { sessionId: string; runId: string; operationId: string } | null;
  onUiPromptStart(input: { sessionId: string; kind: string; title?: string }): void;
  onUiPromptEnd(input: { sessionId: string; kind: string }): void;
  onSettled(input: { sessionId: string; isIdle: boolean; aborted?: boolean }): RunOutcome | null;
  onShutdown(reason: ShutdownReason): void;
  currentSessionId(): string | undefined;
  sessionCostUsd(): number | undefined;
  isWaitingForUser(): boolean;
  isStale(): boolean;
}

function classify(reason: AssistantStopReason | undefined): RunStatus {
  if (reason === "error") return "failed";
  if (reason === "aborted") return "aborted";
  if (reason === "stop" || reason === "length" || reason === "toolUse") return "completed";
  return "unknown";
}
function compactionReason(value: string): CompactionReason {
  return value === "overflow" || value === "threshold" ? value : "manual";
}
function blockingKind(value: string): value is BlockingPromptKind {
  return value === "select" || value === "confirm" || value === "input" || value === "editor";
}

export function createLifecycle({ log, now, instanceToken }: LifecycleOptions): Lifecycle {
  let boundSessionId: string | undefined;
  let stale = false;
  let counter = 0;
  let operationSeq = 0;
  let promptSeq = 0;
  let observedAt: number | undefined;
  const clock = () => observedAt ?? now();
  let restingState: RuntimeSnapshot["state"] = "unknown";
  let activeRun: {
    runId: string; startedAt: number; startObserved: boolean; sawAssistant: boolean;
    stopReason?: AssistantStopReason; errorMessage?: string; costUsd?: number;
    assistantMessageCount: number; costReportCount: number; assistantText?: string;
    toolFailures: Map<string, number>; toolCalls: Set<string>; compactFailed: boolean;
    overflowRecoveryFailed: boolean;
  } | undefined;
  let lastRun: MachineRun | undefined;
  let compaction: { operationId: string; reason: CompactionReason; runId?: string } | undefined;
  let lastOperation: RuntimeSnapshot["lastOperation"];
  let prompts: RuntimeSnapshot["prompts"] = [];
  let sessionCostUsd: number | undefined;
  let sessionCostComplete = true;

  function accept(sessionId: string): boolean {
    if (stale) return false;
    boundSessionId ??= sessionId;
    return boundSessionId === sessionId;
  }
  function newRun(startObserved: boolean): NonNullable<typeof activeRun> {
    return {
      runId: `${instanceToken}-${++counter}`, startedAt: clock(), startObserved, sawAssistant: false,
      assistantMessageCount: 0, costReportCount: 0, toolFailures: new Map(), toolCalls: new Set(),
      compactFailed: false, overflowRecoveryFailed: false,
    };
  }
  function ignored(status: string, reason?: string): null {
    log.record({ event: "settled_ignored", status, ...(reason ? { reason } : {}) });
    return null;
  }
  function startCompaction(reason: CompactionReason): NonNullable<typeof compaction> {
    compaction = { operationId: `${instanceToken}-compact-${++operationSeq}`, reason, ...(activeRun ? { runId: activeRun.runId } : {}) };
    return compaction;
  }

  const lifecycle: Lifecycle = {
    onSessionStart({ sessionId, reason }) {
      if (stale) return;
      boundSessionId = sessionId;
      activeRun = undefined; lastRun = undefined; compaction = undefined; lastOperation = undefined;
      prompts = []; restingState = "idle";
      sessionCostUsd = undefined; sessionCostComplete = true;
      log.record({ event: "lifecycle_session_start", sessionId, reason });
    },
    onAgentStart({ sessionId }) {
      if (!accept(sessionId)) return;
      // agent.continue() starts again before the same final settle. Do not reset its facts.
      if (activeRun) return;
      activeRun = newRun(true);
      log.record({ event: "lifecycle_run_start", sessionId, runId: activeRun.runId });
    },
    onAssistantMessage({ sessionId, stopReason, errorMessage, usageCostUsd, text }) {
      if (!accept(sessionId)) return;
      if (!activeRun) {
        activeRun = newRun(false);
        log.record({ event: "lifecycle_run_implicit", sessionId, runId: activeRun.runId });
      }
      const run = activeRun;
      run.sawAssistant = true; run.assistantMessageCount += 1; run.stopReason = stopReason;
      // A successful retry replaces an earlier error, including its error text.
      run.errorMessage = errorMessage ? sanitizeError(errorMessage, 200) : undefined;
      if (classify(stopReason) === "completed") run.overflowRecoveryFailed = false;
      if (typeof usageCostUsd === "number" && Number.isFinite(usageCostUsd) && usageCostUsd >= 0) {
        run.costReportCount += 1;
        run.costUsd = (run.costUsd ?? 0) + usageCostUsd;
        sessionCostUsd = (sessionCostUsd ?? 0) + usageCostUsd;
      } else sessionCostComplete = false;
      if (text) run.assistantText = [...text].slice(0, 200).join("");
    },
    onToolExecutionEnd({ sessionId, toolName, isError, toolCallId }) {
      if (!accept(sessionId) || !isError) return null;
      const safeName = sanitizeError(toolName, 100);
      const run = activeRun;
      if (toolCallId && run?.toolCalls.has(toolCallId)) return null;
      if (toolCallId && run) run.toolCalls.add(toolCallId);
      const count = (run?.toolFailures.get(safeName) ?? 0) + 1;
      run?.toolFailures.set(safeName, count);
      const scopeId = run?.runId ?? `${instanceToken}-tool-${++operationSeq}`;
      const accumulated = run ? [...run.toolFailures].map(([toolName, count]) => ({ toolName, count })) : [{ toolName: safeName, count }];
      log.record({ event: "lifecycle_tool_failed", sessionId, runId: scopeId, toolName: safeName, count });
      return { sessionId, runId: scopeId, toolName: safeName, count, accumulated };
    },
    onCompactFailed({ sessionId, reason, errorMessage, aborted }) {
      if (!accept(sessionId)) return null;
      const op = compaction ?? startCompaction(compactionReason(reason));
      if (activeRun) {
        activeRun.compactFailed = true;
        if (reason === "overflow" && !aborted) {
          activeRun.overflowRecoveryFailed = true;
          activeRun.errorMessage = errorMessage ? sanitizeError(errorMessage, 200) : activeRun.errorMessage;
        }
      }
      lastOperation = { operationId: op.operationId, reason: op.reason, status: aborted ? "aborted" : "failed" };
      compaction = undefined;
      if (!activeRun) restingState = aborted ? "idle" : "error";
      log.record({ event: "lifecycle_compact_failed", sessionId, operationId: op.operationId,
        ...(activeRun ? { runId: activeRun.runId } : {}), reason, aborted,
        ...(errorMessage ? { error: sanitizeError(errorMessage, 200) } : {}) });
      // v1 notification scope remains a string; it is not an agent run in the API.
      return { sessionId, runId: activeRun?.runId ?? op.operationId, operationId: op.operationId };
    },
    onUiPromptStart({ sessionId, kind }) {
      if (!accept(sessionId) || !blockingKind(kind)) return;
      prompts.push({ promptId: `${instanceToken}-prompt-${++promptSeq}`, kind });
      log.record({ event: "lifecycle_prompt_start", sessionId, kind, depth: prompts.length });
    },
    onUiPromptEnd({ sessionId, kind }) {
      if (!accept(sessionId) || !blockingKind(kind)) return;
      prompts.pop();
      log.record({ event: "lifecycle_prompt_end", sessionId, kind, depth: prompts.length });
    },
    onSettled({ sessionId, isIdle, aborted }) {
      if (stale) return ignored("instance_stale");
      if (boundSessionId !== undefined && boundSessionId !== sessionId) return ignored("session_mismatch", `${boundSessionId} != ${sessionId}`);
      if (!isIdle) return ignored("not_idle");
      const run = activeRun;
      if (!run) return ignored("no_active_run");
      activeRun = undefined;
      const status = aborted ? "aborted" : run.overflowRecoveryFailed ? "failed" : classify(run.stopReason);
      const outcome: RunOutcome = {
        sessionId, runId: run.runId, status, startedAt: run.startedAt, startObserved: run.startObserved,
        durationMs: Math.max(0, clock() - run.startedAt), stopReason: run.stopReason,
        ...(status === "failed" && run.errorMessage ? { errorMessage: run.errorMessage } : {}),
        toolFailures: [...run.toolFailures].map(([toolName, count]) => ({ toolName, count })),
        ...(run.compactFailed ? { compactFailed: true } : {}),
        ...(run.costUsd !== undefined && run.costReportCount === run.assistantMessageCount ? { costUsd: run.costUsd } : {}),
        ...(run.assistantText ? { assistantExcerpt: run.assistantText } : {}),
      };
      lastRun = projectRun(outcome);
      restingState = status === "completed" ? "done" : status === "failed" ? "error" : status === "aborted" ? "idle" : "unknown";
      log.record({ event: "run_settled", sessionId, runId: outcome.runId, status,
        stopReason: outcome.stopReason ?? null, durationMs: outcome.durationMs, sawAssistant: run.sawAssistant,
        toolFailures: outcome.toolFailures.length, compactFailed: run.compactFailed, costUsd: outcome.costUsd ?? null,
        sessionCostUsd: lifecycle.sessionCostUsd() });
      return outcome;
    },
    onShutdown(reason) {
      stale = true; activeRun = undefined; compaction = undefined; prompts = []; restingState = "unknown";
      log.record({ event: "lifecycle_shutdown", reason, sessionId: boundSessionId ?? null });
    },
    currentSessionId: () => boundSessionId,
    sessionCostUsd: () => sessionCostComplete ? sessionCostUsd : undefined,
    isWaitingForUser: () => prompts.length > 0,
    isStale: () => stale,
    snapshot() {
      return structuredClone({
        state: stale ? "unknown" : prompts.length ? "blocked" : compaction || activeRun ? "working" : restingState,
        ...(activeRun ? { activeRun: { runId: activeRun.runId, startObserved: activeRun.startObserved,
          ...(activeRun.startObserved ? { startedAt: activeRun.startedAt } : {}) } } : {}),
        ...(lastRun ? { lastRun } : {}),
        ...(compaction ? { compaction: { operationId: compaction.operationId, reason: compaction.reason } } : {}),
        ...(lastOperation ? { lastOperation } : {}),
        prompts,
        ...(lifecycle.sessionCostUsd() !== undefined ? { sessionCostUsd: lifecycle.sessionCostUsd() } : {}),
      }) as RuntimeSnapshot;
    },
    observe(signal) {
      const update: LifecycleUpdate = { facts: [] };
      if (!accept(signal.sessionId)) return update;
      observedAt = signal.at;
      const { sessionId, at } = signal;
      const emit = (fact: Omit<RuntimeFact, "at">) => update.facts.push({ ...fact, at } as RuntimeFact);
      const previousRunId = activeRun?.runId;
      try {
        switch (signal.kind) {
          case "session_started":
            lifecycle.onSessionStart({ sessionId, reason: signal.reason ?? "startup" });
            if (signal.settled?.isIdle === false) restingState = "unknown";
            emit({ type: "session.started", data: { reason: signal.reason ?? "startup", coverage: {
              agent: "settled", compaction: "public-hooks", prompts: "extension-ui-only", heartbeat: false,
            } } }); break;
          case "session_updated": emit({ type: "session.updated", data: {} }); break;
          case "state_snapshot": emit({ type: "state.snapshot", data: {} }); break;
          case "run_started":
            lifecycle.onAgentStart({ sessionId });
            if (!previousRunId && activeRun) emit({ type: "run.started", runId: activeRun.runId, data: { startObserved: true } });
            break;
          case "assistant_message":
            if (signal.assistant) lifecycle.onAssistantMessage({ sessionId, ...signal.assistant });
            if (!previousRunId && activeRun) emit({ type: "run.started", runId: activeRun.runId, data: { startObserved: false } });
            break;
          case "tool_finished": {
            if (!signal.tool) break;
            const failure = lifecycle.onToolExecutionEnd({ sessionId, ...signal.tool });
            if (failure) {
              update.toolFailure = failure;
              emit({ type: "tool.failed", ...(activeRun ? { runId: activeRun.runId } : { operationId: failure.runId }),
                data: { toolName: failure.toolName, count: failure.count } });
            }
            break;
          }
          case "run_settled": {
            const outcome = lifecycle.onSettled({ sessionId, isIdle: signal.settled?.isIdle ?? false, aborted: signal.settled?.aborted });
            if (outcome) { update.outcome = outcome; emit({ type: "run.settled", runId: outcome.runId, data: projectRun(outcome) }); }
            break;
          }
          case "compact_started": {
            const op = startCompaction(signal.compact?.reason ?? "manual");
            emit({ type: "compaction.started", operationId: op.operationId, ...(op.runId ? { runId: op.runId } : {}), data: { reason: op.reason } });
            break;
          }
          case "compact_completed": {
            const op = compaction ?? startCompaction(signal.compact?.reason ?? "manual");
            compaction = undefined;
            lastOperation = { operationId: op.operationId, reason: op.reason, status: "completed" };
            if (!activeRun) restingState = "done";
            emit({ type: "compaction.settled", operationId: op.operationId, ...(op.runId ? { runId: op.runId } : {}), data: { reason: op.reason, status: "completed" } });
            break;
          }
          case "compact_failed": {
            const compact = signal.compact;
            if (!compact) break;
            const info = lifecycle.onCompactFailed({ sessionId, ...compact });
            if (info) {
              update.compactFailure = info;
              emit({ type: "compaction.settled", operationId: info.operationId, ...(activeRun ? { runId: activeRun.runId } : {}),
                data: { reason: compact.reason, status: compact.aborted ? "aborted" : "failed",
                  ...(!compact.aborted && compact.errorMessage ? { errorMessage: sanitizeError(compact.errorMessage, 200) } : {}) } });
            }
            break;
          }
          case "ui_prompt_start":
            lifecycle.onUiPromptStart({ sessionId, kind: signal.uiPrompt?.kind ?? "custom" });
            if (signal.uiPrompt?.kind !== "custom" && signal.uiPrompt && prompts.length) {
              const prompt = prompts.at(-1)!;
              update.prompt = { ...prompt };
              emit({ type: "prompt.opened", promptId: prompt.promptId, ...(activeRun ? { runId: activeRun.runId } : {}), data: { kind: prompt.kind } });
            }
            break;
          case "ui_prompt_end": {
            const prompt = prompts.at(-1);
            lifecycle.onUiPromptEnd({ sessionId, kind: signal.uiPrompt?.kind ?? "custom" });
            if (prompt && signal.uiPrompt?.kind !== "custom" && signal.uiPrompt) emit({ type: "prompt.closed", promptId: prompt.promptId,
              ...(activeRun ? { runId: activeRun.runId } : {}), data: { kind: prompt.kind } });
            break;
          }
          case "session_shutdown":
            lifecycle.onShutdown(signal.shutdown?.reason ?? "quit");
            emit({ type: "session.ended", data: { reason: signal.shutdown?.reason ?? "quit" } }); break;
        }
      } finally { observedAt = undefined; }
      return update;
    },
  };
  return lifecycle;
}
