/**
 * `/notify` 命令（设计 §10.3；UX 方案 §信息架构）。
 *
 * **唯一入口**：不带参数打开通知设置（TUI）；旧子命令已移除。
 * 原有能力仍在，只是折叠进设置界面：`Ctrl+T` 自检、`Ctrl+R` 重读、`Ctrl+O` 状态总览，
 * 非 TUI（print/json/rpc）则直接打印状态与配置文件路径。
 *
 * 三个值的归属在这里落地：
 *  - 出厂默认：只读（config.ts）
 *  - 用户级默认：Ctrl+S → `writeUserDefault`（**单项稀疏写盘**）
 *  - 本对话：Enter → 会话覆盖（overlay）→ 由 index.ts 应用并写 `pi.appendEntry`
 *
 * 官方 `ctx.ui.notify` **不能**作为外部投递成功的证据（§1.8）。
 *
 * 注意（§2.2 第 6 点）：用 `ctx.mode === "tui"` 而不是 `hasUI` 守卫终端 UI —— RPC 下 hasUI 也为真，
 * 但那里的对话框语义不同，`ctx.ui.custom` 在 RPC 下不可用。`ui.notify` 在 print/json 下是 no-op。
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
  /** 重新读盘并应用当前会话覆盖（不重建扩展/生命周期） */
  reload(ctx: ExtensionCommandContext): void;
  /** 会话级静默标志（`--no-notify`） */
  isSilenced(): boolean;
  /** 首次启用时载入的会话 id，用于展示 */
  sessionId(): string | undefined;
  /** 当前是否在等用户输入（S6 的 waiting 状态） */
  isWaitingForUser?(): boolean;
  /** 本对话覆盖（可变引用；命令层只读它，写走 setOverlay） */
  overlay(): SessionOverlay;
  /** 写入本对话覆盖：应用生效配置 + 落会话条目 */
  setOverlay(next: SessionOverlay): void;
  /** 原始用户文件（稀疏用户默认的存在性），每次调用都重新读盘 */
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

/** 会话被强制静默时，界面不应能把它打开，也不该把它写进用户默认。 */
function forcedOff(deps: CommandDeps): boolean {
  return deps.isSilenced() || isDisabledByEnv();
}

/**
 * 把界面的写入请求接到真实的配置/持久化上。
 *
 * - Enter（setValue）→ 本对话覆盖（内存 + 会话条目），立即生效、跨 `/reload` 与同一对话恢复保留；
 * - Ctrl+S（saveDefault）→ 单项稀疏写盘（只写这一项），随后重读配置让“当前值/用户默认”都新鲜。
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
          // 渠道是数组字段：写盘要写整个数组，取「当前生效」的那一份（含本对话的开关），
          // 这样 Ctrl+S 的语义才是“把当前值固化为用户默认”。
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
      deps.reload(ctx); // 成功落盘后才重读，让用户默认与当前值一起刷新
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
        // 自检绕过静默时段/合并/冷却：否则刚跑完一个任务再自检会被冷却吃掉，
        // 用户会把它误读成「渠道坏了」。
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

  // 单一入口：子命令已移除。给一句明确指路，而不是静默什么都不做。
  if (trimmed !== "") {
    deps.log.record({ event: "notify_usage", args: sanitize(trimmed, 100) });
    report(ctx, `通知设置已收敛为单一入口：直接输入 /notify 打开设置。\n状态总览 Ctrl+O、自检 Ctrl+T、重读配置 Ctrl+R 都在设置界面里。`, "warning");
    return;
  }

  if (ctx.mode !== "tui") {
    // 非 TUI 不打开组件（RPC 下 custom() 不可用），只打印状态与路径，且不写盘。
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

/** 供非 TUI 分支复用（状态文本与脱敏视图）。 */
export { formatStatus as formatNotifyStatus, configView as notifyConfigView };
