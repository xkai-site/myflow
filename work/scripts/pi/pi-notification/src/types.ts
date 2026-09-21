/**
 * 共享契约（对应设计 §11 / §17.4）。
 *
 * 本文件是唯一的跨层契约来源：
 *   lifecycle / rules  ->  NotificationRequest  ->  service  ->  Notifier[]
 * 不携带任何 `ctx` / `SessionManager` / Pi 类型引用，避免旧实例语境泄漏。
 */

// ---------------------------------------------------------------------------
// 等级与基本枚举
// ---------------------------------------------------------------------------

export type NotifyLevel = "info" | "warning" | "error";

export type LogLevel = NotifyLevel | "debug";

export type RunStatus = "completed" | "failed" | "aborted" | "unknown";

/** 与 Pi 的 assistant stopReason 对齐（`O/docs/session-format.md`）。 */
export type AssistantStopReason =
  | "pending"
  | "stop"
  | "length"
  | "toolUse"
  | "error"
  | "aborted"
  | "deferred";

export type ShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

/** 稳定的规则标识；用它做去重/冷却/日志键，**不用文案做键**。 */
export type NotificationKind =
  | "run_completed"
  | "run_failed"
  | "run_aborted"
  | "tool_failed"
  | "compact_failed"
  | "waiting_for_user";

/**
 * Pi 的 `ui_prompt_*` kind（`O/dist/core/extensions/types.d.ts`）。
 * `custom` **永久排除**（§18.5 修订 1：加载器也会触发它，与用户输入无关）。
 */
export type UIPromptKind = "select" | "confirm" | "input" | "editor" | "custom";

/** 工具失败的通知策略（设计 §12.3）。 */
export type ToolFailureMode = "aggregate" | "immediate";

// ---------------------------------------------------------------------------
// index.ts 产出的最小事实（不含 ctx）
// ---------------------------------------------------------------------------

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
  /** epoch ms（由注入 clock 提供） */
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
    /** 官方语义：是否真的空闲（除非另一扩展又启动了新 run） */
    isIdle: boolean;
  };
  shutdown?: {
    reason: ShutdownReason;
  };
}

// ---------------------------------------------------------------------------
// 运行判定结果（lifecycle 的唯一产出）
// ---------------------------------------------------------------------------

export interface ToolFailure {
  toolName: string;
  count: number;
}

export interface RunOutcome {
  sessionId: string;
  /** 实例内自增，用于去重键 */
  runId: string;
  status: RunStatus;
  startedAt: number;
  durationMs: number;
  /** 最终 assistant 的 stopReason；无法确定时 undefined */
  stopReason?: AssistantStopReason;
  /** 已脱敏 */
  errorMessage?: string;
  toolFailures: ToolFailure[];
  compactFailed?: boolean;
}

/** 一次失败的 `tool_execution_end` 累积结果（lifecycle 产出，rules 消费）。 */
export interface ToolFailureEvent {
  sessionId: string;
  runId: string;
  toolName: string;
  /** 本 run 内该工具**去重后**的失败次数（设计 §12.3：同 run 内同工具只计一次计数） */
  count: number;
  /** 本 run 至今的失败工具汇总：immediate 模式的文案直接用这个（§12.3「N 个工具失败: …」） */
  accumulated: ToolFailure[];
}

export interface RunSummary {
  runStatus: RunStatus;
  durationMs: number;
  toolFailures: ToolFailure[];
  costUsd?: number;
  contextPercent?: number;
}

// ---------------------------------------------------------------------------
// 规则层
// ---------------------------------------------------------------------------

export interface NotificationRequest {
  level: NotifyLevel;
  kind: NotificationKind;
  title: string;
  body: string;
  /** 允许跨会话合并/冷却的稳定键 */
  dedupeKey: string;
  /**
   * 可选：这一条专用的合并窗口。缺省用 `config.coalesce.windowMs`。
   * 工具失败的 immediate 模式用它把并行失败聚合成一条（`coalesce.toolFailureWindowMs`）。
   */
  coalesceWindowMs?: number;
  /** provider id 列表 */
  channels: string[];
  /** 仅用于投递与日志，不含原始 prompt / 完整回复 */
  meta: {
    sessionId: string;
    runId: string;
    cwd?: string;
    durationMs?: number;
    level: NotifyLevel;
  };
}

/** 纯函数，无 IO。 */
export type RuleEvaluator = (
  input: { outcome: RunOutcome; summary?: RunSummary },
  config: NotificationConfig,
) => NotificationRequest | null;

// ---------------------------------------------------------------------------
// Provider 契约（渠道解耦的关键）
// ---------------------------------------------------------------------------

export interface Notifier {
  readonly id: string;
  readonly type: string;
  /** 校验自身配置；返回错误字符串表示不可用。不得抛异常。 */
  validate(options: unknown): string | undefined;
  /** 可选：渠道特定格式化；缺省走通用 title/body。 */
  format?(req: NotificationRequest): unknown;
  /** 单次投递。必须尊重 signal，不自行重试（重试由 decorator 负责）。 */
  send(req: NotificationRequest, signal: AbortSignal): Promise<void>;
  /** 幂等释放。不得依赖 Pi 的 ctx。 */
  dispose(): Promise<void>;
}

export type NotifierFactory = (id: string, options: unknown) => Notifier;

export interface NotifierRegistry {
  register(type: string, factory: NotifierFactory): void;
  /** 未注册 → NoopNotifier + 警告（Null Object，消灭调用点的 if） */
  create(id: string, type: string, options: unknown): Notifier;
}

export interface DeliveryResult {
  providerId: string;
  ok: boolean;
  attempts: number;
  /** 已脱敏 */
  error?: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// 服务层
// ---------------------------------------------------------------------------

export interface NotificationService {
  /**
   * 立即返回（入队）。绝不 await 网络。
   * `bypassFilters` 仅供 `/notify test` 这类自检使用：绕过合并/冷却（但不绕过去重与门槛），
   * 否则「自检没收到」会被误读成渠道坏了。
   */
  submit(req: NotificationRequest, options?: { bypassFilters?: boolean }): void;
  /** 仅 quit 等收尾场景使用，带预算。 */
  flush(timeoutMs: number): Promise<void>;
  /** 丢弃未投递项（reload/new/resume/fork）。 */
  discardPending(reason: string): void;
  /** 幂等 */
  dispose(): Promise<void>;
  /** 只读快照，供 `/notify status` 展示（不触发任何投递） */
  snapshot(): ServiceSnapshot;
}

/** `/notify status` 需要的运行统计；全部在内存里，不持久化（设计 §13 第 16 项）。 */
export interface ServiceSnapshot {
  queued: number;
  active: number;
  delivered: number;
  failed: number;
  deduped: number;
  dropped: number;
  /** 被「同一运行只放行一条」窗口合并掉的数量（S4） */
  coalesced: number;
  /** 被同 kind 冷却窗口拦下的数量（S4） */
  cooled: number;
  lastAttemptAt?: number;
  lastOkAt?: number;
  lastError?: string;
}

// ---------------------------------------------------------------------------
// 配置（§10.2 的 S1 子集）
// ---------------------------------------------------------------------------

export interface RuleConfig {
  enabled: boolean;
  level: NotifyLevel;
  channels: string[];
}

export interface ToolFailureRuleConfig extends RuleConfig {
  mode: ToolFailureMode;
  /** `immediate` 模式下，同一工具失败达到该次数即通知（设计 §12.3） */
  threshold: number;
}

export interface WaitingForUserRuleConfig extends RuleConfig {
  /** 白名单 kind；`custom` 永远不在此列表（§18.5 修订 1） */
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
  /** 全局门槛：低于此级别的通知一律不发 */
  minLevel: NotifyLevel;
  rules: {
    runCompleted: RuleConfig;
    runFailed: RuleConfig;
    runAborted: RuleConfig;
    toolFailed: ToolFailureRuleConfig;
    compactFailed: RuleConfig;
    waitingForUser: WaitingForUserRuleConfig;
  };
  /** 合并/冷却（设计 §10.2 / §12.1 第 5 步）；0 表示关闭该项过滤 */
  coalesce: {
    /** 同一「逻辑运行」（sessionId+runId）内只放行一条通知 */
    windowMs: number;
    /** 工具失败聚合窗口；仅用于 immediate 模式的判定说明与日志 */
    toolFailureWindowMs: number;
    /** 同一 kind 两次入队之间的最小间隔 */
    cooldownMs: number;
  };
  content: {
    includeDuration: boolean;
    includeToolFailureNames: boolean;
    includePromptExcerpt: boolean;
    maxMessageChars: number;
  };
  delivery: {
    timeoutMs: number;
    maxRetries: number;
    concurrency: number;
    queueLimit: number;
    /** 连续失败多少次后熔断该渠道（decorators，设计 §13 第 1 项） */
    circuitBreakerFailures: number;
  };
  providers: ProviderConfig[];
  /** session_shutdown(reason=quit) 内允许的最大等待预算（§18.4 硬约束） */
  shutdownFlushMs: number;
}

// ---------------------------------------------------------------------------
// 注入依赖（便于测试注入 fake clock / 观测 sink）
// ---------------------------------------------------------------------------

export interface Logger {
  log(level: LogLevel, message: string, meta?: Record<string, unknown>): void;
  /** 结构化记录（仅写 `PI_NOTIFY_LOG_FILE`），供回归脚本断言。 */
  record(entry: Record<string, unknown>): void;
}

export interface Deps {
  now(): number;
  log: Logger;
}
