/** Rule selection and human notification content. The service owns delivery and filters. */
import { notificationTitle } from "./content.ts";
import { redact, singleLine } from "./log.ts";
import { LEVEL_RANK } from "./types.ts";
import type {
  CompactionReason, NotificationConfig, NotificationRequest, NotifyLevel, RuleConfig,
  RunOutcome, RunSummary, SessionLabels, ToolFailure, UIPromptKind,
} from "./types.ts";

export function resolveChannels(config: NotificationConfig, rule: Pick<RuleConfig, "channels">): string[] {
  return [...(rule.channels === "inherit" ? config.channels : rule.channels)];
}

const toolFailureCount = (failures: ToolFailure[]) => failures.reduce((sum, failure) => sum + failure.count, 0);
const describeToolFailures = (count: number) => count > 0 ? `工具执行失败 ${count} 次` : "";

function settlementContent({ outcome, summary }: { outcome: RunOutcome; summary?: RunSummary }, config: NotificationConfig) {
  const percent = summary?.contextPercent;
  return {
    labels: summary,
    durationMs: outcome.durationMs,
    startObserved: outcome.startObserved,
    costUsd: outcome.costUsd,
    ...(config.content.mode === "full" ? { details: {
      ...(typeof percent === "number" && Number.isFinite(percent) && percent >= 1
        ? { contextPercent: Math.min(100, Math.round(percent)) } : {}),
      finalReply: outcome.finalReply ?? null,
    } } : {}),
  };
}

function request(input: {
  kind: NotificationRequest["kind"];
  level: NotifyLevel;
  status: string;
  body: string;
  dedupeKey: string;
  channels: string[];
  sessionId: string;
  runId: string;
  labels?: SessionLabels;
  durationMs?: number;
  startObserved?: boolean;
  costUsd?: number;
  details?: NotificationRequest["details"];
  coalesceWindowMs?: number;
}): NotificationRequest {
  return {
    level: input.level,
    kind: input.kind,
    title: notificationTitle(input.status, input.labels, input.startObserved === false ? undefined : input.durationMs, input.costUsd),
    body: input.body,
    ...(input.details ? { details: input.details } : {}),
    dedupeKey: input.dedupeKey,
    ...(input.coalesceWindowMs !== undefined ? { coalesceWindowMs: input.coalesceWindowMs } : {}),
    channels: input.channels,
    meta: {
      sessionId: input.sessionId,
      runId: input.runId,
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      level: input.level,
    },
  };
}

export function evaluateRunOutcome(
  input: { outcome: RunOutcome; summary?: RunSummary },
  config: NotificationConfig,
): NotificationRequest | null {
  const { outcome } = input;
  if (outcome.status === "unknown") return null;
  const hitOutputLimit = outcome.stopReason === "length";
  const truncated = outcome.status === "completed" && hitOutputLimit;
  const { kind, status, rule } = outcome.status === "completed"
    ? { kind: "run_completed", status: truncated ? "输出已截断" : "已完成", rule: config.rules.runCompleted } as const
    : outcome.status === "failed"
      ? { kind: "run_failed", status: "运行失败", rule: config.rules.runFailed } as const
      : { kind: "run_aborted", status: "已中止", rule: config.rules.runAborted } as const;
  if (!rule.enabled) return null;

  const body = [
    outcome.errorMessage && outcome.status === "failed" ? `失败原因：${singleLine(outcome.errorMessage)}` : "",
    truncated ? "已达到模型输出上限" : "",
    outcome.compactionError ? "上下文压缩失败" : "",
    describeToolFailures(toolFailureCount(outcome.toolFailures)),
  ].filter(Boolean).join("；");

  return request({
    kind,
    level: hitOutputLimit && LEVEL_RANK[rule.level] < LEVEL_RANK.warning ? "warning" : rule.level,
    status,
    body,
    dedupeKey: `${outcome.sessionId}:${outcome.runId}:${kind}`,
    channels: resolveChannels(config, rule),
    sessionId: outcome.sessionId,
    runId: outcome.runId,
    ...settlementContent(input, config),
  });
}

/** Immediate failures retain the per-tool dedupe key, but never list tool names in the display. */
export function evaluateToolFailure(
  input: {
    sessionId: string;
    runId: string;
    labels?: SessionLabels;
    toolFailures: ToolFailure[];
    accumulated?: ToolFailure[];
    toolName?: string;
    settlement?: { outcome: RunOutcome; summary?: RunSummary };
  },
  config: NotificationConfig,
): NotificationRequest | null {
  const rule = config.rules.toolFailed;
  if (!rule.enabled || input.toolFailures.length === 0) return null;
  const immediate = rule.mode === "immediate";
  if (immediate && input.toolName === undefined) return null;
  const count = toolFailureCount(immediate ? input.accumulated ?? input.toolFailures : input.toolFailures);
  if (count <= 0 || (!immediate && count < rule.threshold)) return null;

  return request({
    kind: "tool_failed",
    level: rule.level,
    status: "工具执行失败",
    body: `累计失败 ${count} 次`,
    dedupeKey: immediate
      ? `${input.sessionId}:${input.runId}:tool_failed:${input.toolName}`
      : `${input.sessionId}:${input.runId}:tool_failed`,
    ...(immediate ? { coalesceWindowMs: config.coalesce.toolFailureWindowMs } : {}),
    channels: resolveChannels(config, rule),
    sessionId: input.sessionId,
    runId: input.runId,
    labels: input.labels,
    ...(input.settlement ? settlementContent(input.settlement, config) : {}),
  });
}

/** At most one notification per settlement: run outcome first, aggregated tool failures as fallback. */
export function evaluateSettlement(
  input: { outcome: RunOutcome; summary?: RunSummary },
  config: NotificationConfig,
): NotificationRequest | null {
  return evaluateRunOutcome(input, config)
    ?? evaluateToolFailure({
      sessionId: input.outcome.sessionId,
      runId: input.outcome.runId,
      toolFailures: input.outcome.toolFailures,
      settlement: input,
    }, config);
}

const COMPACTION_TRIGGERS: Record<CompactionReason, string> = {
  manual: "手动压缩", threshold: "达到压缩阈值", overflow: "上下文溢出",
};

/** Standalone compaction failures have no agent settlement; user-cancelled compaction stays silent. */
export function evaluateCompactFailure(
  input: { sessionId: string; runId: string; labels?: SessionLabels; reason: CompactionReason; errorMessage?: string; aborted: boolean; seq: number },
  config: NotificationConfig,
): NotificationRequest | null {
  const rule = config.rules.compactFailed;
  if (!rule.enabled || input.aborted) return null;

  const error = singleLine(redact(input.errorMessage ?? ""));
  const trigger = COMPACTION_TRIGGERS[input.reason];
  return request({
    kind: "compact_failed",
    level: rule.level,
    status: "上下文压缩失败",
    body: [trigger, error && `失败原因：${error}`].filter(Boolean).join("；"),
    dedupeKey: `${input.sessionId}:compact_failed:${input.seq}`,
    channels: resolveChannels(config, rule),
    sessionId: input.sessionId,
    runId: input.runId,
    labels: input.labels,
  });
}

export function evaluateWaitingForUser(
  input: { sessionId: string; runId: string; labels?: SessionLabels; kind: UIPromptKind; title?: string; seq: number },
  config: NotificationConfig,
): NotificationRequest | null {
  const rule = config.rules.waitingForUser;
  if (!rule.enabled || input.kind === "custom" || !rule.kinds.includes(input.kind)) return null;

  return request({
    kind: "waiting_for_user",
    level: rule.level,
    status: "等待输入",
    body: singleLine(input.title ?? ""),
    dedupeKey: `${input.sessionId}:waiting_for_user:${input.seq}`,
    channels: resolveChannels(config, rule),
    sessionId: input.sessionId,
    runId: input.runId,
    labels: input.labels,
  });
}
