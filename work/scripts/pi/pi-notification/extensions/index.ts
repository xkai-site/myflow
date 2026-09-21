/**
 * Pi 插件入口（设计 §5 / §6 / §8）。
 *
 * 薄接线层：只做「注册 + 形状转换 + 转发」，不做业务判定、不碰网络。
 *
 * 注册的 hook（全部纯通知型，§1.3）：
 *   session_start / agent_start / message_end(只读) / agent_settled / session_shutdown
 *   + S6：tool_execution_end / session_compact_failed / ui_prompt_start / ui_prompt_end
 * 以及 1 个命令（`/notify`）与 1 个 CLI 开关（`--no-notify`）。
 *
 * 三条实测硬约束（§18.4 / §18.5）：
 *  - 出口只有 `agent_settled`；**不注册 `agent_end`**（会被重试/压缩/续跑多次触发）。
 *  - `agent_settled` handler **只入队后立即返回**，handler 体内零 `await`（它会阻塞下一次 run）。
 *  - `session_shutdown` 收尾投递带短超时；旧实例在 shutdown 之后不再产生任何结论。
 *  其余新 hook 同样遵守「只入队」纪律：`tool_execution_end` 与 `ui_prompt_*` 也可能在
 *  用户交互的路径上，handler 内一旦 await 就会把延迟传导给用户。
 */

import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { handleNotifyCommand } from "../src/commands.ts";
import {
  CONFIG_VERSION,
  isDisabledByEnv,
  loadConfig,
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
import type { AssistantStopReason, Notifier, NotificationConfig, UIPromptKind } from "../src/types.ts";

/** 实例标识：保证 reload 后新旧实例的 runId / 去重键不冲突。 */
const INSTANCE_TOKEN = Math.random().toString(36).slice(2, 8);

function isAssistantStopReason(value: unknown): value is AssistantStopReason {
  return (
    value === "pending" || value === "stop" || value === "length" || value === "toolUse"
    || value === "error" || value === "aborted" || value === "deferred"
  );
}

/** `ui_prompt_*` 的 kind（只接受已知值，避免把未知字符串写进白名单比较）。 */
function asPromptKind(value: unknown): UIPromptKind | undefined {
  return value === "select" || value === "confirm" || value === "input" || value === "editor" || value === "custom"
    ? value
    : undefined;
}

export default function piNotification(pi: ExtensionAPI): void {
  const log = createLogger();

  // 用户级配置在工厂里读（§5）：失败也要完成注册，保证 `/notify status` 一定可用。
  let load: ConfigLoadResult = loadConfig({
    agentDir: getAgentDir(),
    configDirName: CONFIG_DIR_NAME,
    projectTrusted: false,
  });
  const config: NotificationConfig = load.config;
  if (isDisabledByEnv()) config.enabled = false;

  const registry = createRegistry({ log });

  /**
   * 可靠性参数从**当前**配置派生（`session_start` 会重新读盘，所以用 thunk 而不是快照）。
   * 单次尝试的 deadline 必须小于外层 `delivery.timeoutMs / (maxRetries+1)`，否则第一次尝试
   * 就吃完了整个预算，重试会在已 abort 的 signal 上立刻失败（等于没重试）。
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
  /** 所有渠道共享同一套可靠性包装（§17.2：超时/重试/熔断/脱敏只实现一次）。 */
  const reliable = (notifier: Notifier): Notifier => withReliability(notifier, reliability, log);

  // 阶段 1 渠道：系统桌面通知（OSC 777 / OSC 99 / Windows toast）
  registry.register("terminal", (id) =>
    reliable(createTerminalNotifier(id, { log, maxChars: config.content.maxMessageChars })));
  // 排障用渠道：把通知写成一行日志，不碰终端
  registry.register("debug", (id) =>
    reliable(createDebugNotifier(id, { log, maxChars: config.content.maxMessageChars })));
  // 阶段 2 渠道：通用 HTTP POST（唯一需要凭据与网络的类型）
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
  /** 让 `/compact`、`ui_prompt` 这类「没有 run 上下文」的通知也有稳定去重键（与 run 键隔离）。 */
  let promptSeq = 0;
  let compactSeq = 0;

  /** 旧 ctx 在换会话/重载后会 throw，因此所有 ctx 取值都要防御。 */
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
      // 绝不向 Hook 外抛（§13 第 11 项）：宁可少发通知，也不阻断 Pi。
      log.log("error", `${where} 处理失败（已忽略）`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 配置被重新合并后同步到内存态（service 的渠道表惰性派生，见 service.ts）。 */
  function adoptConfig(next: ConfigLoadResult, reason: string): void {
    load = next;
    const merged = next.config;
    if (isDisabledByEnv()) merged.enabled = false;
    // 原地替换字段：service / rules 持有的是同一个对象引用
    config.enabled = merged.enabled;
    config.minLevel = merged.minLevel;
    config.rules = merged.rules;
    config.coalesce = merged.coalesce;
    config.content = merged.content;
    config.delivery = merged.delivery;
    config.shutdownFlushMs = merged.shutdownFlushMs;
    config.providers = merged.providers;
    log.record({
      event: "config_loaded",
      reason,
      sources: next.sources,
      degraded: next.degraded,
      errors: next.errors,
      warnings: next.warnings,
      enabled: config.enabled,
      minLevel: config.minLevel,
    });
    for (const problem of next.errors) {
      log.log("error", `配置错误 ${problem.path}: ${problem.message}`);
    }
    for (const problem of next.warnings) {
      log.log("warning", `配置提示 ${problem.path}: ${problem.message}`);
    }
  }

  if (load.errors.length > 0 || load.warnings.length > 0) {
    log.record({ event: "config_loaded_initial", degraded: load.degraded, errors: load.errors, warnings: load.warnings });
  }
  if (load.degraded) {
    log.log("error", `配置非法，已降级为「仅失败通知 / 仅终端 / error 门槛」。原因见 /notify status。`);
  }

  pi.registerFlag("no-notify", {
    description: "本会话不发送消息通知（不改配置文件）",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("notify", {
    description: "消息通知：status（状态）/ test（发一条自检通知）",    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        await handleNotifyCommand(args, ctx, {
          log,
          config: () => config,
          configLoad: () => load,
          service: () => service,
          isSilenced: () => pi.getFlag("no-notify") === true,
          sessionId: () => currentSessionId,
          isWaitingForUser: () => lifecycle.isWaitingForUser(),
        });
      } catch (error) {
        // 命令里的异常不能冒泡（§13 第 11 项）
        log.log("error", "notify 命令失败（已忽略）", {
          error: error instanceof Error ? error.message : String(error),
        });
        try {
          ctx.ui.notify("pi-notification: 命令执行失败，详见 /notify status 或诊断日志", "error");
        } catch {
          // ui 不可用则忽略
        }
      }
    },
  });

  pi.on("session_start", (event, ctx) => {
    guard("session_start", () => {
      const sessionId = sessionIdOf(ctx) ?? "unknown";
      currentSessionId = sessionId;
      lifecycle.onSessionStart({ sessionId, reason: event.reason });

      // 项目级配置只在项目被信任时读（§10.1 / §13 第 7 项）。
      let projectTrusted = false;
      let cwd: string | undefined;
      try {
        projectTrusted = ctx.isProjectTrusted();
        cwd = ctx.cwd;
      } catch {
        projectTrusted = false;
      }
      adoptConfig(
        loadConfig({ agentDir: getAgentDir(), cwd, configDirName: CONFIG_DIR_NAME, projectTrusted }),
        `session_start:${event.reason}${projectTrusted ? ":trusted" : ""}`,
      );

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
        // 不静默全关：明确告诉用户"通知没坏，但配置有问题"（§13 第 5 项）
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

  // 只读：捕获 assistant 的 stopReason / errorMessage。**不得返回任何值**，
  // 否则会进入消息替换链（§1.3 / §13 第 17 项）。
  pi.on("message_end", (event, ctx) => {
    guard("message_end", () => {
      const message = event.message as { role?: string; stopReason?: unknown; errorMessage?: unknown };
      if (message?.role !== "assistant") return;
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      lifecycle.onAssistantMessage({
        sessionId,
        stopReason: isAssistantStopReason(message.stopReason) ? message.stopReason : undefined,
        ...(typeof message.errorMessage === "string" ? { errorMessage: message.errorMessage } : {}),
      });
    });
  });

  // S6：工具失败。与 settled 同样只做「累积 + 入队」，不 await。
  pi.on("tool_execution_end", (event, ctx) => {
    guard("tool_execution_end", () => {
      if (pi.getFlag("no-notify") === true) return;
      if (event.isError !== true) return; // 成功执行不产生任何通知
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      const toolName = typeof event.toolName === "string" ? event.toolName : "";
      if (toolName === "") return;
      const failure = lifecycle.onToolExecutionEnd({ sessionId, toolName, isError: true });
      if (!failure) return;
      // `aggregate`（默认）不在这一刻发：等到 settled 由 `evaluateSettlement` 统一出题。
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

  // S6：压缩失败。手工 `/compact` 没有 run 可 settle，所以必须在**当下**投递，
  // 否则这条最重要的上下文告警永远不会出现。
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

  // S6：等待用户输入。白名单与 `custom` 永久排除由 rules/config 把关，这里只做形状转换。
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
      if (kind === "custom") return; // §18.5 修订 1：永久排除
      promptSeq += 1;
      const request = evaluateWaitingForUser(
        {
          sessionId,
          // 专用 runId：不与会话里的 run 共用合并窗口，否则「等待确认」可能被完成通知合并掉
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
      // 不可依赖 `start.kind === end.kind` 配对：嵌套时只发外层 span（§18.5 修订 1）。
      lifecycle.onUiPromptEnd({ sessionId, kind: asPromptKind(event.kind) ?? "custom" });
    });
  });

  // ⚠️ 唯一出口，且必须**同步返回**：handler 会被 await，任何网络投递都会拖慢用户的下一次输入。
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
      // 一个运行最多一条：「结果通知」优先，聚合的工具失败只在没有结果时兜底（§12.1 第 4 步）。
      const request = evaluateSettlement({ outcome }, config);
      if (!request) return;
      service.submit(request); // 同步入队，立即返回
    });
  });

  pi.on("session_shutdown", async (event) => {
    try {
      lifecycle.onShutdown(event.reason);
      if (event.reason === "quit") {
        // 唯一允许等待的收尾路径，且必须有预算（§18.4）。
        await service.flush(config.shutdownFlushMs);
      } else {
        // reload/new/resume/fork：不要给「已经离开的会话」继续弹通知。
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
        // 幂等释放失败不再冒泡
      }
    }
  });
}
