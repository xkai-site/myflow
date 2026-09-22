/**
 * Plugin entry point: thin wiring only (register, convert shapes, forward). No judgement logic
 * and no network access here.
 *
 * Registered hooks, all notification-only: session_start, agent_start, message_end (read-only),
 * agent_settled, session_shutdown, tool_execution_end, session_compact_failed, ui_prompt_start
 * and ui_prompt_end; plus one command (`/notify`) and one CLI flag (`--no-notify`).
 *
 * Three hard constraints:
 *  - The only exit is `agent_settled`; `agent_end` must never be registered because retries,
 *    compaction retries and queued continuations fire it more than once per run.
 *  - The `agent_settled` handler enqueues and returns with no `await` in its body, because it
 *    blocks the next run.
 *  - `session_shutdown` flushes with a short budget, and the instance it belonged to must not
 *    produce further conclusions.
 *  - The newer hooks follow the same enqueue-only discipline: `tool_execution_end` and the
 *    `ui_prompt_*` pair sit on interactive paths, where awaiting would relay the delay to the user.
 */

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";

import { handleNotifyCommand } from "../src/commands.ts";
import {
  CONFIG_VERSION,
  isDisabledByEnv,
  loadConfig,
  readUserConfigRaw,
  type ConfigLoadResult,
} from "../src/config.ts";
import { createLifecycle } from "../src/lifecycle.ts";
import { createLogger } from "../src/log.ts";
import { withReliability } from "../src/providers/decorators.ts";
import { createDebugNotifier } from "../src/providers/debug.ts";
import { createRegistry } from "../src/providers/registry.ts";
import { createTerminalNotifier } from "../src/providers/terminal.ts";
import { createWebhookNotifier, type WebhookOptions } from "../src/providers/webhook.ts";
import {
  evaluateCompactFailure,
  evaluateSettlement,
  evaluateToolFailure,
  evaluateWaitingForUser,
} from "../src/rules.ts";
import { createService } from "../src/service.ts";
import {
  SESSION_OVERLAY_ENTRY,
  applyOverlay,
  emptyOverlay,
  isEmptyOverlay,
  restoreOverlayFromEntries,
  type SessionOverlay,
} from "../src/settings.ts";
import type { AssistantStopReason, Notifier, NotificationConfig, RunSummary, UIPromptKind } from "../src/types.ts";

/** Instance token: keeps run ids and dedupe keys distinct across a reload. */
const INSTANCE_TOKEN = Math.random().toString(36).slice(2, 8);

function isAssistantStopReason(value: unknown): value is AssistantStopReason {
  return (
    value === "pending" || value === "stop" || value === "length" || value === "toolUse"
    || value === "error" || value === "aborted" || value === "deferred"
  );
}

/**
 * Keeps only text parts, at most 200 code points, as an assistant reply sample.
 * The display length is decided by the rules layer; the cap here only stops per-run state from
 * growing without bound.
 */
function assistantText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    if ((part as { type?: unknown })?.type !== "text") continue;
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string" && text !== "") parts.push(text);
  }
  const joined = parts.join(" ").trim();
  return joined === "" ? undefined : [...joined].slice(0, 200).join("");
}

/**
 * Context usage percentage, omitted unless both `getContextUsage()` and `model.contextWindow`
 * are available: guessing a number would be worse than showing nothing, since local and unknown
 * models have no reliable window size.
 */
function contextPercentOf(ctx: ExtensionContext): number | undefined {
  try {
    const used = ctx.getContextUsage()?.tokens;
    const window = ctx.model?.contextWindow;
    if (typeof used !== "number" || !Number.isFinite(used) || typeof window !== "number" || window <= 0) return undefined;
    return Math.max(0, Math.round((used / window) * 100));
  } catch {
    return undefined;
  }
}

/** `ui_prompt_*` kinds; unknown strings are rejected so they cannot reach an allow-list comparison. */
function asPromptKind(value: unknown): UIPromptKind | undefined {
  return value === "select" || value === "confirm" || value === "input" || value === "editor" || value === "custom"
    ? value
    : undefined;
}

export default function piNotification(pi: ExtensionAPI): void {
  const log = createLogger();

  // Read the user defaults in the factory, and finish registration even when that fails so
  // `/notify` is always available.
  let load: ConfigLoadResult = loadConfig({ agentDir: getAgentDir() });
  const config: NotificationConfig = load.config;
  if (isDisabledByEnv()) config.enabled = false;

  /**
   * Per-conversation choices: Enter writes here and never to the user file.
   * The effective config is factory defaults, then user defaults from disk, then this overlay,
   * combined in one pass inside `adoptConfig`.
   */
  let overlay: SessionOverlay = emptyOverlay();

  const registry = createRegistry({ log });

  /**
   * Reliability options are derived from the **current** config (`session_start` re-reads it), so
   * they are thunks rather than a snapshot. The per-attempt deadline must stay below
   * `delivery.timeoutMs / (maxRetries + 1)`, otherwise the first attempt consumes the whole budget
   * and the retry fails immediately on an already aborted signal, which is the same as no retry.
   */
  const reliability = () => {
    const maxRetries = Math.max(0, Math.floor(config.delivery.maxRetries));
    const attempts = maxRetries + 1;
    return {
      attemptTimeoutMs: Math.max(250, Math.floor(config.delivery.timeoutMs / attempts)),
      maxRetries,
      retryDelayMs: 250,
      breakerFailures: Math.max(0, Math.floor(config.delivery.circuitBreakerFailures)),
      breakerCooldownMs: 30000,
    };
  };
  /** Every channel shares one reliability stack, so timeout, retry, breaker and redaction exist once. */
  const reliable = (notifier: Notifier): Notifier => withReliability(notifier, reliability, log);

  // Default channel: desktop notification through OSC 777, OSC 99 or a Windows toast.
  registry.register("terminal", (id) =>
    reliable(createTerminalNotifier(id, { log, maxChars: config.content.maxMessageChars })));
  // Diagnostic channel: writes the notification as one log line instead of touching the output.
  registry.register("debug", (id) =>
    reliable(createDebugNotifier(id, { log, maxChars: config.content.maxMessageChars })));
  // Generic HTTP POST channel, the only type that needs credentials and the network.
  registry.register("webhook", (id, options) =>
    reliable(createWebhookNotifier(id, (options ?? {}) as WebhookOptions, { log, maxChars: config.content.maxMessageChars })));

  const service = createService({ config, registry, log, now: () => Date.now() });
  const lifecycle = createLifecycle({
    config,
    log,
    now: () => Date.now(),
    instanceToken: INSTANCE_TOKEN,
  });

  let currentSessionId: string | undefined;
  /**
   * Session name from `/name`, used only as a body label: read at `session_start` and kept up to
   * date by `session_info_changed`.
   */
  let sessionName: string | undefined;
  /** Project directory name, used as the fallback label when the session has no name. */
  let projectName: string | undefined;
  /** Stable dedupe keys for notifications that have no run context, kept separate from run keys. */
  let promptSeq = 0;
  let compactSeq = 0;

  /** A stale `ctx` throws after a session switch or reload, so every access is defended. */
  function sessionIdOf(ctx: ExtensionContext | undefined): string | undefined {
    try {
      return ctx?.sessionManager?.getSessionId();
    } catch {
      return undefined;
    }
  }

  function guard(where: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      // Never throw into a hook: fewer notifications beats blocking Pi.
      log.log("error", `${where} 处理失败（已忽略）`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Copies a re-merged config into the in-memory object the service and lifecycle already hold. */
  function adoptConfig(next: ConfigLoadResult, reason: string): void {
    // Layer the per-conversation overlay first: it only holds fields the user changed, so every
    // other field is inherited from the config on disk.
    const applied = applyOverlay(next.config, overlay);
    const merged: ConfigLoadResult = applied.problems.length > 0
      ? { ...next, config: applied.config, warnings: [...next.warnings, ...applied.problems] }
      : { ...next, config: applied.config };
    if (applied.problems.length > 0) {
      // The overlay itself is no longer valid (for example the file now holds a conflicting value):
      // ignore it as a whole so delivery is unaffected.
      log.log("warning", "本对话覆盖已失效，已忽略（详见状态总览）");
    }
    load = merged;
    const effective = merged.config;
    if (isDisabledByEnv()) effective.enabled = false;
    // Replaced field by field: the service and lifecycle hold a reference to this same object.
    config.enabled = effective.enabled;
    config.minLevel = effective.minLevel;
    config.rules = effective.rules;
    config.coalesce = effective.coalesce;
    config.quietHours = effective.quietHours;
    config.content = effective.content;
    config.delivery = effective.delivery;
    config.shutdownFlushMs = effective.shutdownFlushMs;
    config.providers = effective.providers;
    log.record({
      event: "config_loaded",
      reason,
      sources: next.sources,
      degraded: next.degraded,
      errors: next.errors,
      warnings: merged.warnings,
      overlay: !isEmptyOverlay(overlay),
      enabled: config.enabled,
      minLevel: config.minLevel,
    });
    for (const problem of next.errors) {
      log.log("error", `配置错误 ${problem.path}: ${problem.message}`);
    }
    for (const problem of merged.warnings) {
      log.log("warning", `配置提示 ${problem.path}: ${problem.message}`);
    }
  }

  /** Shared by `session_start` and Ctrl+R; it never rebuilds the lifecycle. */
  function reloadConfig(_ctx: ExtensionContext, reason: string): void {
    adoptConfig(loadConfig({ agentDir: getAgentDir() }), reason);
  }

  /**
   * Restores this conversation's overlay, the result of Enter.
   * The filtering rules, including entries copied by `/fork`, live in `restoreOverlayFromEntries`
   * and are covered by unit tests.
   */
  function restoreOverlay(ctx: ExtensionContext, sessionId: string): void {
    try {
      overlay = restoreOverlayFromEntries(ctx.sessionManager.getEntries(), sessionId);
    } catch (error) {
      overlay = emptyOverlay();
      log.log("warning", "恢复本对话覆盖失败（已忽略）", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Each overlay is a full snapshot, including the empty one: that is how “everything was cleared”
   * is expressed, so a later `/reload` cannot resurrect the previous entry's choices. Skipping the
   * empty snapshot here would make the last non-empty entry win again on restore.
   */
  function persistOverlay(): void {
    try {
      pi.appendEntry(SESSION_OVERLAY_ENTRY, {
        sessionId: currentSessionId,
        patch: overlay.patch,
        providers: overlay.providers,
        at: Date.now(),
      });
    } catch (error) {
      // Without a session file `appendEntry` may be unavailable; the in-memory overlay still applies.
      log.log("warning", "本对话覆盖未能写入会话（仅本次进程内有效）", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Enter in the UI: write the overlay, persist a session entry, then re-apply the effective config. */
  function setOverlay(next: SessionOverlay): void {
    overlay = next;
    persistOverlay();
    adoptConfig(loadConfig({ agentDir: getAgentDir() }), "session_overlay");
  }

  if (load.errors.length > 0 || load.warnings.length > 0) {
    log.record({ event: "config_loaded_initial", degraded: load.degraded, errors: load.errors, warnings: load.warnings });
  }
  if (load.degraded) {
    log.log("error", `配置非法，已降级为「仅失败通知 / 仅终端 / error 门槛」。原因见状态总览（Ctrl+O）。`);
  }

  pi.registerFlag("no-notify", {
    description: "本会话不发送消息通知（不改配置文件）",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("notify", {
    description: "通知设置（单一入口：分类浏览、Ctrl+S 保存为默认）",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        await handleNotifyCommand(args, ctx, {
          log,
          config: () => config,
          configLoad: () => load,
          service: () => service,
          agentDir: () => getAgentDir(),
          reload: (commandCtx) => reloadConfig(commandCtx, "notify_reload"),
          isSilenced: () => pi.getFlag("no-notify") === true,
          sessionId: () => currentSessionId,
          isWaitingForUser: () => lifecycle.isWaitingForUser(),
          overlay: () => overlay,
          setOverlay,
          userRaw: () => {
            const raw = readUserConfigRaw(getAgentDir());
            return raw.ok ? raw.raw : undefined;
          },
        });
      } catch (error) {
        // Exceptions from the command must not escape.
        log.log("error", "notify 命令失败（已忽略）", {
          error: error instanceof Error ? error.message : String(error),
        });
        try {
          ctx.ui.notify("pi-notification: 命令执行失败，详见状态总览（Ctrl+O）或诊断日志", "error");
        } catch {
          // Ignore when the UI is unavailable.
        }
      }
    },
  });

  pi.on("session_start", (event, ctx) => {
    guard("session_start", () => {
      const sessionId = sessionIdOf(ctx) ?? "unknown";
      currentSessionId = sessionId;
      lifecycle.onSessionStart({ sessionId, reason: event.reason });
      try {
        sessionName = pi.getSessionName() || undefined;
      } catch {
        sessionName = undefined; // Treat an unreadable name as unnamed; nothing else is affected.
      }
      try {
        // A filesystem root basename is an empty string, which the rules treat as absent, so no
        // empty brackets are ever produced.
        projectName = basename(ctx.cwd) || undefined;
      } catch {
        projectName = undefined;
      }

      restoreOverlay(ctx, sessionId);
      reloadConfig(ctx, `session_start:${event.reason}`);

      log.record({
        event: "plugin_session_start",
        instance: INSTANCE_TOKEN,
        sessionId,
        reason: event.reason,
        version: CONFIG_VERSION,
        enabled: config.enabled,
        silenced: pi.getFlag("no-notify") === true,
        minLevel: config.minLevel,
        providers: config.providers.filter((provider) => provider.enabled).map((provider) => provider.id),
        degraded: load.degraded,
      });

      if (load.degraded && ctx.mode === "tui") {
        // Degrading must not silently switch everything off: say that notifications still work and
        // only the config is broken.
        ctx.ui.notify("pi-notification: 配置有误，已降级为仅发送失败通知。用 /notify status 查看原因。", "warning");
      }
    });
  });

  pi.on("agent_start", (_event, ctx) => {
    guard("agent_start", () => {
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      lifecycle.onAgentStart({ sessionId });
    });
  });

  // Read-only: captures the assistant stopReason and errorMessage. It must not return a value,
  // otherwise the message would enter the replacement chain.
  pi.on("message_end", (event, ctx) => {
    guard("message_end", () => {
      const message = event.message as {
        role?: string;
        stopReason?: unknown;
        errorMessage?: unknown;
        content?: unknown;
        usage?: { cost?: { total?: unknown } };
      };
      if (message?.role !== "assistant") return;
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      const text = assistantText(message.content);
      lifecycle.onAssistantMessage({
        sessionId,
        stopReason: isAssistantStopReason(message.stopReason) ? message.stopReason : undefined,
        ...(typeof message.errorMessage === "string" ? { errorMessage: message.errorMessage } : {}),
        ...(typeof message.usage?.cost?.total === "number" ? { usageCostUsd: message.usage.cost.total } : {}),
        ...(text !== undefined ? { text } : {}),
      });
    });
  });

  // Read-only: refreshes the body label when the session name changes. The name itself is never
  // recorded, only whether one exists.
  pi.on("session_info_changed", (event) => {
    guard("session_info_changed", () => {
      const name = typeof event.name === "string" && event.name.trim() !== "" ? event.name : undefined;
      sessionName = name;
      log.record({ event: "session_name_changed", hasName: name !== undefined });
    });
  });

  // Tool failures: like settle, this only accumulates and enqueues, never awaits.
  pi.on("tool_execution_end", (event, ctx) => {
    guard("tool_execution_end", () => {
      if (pi.getFlag("no-notify") === true) return;
      if (event.isError !== true) return; // A successful execution never produces a notification.
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      const toolName = typeof event.toolName === "string" ? event.toolName : "";
      if (toolName === "") return;
      const failure = lifecycle.onToolExecutionEnd({ sessionId, toolName, isError: true });
      if (!failure) return;
      // The default `aggregate` mode stays quiet here and lets `evaluateSettlement` decide at settle time.
      const rule = config.rules.toolFailed;
      if (rule.mode !== "immediate") return;
      if (failure.count < rule.threshold) return;
      const request = evaluateToolFailure(
        {
          sessionId,
          runId: failure.runId,
          toolFailures: [{ toolName, count: failure.count }],
          accumulated: failure.accumulated,
          toolName,
        },
        config,
      );
      if (request) service.submit(request);
    });
  });

  // Compact failure: a manual `/compact` has no run that can settle, so it must be delivered right
  // now, otherwise this most important context warning would never appear.
  pi.on("session_compact_failed", (event, ctx) => {
    guard("session_compact_failed", () => {
      if (pi.getFlag("no-notify") === true) return;
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      const errorMessage = typeof event.errorMessage === "string" ? event.errorMessage : undefined;
      const aborted = event.aborted === true;
      const info = lifecycle.onCompactFailed({
        sessionId,
        reason: typeof event.reason === "string" ? event.reason : "unknown",
        ...(errorMessage !== undefined ? { errorMessage } : {}),
        aborted,
      });
      if (!info) return;
      compactSeq += 1;
      const request = evaluateCompactFailure(
        {
          sessionId,
          runId: info.runId,
          reason: typeof event.reason === "string" ? event.reason : "unknown",
          ...(errorMessage !== undefined ? { errorMessage } : {}),
          aborted,
          seq: compactSeq,
        },
        config,
      );
      if (request) service.submit(request);
    });
  });

  // Waiting for user input: the allow-list and the permanent exclusion of `custom` are enforced by
  // the rules and config layers; this handler only converts shapes.
  pi.on("ui_prompt_start", (event, ctx) => {
    guard("ui_prompt_start", () => {
      if (pi.getFlag("no-notify") === true) return;
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      const kind = asPromptKind(event.kind) ?? "custom";
      const title = typeof event.title === "string" ? event.title : undefined;
      lifecycle.onUiPromptStart({ sessionId, kind, ...(title ? { title } : {}) });
      const rule = config.rules.waitingForUser;
      if (!rule.enabled) return;
      if (kind === "custom") return; // Permanently excluded: the loader and progress UI emit it too.
      promptSeq += 1;
      const request = evaluateWaitingForUser(
        {
          sessionId,
          // Dedicated run id: sharing the session's coalescing window could swallow a waiting
          // prompt into a completion notification.
          runId: `${INSTANCE_TOKEN}-prompt-${promptSeq}`,
          kind,
          ...(title ? { title } : {}),
          seq: promptSeq,
        },
        config,
      );
      if (request) service.submit(request);
    });
  });

  pi.on("ui_prompt_end", (event, ctx) => {
    guard("ui_prompt_end", () => {
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      // Start and end cannot be paired by kind: nested prompts emit only the outer span.
      lifecycle.onUiPromptEnd({ sessionId, kind: asPromptKind(event.kind) ?? "custom" });
    });
  });

  // The only exit, and it must return synchronously: the handler is awaited, so any network
  // delivery would delay the user's next input.
  pi.on("agent_settled", (_event, ctx) => {
    guard("agent_settled", () => {
      if (pi.getFlag("no-notify") === true) return;
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      let isIdle = true;
      try {
        isIdle = ctx.isIdle();
      } catch {
        isIdle = true;
      }
      const outcome = lifecycle.onSettled({ sessionId, isIdle });
      if (!outcome) return;
      // Session-level metadata is assembled here because the rules layer is pure: it reads neither
      // `ctx` nor a clock.
      const percent = contextPercentOf(ctx);
      const summary: RunSummary = {
        runStatus: outcome.status,
        durationMs: outcome.durationMs,
        toolFailures: outcome.toolFailures,
        ...(sessionName !== undefined ? { sessionName } : {}),
        ...(projectName !== undefined ? { projectName } : {}),
        cumulativeCostUsd: lifecycle.sessionCostUsd(),
        ...(percent !== undefined ? { contextPercent: percent } : {}),
      };
      // At most one notification per run: the result wins, and aggregated tool failures only act as
      // a fallback when there is no result notification.
      const request = evaluateSettlement({ outcome, summary }, config);
      if (!request) return;
      service.submit(request); // Synchronous enqueue, then return immediately.
    });
  });

  pi.on("session_shutdown", async (event) => {
    try {
      lifecycle.onShutdown(event.reason);
      if (event.reason === "quit") {
        // The only shutdown path allowed to wait, and it must stay within its budget.
        await service.flush(config.shutdownFlushMs);
      } else {
        // reload/new/resume/fork: a conversation that has been left must not raise more notifications.
        service.discardPending(event.reason);
      }
    } catch (error) {
      log.log("error", "session_shutdown 处理失败（已忽略）", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      log.record({ event: "plugin_shutdown", instance: INSTANCE_TOKEN, reason: event.reason });
      try {
        await service.dispose();
      } catch {
        // A failed idempotent release must not bubble either.
      }
    }
  });
}
