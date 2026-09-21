/**
 * 规则求值（设计 §8 / §12.1 第 4 步）。
 *
 * **纯函数**：无 IO、无时间、无随机、不认识任何渠道名。
 * 输入 `RunOutcome`（+ 可选 `RunSummary`），输出 `NotificationRequest | null`。
 *
 * 渠道路由由 `service` 完成；这里只产出 `level` + `channels` 白名单。
 * 修改本文件不得引入任何 `providers/*` 依赖（§17.3 规则 1、2）。
 */

import { sanitize, sanitizeError } from "./log.ts";
import type {
  NotificationConfig,
  NotificationKind,
  NotificationRequest,
  RunOutcome,
  RunSummary,
} from "./types.ts";

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes}m${rest}s`;
}

function buildBody(
  outcome: RunOutcome,
  config: NotificationConfig,
  parts: string[],
): string {
  const chunks = [...parts];
  if (config.content.includeDuration && outcome.durationMs > 0) {
    chunks.push(`用时 ${formatDuration(outcome.durationMs)}`);
  }
  if (config.content.includeToolFailureNames && outcome.toolFailures.length > 0) {
    const names = outcome.toolFailures.map((failure) => failure.toolName).join(", ");
    chunks.push(`失败工具 ${names}`);
  }
  return sanitize(chunks.join(" · "), config.content.maxMessageChars);
}

/**
 * 运行结果 → 通知请求。
 *
 * `aborted` 与 `unknown` 默认不通知：
 *  - 用户按 Esc 时人就在终端旁边，通知只是噪声（§12.1 第 3 步）；
 *  - `unknown` 表示拿不到 stopReason，宁可少发也不误报（§12.1 第 3 步）。
 * 两条都仍由配置开关控制，规则本身不写死。
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

  const rule = kind === "run_completed" ? config.rules.runCompleted
    : kind === "run_failed" ? config.rules.runFailed
      : config.rules.runAborted;
  if (!rule.enabled) return null;

  const title =
    kind === "run_completed" ? "任务完成"
      : kind === "run_failed" ? "任务失败"
        : "任务已取消";

  const parts: string[] = [];
  if (kind === "run_failed" && outcome.errorMessage) {
    parts.push(sanitizeError(outcome.errorMessage, config.content.maxMessageChars));
  }

  return {
    level: rule.level,
    kind,
    title: sanitize(title, 60),
    body: buildBody(outcome, config, parts),
    dedupeKey: `${outcome.sessionId}:${outcome.runId}:${kind}`,
    channels: [...rule.channels],
    meta: {
      sessionId: outcome.sessionId,
      runId: outcome.runId,
      durationMs: outcome.durationMs,
      level: rule.level,
    },
  };
}
