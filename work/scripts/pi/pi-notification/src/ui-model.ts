/** Task-oriented view models. No IO, terminal styling, or delivery side effects. */
import { defaultConfig, mergeConfig } from "./config.ts";
import { buildSettingItems, RULE_INFOS, patchOperations, type SettingItem, type SettingPatch, type SettingValue } from "./settings.ts";
import { resolveChannels } from "./rules.ts";
import type { NotificationConfig } from "./types.ts";

export type SaveScope = "all" | "email";

/** Canonical leaves avoid counting the same switch through both ordinary and expert controls.
 * Overlay presence is NOT dirtiness: an explicitly pinned value may already match the default.
 * Compare raw values, not formatted summaries (mixed states and inherit must remain distinct).
 */
export function pendingSettings(config: NotificationConfig, raw: unknown, override: (item: SettingItem) => unknown, scope: SaveScope = "all"): SettingItem[] {
  const base = mergeConfig(defaultConfig(), raw ?? {}, "user-defaults").config;
  const seen = new Set<string>();
  return buildSettingItems(config).filter((item) => {
    if (item.paths) return false;
    const identity = item.userPath;
    if (seen.has(identity)) return false;
    seen.add(identity);
    if (scope === "email" && item.id !== "channels" && item.providerId !== "email") return false;
    return override(item) !== undefined && JSON.stringify(item.read(config)) !== JSON.stringify(item.read(base));
  });
}

/** Batch saves own only the listed leaves. In particular channels must not snapshot unrelated
 * selected-provider switches; those appear as separate, reviewable changes when actually dirty. */
export function pendingPatch(items: readonly SettingItem[], config: NotificationConfig): SettingPatch {
  return { kind: "compound", operations: items.flatMap((item) => item.destinations
    ? [{ kind: "path" as const, path: item.userPath, value: item.read(config) }]
    : patchOperations(item.patch(item.read(config) as SettingValue | SettingValue[]))) };
}

/** Ordinary success has no banner. Problems carry a safe summary, an optional direct next step,
 * and separate diagnostic lines. No rendering or raw exceptions in the ordinary message. */
export interface ActionResult {
  ok: boolean;
  message: string;
  feedback?: {
    kind: "blocked" | "recoverable" | "unknown" | "progress";
    next?: "email" | "diagnostics" | "home";
    details?: string[];
  };
}

export function emailMissing(config: NotificationConfig, hasCredential: boolean): string | undefined {
  const email = config.providers.find((provider) => provider.id === "email");
  if (email && email.type !== "email") return undefined;
  return !email?.options.from ? "填写发件 QQ 邮箱" : !Array.isArray(email.options.to) || !email.options.to.length ? "填写收件邮箱"
    : !hasCredential ? "设置 QQ 邮箱授权码" : undefined;
}

/** Includes disabled rules: re-enabling a channel must not silently change their future routing. */
export function channelRules(config: NotificationConfig, id: string): string[] {
  return RULE_INFOS.filter((rule) => resolveChannels(config, config.rules[rule.key as keyof NotificationConfig["rules"]]).includes(id)).map((rule) => rule.label);
}

export function channelState(config: NotificationConfig, id: string, hasCredential: boolean, terminalIssue?: string, channelIssues: readonly string[] = []): string {
  const provider = config.providers.find((entry) => entry.id === id);
  if (!provider) return "未配置";
  if (provider.type === "email" && (!provider.options.from || !Array.isArray(provider.options.to) || !provider.options.to.length || !hasCredential)) return "未配置";
  if (!provider.enabled) return "关闭";
  if (channelIssues.includes(id) || (provider.type === "terminal" && terminalIssue)) return "不可用";
  if (provider.type === "noop") return "不发送";
  const used = Object.values(config.rules).some((rule) => rule.enabled && resolveChannels(config, rule).includes(id));
  return used ? "开启" : "开启 · 未使用";
}

export interface ControlStatus { label: string; tone: "success" | "warning" | "error"; notes: string[] }
export function controlStatus(config: NotificationConfig, options: { restrictions: { label: string; reason: string }[]; degraded?: boolean; configError?: boolean; quiet?: boolean; terminalIssue?: string; channelIssues?: readonly string[]; hasCredential: boolean }): ControlStatus {
  const state = (label: string, tone: ControlStatus["tone"] = "warning", notes: string[] = []): ControlStatus => ({ label, tone, notes });
  if (options.restrictions.length) return state("强制静默 · 通知已停止");
  if (options.degraded || options.configError) return state("配置异常 · 请查看诊断", "error");
  if (!config.enabled) return state("通知已暂停");
  const enabled = Object.values(config.rules).filter((rule) => rule.enabled);
  if (!enabled.length) return state("没有开启的提醒时机");
  const used = [...new Set(enabled.flatMap((rule) => resolveChannels(config, rule)))];
  if (!used.length) return state("未选择接收方式");
  const available = used.filter((id) => channelState(config, id, options.hasCredential, options.terminalIssue, options.channelIssues) === "开启");
  if (!available.length) return state("暂无可用接收方式", "error");
  const rank = { info: 0, warning: 1, error: 2 };
  // Completion can be promoted to warning for truncated output; do not claim it is fully filtered.
  const eligible = enabled.filter((rule) => rank[rule.level] >= rank[config.minLevel] || (rule === config.rules.runCompleted && config.minLevel === "warning"));
  if (!eligible.length) return state("当前通知均被等级筛选暂停");
  const deliverable = eligible.filter((rule) => resolveChannels(config, rule).some((id) => available.includes(id)));
  if (!deliverable.length) return state("符合等级的通知无可用接收方式");
  if (options.quiet) return state(config.quietHours.exceptLevels.length ? "免打扰中 · 仅保留例外等级" : "免打扰中 · 通知已暂停");
  const partial = available.length < used.length || deliverable.length < enabled.length;
  return state(partial ? "通知部分可用" : "通知已开启", partial ? "warning" : "success");
}

export function emailSetup(config: NotificationConfig, hasCredential: boolean, testLabel: string | undefined, _pending: number) {
  const missing = emailMissing(config, hasCredential);
  const enabled = !!config.providers.find((provider) => provider.id === "email")?.enabled;
  return { conditions: missing ? "配置未完成" : "配置已就绪", next: missing,
    test: testLabel ?? "未测试", enabled };
}
