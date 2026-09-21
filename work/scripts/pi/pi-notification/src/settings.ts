/**
 * Single source of truth for the notification settings.
 *
 * Three concerns live here so `commands` and `ui` never build path strings themselves:
 *  1. the setting description table: path, group, kind, candidates (including presets),
 *     formatting and input parsing per item;
 *  2. the session overlay: Enter changes the per-conversation value, which is deep-merged
 *     onto the config read from disk; provider switches live in a separate `providers` map
 *     so channel options (which may reference headers or credentials) are never copied
 *     into a session entry;
 *  3. sparse user defaults: Ctrl+S writes only the saved item, and `hasUserDefault()`
 *     decides by path presence in the raw JSON rather than by comparing against factory
 *     defaults, because a factory default is not something the user saved.
 *
 * No IO and no `ctx` here: writes live in `config.ts`, rendering and key handling in `ui.ts`.
 */

import { mergeConfig, type ConfigProblem } from "./config.ts";
import { getPathValue, hasPath, isPlainObject, mergePatch, setPatchPath, type ConfigPatch } from "./patch.ts";
import type { NotificationConfig, NotifyLevel } from "./types.ts";

// ---------------------------------------------------------------------------
// Session overlay
// ---------------------------------------------------------------------------

export { getPathValue, hasPath, mergePatch, setPatchPath };
export type { ConfigPatch };

/**
 * Per-conversation choices. `patch` goes through the `mergeConfig` field validation;
 * `providers` stores only id to enabled and stays decoupled from the provider array
 * in the config.
 */
export interface SessionOverlay {
  patch: ConfigPatch;
  providers: Record<string, boolean>;
}

export function emptyOverlay(): SessionOverlay {
  return { patch: {}, providers: {} };
}

/** Empty overlay means no session entry is written and the config is left as read. */
export function isEmptyOverlay(overlay: SessionOverlay): boolean {
  return Object.keys(overlay.patch).length === 0 && Object.keys(overlay.providers).length === 0;
}

/** Restores an overlay from session entry data; defensive because the session file can be edited by hand. */
export function overlayFromEntry(value: unknown): SessionOverlay | undefined {
  if (!isPlainObject(value)) return undefined;
  const patch = isPlainObject(value.patch) ? (value.patch as ConfigPatch) : {};
  const providers: Record<string, boolean> = {};
  if (isPlainObject(value.providers)) {
    for (const [id, enabled] of Object.entries(value.providers)) {
      if (typeof enabled === "boolean") providers[id] = enabled;
    }
  }
  const overlay = { patch, providers };
  return isEmptyOverlay(overlay) ? undefined : overlay;
}

export const SESSION_OVERLAY_ENTRY = "notify-session-overlay";

/**
 * Restores the overlay of **this** session from session entries.
 *
 * Filtering by sessionId is required: `/fork` and `/clone` copy entries into a new session
 * file, and since that session has a different id it must not inherit the temporary choices
 * of the previous conversation. Every overlay is a full snapshot, so the last one wins.
 */
export function restoreOverlayFromEntries(entries: readonly unknown[], sessionId: string | undefined): SessionOverlay {
  let overlay = emptyOverlay();
  if (sessionId === undefined) return overlay;
  for (const entry of entries) {
    if (!isPlainObject(entry) || entry.type !== "custom" || entry.customType !== SESSION_OVERLAY_ENTRY) continue;
    const data = entry.data;
    if (!isPlainObject(data) || data.sessionId !== sessionId) continue;
    const restored = overlayFromEntry(data);
    if (restored) overlay = restored;
  }
  return overlay;
}

/**
 * Applies the overlay on top of `base` (factory plus user defaults).
 *
 * `mergeConfig` performs the per-field validation: one overlay or one saved setting touches
 * a single field, and every sibling must be inherited from `base`. When validation fails the
 * whole overlay is ignored and the problems are reported, because a stale self-made overlay
 * must never degrade delivery.
 */
export function applyOverlay(
  base: NotificationConfig,
  overlay: SessionOverlay,
): { config: NotificationConfig; problems: ConfigProblem[] } {
  if (isEmptyOverlay(overlay)) return { config: base, problems: [] };
  const raw: ConfigPatch = structuredClone(overlay.patch);
  if (Object.keys(overlay.providers).length > 0) {
    raw.providers = base.providers.map((provider) => (
      overlay.providers[provider.id] === undefined
        ? { ...provider }
        : { ...provider, enabled: overlay.providers[provider.id] }
    ));
  }
  const merged = mergeConfig(base, raw, SESSION_OVERLAY_ENTRY);
  if (merged.errors.length > 0) return { config: base, problems: merged.errors };
  return { config: merged.config, problems: [] };
}

// ---------------------------------------------------------------------------
// Setting description table
// ---------------------------------------------------------------------------

export type SettingKind = "boolean" | "enum" | "number" | "time" | "collection";

export type SettingValue = string | number | boolean;

export type SettingPatch =
  /** Plain field: one path serves both the session overlay and the sparse user file. */
  | { kind: "path"; path: string; value: unknown }
  /** Provider switch: the overlay uses the provider map, the user file gets the whole array. */
  | { kind: "providers"; id: string; value: boolean };

export interface SettingCandidate {
  value: SettingValue;
  /** Candidate text without the marker column or the `default` suffix. */
  label: string;
}

export interface SettingItem {
  id: string;
  group: string;
  label: string;
  kind: SettingKind;
  /** Current value, read from the effective config. */
  read(config: NotificationConfig): unknown;
  /** Builds the write patch; collection items pass the whole array. */
  patch(value: SettingValue | readonly SettingValue[]): SettingPatch;
  /** Candidates; number items return presets and the UI appends its own `custom…` row. */
  candidates(config: NotificationConfig): SettingCandidate[];
  /** Value text rendered in the parent list. */
  format(value: unknown): string;
  /** Path of this item inside the raw user JSON; provider items use `providerId` instead. */
  userPath: string;
  providerId?: string;
  /** Extra information such as the provider type. */
  detail?(config: NotificationConfig): string | undefined;
  /** Input parsing for number and time items, used by the `custom…` row. */
  parseInput?(text: string): { ok: true; value: SettingValue } | { ok: false; message: string };
}

const LEVELS: NotifyLevel[] = ["info", "warning", "error"];

/** Fixed label of the `custom…` candidate row, shared by the UI and the tests. */
export const CUSTOM_ROW_LABEL = "custom…";

const RULES: Array<{ key: keyof NotificationConfig["rules"]; label: string }> = [
  { key: "runCompleted", label: "运行完成" },
  { key: "runFailed", label: "运行失败" },
  { key: "runAborted", label: "运行中止" },
  { key: "toolFailed", label: "工具失败" },
  { key: "compactFailed", label: "压缩失败" },
  { key: "waitingForUser", label: "等待输入" },
];

function valuesToCandidates(values: SettingValue[], unit = ""): SettingCandidate[] {
  return values.map((value) => ({ value, label: withUnit(value, unit) }));
}

/** Renders a value with its unit; an empty unit renders the value itself. */
function withUnit(value: unknown, unit: string): string {
  return unit === "" ? String(value) : `${String(value)} ${unit}`;
}

interface ItemSpec {
  id?: string;
  group: string;
  label: string;
  path: string;
  kind: SettingKind;
  candidates?: (config: NotificationConfig) => SettingCandidate[];
  presets?: number[];
  unit?: string;
  min?: number;
  max?: number;
  /** Empty-value label for collection fields. */
  emptyLabel?: string;
  detail?: (config: NotificationConfig) => string | undefined;
}

function formatValue(kind: SettingKind, value: unknown, unit: string, emptyLabel: string): string {
  if (value === undefined) return "—";
  if (kind === "collection") {
    const members = Array.isArray(value) ? value.map((item) => String(item)) : [];
    return members.length === 0 ? emptyLabel : members.join(", ");
  }
  if (kind === "number") return withUnit(value, unit);
  return String(value);
}

function makeItem(spec: ItemSpec): SettingItem {
  const kind = spec.kind;
  const unit = spec.unit ?? "";
  const emptyLabel = spec.emptyLabel ?? "（空）";
  const candidates = spec.candidates
    ?? (kind === "boolean"
      ? () => [{ value: true, label: "true" }, { value: false, label: "false" }]
      : () => valuesToCandidates(spec.presets ?? [], unit));

  const item: SettingItem = {
    id: spec.id ?? spec.path,
    group: spec.group,
    label: spec.label,
    kind,
    read: (config) => getPathValue(config, spec.path),
    patch: (value) => ({ kind: "path", path: spec.path, value }),
    candidates,
    format: (value) => formatValue(kind, value, unit, emptyLabel),
    userPath: spec.path,
    ...(spec.detail ? { detail: spec.detail } : {}),
  };

  if (kind === "number") {
    const min = spec.min ?? 0;
    const max = spec.max ?? Number.MAX_SAFE_INTEGER;
    item.parseInput = (text) => {
      const trimmed = text.trim();
      if (!/^\d+$/.test(trimmed)) return { ok: false, message: "必须是整数" };
      const value = Number(trimmed);
      if (!Number.isInteger(value) || value < min || value > max) {
        return { ok: false, message: `必须是 ${min}..${max} 的整数` };
      }
      return { ok: true, value };
    };
  }
  if (kind === "time") {
    item.parseInput = (text) => {
      const trimmed = text.trim();
      return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(trimmed)
        ? { ok: true, value: trimmed }
        : { ok: false, message: "必须是严格 HH:MM（00:00–23:59）" };
    };
  }
  return item;
}

/** Time presets covering common schedules; everything else goes through `custom…`. */
const TIME_PRESETS = ["00:00", "07:00", "08:00", "12:00", "18:00", "22:00", "23:00"];

/**
 * Builds the setting list for the current config, providers included.
 * Array order is render order and the group is the section shown in the UI; `config` is only
 * used to enumerate providers, every other candidate is config-independent.
 */
export function buildSettingItems(config: NotificationConfig): SettingItem[] {
  const items: SettingItem[] = [];

  items.push(makeItem({ group: "基础", label: "总开关", path: "enabled", kind: "boolean" }));
  items.push(makeItem({
    group: "基础",
    label: "最低等级",
    path: "minLevel",
    kind: "enum",
    candidates: () => valuesToCandidates(LEVELS),
  }));

  const channelCandidates = (): SettingCandidate[] => (
    config.providers.map((provider) => ({ value: provider.id, label: provider.id }))
  );
  for (const rule of RULES) {
    const base = `rules.${rule.key}`;
    items.push(makeItem({ group: "通知规则", label: `${rule.label} · 开关`, path: `${base}.enabled`, kind: "boolean" }));
    items.push(makeItem({
      group: "通知规则",
      label: `${rule.label} · 等级`,
      path: `${base}.level`,
      kind: "enum",
      candidates: () => valuesToCandidates(LEVELS),
    }));
    items.push(makeItem({
      group: "通知规则",
      label: `${rule.label} · 渠道`,
      path: `${base}.channels`,
      kind: "collection",
      candidates: channelCandidates,
      emptyLabel: "（不发往任何渠道）",
    }));
    if (rule.key === "toolFailed") {
      items.push(makeItem({
        group: "通知规则",
        label: "工具失败 · 策略",
        path: `${base}.mode`,
        kind: "enum",
        candidates: () => valuesToCandidates(["aggregate", "immediate"]),
      }));
      items.push(makeItem({
        group: "通知规则",
        label: "工具失败 · 阈值",
        path: `${base}.threshold`,
        kind: "number",
        presets: [1, 2, 3, 5, 10],
        min: 1,
        max: 100,
      }));
    }
    if (rule.key === "waitingForUser") {
      items.push(makeItem({
        group: "通知规则",
        label: "等待输入 · 类型",
        path: `${base}.kinds`,
        kind: "collection",
        // `custom` is rejected by config.ts, so it is not a candidate here.
        candidates: () => valuesToCandidates(["select", "confirm", "input", "editor"]),
        emptyLabel: "（不等待任何类型）",
      }));
    }
  }

  items.push(makeItem({ group: "内容", label: "包含耗时", path: "content.includeDuration", kind: "boolean" }));
  items.push(makeItem({ group: "内容", label: "包含失败工具名", path: "content.includeToolFailureNames", kind: "boolean" }));
  items.push(makeItem({ group: "内容", label: "包含会话标识", path: "content.includeSessionLabel", kind: "boolean" }));
  items.push(makeItem({ group: "内容", label: "包含助手摘录", path: "content.includeAssistantExcerpt", kind: "boolean" }));
  items.push(makeItem({ group: "内容", label: "包含成本与上下文", path: "content.includeCost", kind: "boolean" }));
  items.push(makeItem({
    group: "内容",
    label: "正文最大长度",
    path: "content.maxMessageChars",
    kind: "number",
    presets: [100, 300, 600, 1200],
    min: 20,
    max: 2000,
  }));

  items.push(makeItem({ group: "静默与频率", label: "静默时段 · 开关", path: "quietHours.enabled", kind: "boolean" }));
  items.push(makeItem({
    group: "静默与频率",
    label: "静默时段 · 开始",
    path: "quietHours.start",
    kind: "time",
    candidates: () => valuesToCandidates(TIME_PRESETS),
  }));
  items.push(makeItem({
    group: "静默与频率",
    label: "静默时段 · 结束",
    path: "quietHours.end",
    kind: "time",
    candidates: () => valuesToCandidates(TIME_PRESETS),
  }));
  items.push(makeItem({
    group: "静默与频率",
    label: "静默时段 · 等级例外",
    path: "quietHours.exceptLevels",
    kind: "collection",
    candidates: () => valuesToCandidates(LEVELS),
    emptyLabel: "（无例外）",
  }));
  for (const [label, path] of [
    ["同运行合并窗口", "coalesce.windowMs"],
    ["工具失败聚合窗口", "coalesce.toolFailureWindowMs"],
    ["同类型冷却", "coalesce.cooldownMs"],
  ] as const) {
    items.push(makeItem({
      group: "静默与频率",
      label,
      path,
      kind: "number",
      presets: [0, 1500, 3000, 10000, 60000],
      unit: "ms",
      min: 0,
      max: 600000,
    }));
  }

  items.push(makeItem({
    group: "投递",
    label: "单次投递超时",
    path: "delivery.timeoutMs",
    kind: "number",
    presets: [1000, 3000, 5000, 8000, 30000],
    unit: "ms",
    min: 1,
    max: 120000,
  }));
  items.push(makeItem({
    group: "投递",
    label: "最大重试次数",
    path: "delivery.maxRetries",
    kind: "number",
    presets: [0, 1, 2, 3],
    min: 0,
    max: 10,
  }));
  items.push(makeItem({
    group: "投递",
    label: "并发投递数",
    path: "delivery.concurrency",
    kind: "number",
    presets: [1, 2, 4],
    min: 1,
    max: 8,
  }));
  items.push(makeItem({
    group: "投递",
    label: "队列上限",
    path: "delivery.queueLimit",
    kind: "number",
    presets: [10, 50, 100, 500],
    min: 1,
    max: 1000,
  }));
  items.push(makeItem({
    group: "投递",
    label: "熔断失败次数",
    path: "delivery.circuitBreakerFailures",
    kind: "number",
    presets: [0, 3, 5, 10],
    min: 0,
    max: 100,
  }));
  items.push(makeItem({
    group: "投递",
    label: "退出收尾预算",
    path: "shutdownFlushMs",
    kind: "number",
    presets: [0, 200, 500, 1000],
    unit: "ms",
    min: 0,
    max: 5000,
  }));

  // Providers expose only their switch; options (url, headers, secret references) stay JSON-only.
  for (const provider of config.providers) {
    items.push({
      id: `provider:${provider.id}`,
      group: "渠道",
      label: provider.id,
      kind: "boolean",
      providerId: provider.id,
      read: (current) => current.providers.find((item) => item.id === provider.id)?.enabled ?? false,
      patch: (value) => ({ kind: "providers", id: provider.id, value: value === true }),
      candidates: () => [{ value: true, label: "true" }, { value: false, label: "false" }],
      format: (value) => String(value === true),
      userPath: `providers.${provider.id}.enabled`,
      detail: () => provider.type,
    });
  }

  return items;
}

/**
 * True when this item was explicitly saved in the user file.
 * Providers live in an array, so their entry is located by id and `enabled` is checked there.
 */
export function hasUserDefault(rawUser: unknown, item: SettingItem): boolean {
  if (item.providerId !== undefined) {
    const providers = getPathValue(rawUser, "providers");
    if (!Array.isArray(providers)) return false;
    const entry = providers.find((candidate) => isPlainObject(candidate) && candidate.id === item.providerId);
    return entry !== undefined && hasPath(entry, "enabled");
  }
  return hasPath(rawUser, item.userPath);
}

/** Reads the value saved in the user file for this item, or undefined when it was never saved. */
export function userDefaultValue(rawUser: unknown, item: SettingItem): unknown {
  if (!hasUserDefault(rawUser, item)) return undefined;
  if (item.providerId !== undefined) {
    const providers = getPathValue(rawUser, "providers");
    const entry = Array.isArray(providers)
      ? providers.find((candidate) => isPlainObject(candidate) && candidate.id === item.providerId)
      : undefined;
    return isPlainObject(entry) ? entry.enabled : undefined;
  }
  return getPathValue(rawUser, item.userPath);
}

/** Compares a candidate against the current value; collection kinds match by membership. */
export function isCurrentValue(kind: SettingKind, current: unknown, candidate: SettingValue): boolean {
  if (kind === "collection") return Array.isArray(current) && current.some((item) => item === candidate);
  return current === candidate;
}

/**
 * Submit semantics of Enter: collection items toggle one member, every other kind replaces the
 * value. Member order is stable and new members are appended, so toggling never reorders candidates.
 */
export function collectionValue(current: unknown, candidate: SettingValue): SettingValue[] {
  const members: SettingValue[] = Array.isArray(current) ? [...current] as SettingValue[] : [];
  const index = members.findIndex((item) => item === candidate);
  if (index >= 0) members.splice(index, 1);
  else members.push(candidate);
  return members;
}

/** Candidate snapshot for the detail view, so rendering does not rebuild it on every frame. */
export function candidatesOf(item: SettingItem, config: NotificationConfig): SettingCandidate[] {
  return item.candidates(config);
}
