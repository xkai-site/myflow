/** Pure candidate derivation and markers. No host, navigation or terminal dependencies. */
import { CUSTOM_ROW_LABEL, isCurrentValue, type SettingItem, type SettingValue } from "./settings.ts";
import type { NotificationConfig } from "./types.ts";
import type { ItemValue } from "./settings-actions.ts";

export interface Candidate {
  value: ItemValue;
  label: string;
  custom?: boolean;
  inherit?: boolean;
  feedback?: boolean;
}

export function settingCandidates(item: SettingItem, config: NotificationConfig, fallback: unknown): Candidate[] {
  const rows: Candidate[] = item.candidates(config).map(({ value, label }) => ({ value, label }));
  if (item.id.startsWith("rules.") && item.id.endsWith(".channels")) rows.unshift({ value: "inherit", label: "跟随统一设置", inherit: true });
  if (item.kind !== "collection" && !item.paths) {
    const known = new Set(rows.map((row) => String(row.value)));
    for (const extra of [item.read(config), fallback]) {
      if (extra === undefined || known.has(String(extra))) continue;
      known.add(String(extra));
      rows.push({ value: extra as SettingValue, label: item.format(extra) });
    }
  }
  if (item.parseInput) rows.push({ value: "", label: CUSTOM_ROW_LABEL, custom: true });
  return rows;
}

export function candidateIsCurrent(item: SettingItem, candidate: Candidate, current: unknown): boolean {
  return !candidate.custom && !candidate.feedback && (candidate.inherit ? current === "inherit" : isCurrentValue(item.kind, current, candidate.value as SettingValue));
}

/** An absent sparse default is not a default marker; collection defaults match by membership. */
export function candidateIsDefault(item: SettingItem, candidate: Candidate, current: unknown, fallback: unknown, hasDefault: boolean): boolean {
  if (!hasDefault || candidate.custom || candidate.feedback) return false;
  if (candidate.inherit) return fallback === "inherit";
  if (item.kind === "collection") return Array.isArray(fallback) && fallback.includes(candidate.value);
  return fallback === candidate.value || (current !== undefined && item.format(fallback) === candidate.label && candidateIsCurrent(item, candidate, current));
}

export function initialCandidateFocus(item: SettingItem, rows: Candidate[], current: unknown): number {
  const index = rows.findIndex((row) => candidateIsCurrent(item, row, current));
  return Math.max(0, index);
}
