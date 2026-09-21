/**
 * Rule evaluation: pure functions with no IO, no clock and no random source.
 * Input is a `RunOutcome` (plus an optional `RunSummary`), output is a
 * `NotificationRequest | null`. Channel routing happens in `service`; this layer
 * only decides `level` and the `channels` allow-list.
 *
 * Three deliberate judgement calls:
 *  1. `aborted` and `unknown` are silent by default: a user pressing Esc is right
 *     there, and without a stop reason it is better to stay quiet than to misreport.
 *  2. `length` means "completed but truncated": the level is raised to at least
 *     `warning` and the title says so, because truncation is more notable than a
 *     plain completion.
 *  3. One run produces at most one notification: `evaluateSettlement` takes the
 *     first non-null of "result, then aggregated tool failures", and tool failure
 *     names are folded into the result body.
 *
 * Body content is metadata (identity label, cost, context usage) plus an optional
 * assistant excerpt; the excerpt is off by default because it can carry file
 * content or secrets.
 */

import { sanitize, sanitizeError } from "./log.ts";
import type {
  NotificationConfig,
  NotificationKind,
  NotificationRequest,
  NotifyLevel,
  RunOutcome,
  RunSummary,
  ToolFailure,
} from "./types.ts";

const LEVEL_RANK: Record<NotifyLevel, number> = { info: 0, warning: 1, error: 2 };

/**
 * Assistant excerpt length in code points. Deliberately a constant, not a setting:
 * ten characters are enough to serve as a hint, and an extra setting only adds
 * another way to configure something that has no effect.
 */
export const ASSISTANT_EXCERPT_CHARS = 10;

/** Truncation marker, so "we cut it" is distinguishable from "the model stopped mid-sentence". */
export const EXCERPT_ELLIPSIS = "…";

/** Hard cap for the leading identity label, so a very long name cannot fill the body. */
const IDENTITY_LABEL_CHARS = 40;

/** Context usage below 1% is noise ("context 0%"), not information. */
const MIN_CONTEXT_PERCENT = 1;

/** Higher of two levels; used to force at least `warning` for truncated output. */
function atLeast(level: NotifyLevel, floor: NotifyLevel): NotifyLevel {
  return LEVEL_RANK[level] >= LEVEL_RANK[floor] ? level : floor;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes}m${rest}s`;
}

function joinBody(parts: string[], config: NotificationConfig): string {
  return sanitize(parts.filter((part) => part !== "").join(" · "), config.content.maxMessageChars);
}

/**
 * Cost rendering.
 * Both "provider reports no usage" (undefined) and "reported as 0" (local model,
 * free quota) stay silent: printing `$0.0000` would wrongly suggest it was free.
 */
function formatUsd(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  // A single call is often a fraction of a cent: four decimals for small amounts, two for large.
  const text = value < 1 ? value.toFixed(4) : value.toFixed(2);
  return Number(text) <= 0 ? "" : `$${text}`;
}

/**
 * Leading identity label: session name first, else the project directory name.
 * Most users never run `/name`, so without the fallback this part of the body
 * would never appear for them. White-space-only values count as absent.
 */
function identityLabel(summary: RunSummary | undefined): string {
  const clean = (value: string | undefined): string =>
    typeof value === "string" ? sanitize(value, IDENTITY_LABEL_CHARS) : "";
  return clean(summary?.sessionName) || clean(summary?.projectName);
}

/**
 * Assistant excerpt: sanitize first, then truncate.
 * Order matters: assistant messages often start with newlines or indentation, and
 * truncating first would cut whitespace into the excerpt and then sanitize it away.
 *
 * Two refinements are applied only when the text is really truncated:
 *  1. drop punctuation left dangling by the cut;
 *  2. append an ellipsis so truncation is visible.
 */
function excerptOf(text: string | undefined): string {
  if (typeof text !== "string") return "";
  const points = [...sanitize(text, 200)];
  if (points.length <= ASSISTANT_EXCERPT_CHARS) return points.join("");
  const cut = points.slice(0, ASSISTANT_EXCERPT_CHARS).join("").replace(/[\s·,，、;；:：.。,、|丨/\\-]+$/, "");
  // Degenerate case: if the cut left only punctuation or whitespace, show the raw slice
  // rather than an excerpt that is nothing but an ellipsis.
  return cut === "" ? `${points.slice(0, ASSISTANT_EXCERPT_CHARS).join("")}${EXCERPT_ELLIPSIS}` : `${cut}${EXCERPT_ELLIPSIS}`;
}

/** Single constructor for requests, so `channels` is always copied and `meta` always carries ids. */
function request(input: {
  kind: NotificationKind;
  level: NotifyLevel;
  title: string;
  body: string;
  dedupeKey: string;
  channels: string[];
  sessionId: string;
  runId: string;
  durationMs?: number;
  maxChars: number;
  /** Optional per-request coalescing window (defaults to `config.coalesce.windowMs`). */
  coalesceWindowMs?: number;
}): NotificationRequest {
  return {
    level: input.level,
    kind: input.kind,
    title: sanitize(input.title, 60),
    body: sanitize(input.body, input.maxChars),
    dedupeKey: input.dedupeKey,
    ...(input.coalesceWindowMs !== undefined ? { coalesceWindowMs: input.coalesceWindowMs } : {}),
    channels: [...input.channels],
    meta: {
      sessionId: input.sessionId,
      runId: input.runId,
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      level: input.level,
    },
  };
}

function ruleOf(config: NotificationConfig, kind: NotificationKind) {
  if (kind === "run_completed") return config.rules.runCompleted;
  if (kind === "run_failed") return config.rules.runFailed;
  if (kind === "run_aborted") return config.rules.runAborted;
  if (kind === "tool_failed") return config.rules.toolFailed;
  if (kind === "compact_failed") return config.rules.compactFailed;
  return config.rules.waitingForUser;
}

/** "N tool failures: read, bash"; with `includeToolFailureNames=false` only the count is shown. */
export function describeToolFailures(failures: ToolFailure[], config: NotificationConfig): string {
  if (failures.length === 0) return "";
  const total = failures.reduce((sum, failure) => sum + failure.count, 0);
  if (!config.content.includeToolFailureNames) return `${total} 个工具失败`;
  const names = failures.map((failure) => failure.toolName).join(", ");
  return `${total} 个工具失败: ${names}`;
}

/**
 * Run outcome to notification request.
 * `aborted` and `unknown` are silent by default, but always through the config
 * switch: the rules themselves never hard-code a level or a channel.
 */
export function evaluateRunOutcome(
  input: { outcome: RunOutcome; summary?: RunSummary },
  config: NotificationConfig,
): NotificationRequest | null {
  const { outcome } = input;
  const kind: NotificationKind | undefined =
    outcome.status === "completed" ? "run_completed"
      : outcome.status === "failed" ? "run_failed"
        : outcome.status === "aborted" ? "run_aborted"
          : undefined;
  if (!kind) return null;

  const rule = ruleOf(config, kind);
  if (!rule.enabled) return null;

  const truncated = outcome.stopReason === "length";
  const title =
    kind === "run_completed" ? (truncated ? "任务完成（输出被截断）" : "任务完成")
      : kind === "run_failed" ? "任务失败"
        : "任务已取消";

  const parts: string[] = [];
  // Order is reading priority: which task, then the result, then cost and the excerpt
  // the user may not want.
  if (config.content.includeSessionLabel) {
    const label = identityLabel(input.summary);
    if (label !== "") parts.push(`[${label}]`);
  }
  if (kind === "run_failed" && outcome.errorMessage) {
    parts.push(sanitizeError(outcome.errorMessage, config.content.maxMessageChars));
  }
  if (config.content.includeDuration && outcome.durationMs > 0) {
    parts.push(`用时 ${formatDuration(outcome.durationMs)}`);
  }
  const failures = describeToolFailures(outcome.toolFailures, config);
  if (failures !== "") parts.push(kind === "run_completed" ? `但 ${failures}` : failures);
  if (config.content.includeCost) {
    const cost = formatUsd(outcome.costUsd);
    if (cost !== "") {
      const cumulative = formatUsd(input.summary?.cumulativeCostUsd);
      parts.push(cumulative === "" || cumulative === cost ? `成本 ${cost}` : `成本 ${cost}（累计 ${cumulative}）`);
    }
    const percent = input.summary?.contextPercent;
    if (typeof percent === "number" && Number.isFinite(percent) && percent >= MIN_CONTEXT_PERCENT) {
      parts.push(`上下文 ${Math.min(100, Math.round(percent))}%`);
    }
  }
  if (config.content.includeAssistantExcerpt) {
    const excerpt = excerptOf(outcome.assistantExcerpt);
    if (excerpt !== "") parts.push(excerpt);
  }

  return request({
    kind,
    // `length` is not an error, but "output was truncated" must stand out more than a plain completion.
    level: truncated ? atLeast(rule.level, "warning") : rule.level,
    title,
    body: joinBody(parts, config),
    dedupeKey: `${outcome.sessionId}:${outcome.runId}:${kind}`,
    channels: rule.channels,
    sessionId: outcome.sessionId,
    runId: outcome.runId,
    durationMs: outcome.durationMs,
    maxChars: config.content.maxMessageChars,
  });
}

/**
 * Tool failures.
 *
 * - `aggregate` (default): used only when this run produced no result notification
 *   (`evaluateSettlement` guarantees this); otherwise the failure names are already in
 *   the result body and a second message would be noise.
 * - `immediate`: fires as soon as one tool reaches `threshold` failures, because nobody
 *   nobody is watching the output during a long task. The dedupe key includes the tool name,
 *   so one tool notifies at most once per run.
 */
export function evaluateToolFailure(
  input: {
    sessionId: string;
    runId: string;
    durationMs?: number;
    toolFailures: ToolFailure[];
    /** Full summary for this run so far; `immediate` mode collapses parallel failures with it. */
    accumulated?: ToolFailure[];
    /** Only set in `immediate` mode: the tool that just failed. */
    toolName?: string;
  },
  config: NotificationConfig,
): NotificationRequest | null {
  const rule = config.rules.toolFailed;
  if (!rule.enabled) return null;
  if (input.toolFailures.length === 0) return null;
  const immediate = rule.mode === "immediate";
  // `immediate` only fires at the moment of failure; reaching settle means it already fired.
  if (immediate && input.toolName === undefined) return null;

  const failures = immediate
    ? (input.accumulated ?? input.toolFailures).filter((failure) => failure.count > 0)
    : input.toolFailures;
  if (failures.length === 0) return null;
  if (!immediate && !satisfiesAggregate(input.toolFailures, rule)) return null;

  const body = describeToolFailures(failures, config);
  if (body === "") return null;

  return request({
    kind: "tool_failed",
    level: rule.level,
    title: immediate ? `工具 ${input.toolName} 失败` : "工具失败",
    body,
    dedupeKey: immediate
      ? `${input.sessionId}:${input.runId}:tool_failed:${input.toolName}`
      : `${input.sessionId}:${input.runId}:tool_failed`,
    // `immediate` mode: a wider window collapses parallel tool failures of the same run.
    ...(immediate ? { coalesceWindowMs: config.coalesce.toolFailureWindowMs } : {}),
    channels: rule.channels,
    sessionId: input.sessionId,
    runId: input.runId,
    durationMs: input.durationMs,
    maxChars: config.content.maxMessageChars,
  });
}

function satisfiesAggregate(
  failures: ToolFailure[],
  rule: NotificationConfig["rules"]["toolFailed"],
): boolean {
  const total = failures.reduce((sum, failure) => sum + failure.count, 0);
  return total >= rule.threshold;
}

/**
 * Picks at most one request out of every candidate for a run.
 *
 * Priority order:
 *   1. the run result (failed / aborted / completed) - it carries the most information,
 *      with tool failure names already folded into the body;
 *   2. aggregated tool failures - only as a fallback when the result is not announced
 *      (for example `runCompleted` is off and aborted runs stay silent).
 *
 * Compact failures are not in this sequence: they are delivered the moment
 * `session_compact_failed` arrives, because a manual `/compact` has no run to settle.
 */
export function evaluateSettlement(
  input: { outcome: RunOutcome; summary?: RunSummary },
  config: NotificationConfig,
): NotificationRequest | null {
  return evaluateRunOutcome(input, config)
    ?? evaluateToolFailure(
      {
        sessionId: input.outcome.sessionId,
        runId: input.outcome.runId,
        durationMs: input.outcome.durationMs,
        toolFailures: input.outcome.toolFailures,
      },
      config,
    );
}

/**
 * `session_compact_failed` to notification (error level by default).
 *
 * `aborted === true` means the user cancelled compaction, so nothing is sent.
 * The dedupe key carries `seq` because every compaction failure is its own event and
 * must not be swallowed by the service's `seen` set; the cooldown window handles repetition.
 */
export function evaluateCompactFailure(
  input: {
    sessionId: string;
    runId: string;
    reason: string;
    errorMessage?: string;
    aborted: boolean;
    seq: number;
  },
  config: NotificationConfig,
): NotificationRequest | null {
  const rule = config.rules.compactFailed;
  if (!rule.enabled) return null;
  if (input.aborted) return null;

  const parts: string[] = [`触发原因 ${input.reason}`];
  if (input.errorMessage) parts.push(sanitizeError(input.errorMessage, config.content.maxMessageChars));

  return request({
    kind: "compact_failed",
    level: rule.level,
    title: "上下文压缩失败",
    body: joinBody(parts, config),
    dedupeKey: `${input.sessionId}:compact_failed:${input.seq}`,
    channels: rule.channels,
    sessionId: input.sessionId,
    runId: input.runId,
    maxChars: config.content.maxMessageChars,
  });
}

/**
 * `ui_prompt_start` to "Pi is waiting for you". Off by default because it overlaps
 * heavily with `run_completed`.
 *
 * The allow-list comes from config and `custom` is filtered out during config
 * validation, so it can never be enabled by editing the file. Titles are sanitized
 * before they reach the output.
 */
export function evaluateWaitingForUser(
  input: { sessionId: string; runId: string; kind: string; title?: string; seq: number },
  config: NotificationConfig,
): NotificationRequest | null {
  const rule = config.rules.waitingForUser;
  if (!rule.enabled) return null;
  if (input.kind === "custom") return null; // Hard exclusion: never depends on configuration.
  if (!rule.kinds.includes(input.kind as (typeof rule.kinds)[number])) return null;

  const body = input.title && input.title.trim() !== ""
    ? `等待你确认：${input.title}`
    : `Pi 正在等待你输入（${input.kind}）`;

  return request({
    kind: "waiting_for_user",
    level: rule.level,
    title: "轮到你输入",
    body,
    dedupeKey: `${input.sessionId}:waiting_for_user:${input.seq}`,
    channels: rule.channels,
    sessionId: input.sessionId,
    runId: input.runId,
    maxChars: config.content.maxMessageChars,
  });
}
