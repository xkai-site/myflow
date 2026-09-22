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

import { defaultConfig, mergeConfig, type ConfigProblem } from "./config.ts";
import { getPathValue, hasPath, isPlainObject, mergePatch, removePath, setPatchPath, type ConfigPatch } from "./patch.ts";
import type { NotificationConfig, NotifyLevel, ToolFailureMode } from "./types.ts";

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

/**
 * Restores an overlay from session entry data; defensive because the session file can be edited by
 * hand. An entry with an empty patch/providers is a valid snapshot meaning “everything was cleared”
 * and is returned as such: dropping it would let a `/reload` resurrect the previous entry's choices.
 */
export function overlayFromEntry(value: unknown): SessionOverlay | undefined {
  if (!isPlainObject(value)) return undefined;
  const patch = isPlainObject(value.patch) ? (value.patch as ConfigPatch) : {};
  const providers: Record<string, boolean> = {};
  if (isPlainObject(value.providers)) {
    for (const [id, enabled] of Object.entries(value.providers)) {
      if (typeof enabled === "boolean") providers[id] = enabled;
    }
  }
  return { patch, providers };
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
  /** Rule this item belongs to; the UI groups a rule's fields onto one page. */
  rule?: { key: string; label: string };
  /**
   * False when the field has no effect in the current config, such as the immediate-only aggregation
   * window; hidden fields are never offered as if they did something. Defaults to visible.
   */
  visible?(config: NotificationConfig): boolean;
  /** Extra information such as the provider type. */
  detail?(config: NotificationConfig): string | undefined;
  /** Input parsing for number and time items, used by the `custom…` row. */
  parseInput?(text: string): { ok: true; value: SettingValue } | { ok: false; message: string };
  /** Unit and range shown while editing a `custom…` value; undefined when the item has no free input. */
  inputHint?: string;
}

const LEVELS: NotifyLevel[] = ["info", "warning", "error"];

/** Chinese text per level. Only the label changes; the stored value stays `info | warning | error`. */
const LEVEL_LABELS: Record<NotifyLevel, string> = {
  info: "提示",
  warning: "警告",
  error: "错误",
};

/**
 * The global threshold reads differently from a rule's own severity: `minLevel: warning` means
 * "warning and above", while a rule's `level: warning` describes the message itself. Using one
 * wording for both would make the two fields look like the same setting.
 */
const THRESHOLD_LABELS: Record<NotifyLevel, string> = {
  info: "所有等级",
  warning: "警告及错误",
  error: "仅错误",
};

const TOOL_FAILURE_MODE_LABELS: Record<ToolFailureMode, string> = {
  aggregate: "并入结果",
  immediate: "立即提醒",
};

const PROMPT_KIND_LABELS: Record<string, string> = {
  select: "选择",
  confirm: "确认",
  input: "输入",
  editor: "编辑器",
};

/** Boolean text used everywhere a boolean is displayed; the stored value stays `true`/`false`. */
export function booleanLabel(value: unknown): string {
  return value === true ? "开启" : "关闭";
}

const BOOLEAN_CANDIDATES: SettingCandidate[] = [
  { value: true, label: "开启" },
  { value: false, label: "关闭" },
];

/** Fixed label of the `custom…` candidate row, shared by the UI and the tests. */
export const CUSTOM_ROW_LABEL = "自定义…";

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

/** Unit text as shown to the user; `ms` always reads as 毫秒, never as a bare symbol. */
function unitText(unit: string): string {
  return unit === "ms" ? "毫秒" : unit;
}

/**
 * Milliseconds to readable text: below one second stays in 毫秒, otherwise seconds with only
 * trailing zeros removed. The stored value keeps full millisecond precision, and a non-round
 * value such as 4321 ms therefore reads back as `4.321 秒` instead of a rounded number.
 */
function formatDuration(value: unknown): string {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return String(value);
  if (ms < 1000) return `${ms} 毫秒`;
  const seconds = (ms / 1000).toFixed(3).replace(/\.?0+$/, "");
  return `${seconds} 秒`;
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
  /** Value to display text; a value missing from the map falls back to its raw form. */
  labels?: Record<string, string>;
  detail?: (config: NotificationConfig) => string | undefined;
  visible?: (config: NotificationConfig) => boolean;
}

function displayValue(value: unknown, labels?: Record<string, string>): string {
  const raw = String(value);
  return labels?.[raw] ?? raw;
}

function formatValue(
  kind: SettingKind,
  value: unknown,
  options: { unit: string; emptyLabel: string; labels?: Record<string, string> },
): string {
  if (value === undefined) return "—";
  if (kind === "collection") {
    const members = Array.isArray(value) ? value.map((item) => displayValue(item, options.labels)) : [];
    return members.length === 0 ? options.emptyLabel : members.join("、");
  }
  if (kind === "number") return options.unit === "ms" ? formatDuration(value) : withUnit(value, options.unit);
  if (kind === "boolean") return booleanLabel(value);
  return displayValue(value, options.labels);
}

function makeItem(spec: ItemSpec): SettingItem {
  const kind = spec.kind;
  const unit = spec.unit ?? "";
  const emptyLabel = spec.emptyLabel ?? "（空）";
  const labels = spec.labels;
  const format = (value: unknown): string => formatValue(kind, value, { unit, emptyLabel, ...(labels ? { labels } : {}) });
  const candidates = spec.candidates
    ?? (kind === "boolean"
      ? () => BOOLEAN_CANDIDATES.map((candidate) => ({ ...candidate }))
      // Number presets go through the same formatter as the rows, so a duration preset is never
      // shown as a raw `1500 ms` while the current value reads `1.5 秒`.
      : () => (spec.presets ?? []).map((value) => ({ value, label: format(value) })));

  const item: SettingItem = {
    id: spec.id ?? spec.path,
    group: spec.group,
    label: spec.label,
    kind,
    read: (config) => getPathValue(config, spec.path),
    patch: (value) => ({ kind: "path", path: spec.path, value }),
    candidates,
    format,
    userPath: spec.path,
    ...(spec.detail ? { detail: spec.detail } : {}),
    ...(spec.visible ? { visible: spec.visible } : {}),
  };

  if (kind === "number") {
    const min = spec.min ?? 0;
    const max = spec.max ?? Number.MAX_SAFE_INTEGER;
    const range = `${min}..${max}`;
    const unitSuffix = unit === "" ? "" : `（${unitText(unit)}）`;
    item.inputHint = `整数 ${range}${unitSuffix}`;
    item.parseInput = (text) => {
      const trimmed = text.trim();
      if (!/^\d+$/.test(trimmed)) return { ok: false, message: `必须是整数${unitSuffix}` };
      const value = Number(trimmed);
      if (!Number.isInteger(value) || value < min || value > max) {
        return { ok: false, message: `必须是 ${range} 的整数${unitSuffix}` };
      }
      return { ok: true, value };
    };
  }
  if (kind === "time") {
    item.inputHint = "HH:MM（00:00–23:59）";
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
 * Value this conversation set for the item, or undefined when Enter never touched it.
 * Presence, not equality: a session value equal to the user default is still a session override,
 * and comparing values would misreport "this conversation changed it" as "inherited".
 */
export function sessionOverrideValue(overlay: SessionOverlay, item: SettingItem): unknown {
  if (item.providerId !== undefined) {
    // Own-property check: an id like `toString` or `constructor` would otherwise read an inherited
    // Object.prototype member and be reported as a conversation override that does not exist.
    return Object.prototype.hasOwnProperty.call(overlay.providers, item.providerId)
      ? overlay.providers[item.providerId]
      : undefined;
  }
  return hasPath(overlay.patch, item.userPath) ? getPathValue(overlay.patch, item.userPath) : undefined;
}

/** Factory-default value of an item; the lowest of the three layers.
 *
 * A channel switch is special: `checkProviders` treats a missing `enabled` as true, so every
 * channel switch has a built-in default of on even when the channel definition itself is
 * user-provided (and therefore absent from `defaultConfig().providers`).
 */
export function builtinDefaultValue(item: SettingItem): unknown {
  if (item.providerId !== undefined) return true;
  return item.read(defaultConfig());
}

/**
 * Where a channel's definition comes from. Providers are populated only by the factory defaults or
 * the user file, so an id that appears in the user file counts as user-provided even when it
 * happens to be named like a built-in channel (its type or options may differ); the id alone is
 * not evidence of the factory definition.
 */
export function providerDefinitionSource(item: SettingItem, rawUser: unknown): "default" | "user" {
  if (item.providerId === undefined) return "default";
  const providers = getPathValue(rawUser, "providers");
  const definedByUser = Array.isArray(providers)
    && providers.some((candidate) => isPlainObject(candidate) && candidate.id === item.providerId);
  return definedByUser ? "user" : "default";
}

/**
 * Builds the setting list for the current config, providers included.
 * Array order is render order and the group is the section shown in the UI; `config` is only
 * used to enumerate providers, every other candidate is config-independent.
 */
export function buildSettingItems(config: NotificationConfig): SettingItem[] {
  const items: SettingItem[] = [];

  items.push(makeItem({ group: "基础", label: "启用通知", path: "enabled", kind: "boolean" }));
  items.push(makeItem({
    group: "基础",
    label: "通知门槛",
    path: "minLevel",
    kind: "enum",
    labels: THRESHOLD_LABELS,
    candidates: () => LEVELS.map((level) => ({ value: level, label: THRESHOLD_LABELS[level] })),
  }));

  const channelCandidates = (): SettingCandidate[] => (
    config.providers.map((provider) => ({ value: provider.id, label: provider.id }))
  );
  for (const rule of RULES) {
    const base = `rules.${rule.key}`;
    items.push(makeItem({ group: "通知规则", label: `${rule.label} · 开关`, path: `${base}.enabled`, kind: "boolean" }));
    items.push(makeItem({
      group: "通知规则",
      label: `${rule.label} · 严重程度`,
      path: `${base}.level`,
      kind: "enum",
      labels: LEVEL_LABELS,
      candidates: () => LEVELS.map((level) => ({ value: level, label: LEVEL_LABELS[level] })),
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
        labels: TOOL_FAILURE_MODE_LABELS,
        candidates: () => (["aggregate", "immediate"] as ToolFailureMode[]).map((mode) => ({
          value: mode,
          label: TOOL_FAILURE_MODE_LABELS[mode],
        })),
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
        labels: PROMPT_KIND_LABELS,
        candidates: () => valuesToCandidates(["select", "confirm", "input", "editor"])
          .map((candidate) => ({ value: candidate.value, label: PROMPT_KIND_LABELS[String(candidate.value)] ?? candidate.label })),
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

  items.push(makeItem({ group: "免打扰", label: "静默时段 · 开关", path: "quietHours.enabled", kind: "boolean" }));
  items.push(makeItem({
    group: "免打扰",
    label: "静默时段 · 开始",
    path: "quietHours.start",
    kind: "time",
    candidates: () => valuesToCandidates(TIME_PRESETS),
  }));
  items.push(makeItem({
    group: "免打扰",
    label: "静默时段 · 结束",
    path: "quietHours.end",
    kind: "time",
    candidates: () => valuesToCandidates(TIME_PRESETS),
  }));
  items.push(makeItem({
    group: "免打扰",
    label: "静默时段 · 等级例外",
    path: "quietHours.exceptLevels",
    kind: "collection",
    labels: LEVEL_LABELS,
    candidates: () => LEVELS.map((level) => ({ value: level, label: LEVEL_LABELS[level] })),
    emptyLabel: "（无例外）",
  }));
  for (const [label, path, visible] of [
    ["同运行合并窗口", "coalesce.windowMs"],
    // The immediate-mode aggregation window is only consumed by the immediate branch; in aggregate
    // mode it changes nothing, so it is hidden instead of pretending to be configurable.
    ["工具失败聚合窗口", "coalesce.toolFailureWindowMs", (config: NotificationConfig) => config.rules.toolFailed.mode === "immediate"],
    ["同类型冷却", "coalesce.cooldownMs"],
  ] as const) {
    items.push(makeItem({
      group: "高级设置",
      label,
      path,
      kind: "number",
      presets: [0, 1500, 3000, 10000, 60000],
      unit: "ms",
      min: 0,
      max: 600000,
      ...(visible ? { visible } : {}),
    }));
  }

  items.push(makeItem({
    group: "高级设置",
    label: "单次投递超时",
    path: "delivery.timeoutMs",
    kind: "number",
    presets: [1000, 3000, 5000, 8000, 30000],
    unit: "ms",
    min: 1,
    max: 120000,
  }));
  items.push(makeItem({
    group: "高级设置",
    label: "最大重试次数",
    path: "delivery.maxRetries",
    kind: "number",
    presets: [0, 1, 2, 3],
    min: 0,
    max: 10,
  }));
  items.push(makeItem({
    group: "高级设置",
    label: "并发投递数",
    path: "delivery.concurrency",
    kind: "number",
    presets: [1, 2, 4],
    min: 1,
    max: 8,
  }));
  items.push(makeItem({
    group: "高级设置",
    label: "队列上限",
    path: "delivery.queueLimit",
    kind: "number",
    presets: [10, 50, 100, 500],
    min: 1,
    max: 1000,
  }));
  items.push(makeItem({
    group: "高级设置",
    label: "熔断失败次数",
    path: "delivery.circuitBreakerFailures",
    kind: "number",
    presets: [0, 3, 5, 10],
    min: 0,
    max: 100,
  }));
  items.push(makeItem({
    group: "高级设置",
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
      read: (current) => current.providers.find((item) => item.id === provider.id)?.enabled,
      patch: (value) => ({ kind: "providers", id: provider.id, value: value === true }),
      candidates: () => BOOLEAN_CANDIDATES.map((candidate) => ({ ...candidate })),
      format: (value) => booleanLabel(value),
      userPath: `providers.${provider.id}.enabled`,
      detail: () => provider.type,
    });
  }

  // Rule items are tagged by id so the UI can group one rule's fields onto a single page without
  // re-parsing the label.
  for (const item of items) {
    const match = /^rules\.([^.]+)\./.exec(item.id);
    if (!match) continue;
    const rule = RULES.find((candidate) => candidate.key === match[1]);
    if (rule) item.rule = { key: rule.key, label: rule.label };
  }

  return items;
}

/** Rule rows of the home page's 通知规则 category, in the stable `RULES` order. */
export const RULE_INFOS: ReadonlyArray<{ key: string; label: string }> = RULES.map((rule) => ({ key: rule.key, label: rule.label }));

/**
 * One-line summary of a rule for its list row: switch, severity and channels, each formatted by
 * the same `format()` the field rows use, so the two views cannot drift apart.
 */
export function ruleSummary(config: NotificationConfig, items: readonly SettingItem[], ruleKey: string): string {
  const of = (suffix: string): SettingItem | undefined => items.find((item) => item.id === `rules.${ruleKey}.${suffix}`);
  return ["enabled", "level", "channels"]
    .map((suffix) => of(suffix))
    .filter((item): item is SettingItem => item !== undefined)
    .map((item) => item.format(item.read(config)))
    .join(" · ");
}

/**
 * Home-page category: either one row per rule, or the fields of a group. `summary` is recomputed
 * from the effective config on every refresh, so a category row never shows a stale value.
 */
export interface SettingCategory {
  id: string;
  label: string;
  kind: "rules" | "fields";
  /** Group whose items this category lists; only for `kind: "fields"`. */
  group?: string;
  summary(config: NotificationConfig): string;
  /**
   * Rows hidden behind one expandable row while `when` is true (a disabled feature's parameters).
   * They stay reachable through that row instead of disappearing from the UI entirely.
   */
  collapsed?: { when(config: NotificationConfig): boolean; label: string; note: string; ids: readonly string[] };
  /** Extra action rows appended after the fields (e.g. preview and advanced maintenance actions). */
  actions?: ReadonlyArray<{ key: string; action: "test" | "status" | "reload" | "search" | "preview" }>;
}

/**
 * Rows of a category page: the visible fields of its group, or the always-shown ones plus the
 * expandable row for the parameters a disabled feature hides.
 */
export function categoryPageItems(
  category: SettingCategory,
  items: readonly SettingItem[],
  config: NotificationConfig,
): { items: SettingItem[]; collapsed: SettingItem[] } {
  const ofGroup = items.filter((item) => item.group === category.group && (item.visible?.(config) ?? true));
  const collapsed = category.collapsed;
  if (!collapsed || !collapsed.when(config)) return { items: ofGroup, collapsed: [] };
  const ids = new Set(collapsed.ids);
  return { items: ofGroup.filter((item) => !ids.has(item.id)), collapsed: ofGroup.filter((item) => ids.has(item.id)) };
}

/**
 * Categories shown on the home page, in render order. Order is part of the UI contract; the group
 * names are the same ones `buildSettingItems` assigns, so a category page is a plain group filter.
 */
export const SETTING_CATEGORIES: readonly SettingCategory[] = [
  {
    id: "rules",
    label: "通知场景",
    kind: "rules",
    summary: (config) => {
      const enabled = RULE_INFOS.filter((rule) => config.rules[rule.key as keyof NotificationConfig["rules"]].enabled).length;
      // Short on purpose: a comma-joined list of every event name would crowd out the label on a
      // narrow terminal, and the rule rows below already spell each event out.
      return enabled === 0 ? "全部关闭" : `${enabled} 类已开启`;
    },
  },
  { id: "content", label: "通知内容", kind: "fields", group: "内容", summary: () => "耗时、会话名等", actions: [{ key: "action:preview", action: "preview" }] },
  {
    id: "quietHours",
    label: "安静时间",
    kind: "fields",
    group: "免打扰",
    summary: (config) => (config.quietHours.enabled ? `${config.quietHours.start}–${config.quietHours.end}` : "未开启"),
    // While quiet hours are off the times and exceptions change nothing, so they collapse behind one
    // row that still opens them; turning the feature on reveals them in place.
    collapsed: {
      when: (config) => !config.quietHours.enabled,
      label: "静默时间与例外",
      note: "启用后生效",
      ids: ["quietHours.start", "quietHours.end", "quietHours.exceptLevels"],
    },
  },
  {
    id: "channels",
    label: "通知方式",
    kind: "fields",
    group: "渠道",
    summary: (config) => {
      const enabled = config.providers.filter((provider) => provider.enabled).length;
      return enabled === 0 ? "无启用渠道" : `${enabled} 个已启用`;
    },
  },
  {
    id: "advanced",
    label: "更多设置",
    kind: "fields",
    group: "高级设置",
    summary: () => "高级选项、测试与诊断",
    actions: [
      { key: "action:test", action: "test" },
      { key: "action:status", action: "status" },
      { key: "action:reload", action: "reload" },
      { key: "action:search", action: "search" },
    ],
  },
];

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

/**
 * User-file patch that saves one channel switch (Ctrl+S on a provider item).
 *
 * `providers` is an array field and `mergePatch` replaces arrays as a whole, so the patch must
 * carry the complete array. Building it from the effective config would freeze everything else
 * into the user file — other channels' conversation switches and every channel's factory
 * `options` — so it is rebuilt from the **raw user file** instead, where only the target entry's
 * `enabled` changes. Existing entries keep their order, options, unknown fields and sibling
 * channels; a channel that only exists in the factory defaults gets a minimal new entry
 * (`id`, `type`, `enabled`) rather than a copy of its factory options.
 */
export function channelUserFilePatch(
  rawUser: unknown,
  providerId: string,
  providerType: string,
  value: boolean,
): ConfigPatch {
  const rawProviders = getPathValue(rawUser, "providers");
  const entries: unknown[] = Array.isArray(rawProviders)
    ? rawProviders.map((entry) => (isPlainObject(entry) ? { ...entry } : entry))
    : [];
  const index = entries.findIndex((entry) => isPlainObject(entry) && entry.id === providerId);
  if (index >= 0) {
    entries[index] = { ...(entries[index] as Record<string, unknown>), enabled: value };
  } else {
    entries.push({ id: providerId, type: providerType, enabled: value });
  }
  return { providers: entries };
}

/**
 * This conversation's overlay without the item's entry: “follow the user default again”. The
 * provider map is keyed by id; a plain field is removed by path with its empty ancestors pruned.
 */
export function clearItemOverride(overlay: SessionOverlay, item: SettingItem): SessionOverlay {
  if (item.providerId !== undefined) {
    const providers = { ...overlay.providers };
    delete providers[item.providerId];
    return { patch: overlay.patch, providers };
  }
  return { patch: removePath(overlay.patch, item.userPath), providers: { ...overlay.providers } };
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
