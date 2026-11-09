/** Task-oriented view models. No IO, terminal styling, or delivery side effects. */
import { defaultConfig, mergeConfig } from "./config.ts";
import { buildSettingItems, channelLabel, patchOperations, routingExceptions, type SettingItem, type SettingPatch, type SettingValue } from "./settings.ts";
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

export interface ControlStatus { label: string; tone: "success" | "warning" | "error"; notes: string[] }
export function controlStatus(config: NotificationConfig, options: { restrictions: { label: string; reason: string }[]; degraded?: boolean; configError?: boolean; quiet?: boolean; terminalIssue?: string; hasCredential: boolean }): ControlStatus {
  const notes: string[] = [];
  const enabledRules = Object.values(config.rules).filter((rule) => rule.enabled);
  const used = [...new Set(enabledRules.flatMap((rule) => resolveChannels(config, rule)))];
  const available = used.filter((id) => config.providers.some((provider) => provider.id === id && provider.enabled));
  let label = "提醒已开启", tone: ControlStatus["tone"] = "success";
  if (options.restrictions.length) { label = "强制静默 · 所有外发已停止"; tone = "warning"; }
  else if (!config.enabled) { label = "提醒已暂停"; tone = "warning"; }
  else if (!enabledRules.length) { label = "没有开启的提醒时机"; tone = "warning"; }
  else if (!used.length) { label = "没有提醒使用接收方式"; tone = "warning"; }
  else if (!available.length) { label = "接收方式已关闭或不存在"; tone = "error"; }
  else if (options.quiet) { label = "免打扰中 · 仅接收例外等级"; tone = "warning"; }
  if (options.degraded || options.configError) {
    notes.push(options.degraded ? "配置损坏：默认已降级，本对话修改仍优先；拒绝覆盖默认，请修复后重读。" : "配置有错误：保存可能被阻止；请到诊断查看并修复。");
    tone = "error";
    if (options.degraded && !options.restrictions.length) label = "配置降级 · 安全默认";
  }
  const unavailable = used.filter((id) => !available.includes(id));
  if (config.enabled && unavailable.length) notes.push(`不可用：${unavailable.map(channelLabel).join("、")}；检查接收方式开关。`);
  if (available.includes("terminal") && options.terminalIssue) notes.push(`本机不可用：${options.terminalIssue}。`);
  if (available.includes("email")) {
    const email = config.providers.find((provider) => provider.id === "email");
    if (!email?.options.from || !Array.isArray(email.options.to) || !email.options.to.length || !options.hasCredential) {
      notes.push("邮箱尚未就绪：进入接收方式完成地址与授权码设置。");
      if (config.enabled && !options.restrictions.length && !options.degraded && available.length === 1) { label = "邮箱尚未就绪 · 暂不能投递"; tone = "warning"; }
    }
  }
  if (config.minLevel !== "info") notes.push(`等级筛选：${config.minLevel === "error" ? "仅错误" : "警告及错误"}；开启的低等级提醒仍会被过滤。`);
  if (routingExceptions(config).length) notes.push(`接收例外：${routingExceptions(config).join("、")}单独设置，不随统一选择变化。`);
  return { label, tone, notes };
}

export function emailSetup(config: NotificationConfig, hasCredential: boolean, testLabel: string | undefined, pending: number) {
  const email = config.providers.find((provider) => provider.id === "email" && provider.type === "email");
  const from = !!email?.options.from, to = Array.isArray(email?.options.to) && email.options.to.length > 0;
  const enabled = !!email?.enabled && config.channels.includes("email");
  const mark = (ready: boolean) => ready ? "✓" : "—";
  const next = !from ? "填写发件 QQ 邮箱" : !to ? "填写收件邮箱" : !hasCredential ? "设置 QQ 邮箱授权码（不是登录密码）"
    : !enabled ? "明确确认启用邮箱" : !config.enabled ? "开启通知总开关后再测试" : !testLabel ? "手动发送邮箱测试并检查收件箱"
      : testLabel.includes("未成功") ? "检查测试结果，修复后重试" : pending ? "确认收件后，保存邮箱设置为以后默认" : "默认已同步；服务接受仍需你确认收件";
  return { conditions: `就绪条件：地址 ${mark(from && to)}  授权码 ${mark(hasCredential)}  启用 ${mark(enabled)}`, next,
    test: testLabel ?? "未测试", enabled };
}
