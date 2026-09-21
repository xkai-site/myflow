/**
 * The `/notify` command.
 *
 * Single entry point: without arguments it opens the settings UI in the TUI; the old
 * subcommands are gone. Their capabilities still exist, folded into that UI (Ctrl+T self-test,
 * Ctrl+R re-read, Ctrl+O status). Outside the TUI (print/json/rpc) it prints the status and the
 * config file paths instead.
 *
 * Where each value belongs:
 *  - factory defaults: read-only, from `config.ts`;
 *  - user defaults: Ctrl+S through `writeUserDefault`, a single sparse write;
 *  - this conversation: Enter writes the session overlay, which the extension applies and
 *    persists as a session entry.
 *
 * `ctx.ui.notify` is not evidence that an external delivery succeeded: it only reports to the
 * host's own UI.
 *
 * Guard terminal UI with `ctx.mode === "tui"` rather than `hasUI`, because `hasUI` is also true
 * over RPC where `ctx.ui.custom` is unavailable; `ui.notify` is a no-op under print/json.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  describeConfig,
  isDisabledByEnv,
  readUserConfigRaw,
  userConfigPath,
  writeUserDefault,
  type ConfigLoadResult,
} from "./config.ts";
import { sanitize, sanitizeError } from "./log.ts";
import { createDefaultTerminalIo, selectTerminalChannel } from "./providers/terminal.ts";
import { setPatchPath, type SessionOverlay } from "./settings.ts";
import { NotifySettingsComponent, type ItemValue, type NotifySettingsSummary, type SettingsHost } from "./ui.ts";
import type { Logger, NotificationConfig, NotificationService } from "./types.ts";

export interface CommandDeps {
  log: Logger;
  config(): NotificationConfig;
  configLoad(): ConfigLoadResult;
  service(): NotificationService;
  agentDir(): string;
  /** Re-reads the config and applies the current session overlay, without rebuilding the extension. */
  reload(ctx: ExtensionCommandContext): void;
  /** Session-level silence flag, set by `--no-notify`. */
  isSilenced(): boolean;
  /** Session id loaded at first enable, used for display. */
  sessionId(): string | undefined;
  /** True while a user prompt is open. */
  isWaitingForUser?(): boolean;
  /** Session overlay; the command layer only reads it, writes go through `setOverlay`. */
  overlay(): SessionOverlay;
  /** Writes the overlay: applies the effective config and persists a session entry. */
  setOverlay(next: SessionOverlay): void;
  /** Raw user file, re-read on every call, used for the presence of sparse user defaults. */
  userRaw(): unknown;
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
  lines.push(`  用户默认: ${userConfigPath(deps.agentDir())}（单项保存，未保存的项跟随出厂默认）`);
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

/** print/json notify is a no-op, so stderr keeps the stdout protocol clean. */
function report(ctx: ExtensionCommandContext, text: string, type: "info" | "warning" | "error" = "info"): void {
  ctx.ui.notify(text, type);
  if (ctx.mode === "print" || ctx.mode === "json") process.stderr.write(`${text}\n`);
}

function configView(config: NotificationConfig): string {
  // Provider options may hold arbitrary header or query credentials; never guess secret names
  // with a regex.
  const visible = { ...config, providers: config.providers.map(({ options: _options, ...provider }) => ({ ...provider, options: "[隐藏，请在配置文件查看]" })) };
  return sanitize(JSON.stringify(visible, null, 2), 12000);
}

/** While the session is force-silenced the UI must not be able to turn notifications on. */
function forcedOff(deps: CommandDeps): boolean {
  return deps.isSilenced() || isDisabledByEnv();
}

/**
 * Connects the UI write requests to the real config and persistence.
 *
 * Enter (setValue) writes the session overlay, effective immediately and preserved across
 * `/reload` for the same conversation. Ctrl+S (saveDefault) performs one sparse write and then
 * re-reads the config so both the current value and the user default are fresh.
 */
function createSettingsHost(ctx: ExtensionCommandContext, deps: CommandDeps): SettingsHost {
  const applyPatch = (item: Parameters<SettingsHost["setValue"]>[0], value: ItemValue): { ok: true; message: string } | { ok: false; message: string } => {
    const patch = item.patch(value);
    const next: SessionOverlay = {
      patch: patch.kind === "providers" ? deps.overlay().patch : setPatchPath(deps.overlay().patch, patch.path, patch.value),
      providers: patch.kind === "providers"
        ? { ...deps.overlay().providers, [patch.id]: patch.value }
        : { ...deps.overlay().providers },
    };
    deps.setOverlay(next);
    return { ok: true, message: `已应用（仅本对话）· ${item.format(item.read(deps.config()))}` };
  };

  return {
    config: () => deps.config(),
    userRaw: () => deps.userRaw(),

    setValue(item, value) {
      if (item.id === "enabled" && forcedOff(deps) && value === true) {
        return { ok: false, message: "本会话被 --no-notify / PI_NOTIFY_DISABLE 强制静默，界面无法开启通知" };
      }
      return applyPatch(item, value);
    },

    saveDefault(item, value) {
      if (item.id === "enabled" && forcedOff(deps) && value === true) {
        return { ok: false, message: "本会话被强制静默；强制关闭不会被写成用户默认" };
      }
      const patch = item.patch(value);
      const filePatch = patch.kind === "providers"
        ? {
          // Providers are an array field: the whole array is written, taken from the effective
          // config (including this conversation's switches), so Ctrl+S really means "freeze the
          // current value as the user default".
          providers: deps.config().providers.map((provider) => (
            provider.id === patch.id ? { ...provider, enabled: patch.value } : { ...provider }
          )),
        }
        : setPatchPath({}, patch.path, patch.value);
      const result = writeUserDefault(deps.agentDir(), filePatch);
      if (!result.ok) {
        const problems = result.problems.map((problem) => sanitizeError(`${problem.path}: ${problem.message}`));
        deps.log.record({ event: "notify_default_write_failed", item: item.id, problems });
        return { ok: false, message: `保存失败，用户文件未改动：${problems.join("; ")}` };
      }
      deps.reload(ctx); // Re-read only after a successful write, so both layers refresh together.
      deps.log.record({ event: "notify_default_saved", item: item.id, path: patch.kind === "providers" ? `providers.${patch.id}.enabled` : patch.path });
      return { ok: true, message: `已保存为默认 · ${sanitize(userConfigPath(deps.agentDir()), 2000)}` };
    },

    test() {
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
        // Self-tests bypass quiet hours, coalescing and cooldown: otherwise a self-test right
        // after a run would be swallowed by the cooldown and read as a broken channel.
        { bypassFilters: true },
      );
      const selection = selectTerminalChannel(createDefaultTerminalIo().environment());
      deps.log.record({ event: "notify_test", channel: selection.channel, reason: selection.reason ?? null });
      const base = selection.channel === "none"
        ? `已提交自检通知，但本地渠道不可用：${selection.reason}`
        : `已提交自检通知（机制 ${selection.channel}）`;
      const quiet = deps.service().isQuietHours()
        ? " 当前处于静默时段，真实通知会被静默；本次自检绕过静默。"
        : "";
      return { ok: true, message: base + quiet };
    },

    reload() {
      deps.reload(ctx);
      const load = deps.configLoad();
      deps.log.record({ event: "notify_reload", degraded: load.degraded });
      return load.degraded
        ? { ok: false, message: "已重新读取配置：配置有问题，当前是降级后的安全子集（Ctrl+O 看状态）" }
        : { ok: true, message: "已重新读取配置（未重载扩展）" };
    },

    statusLines: () => formatStatus(deps).split("\n"),
  };
}

export async function handleNotifyCommand(args: string, ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
  const trimmed = (args ?? "").trim();

  // Single entry point: subcommands were removed, so point the user somewhere instead of
  // silently doing nothing.
  if (trimmed !== "") {
    deps.log.record({ event: "notify_usage", args: sanitize(trimmed, 100) });
    report(ctx, `通知设置已收敛为单一入口：直接输入 /notify 打开设置。\n状态总览 Ctrl+O、自检 Ctrl+T、重读配置 Ctrl+R 都在设置界面里。`, "warning");
    return;
  }

  if (ctx.mode !== "tui") {
    // Non-TUI never opens the component (custom() is unavailable over RPC); it prints the status
    // and paths and writes nothing.
    deps.log.record({ event: "notify_settings_view", mode: ctx.mode });
    report(ctx, `${formatStatus(deps)}\n\n设置界面仅 TUI 可用；用户级默认文件: ${sanitize(userConfigPath(deps.agentDir()), 2000)}\n当前生效值（渠道 options 隐藏）:\n${configView(deps.config())}`);
    return;
  }

  const host = createSettingsHost(ctx, deps);
  const summary = await ctx.ui.custom<NotifySettingsSummary | undefined>((tui, theme, keybindings, done) => {
    const component = new NotifySettingsComponent({
      theme,
      keybindings,
      host,
      requestRender: () => tui.requestRender(),
      done,
    });
    return {
      render: (width: number) => component.render(width),
      handleInput: (data: string) => component.handleInput(data),
      invalidate: () => component.invalidate(),
    };
  });
  deps.log.record({
    event: "notify_settings_closed",
    savedDefaults: summary?.savedDefaults ?? 0,
    changed: summary?.changed ?? 0,
  });
}

/** Reused by the non-TUI branches: sanitized status text and config view. */
export { formatStatus as formatNotifyStatus, configView as notifyConfigView };
