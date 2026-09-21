/**
 * `/notify` 命令（设计 §10.3）。
 *
 * status/test + 用户级 on/off/config 原子写盘 + reload 配置热读。
 * 官方 `ctx.ui.notify` **不能**作为外部投递成功的证据（§1.8）。
 *
 * 注意（§2.2 第 6 点）：用 `ctx.mode === "tui"` 而不是 `hasUI` 守卫终端 UI —— RPC 下 hasUI 也为真，
 * 但那里的对话框语义不同。`ui.notify` 在 print/json 下是 no-op，所以直接用是安全的。
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { describeConfig, userConfigPath, writeUserConfig, type ConfigLoadResult } from "./config.ts";
import { sanitize, sanitizeError } from "./log.ts";
import { configureRules } from "./ui.ts";
import { createDefaultTerminalIo, selectTerminalChannel } from "./providers/terminal.ts";
import type { Logger, NotificationConfig, NotificationService } from "./types.ts";

export interface CommandDeps {
  log: Logger;
  config(): NotificationConfig;
  configLoad(): ConfigLoadResult;
  service(): NotificationService;
  agentDir(): string;
  /** 不含项目级/环境覆盖，避免把会话偏好写成用户全局偏好。 */
  userConfig(): ConfigLoadResult;
  reload(ctx: ExtensionCommandContext): void;
  /** 会话级静默标志（`--no-notify`） */
  isSilenced(): boolean;
  /** 首次启用时载入的会话 id，用于展示 */
  sessionId(): string | undefined;
  /** 当前是否在等用户输入（S6 的 waiting 状态） */
  isWaitingForUser?(): boolean;
}

function formatStatus(deps: CommandDeps): string {
  const config = deps.config();
  const load = deps.configLoad();
  const snapshot = deps.service().snapshot();
  const selection = selectTerminalChannel(createDefaultTerminalIo().environment());

  const lines: string[] = [];
  lines.push(`pi-notification: ${config.enabled && !deps.isSilenced() ? "开启" : "关闭"}${deps.isSilenced() ? "（--no-notify）" : ""}`);
  lines.push(`  规则/渠道: ${describeConfig(config)}`);
  lines.push(
    `  合并/冷却: 同运行窗口 ${config.coalesce.windowMs}ms / 同 kind 冷却 ${config.coalesce.cooldownMs}ms`
    + ` / 工具失败 ${config.rules.toolFailed.mode}(${config.rules.toolFailed.threshold})`,
  );
  const quiet = config.quietHours;
  lines.push(`  静默时段: ${quiet.start}–${quiet.end}（${!quiet.enabled ? "未开启" : deps.service().isQuietHours() ? "当前生效" : "当前未生效"}；本地时间；例外 ${quiet.exceptLevels.join(",") || "无"}）`);
  lines.push(`  配置来源: ${load.sources.join(" → ")}${load.degraded ? "（已降级）" : ""}`);
  lines.push(`  终端机制: ${selection.channel}${selection.reason ? `（${selection.reason}）` : ""}`);
  lines.push(
    `  投递统计: 成功 ${snapshot.delivered} / 失败 ${snapshot.failed} / 去重 ${snapshot.deduped}`
    + ` / 合并 ${snapshot.coalesced} / 冷却 ${snapshot.cooled}`
    + ` / 丢弃 ${snapshot.dropped} / 在队 ${snapshot.queued} / 在途 ${snapshot.active}`,
  );
  lines.push(`  上次成功: ${snapshot.lastOkAt ? new Date(snapshot.lastOkAt).toLocaleString() : "—"}`);
  if (snapshot.lastError) lines.push(`  上次错误: ${snapshot.lastError}`);
  if (deps.sessionId()) lines.push(`  会话: ${deps.sessionId()}${deps.isWaitingForUser?.() ? "（正在等你输入）" : ""}`);
  for (const problem of load.errors) lines.push(`  ⚠ 配置错误 ${problem.path}: ${problem.message}`);
  for (const problem of load.warnings) lines.push(`  · 提示 ${problem.path}: ${problem.message}`);
  return lines.join("\n");
}

/** print/json 的 notify 是 no-op；用 stderr 保持 stdout 协议干净。 */
function report(ctx: ExtensionCommandContext, text: string, type: "info" | "warning" | "error" = "info"): void {
  ctx.ui.notify(text, type);
  if (ctx.mode === "print" || ctx.mode === "json") process.stderr.write(`${text}\n`);
}

function configView(config: NotificationConfig): string {
  // 渠道 options 可含任意 header/query 凭据；不要靠正则猜密钥名。
  const visible = { ...config, providers: config.providers.map(({ options: _options, ...provider }) => ({ ...provider, options: "[隐藏，请在配置文件查看]" })) };
  return sanitize(JSON.stringify(visible, null, 2), 12000);
}

export async function handleNotifyCommand(args: string, ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
  const sub = (args ?? "").trim().split(/\s+/)[0] ?? "status";

  if (sub === "" || sub === "status") {
    const text = formatStatus(deps);
    deps.log.record({ event: "notify_status", text });
    ctx.ui.notify(text, "info");
    return;
  }

  if (sub === "reload") {
    deps.reload(ctx);
    const text = `已重新读取通知配置（未重载扩展）。\n${formatStatus(deps)}`;
    deps.log.record({ event: "notify_reload", degraded: deps.configLoad().degraded });
    report(ctx, text, deps.configLoad().degraded ? "warning" : "info");
    return;
  }

  if (sub === "on" || sub === "off" || sub === "config") {
    const file = userConfigPath(deps.agentDir());
    if (sub === "config" && ctx.mode !== "tui") {
      report(ctx, `用户级配置: ${sanitize(file, 2000)}\n当前生效值（渠道 options 隐藏）:\n${configView(deps.config())}\n请编辑 JSON 后 /notify reload；向导仅在 TUI 可用。`);
      deps.log.record({ event: "notify_config", mode: ctx.mode });
      return;
    }
    const user = deps.userConfig();
    if (user.degraded) {
      report(ctx, `拒绝覆盖损坏的用户配置，请先修复：${user.errors.map((p) => sanitizeError(`${p.path}: ${p.message}`)).join("; ")}`, "error");
      return;
    }
    const draft = sub === "config"
      ? await configureRules(ctx, user.config)
      : { ...user.config, enabled: sub === "on" };
    if (!draft) {
      report(ctx, "已取消，配置未修改。");
      return;
    }
    const result = writeUserConfig(deps.agentDir(), draft);
    if (!result.ok) {
      const problems = result.problems.map((p) => sanitizeError(`${p.path}: ${p.message}`));
      deps.log.record({ event: "notify_config_write_failed", problems });
      report(ctx, `配置保存失败，内存态未修改：${problems.join("; ")}`, "error");
      return;
    }
    deps.reload(ctx); // 成功落盘之后才更新共享配置引用
    deps.log.record({ event: "notify_config_saved", action: sub });
    report(ctx, `已保存用户级配置: ${sanitize(file, 2000)}\n当前通知${deps.config().enabled && !deps.isSilenced() ? "开启" : "关闭"}（项目级配置、环境变量和 --no-notify 仍优先）；详见 /notify status。`, deps.configLoad().degraded ? "warning" : "info");
    return;
  }

  if (sub === "test") {
    // 端到端自检：走与真实通知完全相同的路径（含渠道选择、清洗、降级判断）
    const config = deps.config();
    const now = Date.now();
    deps.service().submit(
      {
        level: "info",
        kind: "run_completed",
        title: "Pi 通知自检",
        body: "如果你看到这条，说明渠道可用",
        dedupeKey: `manual:${now}`,
        channels: config.rules.runCompleted.channels,
        meta: { sessionId: deps.sessionId() ?? "manual", runId: String(now), level: "info" },
      },
      // 自检绕过静默时段/合并/冷却：否则刚跑完一个任务再 `/notify test` 会被冷却吃掉，
      // 用户会把它误读成「渠道坏了」。
      { bypassFilters: true },
    );
    const snapshot = deps.service().snapshot();
    const selection = selectTerminalChannel(createDefaultTerminalIo().environment());
    const text = selection.channel === "none"
      ? `已提交自检通知，但本地渠道不可用：${selection.reason}`
      : `已提交自检通知（机制 ${selection.channel}）；在队 ${snapshot.queued}。用 /notify status 看结果。`;
    deps.log.record({ event: "notify_test", channel: selection.channel, reason: selection.reason ?? null });
    const quietHint = deps.service().isQuietHours()
      ? " 当前处于静默时段，真实通知会被静默（exceptLevels 等级例外除外）；本次自检绕过静默。"
      : "";
    ctx.ui.notify(text + quietHint, "info");
    return;
  }

  const usage = "用法: /notify [status|test|on|off|config|reload]";
  deps.log.record({ event: "notify_usage", args: sanitize(args, 100) });
  ctx.ui.notify(`${sanitize(`未知子命令: ${sub}`, 80)}\n${usage}`, "warning");
}
