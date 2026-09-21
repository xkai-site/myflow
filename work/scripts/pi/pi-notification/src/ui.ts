/** 最小规则向导：只编辑副本，最终确认后由命令层统一校验/写盘。 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { NotificationConfig, NotifyLevel } from "./types.ts";

export async function configureRules(
  ctx: ExtensionCommandContext,
  current: NotificationConfig,
): Promise<NotificationConfig | undefined> {
  // RPC 的 hasUI 也为真，不能据此打开终端向导。
  if (ctx.mode !== "tui") return undefined;
  const draft = structuredClone(current);
  const keys = Object.keys(draft.rules) as Array<keyof NotificationConfig["rules"]>;
  const selected = await ctx.ui.select("通知配置：选择用户级规则", keys);
  if (!selected || !keys.includes(selected as keyof NotificationConfig["rules"])) return undefined;
  const key = selected as keyof NotificationConfig["rules"];
  const rule = draft.rules[key];
  rule.enabled = await ctx.ui.confirm(
    `启用 ${key}？`,
    `当前${rule.enabled ? "开启" : "关闭"}；是=开启，否=关闭。最后一步确认前不会保存。`,
  );
  const levels: NotifyLevel[] = ["info", "warning", "error"];
  const level = await ctx.ui.select(`通知等级（当前 ${rule.level}）`, levels);
  if (!level || !levels.includes(level as NotifyLevel)) return undefined;
  rule.level = level as NotifyLevel;
  if (!await ctx.ui.confirm("保存用户级通知配置？", `${key}: ${rule.enabled ? "开启" : "关闭"} / ${rule.level}。项目级覆盖仍优先。`)) {
    return undefined;
  }
  return draft;
}
