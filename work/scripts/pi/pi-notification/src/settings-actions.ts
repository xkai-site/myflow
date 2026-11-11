/** Application operations and read-only diagnostics for notification settings.
 * Owns session transactions, atomic defaults, credential IO and test submission.
 * No terminal component or SDK context: callers supply the reload operation.
 */

import { randomUUID } from "node:crypto";

import {
  describeConfig,
  loadConfig,
  isDisabledByEnv,
  userConfigPath,
  writeUserDefault,
  deleteUserDefault,
  type ConfigLoadResult,
} from "./config.ts";
import { sanitize, sanitizeError } from "./log.ts";
import { QQ_MAIL_URL, type QqCredentials, type CredentialStatus } from "./mail/credentials.ts";
import { createDefaultTerminalIo, selectTerminalChannel } from "./providers/terminal.ts";
import { evaluateRunOutcome } from "./rules.ts";
import { validateHttpOptions } from "./providers/http.ts";
import { buildSettingItems, channelLabel, type SettingItem, type SettingPatch, type SettingValue } from "./settings.ts";
import { patchOperations, applyOverlay, applySettingPatch, settingSnapshot, settingUserFilePatch, itemRemovals, builtinDefaultValue, clearItemOverride, sessionOverrideValue, pendingPatch, type SessionOverlay } from "./settings-state.ts";
import { emailActivationIssue, channelActivation, controlStatus, emailReadiness, emailRequirement, emailTestBlockReason, type ChannelActivation } from "./channels.ts";
import type { ApiSnapshot, Logger, NotificationConfig, NotificationService, RunOutcome, RunSummary, TestProgress } from "./types.ts";

export type ItemValue = SettingValue | SettingValue[];
export interface ActionResult {
  ok: boolean;
  message: string;
  feedback?: { kind: "blocked" | "recoverable" | "unknown" | "progress" | "delivery"; next?: "email" | "diagnostics" | "home"; details?: string[] };
}
export interface SettingsRestriction { label: string; reason: string }
export interface SettingsTestResult extends ActionResult { unsubscribe?: () => void }
export interface SettingsHost {
  config(): NotificationConfig;
  userRaw(): unknown;
  runtimeState(): { degraded?: boolean; configError?: boolean; quiet?: boolean; terminalIssue?: string; channelIssues?: string[] };
  sessionOverride(item: SettingItem): unknown;
  restrictions(): SettingsRestriction[];
  setValue(item: SettingItem, value: ItemValue): ActionResult;
  /** Snapshot the effective value, never a hovered candidate. */
  saveDefault(item: SettingItem): ActionResult;
  saveChanges(items: readonly SettingItem[]): ActionResult;
  channelActivation(id: string): ChannelActivation;
  enableChannel(id: string): ActionResult;
  test(channels?: string[], onProgress?: (progress: TestProgress) => void): SettingsTestResult;
  testEmail(onProgress?: (progress: TestProgress) => void): SettingsTestResult;
  credentialStatus(): string;
  credentialState(): CredentialStatus;
  saveCredential(value: string): ActionResult;
  deleteCredential(): ActionResult;
  openQqSettings(): ActionResult | Promise<ActionResult>;
  reload(): ActionResult;
  statusLines(): string[];
  followUserDefault(item: SettingItem): ActionResult;
  restoreBuiltinDefault(item: SettingItem): ActionResult;
  itemScope(item: SettingItem): string[];
  preview(): { ok: boolean; message: string; lines: string[] };
}
export { QQ_MAIL_URL } from "./mail/credentials.ts";
export function testBlockMessage(reason: string): string {
  const messages: Record<string, string> = {
    silenced: "未发送：当前对话已强制静默，无法开启通知。", disabled: "未发送：请先开启通知总开关。",
    below_min_level: "未发送：此通知的重要程度低于接收范围。", no_channels: "未发送：请先选择接收方式。",
    no_available_channels: "未发送：选中的接收方式已关闭或不存在；请检查接收方式开关。", duplicate: "未发送：该测试已提交。",
    filtered: "未发送：该通知被当前设置筛选。", queue_full: "未发送：等待发送的提醒已满，请稍后重试。",
    queue_replaced: "未发送：等待期间被更重要的提醒替换，请重试。", disposed: "未发送：设置已重载或对话已结束，请重新打开设置测试。",
    internal_error: "测试未完成：请在状态与诊断中查看原因。",
  };
  return messages[reason] ?? "测试未完成。请查看诊断后重试。";
}

export interface SettingsDeps {
  credentials: QqCredentials;
  /** Optional browser/link capability belongs to the host, never to the mail core. */
  openUrl?(url: string): Promise<boolean>;
  log: Logger;
  config(): NotificationConfig;
  configLoad(): ConfigLoadResult;
  service(): NotificationService;
  agentDir(): string;
  /** Re-reads the config and applies the current session overlay, without rebuilding the extension. */
  reload(): void;
  /** Session-level silence flag, set by `--no-notify`. */
  isSilenced(): boolean;
  /** Session id loaded at first enable, used for display. */
  sessionId(): string | undefined;
  /** True while a user prompt is open. */
  isWaitingForUser?(): boolean;
  apiSnapshot?(): ApiSnapshot;
  /** Session overlay; writes go through `setOverlay`. */
  overlay(): SessionOverlay;
  /** Writes the overlay: applies the effective config and persists a session entry. */
  setOverlay(next: SessionOverlay): void;
  /** Raw user file, re-read on every call, used for the presence of sparse user defaults. */
  userRaw(): unknown;
}

/** Local preflight only: no probe, channel creation, or network request. Technical reasons stay
 * in diagnostics, while the model receives only the unusable ids. */
function channelProblems(config: NotificationConfig): Array<{ id: string; reason: string }> {
  return config.providers.flatMap((provider) => {
    const reason = provider.type === "webhook" ? validateHttpOptions(provider.options)
      : !["terminal", "email", "debug"].includes(provider.type) ? "未注册的接收方式类型" : undefined;
    return reason ? [{ id: provider.id, reason }] : [];
  });
}

function formatStatus(deps: SettingsDeps): string {
  const config = deps.config();
  const load = deps.configLoad();
  const snapshot = deps.service().snapshot();
  const selection = selectTerminalChannel(createDefaultTerminalIo().environment());

  const email = config.providers.find((provider) => provider.id === "email");
  const credential = deps.credentials.status();
  const emailConfigured = email?.enabled === true && emailRequirement(email, credential.state === "configured") === undefined;
  const lines: string[] = [];
  const effective = controlStatus(config, { restrictions: forcedOff(deps) ? [{ label: "强制静默", reason: "" }] : [],
    hasCredential: credential.state === "configured", configError: load.errors.length > 0, degraded: load.degraded,
    quiet: deps.service().isQuietHours(), terminalIssue: selection.channel === "none" ? selection.reason ?? "不可用" : undefined,
    channelIssues: channelProblems(config).map((entry) => entry.id) });
  lines.push(`pi-notification: ${effective.label}`);
  if (forcedOff(deps)) lines.push(`  限制来源：${[deps.isSilenced() ? "--no-notify" : "", isDisabledByEnv() ? "PI_NOTIFY_DISABLE" : ""].filter(Boolean).join("、")}`);
  const readiness = emailReadiness(config, credential);
  lines.push(`  邮箱：${readiness.label}；${readiness.usedBy} 类提醒使用邮箱。`);
  lines.push("  诊断详情：");
  for (const issue of channelProblems(config)) lines.push(`  ${channelLabel(issue.id)}：${issue.reason}`);
  lines.push(`  规则/渠道: ${describeConfig(config)}`);
  if (deps.sessionId()) lines.push(`  会话: ${deps.sessionId()}${deps.isWaitingForUser?.() ? "（等待用户输入）" : ""}`);
  // “Rule enabled” only means “passes the filter”; it is never a promise that a notification was
  // delivered, and no enabled channel is a state worth spelling out.
  const enabledProviders = config.providers.filter((provider) => provider.enabled);
  lines.push(enabledProviders.length === 0
    ? "  送达前提: 没有启用的渠道，通知不会发送"
    : `  送达前提: ${enabledProviders.length} 个渠道启用；规则开启只表示通过筛选，实际送达取决于渠道可用性`);
  lines.push(
    `  合并/冷却: 同运行窗口 ${config.coalesce.windowMs}ms / 同 kind 冷却 ${config.coalesce.cooldownMs}ms`
    + ` / 工具失败 ${config.rules.toolFailed.mode}(${config.rules.toolFailed.threshold})`,
  );
  const quiet = config.quietHours;
  lines.push(`  静默时段: ${quiet.start}–${quiet.end}（${!quiet.enabled ? "未开启" : deps.service().isQuietHours() ? "当前生效" : "当前未生效"}；本地时间；例外 ${quiet.exceptLevels.join(",") || "无"}）`);  lines.push(`  配置来源: ${load.sources.join(" → ")}${load.degraded ? "（已降级）" : ""}`);
  lines.push(`  用户默认: ${userConfigPath(deps.agentDir())}（未单独保存的项使用内置默认）`);
  const credentialStatus = credential.message;
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
  lines.push("  服务接受不代表实际送达，请检查接收端。");
  for (const problem of load.errors) lines.push(`  ⚠ 配置错误 ${problem.path}: ${problem.message}`);
  for (const problem of load.warnings) lines.push(`  提示 ${problem.path}: ${problem.message}`);
  return lines.map((line) => sanitizeError(line, Math.max(1, line.length))).join("\n");
}

function configView(config: NotificationConfig): string {
  // Provider options may hold arbitrary header or query credentials; never guess secret names
  // with a regex.
  const visible = { ...config, api: { enabled: config.api.enabled, options: "[隐藏，请在用户配置文件查看]" },
    providers: config.providers.map(({ options: _options, ...provider }) => ({ ...provider, options: "[隐藏，请在配置文件查看]" })) };
  return sanitize(JSON.stringify(visible, null, 2), 12000);
}

/** While the session is force-silenced the UI must not be able to turn notifications on. */
function forcedOff(deps: SettingsDeps): boolean {
  return deps.isSilenced() || isDisabledByEnv();
}

/**
 * Connects the UI write requests to the real config and persistence.
 *
 * Enter (setValue) writes the session overlay, effective immediately and preserved across
 * `/reload` for the same conversation. Ctrl+S (saveDefault) performs one sparse write and then
 * re-reads the config so both the current value and the user default are fresh.
 */
export function createSettingsHost(deps: SettingsDeps): SettingsHost {
  /** Short user-facing summaries and separate, redacted diagnostics. */
  const blocked = (message: string, next: "email" | "diagnostics" | "home" = "diagnostics"): ActionResult =>
    ({ ok: false, message, feedback: { kind: "blocked", next } });
  const failed = (message: string, details: string[] = []): ActionResult => ({ ok: false, message,
    feedback: { kind: details.length ? "recoverable" : "unknown", next: "diagnostics", details: (details.length ? details : ["此操作未返回详细错误信息，无法确定原因。"]).map((text) => sanitizeError(text, Math.max(1, text.length))) } });

  /** Session-level restrictions that override the user's own setting; shown as extra limits, never as a user default. */
  const restrictions = (): SettingsRestriction[] => {
    const list: SettingsRestriction[] = [];
    if (deps.isSilenced()) list.push({ label: "强制静默", reason: "--no-notify" });
    if (isDisabledByEnv()) list.push({ label: "强制静默", reason: "PI_NOTIFY_DISABLE" });
    return list;
  };

  const emailActivationMessage = (config = deps.config()) => emailActivationIssue(config, deps.credentials.status()) ?? "请先完成邮箱配置。";
  const activation = (config: NotificationConfig, id: string) => channelActivation(config, id,
    id === "email" && deps.credentials.status().state === "configured", channelProblems(config).map((entry) => entry.id));
  /** All gate writes share prerequisites; restoration never consumes the plan's routing suggestion. */
  const checkActivation = (next: NotificationConfig, explicitChannels: readonly string[] = []): ActionResult | undefined => {
    const current = deps.config();
    for (const provider of next.providers) {
      if (!provider.enabled) continue;
      const opening = !current.providers.find((entry) => entry.id === provider.id)?.enabled || explicitChannels.includes(provider.id);
      const resumingEmail = provider.id === "email" && !current.enabled && next.enabled;
      if (!opening && !resumingEmail) continue;
      if (opening && forcedOff(deps)) return blocked("强制静默期间无法开启通知。");
      const plan = activation(next, provider.id);
      if (plan.kind === "blocked") return blocked(plan.message);
      if (plan.kind === "email") return blocked(emailActivationMessage(next), "email");
    }
    return undefined;
  };
  const fromDisk = (overlay = deps.overlay()) => applyOverlay(loadConfig({ agentDir: deps.agentDir() }).config, overlay).config;

  const applyPatch = (item: SettingItem, patch: SettingPatch): ActionResult => {
    const next = applySettingPatch(deps.overlay(), item, patch);
    const checked = applyOverlay(deps.config(), next);
    if (checked.problems.length) return failed(`未应用${item.label}。请检查配置。`, checked.problems.map((problem) => `${problem.path}: ${problem.message}`));
    const issue = checkActivation(checked.config, patchOperations(patch).flatMap((op) => op.kind === "providers" && op.value ? [op.id] : []));
    if (issue) return issue;
    deps.setOverlay(next);
    return { ok: true, message: "" };
  };

  const sendTest = (channels: string[], onProgress?: (progress: TestProgress) => void) => {
    if (forcedOff(deps)) return blocked(testBlockMessage("silenced"));
    const id = `manual:${randomUUID()}`;
    const sessionId = deps.sessionId();
    const result = deps.service().submit({
      level: "info", kind: "run_completed", title: "Pi 测试提醒", body: "固定内容测试。请检查接收端；服务接受不代表实际送达。",
      dedupeKey: id, channels: [...channels], meta: { sessionId: sessionId ?? "manual", runId: id, level: "info" },
    }, { manualTest: true, onProgress: (event) => { if (deps.sessionId() === sessionId) onProgress?.(event); } });
    deps.log.record({ event: "notify_test", id, accepted: result.accepted, channels, ...(result.accepted ? {} : { reason: result.reason }) });
    if (!result.accepted && result.reason === "internal_error") return failed("无法完成测试。请查看诊断后重试。");
    return result.accepted ? { ok: true, message: "测试：等待发送", feedback: { kind: "progress" as const }, unsubscribe: result.unsubscribe }
      : blocked(testBlockMessage(result.reason), result.reason === "disabled" || result.reason === "no_channels" || result.reason === "no_available_channels" ? "home" : "diagnostics");
  };

  return {
    config: () => deps.config(),
    userRaw: () => deps.userRaw(),
    runtimeState: () => {
      const terminal = selectTerminalChannel(createDefaultTerminalIo().environment());
      return { degraded: deps.configLoad().degraded, configError: deps.configLoad().errors.length > 0, quiet: deps.service().isQuietHours(), channelIssues: channelProblems(deps.config()).map((entry) => entry.id),
        terminalIssue: terminal.channel === "none" ? terminal.reason ?? "不可用" : undefined };
    },
    sessionOverride: (item) => sessionOverrideValue(deps.overlay(), item),
    restrictions,

    setValue(item, value) {
      if (item.id === "enabled" && forcedOff(deps) && value === true) return blocked("强制静默期间无法开启通知。");
      return applyPatch(item, item.patch(value));
    },

    channelActivation: (id) => activation(deps.config(), id),

    enableChannel(id) {
      // Confirmation is not authority: recheck current prerequisites before committing.
      const current = deps.config();
      const plan = activation(current, id);
      if (plan.kind === "blocked") return blocked(plan.message);
      if (plan.kind === "email") return blocked(emailActivationMessage(), "email");
      const item = buildSettingItems(current).find((entry) => entry.providerId === id && !entry.providerOptionPath)!;
      return applyPatch(item, { kind: "compound", operations: [
        { kind: "providers", id, value: true },
        ...(plan.addUnified ? [{ kind: "path" as const, path: "channels", value: [...current.channels, id] }] : []),
      ] });
    },

    saveDefault(item) {
      if (item.id === "enabled" && forcedOff(deps)) {
        return blocked("强制静默期间不能保存通知总开关。");
      }
      const current = deps.config();
      const patch = settingSnapshot(item, current);
      const result = writeUserDefault(deps.agentDir(), (raw) => settingUserFilePatch(raw, current, patch));
      if (!result.ok) {
        const problems = result.problems.map((problem) => sanitizeError(`${problem.path}: ${problem.message}`));
        deps.log.record({ event: "notify_default_write_failed", item: item.id, problems });
        return failed(`保存失败：${item.label}。默认设置未改动，当前对话修改仍保留。`, result.problems.map((problem) => `${problem.path}: ${problem.message}`));
      }
      deps.reload(); // Re-read only after a successful write, so both layers refresh together.
      deps.log.record({ event: "notify_default_saved", item: item.id, path: item.paths ?? item.userPath });
      return { ok: true, message: "" };
    },

    saveChanges(items) {
      if (!items.length) return { ok: true, message: "" };
      if (forcedOff(deps) && items.some((item) => item.id === "enabled" || (item.providerId && !item.providerOptionPath && item.read(deps.config()) === true))) {
        return blocked("强制静默期间不能保存通知总开关或开启接收方式。");
      }
      const current = deps.config();
      const patch = pendingPatch(items, current);
      const result = writeUserDefault(deps.agentDir(), (raw) => settingUserFilePatch(raw, current, patch));
      if (!result.ok) {
        deps.log.record({ event: "notify_defaults_write_failed", items: items.map((item) => item.id), problems: result.problems.map((problem) => sanitizeError(`${problem.path}: ${problem.message}`)) });
        return failed("保存失败：默认设置未改动，当前对话修改仍保留。请查看详情后重试。", result.problems.map((problem) => `${problem.path}: ${problem.message}`));
      }
      deps.reload();
      deps.log.record({ event: "notify_defaults_saved", items: items.map((item) => item.id) });
      return { ok: true, message: "" };
    },

    testEmail(onProgress) {
      if (forcedOff(deps)) return blocked(testBlockMessage("silenced"));
      const status = deps.credentials.status();
      const reason = status.state !== "configured" ? emailActivationMessage() : emailTestBlockReason(deps.config(), true);
      if (reason) return blocked(`邮箱测试未发送：${reason}`, !deps.config().enabled ? "home" : "email");
      return sendTest(["email"], onProgress);
    },

    credentialState: () => deps.credentials.status(),
    credentialStatus: () => deps.credentials.status().message,

    saveCredential(value) {
      const result = deps.credentials.save(value);
      deps.log.record({ event: "notify_qq_credential_saved", ok: result.ok });
      return result.ok ? result : blocked(result.message, "email");
    },

    deleteCredential() {
      const result = deps.credentials.delete();
      deps.log.record({ event: "notify_qq_credential_deleted", ok: result.ok });
      return result.ok ? result : blocked(result.message, "email");
    },

    async openQqSettings() {
      const manual = `请打开或复制 ${QQ_MAIL_URL}，在「设置 → 帐户」开启 SMTP 并获取授权码（不是登录密码）。`;
      if (!deps.openUrl) return { ok: true, message: manual };
      try {
        return { ok: true, message: await deps.openUrl(QQ_MAIL_URL) ? `已请求打开 QQ 邮箱。${manual}` : `当前宿主无法打开浏览器。${manual}` };
      } catch { return { ok: false, message: `打开浏览器失败。${manual}` }; }
    },

    test(channels, onProgress) {
      return sendTest(channels ?? deps.config().channels, onProgress);
    },

    reload() {
      const issue = checkActivation(fromDisk());
      if (issue) return issue;
      deps.reload();
      const load = deps.configLoad();
      deps.log.record({ event: "notify_reload", degraded: load.degraded });
      return load.degraded || load.errors.length > 0
        ? failed("配置异常。请修复后重新读取。", load.errors.map((problem) => `${problem.path}: ${problem.message}`))
        : { ok: true, message: "" };
    },

    /** “沿用以后默认”: drop only this conversation's override, so the user default applies again. */
    followUserDefault(item) {
      const next = clearItemOverride(deps.overlay(), item);
      const load = loadConfig({ agentDir: deps.agentDir() });
      const checked = applyOverlay(load.config, next);
      const problems = [...load.errors, ...checked.problems];
      if (problems.length) return failed(`未恢复${item.label}。当前对话修改仍保留。`, problems.map((problem) => `${problem.path}: ${problem.message}`));
      const issue = checkActivation(checked.config);
      if (issue) return issue;
      deps.setOverlay(next);
      deps.log.record({ event: "notify_override_cleared", item: item.id });
      return { ok: true, message: "" };
    },

    /** “恢复此项内置默认”: clear the user default and the conversation override for one item. */
    restoreBuiltinDefault(item) {
      const next = clearItemOverride(deps.overlay(), item);
      let issue: ActionResult | undefined;
      // Validate the actual post-removal defaults inside the file transaction, before either layer changes.
      const result = deleteUserDefault(deps.agentDir(), itemRemovals(item, deps.config(), deps.overlay()), (base) => {
        const checked = applyOverlay(base, next);
        if (checked.problems.length) return checked.problems;
        issue = checkActivation(checked.config);
        return issue ? [{ path: item.userPath, message: issue.message }] : [];
      });
      if (issue) return issue;
      if (!result.ok) {
        const problems = result.problems.map((problem) => sanitizeError(`${problem.path}: ${problem.message}`));
        deps.log.record({ event: "notify_default_delete_failed", item: item.id, problems });
        return failed(`恢复失败：${item.label}。默认设置未改动。`, result.problems.map((problem) => `${problem.path}: ${problem.message}`));
      }
      // Only after the file is clean does the conversation override go away: a failed write must not
      // silently drop this conversation's value.
      deps.setOverlay(next);
      deps.log.record({ event: "notify_default_removed", item: item.id, path: item.userPath });
      if (item.id === "enabled" && forcedOff(deps) && builtinDefaultValue(item) === true) {
        // The default really is back to on, but the session-level silence still wins; never bypass it.
        return { ok: true, message: "默认设置已恢复；当前仍强制静默。", feedback: { kind: "blocked", next: "diagnostics" } };
      }
      return { ok: true, message: "" };
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
        durationMs: 42300, stopReason: "stop", toolFailures: failures,
        costUsd: 0.0123, assistantExcerpt: "已修复登录 bug",
      };
      const summary: RunSummary = {
        runStatus: "completed", durationMs: 42300, toolFailures: failures,
        sessionName: "示例会话", projectName: "myflow", cumulativeCostUsd: 0.0456, contextPercent: 42,
      };
      const request = evaluateRunOutcome({ outcome, summary }, config);
      const lines = [
        "固定数据示例，不读取当前对话，不发送通知。",
        request ? `标题：${request.title}` : "无法生成示例。",
        request ? `正文：${request.body}` : "",
      ].filter((line) => line !== "");
      deps.log.record({ event: "notify_preview" });
      return { ok: true, message: "通知预览（内容示意，不会发送）", lines };
    },

    itemScope: (item) => itemRemovals(item, deps.config(), deps.overlay()).map((entry) => entry.kind === "path"
      ? buildSettingItems(deps.config()).find((candidate) => candidate.userPath === entry.path)?.label ?? "此设置项"
      : `${channelLabel(entry.id)}${entry.kind === "provider" ? "开关" : "设置"}`),
    statusLines: () => formatStatus(deps).split("\n"),
  };
}

/** Reused by the non-TUI branches: sanitized status text and config view. */
export { formatStatus as formatNotifyStatus, configView as notifyConfigView };
