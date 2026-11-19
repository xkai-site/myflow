/** Human presentation shared by rule evaluation, email and the settings preview. */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { singleLine } from "./log.ts";
import type { NotificationRequest, SessionLabels } from "./types.ts";

// A shared presentation target, not a transport limit. Only the name gives up space.
const TITLE_COLUMNS = 48;
const NAME_SEPARATOR = " - ";

function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1000) return "不到1秒";
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const rest = seconds % 60;
  return `${hours ? `${hours}小时` : ""}${minutes ? `${minutes}分` : ""}${rest ? `${rest}秒` : ""}`;
}

function formatUsd(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return value < 1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

export function notificationTitle(status: string, labels?: SessionLabels, durationMs?: number, costUsd?: number): string {
  const metrics = [formatDuration(durationMs), formatUsd(costUsd)].filter((value) => value !== undefined);
  const core = metrics.length ? `${status} [${metrics.join("，")}]` : status;
  const name = singleLine(labels?.sessionName ?? "") || singleLine(labels?.projectName ?? "");
  if (!name) return core;

  const budget = TITLE_COLUMNS - visibleWidth(core + NAME_SEPARATOR);
  // The TUI adds ANSI resets around the ellipsis; the shared title is plain text.
  const clipped = singleLine(truncateToWidth(name, budget, "…"));
  return clipped && (clipped !== "…" || name === clipped) ? `${core}${NAME_SEPARATOR}${clipped}` : core;
}

export function emailContent({ body, details }: Pick<NotificationRequest, "body" | "details">) {
  const supplements = [body, details?.contextPercent === undefined ? "" : `当前上下文已使用 ${details.contextPercent}%`].filter(Boolean);
  const reply = details ? { heading: "Agent回复", text: details.finalReply ?? "没有最终回复。" } : undefined;
  const text = [...supplements, ...(reply ? [reply.heading, reply.text] : [])].join("\n\n");
  return { supplements, reply, text };
}
