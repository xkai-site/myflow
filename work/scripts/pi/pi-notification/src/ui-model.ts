/** Task-oriented view models. No IO, terminal styling, or delivery side effects. */
import { defaultConfig, mergeConfig } from "./config.ts";
import { buildSettingItems, RULE_INFOS, type SettingItem } from "./settings.ts";
import { emailRequirement, rulesUsingChannel } from "./channels.ts";
import { resolveChannels } from "./rules.ts";
import type { NotificationConfig } from "./types.ts";

export type SaveScope = "all" | "email";

/** Resolve the current operation context once, without changing gates or routing. */
export function settingsTestTarget(config: NotificationConfig, item?: SettingItem, pageId?: string): { channels: string[]; emailOnly: boolean } {
  const channelId = pageId === "email-config" ? "email" : pageId === "home" ? item?.providerId : undefined;
  const ruleKey = item?.rule?.key ?? RULE_INFOS.find((rule) => pageId === `rule:${rule.key}`)?.key;
  return {
    channels: channelId ? [channelId] : ruleKey ? resolveChannels(config, config.rules[ruleKey]) : [...config.channels],
    emailOnly: channelId === "email",
  };
}

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

export function emailMissing(config: NotificationConfig, hasCredential: boolean): string | undefined {
  const email = config.providers.find((provider) => provider.id === "email");
  if (email && email.type !== "email") return undefined;
  const missing = emailRequirement(email, hasCredential);
  return missing === "from" ? "填写发件 QQ 邮箱" : missing === "to" ? "填写收件邮箱" : missing === "credential" ? "设置 QQ 邮箱授权码" : undefined;
}

/** Includes disabled rules: re-enabling a channel must not silently change their future routing. */
export function channelRules(config: NotificationConfig, id: string): string[] {
  const used = rulesUsingChannel(config, id);
  return RULE_INFOS.filter((rule) => used.includes(rule.key)).map((rule) => rule.label);
}

export function emailSetup(config: NotificationConfig, hasCredential: boolean, testLabel?: string) {
  const missing = emailMissing(config, hasCredential);
  return { conditions: missing ? "配置未完成" : "配置已就绪", next: missing, test: testLabel ?? "未测试" };
}
