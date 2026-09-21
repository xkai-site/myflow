/**
 * Pi 插件入口（设计 §5 / §6 / §8）。
 *
 * 薄接线层：只做「注册 + 形状转换 + 转发」，不做业务判定、不碰网络。
 *
 * 注册的 hook 只有 5 个（全部纯通知型，§1.3）：
 *   session_start / agent_start / message_end(只读) / agent_settled / session_shutdown
 * 以及 1 个命令（`/notify`）与 1 个 CLI 开关（`--no-notify`）。
 *
 * 三条实测硬约束（§18.4 / §18.5）：
 *  - 出口只有 `agent_settled`；**不注册 `agent_end`**（会被重试/压缩/续跑多次触发）。
 *  - `agent_settled` handler **只入队后立即返回**，handler 体内零 `await`（它会阻塞下一次 run）。
 *  - `session_shutdown` 收尾投递带短超时；旧实例在 shutdown 之后不再产生任何结论。
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
import { createDebugNotifier } from "../src/providers/debug.ts";
import { createRegistry } from "../src/providers/registry.ts";
import { createTerminalNotifier } from "../src/providers/terminal.ts";
import { evaluateRunOutcome } from "../src/rules.ts";
import { createService } from "../src/service.ts";
import type { AssistantStopReason, NotificationConfig } from "../src/types.ts";

/** 实例标识：保证 reload 后新旧实例的 runId / 去重键不冲突。 */
const INSTANCE_TOKEN = Math.random().toString(36).slice(2, 8);

function isAssistantStopReason(value: unknown): value is AssistantStopReason {
  return (
    value === "pending" || value === "stop" || value === "length" || value === "toolUse"
    || value === "error" || value === "aborted" || value === "deferred"
  );
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
  // 阶段 1 渠道：系统桌面通知（OSC 777 / OSC 99 / Windows toast）
  registry.register("terminal", (id) =>
    createTerminalNotifier(id, { log, maxChars: config.content.maxMessageChars }));
  // 排障用渠道：把通知写成一行日志，不碰终端
  registry.register("debug", (id) =>
    createDebugNotifier(id, { log, maxChars: config.content.maxMessageChars }));

  const service = createService({ config, registry, log, now: () => Date.now() });
  const lifecycle = createLifecycle({
    config,
    log,
    now: () => Date.now(),
    instanceToken: INSTANCE_TOKEN,
  });

  let currentSessionId: string | undefined;

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
    description: "消息通知：status（状态）/ test（发一条自检通知）",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        await handleNotifyCommand(args, ctx, {
          log,
          config: () => config,
          configLoad: () => load,
          service: () => service,
          isSilenced: () => pi.getFlag("no-notify") === true,
          sessionId: () => currentSessionId,
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
      const request = evaluateRunOutcome({ outcome }, config);
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
