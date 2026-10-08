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
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  describeConfig,
  isDisabledByEnv,
  readUserConfigRaw,
  userConfigPath,
  writeUserDefault,
  deleteUserDefault,
  type ConfigLoadResult,
} from "./config.ts";
import { sanitize, sanitizeError } from "./log.ts";
import { resolveQqCredential, saveQqCredential, deleteQqCredential } from "./mail/credentials.ts";
import { createDefaultTerminalIo, selectTerminalChannel } from "./providers/terminal.ts";
import { evaluateRunOutcome, resolveChannels } from "./rules.ts";
import { testBlockMessage, emailReadiness, buildSettingItems, channelLabel, patchOperations, applyOverlay, applySettingPatch, settingSnapshot, settingUserFilePatch, itemRemovals, builtinDefaultValue, clearItemOverride, emailTestBlockReason, QQ_MAIL_URL, sessionOverrideValue, type SessionOverlay } from "./settings.ts";
import { NotifySettingsComponent, type ItemValue, type NotifySettingsSummary, type SettingsHost, type SettingsRestriction } from "./ui.ts";
import type { ApiSnapshot, Logger, NotificationConfig, NotificationService, RunOutcome, RunSummary, TestProgress } from "./types.ts";

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
  apiSnapshot?(): ApiSnapshot;
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

  const email = config.providers.find((provider) => provider.id === "email");
  const emailConfigured = email?.enabled === true
    && typeof email.options.from === "string" && email.options.from !== ""
    && Array.isArray(email.options.to) && email.options.to.length > 0;
  const lines: string[] = [];
  lines.push(`pi-notification: ${config.enabled && !deps.isSilenced() ? "开启" : "关闭"}${deps.isSilenced() ? "（--no-notify）" : ""}`);
  const activeChannels = [...new Set(Object.values(config.rules).filter((rule) => rule.enabled).flatMap((rule) => resolveChannels(config, rule)))];
  const issue = forcedOff(deps) ? "本对话已强制静默，请检查启动参数或环境变量。" : !config.enabled ? "提醒已暂停，请开启首页的提醒总开关。"
    : !activeChannels.length ? "没有提醒使用任何接收方式，请选择在哪里接收。"
      : !activeChannels.some((id) => config.providers.some((provider) => provider.id === id && provider.enabled)) ? "提醒使用的接收方式已关闭或不存在，请检查接收方式开关。"
        : deps.service().isQuietHours() ? "当前为免打扰时段，部分提醒暂停；显式测试不受影响。" : "提醒已启用。没有收到时，请先发送测试查看具体结果。";
  lines.push(`  当前情况：${issue}`);
  const readiness = emailReadiness(config, resolveQqCredential().source !== "missing");
  lines.push(`  邮箱：${readiness.label}；${readiness.usedBy} 类提醒使用邮箱。`);
  lines.push("  技术详情（供进一步排查）：");
  lines.push(`  规则/渠道: ${describeConfig(config)}`);
  if (deps.sessionId()) lines.push(`  会话: ${deps.sessionId()}${deps.isWaitingForUser?.() ? "（正在等你输入）" : ""}`);
  // “Rule enabled” only means “passes the filter”; it is never a promise that a notification was
  // delivered, and no enabled channel is a state worth spelling out.
  const enabledProviders = config.providers.filter((provider) => provider.enabled);
  lines.push(enabledProviders.length === 0
    ? "  送达前提: 没有启用的渠道，通知不会到达任何地方"
    : `  送达前提: ${enabledProviders.length} 个渠道启用；规则开启只表示通过筛选，实际送达取决于渠道可用性`);
  lines.push(
    `  合并/冷却: 同运行窗口 ${config.coalesce.windowMs}ms / 同 kind 冷却 ${config.coalesce.cooldownMs}ms`
    + ` / 工具失败 ${config.rules.toolFailed.mode}(${config.rules.toolFailed.threshold})`,
  );
  const quiet = config.quietHours;
  lines.push(`  静默时段: ${quiet.start}–${quiet.end}（${!quiet.enabled ? "未开启" : deps.service().isQuietHours() ? "当前生效" : "当前未生效"}；本地时间；例外 ${quiet.exceptLevels.join(",") || "无"}）`);  lines.push(`  配置来源: ${load.sources.join(" → ")}${load.degraded ? "（已降级）" : ""}`);
  lines.push(`  用户默认: ${userConfigPath(deps.agentDir())}（单项保存，未保存的项跟随出厂默认）`);
  const credentialSource = resolveQqCredential().source;
  const credentialStatus = credentialSource === "vault" ? "Windows 凭据管理器已设置" : credentialSource === "environment" ? "环境变量已设置（回退）" : "未设置";
  lines.push(`  终端机制: ${selection.channel}${selection.reason ? `（${selection.reason}）` : ""}；邮箱 ${email?.enabled ? (emailConfigured ? "已启用且参数齐全" : "已启用但不可用") : "已关闭"}；QQ SMTP 授权码：${credentialStatus}`);
  lines.push(
    `  投递统计: 成功 ${snapshot.delivered} / 失败 ${snapshot.failed} / 跳过 ${snapshot.skipped} / 去重 ${snapshot.deduped}`
    + ` / 合并 ${snapshot.coalesced} / 冷却 ${snapshot.cooled}`
    + ` / 丢弃 ${snapshot.dropped} / 在队 ${snapshot.queued} / 在途 ${snapshot.active}`,
  );
  const api = deps.apiSnapshot?.();
  lines.push(`  机器 API（独立开关）: 配置${config.api.enabled ? "开启" : "关闭"} / 当前${api?.enabled ? "开启" : "关闭"}${forcedOff(deps) ? "（强制静默：通知与 API 均不外发）" : ""}`);
  if (api) {
    lines.push(`  API 统计: 成功 ${api.delivered} / 失败 ${api.failed} / 丢弃 ${api.dropped} / 在队 ${api.queued} / 在途 ${api.active}；best-effort，无补发/心跳`);
    if (api.lastError) lines.push(`  API 错误: ${sanitizeError(api.lastError)}`);
  }
  for (const [providerId, counts] of Object.entries(snapshot.byProvider)) {
    lines.push(`  渠道 ${providerId}: 成功 ${counts.delivered} / 失败 ${counts.failed} / 跳过 ${counts.skipped}`);
  }
  lines.push(`  上次成功: ${snapshot.lastOkAt ? new Date(snapshot.lastOkAt).toLocaleString() : "—"}`);
  if (snapshot.lastError) {
    const smtpDiagnostic = /^(.*)，SMTP 错误代码：([A-Z0-9_]{1,32})$/.exec(snapshot.lastError);
    if (smtpDiagnostic) {
      lines.push(`  上次错误: ${smtpDiagnostic[1]}`);
      lines.push(`  SMTP 错误代码: ${smtpDiagnostic[2]}`);
    } else {
      lines.push(`  上次错误: ${snapshot.lastError}`);
    }
  }
  // The four diagnostic groups the status page keeps apart: config blocking, current silence, the
  // self-test submission and the real delivery counters. Placed after the session line so the
  // waiting state stays inside the first page.
  lines.push("  测试提醒：Ctrl+T 测试当前接收方式。");
  lines.push("  测试忽略重要程度和免打扰，不绕过强制静默或关闭的接收方式。");
  lines.push("  接收服务接受不等于实际送达，请确认是否看到或收到。");
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
  const visible = { ...config, api: { enabled: config.api.enabled, options: "[隐藏，请在用户配置文件查看]" },
    providers: config.providers.map(({ options: _options, ...provider }) => ({ ...provider, options: "[隐藏，请在配置文件查看]" })) };
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
  /** Item name used by every feedback message, so a confirmation names what it changed. */
  const name = (item: Parameters<SettingsHost["setValue"]>[0]): string => `${item.group} · ${item.label}`;

  /** Session-level restrictions that override the user's own setting; shown as extra limits, never as a user default. */
  const restrictions = (): SettingsRestriction[] => {
    const list: SettingsRestriction[] = [];
    if (deps.isSilenced()) list.push({ label: "强制静默", reason: "--no-notify" });
    if (isDisabledByEnv()) list.push({ label: "强制静默", reason: "PI_NOTIFY_DISABLE" });
    return list;
  };

  const applyPatch = (item: Parameters<SettingsHost["setValue"]>[0], value: ItemValue): { ok: true; message: string } | { ok: false; message: string } => {
    const patch = item.patch(value);
    if (forcedOff(deps) && patchOperations(patch).some((operation) => operation.kind === "providers" && operation.value)) {
      return { ok: false, message: "本对话已强制静默，不能开启接收方式。" };
    }
    const next = applySettingPatch(deps.overlay(), item, patch);
    const checked = applyOverlay(deps.config(), next);
    if (checked.problems.length) return { ok: false, message: `未应用「${name(item)}」：${checked.problems.map((problem) => sanitizeError(`${problem.path}: ${problem.message}`)).join(";")}` };
    deps.setOverlay(next);
    return { ok: true, message: `已应用（仅本对话）「${name(item)}」= ${item.format(item.read(deps.config()))}；Ctrl+S 可设为以后默认` };
  };

  const sendTest = (channels: string[], onProgress?: (progress: TestProgress) => void) => {
    if (forcedOff(deps)) return { ok: false, message: testBlockMessage("silenced") };
    const id = `manual:${randomUUID()}`;
    const sessionId = deps.sessionId();
    const result = deps.service().submit({
      level: "info", kind: "run_completed", title: "Pi 测试提醒", body: "这是一条固定内容测试。请确认是否看到；发送接口接受不代表实际显示或进入收件箱。",
      dedupeKey: id, channels: [...channels], meta: { sessionId: sessionId ?? "manual", runId: id, level: "info" },
    }, { manualTest: true, onProgress: (event) => { if (deps.sessionId() === sessionId) onProgress?.(event); } });
    deps.log.record({ event: "notify_test", id, accepted: result.accepted, channels, ...(result.accepted ? {} : { reason: result.reason }) });
    return result.accepted ? { ok: true, message: "已排队；尚不代表已经收到。", unsubscribe: result.unsubscribe }
      : { ok: false, message: testBlockMessage(result.reason) };
  };

  return {
    config: () => deps.config(),
    userRaw: () => deps.userRaw(),
    sessionOverride: (item) => sessionOverrideValue(deps.overlay(), item),
    restrictions,

    setValue(item, value) {
      if (item.id === "enabled" && forcedOff(deps) && value === true) {
        return { ok: false, message: `已拒绝「${name(item)}」= 开启：本会话被 --no-notify / PI_NOTIFY_DISABLE 强制静默（额外限制，不是你的默认值），界面无法开启通知` };
      }
      return applyPatch(item, value);
    },

    saveDefault(item, value) {
      if (item.id === "enabled" && forcedOff(deps)) {
        return { ok: false, message: `不能保存「${name(item)}」：本对话已强制静默；这项临时限制不会保存成以后默认。` };
      }
      const current = deps.config();
      const patch = settingSnapshot(item, current);
      const result = writeUserDefault(deps.agentDir(), (raw) => settingUserFilePatch(raw, current, patch));
      if (!result.ok) {
        const problems = result.problems.map((problem) => sanitizeError(`${problem.path}: ${problem.message}`));
        deps.log.record({ event: "notify_default_write_failed", item: item.id, problems });
        return { ok: false, message: `保存失败「${name(item)}」：用户文件未改动（${problems.join("; ")}）` };
      }
      deps.reload(ctx); // Re-read only after a successful write, so both layers refresh together.
      deps.log.record({ event: "notify_default_saved", item: item.id, path: item.paths ?? item.userPath });
      return { ok: true, message: `已保存为默认「${name(item)}」= ${item.format(item.read(deps.config()))}（作用范围：以后默认；其他本对话修改未保存；${sanitize(userConfigPath(deps.agentDir()), 2000)}）` };
    },

    testEmail(onProgress) {
      if (forcedOff(deps)) return { ok: false, message: testBlockMessage("silenced") };
      const reason = emailTestBlockReason(deps.config(), resolveQqCredential().source !== "missing");
      if (reason) return { ok: false, message: `邮箱测试未发送：${reason}` };
      return sendTest(["email"], onProgress);
    },

    credentialStatus() {
      const source = resolveQqCredential().source;
      return source === "vault" ? "已保存于 Windows 凭据管理器" : source === "environment" ? "使用环境变量（兼容回退）" : "未设置";
    },

    saveCredential(value) {
      const ok = saveQqCredential(value);
      deps.log.record({ event: "notify_qq_credential_saved", ok });
      return ok
        ? { ok: true, message: "QQ SMTP 授权码已保存到 Windows 凭据管理器（未写入配置或会话）。" }
        : { ok: false, message: "保存授权码失败：当前系统的 Windows 凭据管理器不可用，或输入不符合要求。" };
    },

    deleteCredential() {
      const ok = deleteQqCredential();
      deps.log.record({ event: "notify_qq_credential_deleted", ok });
      return ok
        ? { ok: true, message: resolveQqCredential().source === "environment" ? "已从 Windows 凭据管理器移除；仍会使用环境变量中的授权码。" : "已从 Windows 凭据管理器移除授权码。" }
        : { ok: false, message: "移除失败：Windows 凭据管理器不可用或没有可移除的授权码。" };
    },

    openQqSettings() {
      if (process.platform !== "win32") return { ok: false, message: `请在浏览器中打开 ${QQ_MAIL_URL}，登录后进入「设置 → 帐户」。` };
      try {
        const child = spawn("explorer.exe", [QQ_MAIL_URL], { detached: true, stdio: "ignore" });
        child.on("error", () => {});
        child.unref();
        return { ok: true, message: "正在打开 QQ 邮箱官网；登录后进入「设置 → 帐户」，开启 SMTP 并生成授权码。" };
      } catch {
        return { ok: false, message: `未能打开浏览器，请手动访问 ${QQ_MAIL_URL}` };
      }
    },

    test(channels, onProgress) {
      return sendTest(channels ?? deps.config().channels, onProgress);
    },

    reload() {
      deps.reload(ctx);
      const load = deps.configLoad();
      deps.log.record({ event: "notify_reload", degraded: load.degraded });
      return load.degraded
        ? { ok: false, message: "已重新读取配置：配置有问题，当前是降级后的安全子集（Ctrl+O 看状态）" }
        : { ok: true, message: "已重新读取配置（未重载扩展）" };
    },

    /** “沿用以后默认”: drop only this conversation's override, so the user default applies again. */
    followUserDefault(item) {
      deps.setOverlay(clearItemOverride(deps.overlay(), item));
      deps.log.record({ event: "notify_override_cleared", item: item.id });
      return { ok: true, message: `已沿用以后默认「${name(item)}」：本对话不再覆盖（当前 ${item.format(item.read(deps.config()))}）` };
    },

    /** “恢复此项内置默认”: clear the user default and the conversation override for one item. */
    restoreBuiltinDefault(item) {
      const result = deleteUserDefault(deps.agentDir(), itemRemovals(item, deps.config(), deps.overlay()));
      if (!result.ok) {
        const problems = result.problems.map((problem) => sanitizeError(`${problem.path}: ${problem.message}`));
        deps.log.record({ event: "notify_default_delete_failed", item: item.id, problems });
        return { ok: false, message: `恢复失败「${name(item)}」：用户文件未改动（${problems.join("; ")}）` };
      }
      // Only after the file is clean does the conversation override go away: a failed write must not
      // silently drop this conversation's value.
      deps.setOverlay(clearItemOverride(deps.overlay(), item));
      deps.log.record({ event: "notify_default_removed", item: item.id, path: item.userPath });
      if (item.id === "enabled" && forcedOff(deps) && builtinDefaultValue(item) === true) {
        // The default really is back to on, but the session-level silence still wins; never bypass it.
        return { ok: true, message: `已恢复「${name(item)}」内置默认（开启）；但本会话仍被强制静默，界面无法绕过` };
      }
      return { ok: true, message: `已恢复「${name(item)}」内置默认（当前 ${item.format(item.read(deps.config()))}）` };
    },

    /**
     * Read-only example body. A clone of the effective config is used with the completion rule turned
     * on only for the example, and the data is fixed: nothing reads the conversation, and nothing is
     * submitted, so a preview can never notify anyone.
     */
    preview() {
      const config: NotificationConfig = structuredClone(deps.config());
      config.rules.runCompleted = { ...config.rules.runCompleted, enabled: true };
      const failures = [{ toolName: "bash", count: 1 }];
      const outcome: RunOutcome = {
        sessionId: "preview", runId: "preview", status: "completed", startedAt: 0,
        durationMs: 42300, stopReason: "end_turn", toolFailures: failures,
        costUsd: 0.0123, assistantExcerpt: "已修复登录 bug",
      };
      const summary: RunSummary = {
        runStatus: "completed", durationMs: 42300, toolFailures: failures,
        sessionName: "示例会话", projectName: "myflow", cumulativeCostUsd: 0.0456, contextPercent: 42,
      };
      const request = evaluateRunOutcome({ outcome, summary }, config);
      const lines = [
        "示例（不会发送）：以下内容用固定数据生成，不读取你的真实对话，也不会提交投递。",
        request
          ? `规则：${request.kind} · 级别：${request.level} · 渠道：${request.channels.join("、") || "（无）"}`
          : "“运行完成”规则当前被关闭，无法生成示例正文；可先开启该规则。",
        request ? `标题：${request.title}` : "",
        request ? `正文：${request.body}` : "",
        "说明：实际送达取决于渠道可用性、静默时段与总开关；上面这条只是内容示意，不代表已送达。",
      ].filter((line) => line !== "");
      deps.log.record({ event: "notify_preview" });
      return { ok: true, message: "通知预览（内容示意，不会发送）", lines };
    },

    itemScope: (item) => itemRemovals(item, deps.config(), deps.overlay()).map((entry) => entry.kind === "path"
      ? buildSettingItems(deps.config()).find((candidate) => candidate.userPath === entry.path)?.label ?? "此设置项"
      : `${channelLabel(entry.id)} · ${entry.kind === "provider" ? "开关" : "邮箱设置"}`),
    statusLines: () => formatStatus(deps).split("\n"),
  };
}

export async function handleNotifyCommand(args: string, ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
  const trimmed = (args ?? "").trim();

  // Single entry point: subcommands were removed, so point the user somewhere instead of
  // silently doing nothing.
  if (trimmed !== "") {
    deps.log.record({ event: "notify_usage", args: sanitize(trimmed, 100) });
    report(ctx, `通知设置已收敛为单一入口：直接输入 /notify 打开设置。\n状态与诊断 Ctrl+O、测试通知 Ctrl+T、重读配置 Ctrl+R 都在设置界面里。`, "warning");
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
      dispose: () => component.dispose(),
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
