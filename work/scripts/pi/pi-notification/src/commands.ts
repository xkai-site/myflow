/** /notify entry and host-mode adaptation only. Application operations never depend on the TUI. */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { userConfigPath } from "./config.ts";
import { sanitize } from "./log.ts";
import { createSettingsHost, formatNotifyStatus, notifyConfigView, type SettingsDeps } from "./settings-actions.ts";
import { NotifySettingsComponent, type NotifySettingsSummary } from "./ui.ts";

export type CommandDeps = Omit<SettingsDeps, "reload"> & { reload(ctx: ExtensionCommandContext): void };

/** Print/json notify is a no-op; stderr leaves the stdout protocol clean. */
function report(ctx: ExtensionCommandContext, text: string, type: "info" | "warning" = "info"): void {
  ctx.ui.notify(text, type);
  if (ctx.mode === "print" || ctx.mode === "json") process.stderr.write(`${text}\n`);
}
export async function handleNotifyCommand(args: string, ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
  const trimmed = args.trim();
  if (trimmed !== "") {
    deps.log.record({ event: "notify_usage", args: sanitize(trimmed, 100) });
    report(ctx, "不支持此参数。请输入 /notify 打开通知设置。", "warning");
    return;
  }
  const settings: SettingsDeps = { ...deps, reload: () => deps.reload(ctx) };
  // hasUI is also true over RPC, where custom() is unavailable.
  if (ctx.mode !== "tui") {
    deps.log.record({ event: "notify_settings_view", mode: ctx.mode });
    report(ctx, `${formatNotifyStatus(settings)}\n\n设置界面仅 TUI 可用；用户级默认文件: ${sanitize(userConfigPath(deps.agentDir()), 2000)}\n当前生效值（渠道 options 隐藏）:\n${notifyConfigView(deps.config())}`);
    return;
  }
  const host = createSettingsHost(settings);
  const summary = await ctx.ui.custom<NotifySettingsSummary | undefined>((tui, theme, keybindings, done) =>
    new NotifySettingsComponent({ theme, keybindings, host, requestRender: () => tui.requestRender(), done }));
  deps.log.record({ event: "notify_settings_closed", savedDefaults: summary?.savedDefaults ?? 0, changed: summary?.changed ?? 0 });
}
