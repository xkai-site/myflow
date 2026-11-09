/** Pure channel prerequisites and rule usage. No IO, credentials, rendering or notifier creation. */
import { resolveChannels } from "./rules.ts";
import { LEVEL_RANK, type NotificationConfig } from "./types.ts";

type Provider = NotificationConfig["providers"][number];
export type EmailRequirement = "from" | "to" | "credential";
export function emailRequirement(provider: Provider | undefined, hasCredential: boolean): EmailRequirement | undefined {
  return !provider?.options.from
    ? "from"
    : !Array.isArray(provider.options.to) || !provider.options.to.length
    ? "to"
    : !hasCredential
    ? "credential"
    : undefined;
}
/** Disabled rules count too: reopening a gate must preserve their future routing. */
export function rulesUsingChannel(config: NotificationConfig, id: string): Array<keyof NotificationConfig["rules"]> {
  return (Object.keys(config.rules) as Array<keyof NotificationConfig["rules"]>).filter((key) =>
    resolveChannels(config, config.rules[key]).includes(id)
  );
}
export function enabledChannelUsage(config: NotificationConfig, id: string): number {
  return rulesUsingChannel(config, id).filter((key) => config.rules[key].enabled).length;
}
export function emailReadiness(config: NotificationConfig, hasCredential: boolean): { label: string; usedBy: number } {
  const provider = config.providers.find((entry) => entry.id === "email" && entry.type === "email");
  const usedBy = enabledChannelUsage(config, "email");
  const missing = emailRequirement(provider, hasCredential);
  const label = !provider
    ? "未配置"
    : missing === "from"
    ? "缺发件地址"
    : missing === "to"
    ? "缺收件地址"
    : missing === "credential"
    ? "缺授权码"
    : !provider.enabled
    ? "渠道未启用"
    : !config.enabled
    ? "总开关已关"
    : !usedBy
    ? "尚无提醒使用"
    : "配置已就绪";
  return { label, usedBy };
}
export function emailTestBlockReason(config: NotificationConfig, hasCredential: boolean): string | undefined {
  if (!config.enabled) return "通知总开关已关闭，请先开启通知。";
  const provider = config.providers.find((entry) => entry.id === "email" && entry.type === "email");
  if (!provider?.enabled) return "请先开启邮箱通知。";
  const missing = emailRequirement(provider, hasCredential);
  return missing === "from" || missing === "to"
    ? "请填写发件和收件邮箱地址。"
    : missing === "credential"
    ? "请设置 QQ 邮箱授权码（专用发送凭据，非登录密码）。"
    : undefined;
}
export function channelState(
  config: NotificationConfig,
  id: string,
  hasCredential: boolean,
  terminalIssue?: string,
  channelIssues: readonly string[] = []
): string {
  const provider = config.providers.find((entry) => entry.id === id);
  if (!provider) return "未配置";
  const switchState = provider.enabled ? "开启" : "关闭";
  if (provider.type === "email") {
    const missing = emailRequirement(provider, hasCredential);
    if (missing) return `${switchState} · ${missing === "from" ? "缺发件地址" : missing === "to" ? "缺收件地址" : "缺授权码"}`;
  }
  if (channelIssues.includes(id) || (provider.type === "terminal" && terminalIssue)) return `${switchState} · 不可用`;
  if (!provider.enabled) return "关闭";
  if (provider.type === "noop") return "不发送";
  return enabledChannelUsage(config, id) ? "开启" : "开启 · 未使用";
}
/** Effective availability summary; it is not a delivery receipt. */
export interface ControlStatus {
  label: string;
  tone: "success" | "warning" | "error";
}
export function controlStatus(
  config: NotificationConfig,
  options: {
    restrictions: { label: string; reason: string }[];
    degraded?: boolean;
    configError?: boolean;
    quiet?: boolean;
    terminalIssue?: string;
    channelIssues?: readonly string[];
    hasCredential: boolean;
  }
): ControlStatus {
  const state = (label: string, tone: ControlStatus["tone"] = "warning"): ControlStatus => ({ label, tone });
  if (options.restrictions.length) return state("强制静默 · 通知已停止");
  if (options.degraded || options.configError) return state("配置异常 · 请查看诊断", "error");
  if (!config.enabled) return state("通知已暂停");
  const enabled = Object.values(config.rules).filter((rule) => rule.enabled);
  if (!enabled.length) return state("没有开启的提醒时机");
  const used = [...new Set(enabled.flatMap((rule) => resolveChannels(config, rule)))];
  if (!used.length) return state("未选择接收方式");
  const available = used.filter(
    (id) => channelState(config, id, options.hasCredential, options.terminalIssue, options.channelIssues) === "开启"
  );
  if (!available.length) return state("暂无可用接收方式", "error");
  // Completion can be promoted for truncated output, so warning is not fully filtered.
  const eligible = enabled.filter(
    (rule) =>
      LEVEL_RANK[rule.level] >= LEVEL_RANK[config.minLevel] ||
      (rule === config.rules.runCompleted && config.minLevel === "warning")
  );
  if (!eligible.length) return state("当前通知均被等级筛选暂停");
  const deliverable = eligible.filter((rule) => resolveChannels(config, rule).some((id) => available.includes(id)));
  if (!deliverable.length) return state("符合等级的通知无可用接收方式");
  if (options.quiet)
    return state(config.quietHours.exceptLevels.length ? "免打扰中 · 仅保留例外等级" : "免打扰中 · 通知已暂停");
  const partial = available.length < used.length || deliverable.length < enabled.length;
  return state(partial ? "通知部分可用" : "通知已开启", partial ? "warning" : "success");
}

export type ChannelActivation =
  | { kind: "ready"; addUnified: boolean }
  | { kind: "email"; field: EmailRequirement }
  | { kind: "blocked"; message: string };
export function channelActivation(
  config: NotificationConfig,
  id: string,
  hasCredential: boolean,
  channelIssues: readonly string[] = []
): ChannelActivation {
  const provider = config.providers.find((entry) => entry.id === id);
  if (!provider || channelIssues.includes(id))
    return { kind: "blocked", message: "此接收方式暂不可用。请查看配置详情。" };
  const missing = id === "email" && provider.type === "email" ? emailRequirement(provider, hasCredential) : undefined;
  if (missing) return { kind: "email", field: missing };
  return { kind: "ready", addUnified: !config.channels.includes(id) && !rulesUsingChannel(config, id).length };
}
