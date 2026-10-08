/** Small coordinator, not a bus: one state machine and two independent output projections. */
import { createLifecycle } from "./lifecycle.ts";
import { createEnvelope } from "./messages.ts";
import { createMessagePublisher, type MessageSender } from "./api.ts";
import { evaluateCompactFailure, evaluateSettlement, evaluateToolFailure, evaluateWaitingForUser } from "./rules.ts";
import type { Logger, MessagePublisher, NotificationConfig, NotificationService, RunSummary, ShutdownReason, SignalEvent } from "./types.ts";

export interface RuntimeOptions {
  config: NotificationConfig;
  service: NotificationService;
  log: Logger;
  now(): number;
  instanceToken: string;
  isSilenced(): boolean;
  sender?: MessageSender;
}

export function createRuntime(options: RuntimeOptions) {
  const { config, service, log, now, instanceToken, isSilenced } = options;
  const lifecycle = createLifecycle(options);
  let publisher: MessagePublisher | undefined;
  let signature = "";
  let seq = 0;
  let compactSeq = 0;
  let promptSeq = 0;
  let labels: SignalEvent["labels"] = {};

  function publish(signal: SignalEvent) {
    const update = lifecycle.observe(signal);
    const snapshot = lifecycle.snapshot();
    for (const fact of update.facts) {
      seq += 1; // Observation sequence, including facts skipped while external output is disabled.
      publisher?.publish(createEnvelope({ streamId: instanceToken, seq, sessionId: signal.sessionId,
        fact, snapshot, labels, includeLabels: config.api.includeLabels }));
    }
    return update;
  }
  function updateConfig(announce = true): void {
    if (lifecycle.isStale()) return;
    const enabled = config.api?.enabled === true && !isSilenced();
    const next = enabled ? JSON.stringify(config.api) : "";
    if (next === signature && (!enabled || publisher?.snapshot().enabled)) return;
    publisher?.dispose(); publisher = undefined; signature = next;
    if (enabled) publisher = createMessagePublisher({ config: structuredClone(config.api), log, sender: options.sender });
    const sessionId = lifecycle.currentSessionId();
    if (announce && publisher && sessionId) publish({ kind: "state_snapshot", sessionId, at: now() });
  }

  return {
    lifecycle,
    snapshot: () => lifecycle.snapshot(),
    apiSnapshot: () => publisher?.snapshot() ?? { enabled: false, queued: 0, active: 0, delivered: 0, failed: 0, dropped: 0 },
    updateConfig,
    handle(signal: SignalEvent): void {
      if (lifecycle.isStale()) return;
      const sessionId = lifecycle.currentSessionId();
      if (sessionId && sessionId !== signal.sessionId) return;
      if (signal.labels) labels = { ...signal.labels };
      updateConfig(signal.kind !== "session_started");
      const update = publish(signal);
      if (isSilenced() || !config.enabled) return;
      if (update.outcome) {
        const outcome = update.outcome;
        const summary: RunSummary = {
          runStatus: outcome.status, durationMs: outcome.durationMs, toolFailures: outcome.toolFailures,
          ...labels, cumulativeCostUsd: lifecycle.sessionCostUsd(), contextPercent: signal.contextPercent,
        };
        const request = evaluateSettlement({ outcome, summary }, config);
        if (request) service.submit(request);
      }
      const failure = update.toolFailure;
      if (failure && config.rules.toolFailed.mode === "immediate" && failure.count >= config.rules.toolFailed.threshold) {
        const request = evaluateToolFailure({ ...failure, toolFailures: [{ toolName: failure.toolName, count: failure.count }] }, config);
        if (request) service.submit(request);
      }
      if (update.compactFailure && signal.compact) {
        const request = evaluateCompactFailure({ ...update.compactFailure, ...signal.compact, seq: ++compactSeq }, config);
        if (request) service.submit(request);
      }
      if (update.prompt) {
        const request = evaluateWaitingForUser({ sessionId: signal.sessionId, runId: update.prompt.promptId,
          kind: update.prompt.kind, title: signal.uiPrompt?.title, seq: ++promptSeq }, config);
        if (request) service.submit(request);
      }
    },
    async shutdown(reason: ShutdownReason): Promise<void> {
      if (lifecycle.isStale()) return;
      const sessionId = lifecycle.currentSessionId();
      try {
        updateConfig(false); // Respect a force-silence/environment change even on the last hook.
        if (sessionId) publish({ kind: "session_shutdown", sessionId, at: now(), shutdown: { reason } });
        else lifecycle.onShutdown(reason);
        if (reason === "quit") {
          // Both waits run concurrently inside ONE budget; neither can hold the other up.
          await Promise.all([service.flush(config.shutdownFlushMs), publisher?.flush(config.shutdownFlushMs)]);
        } else service.discardPending(reason);
      } finally {
        publisher?.dispose(); publisher = undefined; signature = "";
        await service.dispose();
      }
    },
  };
}
