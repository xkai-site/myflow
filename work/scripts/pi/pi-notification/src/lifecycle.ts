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
  ToolFailure,
  ToolFailureEvent,
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
    /** 本条 assistant 消息的 `usage.cost.total`（provider 不报时不给） */
    usageCostUsd?: number;
    /** 本条 assistant 消息的文本（**由 index 限长**；本层只做“保留最新非空一条”） */
    text?: string;
  }): void;
  /**
   * 一次工具执行结束。`isError === false` 时只做簿记（不累积）。
   * 返回本次失败在当前 run 内的累积状态，供 `immediate` 模式判定（§12.3）。
   */
  onToolExecutionEnd(input: {
    sessionId: string;
    toolName: string;
    isError: boolean;
  }): ToolFailureEvent | null;
  /** `session_compact_failed`（§12.1 第 3 步的输入之一）。返回当前 run 的 id（用于去重键）。 */
  onCompactFailed(input: { sessionId: string; reason: string; errorMessage?: string; aborted: boolean }): {
    sessionId: string;
    runId: string;
  } | null;
  /** `ui_prompt_start`：记录「正在等用户」。不白名单化——那是 rules/config 的职责。 */
  onUiPromptStart(input: { sessionId: string; kind: string; title?: string }): void;
  /** `ui_prompt_end`：复位。注意实测：嵌套 prompt 不产生内层 span，`kind` 报的是外层。 */
  onUiPromptEnd(input: { sessionId: string; kind: string }): void;
  /** 唯一出口。返回 null 表示结构性丢弃（陈旧实例 / 会话不匹配 / 非空闲）。 */
  onSettled(input: { sessionId: string; isIdle: boolean }): RunOutcome | null;
  onShutdown(reason: ShutdownReason): void;
  currentSessionId(): string | undefined;
  /** 本实例内该会话的累计成本（`agent_settled` 的 `RunSummary` 用它做“累计”口径） */
  sessionCostUsd(): number;
  /** 当前是否在等用户输入（`/notify status` 展示用） */
  isWaitingForUser(): boolean;
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
    /** 本 run 内 assistant usage 成本累计（多轮/重试都算在同一次运行里） */
    costUsd?: number;
    /** 本 run 最后一条非空 assistant 文本 */
    assistantText?: string;
    /** 本 run 内的工具失败：按 toolName 去重（§12.3），保留失败顺序 */
    toolFailures: Map<string, number>;
    compactFailed: boolean;
  } | undefined;
  /**
   * 会话累计成本。**只在本实例内存里**：`/reload` 或换会话会重建实例，累计随之归零。
   * 不读 SessionManager：那需要把会话内容搬进本层，与“只吃纯数据”的边界冲突。
   */
  let sessionCostUsd = 0;
  /**
   * 等待用户输入的深度计数。
   * 实测（§18.5 修订 1）：嵌套/重叠 prompt **不会**产生内层 span，`ui_prompt_end.kind` 报的是外层，
   * 因此不能用 “start.kind === end.kind” 配对——只做『开始 +1 / 结束 -1』的簿记。
   * `custom` **不参与计数**：它不代表用户在输入（加载器/进度 UI 也会用它，还可能是长命 span），
   * 计入后会让「正在等你输入」的状态一直挂着。
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

  /** 需要 run 上下文但可能没有 `agent_start`（例如运行中途接管）时，惰性建一个。 */
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
      // 没有 agent_start 也允许记录（实例可能在中途接管），但不会伪造开始时间。
      const run = ensureRun(sessionId);
      run.sawAssistant = true;
      run.stopReason = stopReason;
      if (errorMessage !== undefined) run.errorMessage = errorMessage;
      if (typeof usageCostUsd === "number" && Number.isFinite(usageCostUsd) && usageCostUsd > 0) {
        run.costUsd = (run.costUsd ?? 0) + usageCostUsd;
        sessionCostUsd += usageCostUsd;
      }
      // 只保留最新的非空文本：settled 时它恰好是本 run 的最后一条 assistant 回复。
      if (typeof text === "string" && text !== "") run.assistantText = text;
    },

    onToolExecutionEnd({ sessionId, toolName, isError }): ToolFailureEvent | null {
      if (!accept(sessionId)) return null;
      if (!isError) return null;
      const run = ensureRun(sessionId);
      // §12.3：同一 run 内同一工具失败只计一次计数（并行工具模式下 `tool_execution_end` 乱序、会重复刷）
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
      // 嵌套时 Pi 只发外层 span，所以这里可能一次减到 0；不允许出现负数。
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
        // 官方语义：settled 时若仍有其它扩展启动的 run 在跑，就不该报「完成了」。
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
      // §18.5 修订 1：进程被强杀时可能不补发 `ui_prompt_end`，必须兜底复位。
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
