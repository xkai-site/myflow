/** Pure wire projection. Explicit field whitelists, never spreading host/outcome objects. */
import { sanitize, sanitizeError } from "./log.ts";
import type { MachineRun, MessageEnvelope, RunOutcome, RuntimeFact, RuntimeSnapshot, SignalEvent } from "./types.ts";

const knownNumber = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export function projectRun(run: MachineRun | RunOutcome): MachineRun {
  const startObserved = run.startObserved !== false;
  return {
    runId: run.runId, status: run.status, startObserved,
    ...(startObserved && knownNumber(run.startedAt) ? { startedAt: run.startedAt } : {}),
    ...(startObserved && knownNumber(run.durationMs) ? { durationMs: run.durationMs } : {}),
    ...(run.stopReason ? { stopReason: run.stopReason } : {}),
    ...(run.status === "failed" && run.errorMessage ? { errorMessage: sanitizeError(run.errorMessage, 200) } : {}),
    toolFailures: run.toolFailures.slice(0, 100).map(({ toolName, count }) => ({ toolName: sanitizeError(toolName, 100), count })),
    ...(run.compactFailed ? { compactFailed: true } : {}),
    ...(knownNumber(run.costUsd) ? { costUsd: run.costUsd } : {}),
  };
}
function projectSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  const run = snapshot.activeRun;
  return {
    state: snapshot.state,
    ...(run ? { activeRun: { runId: run.runId, startObserved: run.startObserved,
      ...(run.startObserved && knownNumber(run.startedAt) ? { startedAt: run.startedAt } : {}) } } : {}),
    ...(snapshot.lastRun ? { lastRun: projectRun(snapshot.lastRun) } : {}),
    ...(snapshot.compaction ? { compaction: { operationId: snapshot.compaction.operationId, reason: snapshot.compaction.reason } } : {}),
    ...(snapshot.lastOperation ? { lastOperation: { operationId: snapshot.lastOperation.operationId,
      reason: snapshot.lastOperation.reason, status: snapshot.lastOperation.status } } : {}),
    prompts: snapshot.prompts.map(({ promptId, kind }) => ({ promptId, kind })),
    ...(knownNumber(snapshot.sessionCostUsd) ? { sessionCostUsd: snapshot.sessionCostUsd } : {}),
  };
}
function projectData(fact: RuntimeFact): MessageEnvelope["data"] {
  switch (fact.type) {
    case "session.started": return { reason: sanitize(fact.data.reason, 40), coverage: {
      agent: "settled", compaction: "public-hooks", prompts: "extension-ui-only", heartbeat: false,
    } };
    case "session.ended": return { reason: fact.data.reason };
    case "run.started": return { startObserved: fact.data.startObserved };
    case "run.settled": return projectRun(fact.data);
    case "tool.failed": return { toolName: sanitizeError(fact.data.toolName, 100), count: fact.data.count };
    case "compaction.started": return { reason: fact.data.reason };
    case "compaction.settled": return { reason: fact.data.reason, status: fact.data.status,
      ...(fact.data.status === "failed" && fact.data.errorMessage ? { errorMessage: sanitizeError(fact.data.errorMessage, 200) } : {}) };
    case "prompt.opened": case "prompt.closed": return { kind: fact.data.kind };
    case "session.updated": case "state.snapshot": return {};
  }
}
export function createEnvelope(input: {
  streamId: string; seq: number; sessionId: string; fact: RuntimeFact; snapshot: RuntimeSnapshot;
  labels?: SignalEvent["labels"]; includeLabels?: boolean;
}): MessageEnvelope {
  if (!Number.isSafeInteger(input.seq) || input.seq < 1) throw new Error("message seq 必须是正整数");
  const { streamId, seq, sessionId, fact } = input;
  const labels = input.includeLabels ? {
    ...(input.labels?.sessionName ? { sessionName: sanitizeError(input.labels.sessionName, 80) } : {}),
    ...(input.labels?.projectName ? { projectName: sanitizeError(input.labels.projectName, 80) } : {}),
  } : undefined;
  return {
    source: "pi-notification", schemaVersion: 1, type: fact.type,
    eventId: `${streamId}:${seq}`, streamId, seq, sessionId, occurredAt: fact.at,
    ...(fact.runId ? { runId: fact.runId } : {}),
    ...(fact.operationId ? { operationId: fact.operationId } : {}),
    ...(fact.promptId ? { promptId: fact.promptId } : {}),
    data: projectData(fact), snapshot: projectSnapshot(input.snapshot),
    ...(labels && Object.keys(labels).length ? { labels } : {}),
  } as MessageEnvelope;
}
