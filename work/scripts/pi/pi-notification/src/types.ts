/**
 * Shared contracts; the only cross-layer type source in this plugin:
 * lifecycle / rules -> NotificationRequest -> service -> Notifier[]
 * Deliberately free of Pi `ctx` / `SessionManager` references: a stale session's
 * context must never be able to leak into these structures.
 */

export type NotifyLevel = "info" | "warning" | "error";

export type LogLevel = NotifyLevel | "debug";

export type RunStatus = "completed" | "failed" | "aborted" | "unknown";

/** Mirrors Pi's assistant `stopReason` values. */
export type AssistantStopReason =
  | "pending"
  | "stop"
  | "length"
  | "toolUse"
  | "error"
  | "aborted"
  | "deferred";

export type ShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

/** Stable rule identity: dedupe, cooldown and log keys use this, never the message text. */
export type NotificationKind =
  | "run_completed"
  | "run_failed"
  | "run_aborted"
  | "tool_failed"
  | "compact_failed"
  | "waiting_for_user";

/**
 * Pi's `ui_prompt_*` kinds. `custom` is excluded everywhere: the loader and the
 * progress UI emit it as well, so it does not mean the user is being awaited.
 */
export type UIPromptKind = "select" | "confirm" | "input" | "editor" | "custom";

/** How tool failures are announced. */
export type ToolFailureMode = "aggregate" | "immediate";

export type SignalKind =
  | "run_started"
  | "assistant_message"
  | "tool_finished"
  | "run_settled"
  | "compact_failed"
  | "ui_prompt_start"
  | "ui_prompt_end"
  | "session_shutdown";

export interface SignalEvent {
  kind: SignalKind;
  sessionId: string;
  /** epoch ms, from the injected clock */
  at: number;
  assistant?: {
    stopReason: AssistantStopReason | undefined;
    errorMessage?: string;
  };
  tool?: {
    toolCallId: string;
    toolName: string;
    isError: boolean;
  };
  uiPrompt?: {
    kind: UIPromptKind;
    title?: string;
  };
  compact?: {
    reason: "manual" | "threshold" | "overflow";
    errorMessage?: string;
    aborted: boolean;
  };
  settled?: {
    /** Pi semantics: idle unless another extension has started a new run. */
    isIdle: boolean;
  };
  shutdown?: {
    reason: ShutdownReason;
  };
}

export interface ToolFailure {
  toolName: string;
  count: number;
}

export interface RunOutcome {
  sessionId: string;
  /** Monotonic per instance; part of dedupe keys. */
  runId: string;
  status: RunStatus;
  startedAt: number;
  durationMs: number;
  /** Final assistant stopReason; undefined when it cannot be determined. */
  stopReason?: AssistantStopReason;
  /** Already redacted. */
  errorMessage?: string;
  toolFailures: ToolFailure[];
  compactFailed?: boolean;
  /** Cost accumulated from assistant usage in this run; undefined when usage is never reported. */
  costUsd?: number;
  /** Leading characters of the last assistant text (length-capped upstream, not yet sanitized). */
  assistantExcerpt?: string;
}

/** Accumulated result for a failing `tool_execution_end` (produced by lifecycle, consumed by rules). */
export interface ToolFailureEvent {
  sessionId: string;
  runId: string;
  toolName: string;
  /** Failure count for this tool, deduplicated per tool name within the run. */
  count: number;
  /** All failures seen so far in this run; `immediate` mode renders from this list. */
  accumulated: ToolFailure[];
}

export interface RunSummary {
  runStatus: RunStatus;
  durationMs: number;
  toolFailures: ToolFailure[];
  /** Session name from `/name`; undefined when the session is unnamed. */
  sessionName?: string;
  /** Basename of `ctx.cwd`; fallback label when the session has no name. */
  projectName?: string;
  /** Cost accumulated in this instance for the session; reset by `/reload` or a session change. */
  cumulativeCostUsd?: number;
  contextPercent?: number;
}

export interface NotificationRequest {
  level: NotifyLevel;
  kind: NotificationKind;
  title: string;
  body: string;
  /** Stable key used for dedupe and coalescing. */
  dedupeKey: string;
  /**
   * Per-request coalescing window; defaults to `config.coalesce.windowMs`.
   * `immediate` tool failures pass `coalesce.toolFailureWindowMs` so parallel
   * failures still collapse into one message.
   */
  coalesceWindowMs?: number;
  /** Provider ids to deliver to. */
  channels: string[];
  /** Delivery and logging metadata only; never the raw prompt or full reply. */
  meta: {
    sessionId: string;
    runId: string;
    cwd?: string;
    durationMs?: number;
    level: NotifyLevel;
  };
}

/** Pure function, no IO. */
export type RuleEvaluator = (
  input: { outcome: RunOutcome; summary?: RunSummary },
  config: NotificationConfig,
) => NotificationRequest | null;

export interface Notifier {
  readonly id: string;
  readonly type: string;
  /** Validates its own options; a returned string means unusable. Must not throw. */
  validate(options: unknown): string | undefined;
  /** Optional channel-specific payload; falls back to the generic title/body. */
  format?(req: NotificationRequest): unknown;
  /** One delivery attempt. Must honour `signal` and must not retry: retries live in a decorator. */
  send(req: NotificationRequest, signal: AbortSignal): Promise<void>;
  /** Idempotent release; must not depend on Pi's `ctx`. */
  dispose(): Promise<void>;
}

export type NotifierFactory = (id: string, options: unknown) => Notifier;

export interface NotifierRegistry {
  register(type: string, factory: NotifierFactory): void;
  /** Unregistered or invalid factories degrade to a NoopNotifier so callers need no null checks. */
  create(id: string, type: string, options: unknown): Notifier;
}

export interface DeliveryResult {
  providerId: string;
  ok: boolean;
  attempts: number;
  /** Already redacted. */
  error?: string;
  durationMs: number;
}

export interface NotificationService {
  /**
   * Enqueues and returns immediately; never awaits the network.
   * `bypassFilters` is for self-tests such as `/notify test`: it skips quiet hours,
   * coalescing and cooldown but still honours dedupe and thresholds, so a missing
   * self-test notification cannot be mistaken for a broken channel.
   */
  submit(req: NotificationRequest, options?: { bypassFilters?: boolean }): void;
  /** For shutdown paths only; bounded by `timeoutMs`. */
  flush(timeoutMs: number): Promise<void>;
  /** Drops queued and in-flight deliveries (reload/new/resume/fork). */
  discardPending(reason: string): void;
  /** Idempotent. */
  dispose(): Promise<void>;
  /** Read-only counters for `/notify status`; never triggers a delivery. */
  snapshot(): ServiceSnapshot;
  /** Evaluated with the injected clock, in local time; level exceptions are applied elsewhere. */
  isQuietHours(): boolean;
}

/** In-memory runtime counters for `/notify status`; never persisted. */
export interface ServiceSnapshot {
  queued: number;
  active: number;
  delivered: number;
  failed: number;
  deduped: number;
  dropped: number;
  /** Notifications dropped by the per-run coalescing window. */
  coalesced: number;
  /** Notifications dropped by the per-kind cooldown window. */
  cooled: number;
  lastAttemptAt?: number;
  lastOkAt?: number;
  lastError?: string;
}

export interface RuleConfig {
  enabled: boolean;
  level: NotifyLevel;
  channels: string[];
}

export interface ToolFailureRuleConfig extends RuleConfig {
  mode: ToolFailureMode;
  /** In `immediate` mode: notify once a tool reaches this many failures. */
  threshold: number;
}

export interface WaitingForUserRuleConfig extends RuleConfig {
  /** Allowed prompt kinds; `custom` can never appear here. */
  kinds: UIPromptKind[];
}

export interface ProviderConfig {
  id: string;
  type: string;
  enabled: boolean;
  options: Record<string, unknown>;
}

export interface NotificationConfig {
  version: 1;
  enabled: boolean;
  /** Global threshold: notifications below this level are never delivered. */
  minLevel: NotifyLevel;
  rules: {
    runCompleted: RuleConfig;
    runFailed: RuleConfig;
    runAborted: RuleConfig;
    toolFailed: ToolFailureRuleConfig;
    compactFailed: RuleConfig;
    waitingForUser: WaitingForUserRuleConfig;
  };
  /** Coalescing and cooldown; a value of 0 disables that filter. */
  coalesce: {
    /** At most one notification per logical run (sessionId + runId). */
    windowMs: number;
    /** Aggregation window for `immediate` tool failures. */
    toolFailureWindowMs: number;
    /** Minimum interval between two enqueues of the same kind. */
    cooldownMs: number;
  };
  /** Local time, half-open interval, may wrap past midnight; start=end means all day. */
  quietHours: {
    enabled: boolean;
    start: string;
    end: string;
    exceptLevels: NotifyLevel[];
  };
  content: {
    includeDuration: boolean;
    includeToolFailureNames: boolean;
    /** Leading identity label: session name, else project directory name, else omitted. */
    includeSessionLabel: boolean;
    /** Leading characters of the final assistant reply; off by default (may carry file content or secrets). */
    includeAssistantExcerpt: boolean;
    /** Cost (this run and session total) plus context usage percentage. */
    includeCost: boolean;
    maxMessageChars: number;
  };
  delivery: {
    timeoutMs: number;
    maxRetries: number;
    concurrency: number;
    queueLimit: number;
    /** Consecutive failures before a channel is tripped open; 0 disables the breaker. */
    circuitBreakerFailures: number;
  };
  providers: ProviderConfig[];
  /** Maximum wait budget inside `session_shutdown(reason=quit)`; the exit path must stay short. */
  shutdownFlushMs: number;
}

export interface Logger {
  log(level: LogLevel, message: string, meta?: Record<string, unknown>): void;
  /** Structured record, written only when `PI_NOTIFY_LOG_FILE` is set; used by regression scripts. */
  record(entry: Record<string, unknown>): void;
}

export interface Deps {
  now(): number;
  log: Logger;
}
