/** Human presentation shared by rule evaluation, email and the settings preview. */
import { singleLine } from "./log.ts";
import type { NotificationRequest, SessionLabels } from "./types.ts";

// A compact title target, not a transport limit. Only the name gives up space;
// status, duration and cost are never cut. Clients still control the visible width.
const TITLE_GRAPHEMES = 40;
const LEADING_LABEL_GRAPHEMES = 10;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

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
  const core = metrics.length ? `${status}（${metrics.join("，")}）` : status;
  const name = singleLine(labels?.sessionName ?? "") || singleLine(labels?.projectName ?? "");
  if (!name) return core;

  const budget = TITLE_GRAPHEMES - [...graphemes.segment(core)].length - 3;
  if (budget < 2) return core;
  const parts: string[] = [];
  for (const { segment } of graphemes.segment(name)) {
    // Put the important fields first when a name already risks filling the visible title.
    if (parts.length === budget) return `${core} · ${parts.slice(0, -1).join("")}…`;
    parts.push(segment);
  }
  return parts.length <= LEADING_LABEL_GRAPHEMES ? `${name}：${core}` : `${core} · ${name}`;
}

export function emailContent({ body, details }: Pick<NotificationRequest, "body" | "details">) {
  const metadata = [body, details?.contextPercent === undefined ? "" : `上下文 ${details.contextPercent}%`].filter(Boolean).join("；");
  const reply = details?.finalReply;
  const final = reply === undefined ? "" : reply === null ? "没有最终回复。" : `最终回复\n\n${reply}`;
  return { metadata, reply, text: [metadata, final].filter(Boolean).join("\n\n") };
}
