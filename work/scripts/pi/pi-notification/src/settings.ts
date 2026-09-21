/**
 * 通知设置的单一数据源（UX 方案 §值模型）。
 *
 * 三件事集中在这里，避免 commands/ui 各自拼路径字符串：
 *  1. **配置项描述表**：每一项的路径、分组、类型、候选值（含预设集）、格式化与解析。
 *  2. **会话覆盖（overlay）**：Enter 改的是「本对话」的值，深合并到已读盘的配置之上再交给
 *     `adoptConfig`；渠道开关单独放 `providers` 映射，避免把 options（可能含 header/密钥引用）
 *     复制进会话条目。
 *  3. **稀疏用户默认**：Ctrl+S 只写被保存的那一项；`hasUserDefault()` 按原始 JSON 的路径存在性判断，
 *     不靠「与出厂默认比较」——出厂默认不是用户保存过的默认值。
 *
 * 本模块不碰 IO、不碰 ctx：写盘在 config.ts，渲染与按键在 ui.ts。
 */

import { mergeConfig, type ConfigProblem } from "./config.ts";
import { getPathValue, hasPath, isPlainObject, mergePatch, setPatchPath, type ConfigPatch } from "./patch.ts";
import type { NotificationConfig, NotifyLevel } from "./types.ts";

// ---------------------------------------------------------------------------
// 会话覆盖
// ---------------------------------------------------------------------------

export { getPathValue, hasPath, mergePatch, setPatchPath };
export type { ConfigPatch };

/**
 * 「本对话选择」。`patch` 走 mergeConfig 的字段校验；`providers` 只存 id → enabled，
 * 与配置里的渠道数组（含 options）解耦。
 */
export interface SessionOverlay {
  patch: ConfigPatch;
  providers: Record<string, boolean>;
}

export function emptyOverlay(): SessionOverlay {
  return { patch: {}, providers: {} };
}

/** 判定 overlay 是否为空（空则不写会话条目、不覆盖配置）。 */
export function isEmptyOverlay(overlay: SessionOverlay): boolean {
  return Object.keys(overlay.patch).length === 0 && Object.keys(overlay.providers).length === 0;
}

/** 从会话条目数据恢复 overlay（形状防御：会话文件可能被手改）。 */
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
 * 从会话条目里恢复**本会话**的覆盖。
 *
 * 必须按 sessionId 过滤：`/fork`、`/clone` 会把分支上的条目复制进新会话文件，
 * 新会话的 sessionId 不同，于是不会继承上一个对话的临时选择。
 * 每次覆盖都是完整快照，所以取最后一条。
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
 * 把 overlay 叠到 base（已含出厂 + 用户默认）之上。
 *
 * 复用 `mergeConfig` 做逐字段校验：单项写盘/单项覆盖都只改一个字段，其余字段必须从 base 继承
 * （`checkRules` 已修正为按 base 继承，见 config.ts）。
 * 校验失败时**整体忽略 overlay** 并回报问题——一份自造且已失效的覆盖不该影响通知投递。
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
// 配置项描述表
// ---------------------------------------------------------------------------

export type SettingKind = "boolean" | "enum" | "number" | "time" | "collection";

export type SettingValue = string | number | boolean;

export type SettingPatch =
  /** 普通字段：一套路径同时用于会话覆盖与稀疏用户文件 */
  | { kind: "path"; path: string; value: unknown }
  /** 渠道开关：会话覆盖走 providers 映射，用户文件写整个 providers 数组 */
  | { kind: "providers"; id: string; value: boolean };

export interface SettingCandidate {
  value: SettingValue;
  /** 候选项文本（不含标记位与 default 尾标） */
  label: string;
}

export interface SettingItem {
  id: string;
  group: string;
  label: string;
  kind: SettingKind;
  /** 当前值（来自生效配置） */
  read(config: NotificationConfig): unknown;
  /** 生成写入补丁；集合项传整个数组 */
  patch(value: SettingValue | readonly SettingValue[]): SettingPatch;
  /** 候选项；number 项返回预设集，UI 自行追加 `custom…` 行 */
  candidates(config: NotificationConfig): SettingCandidate[];
  /** 父级列表里展示的值文本 */
  format(value: unknown): string;
  /** 用户级默认在原始用户 JSON 里的路径（渠道项见 providerId） */
  userPath: string;
  providerId?: string;
  /** 附加信息（渠道类型等） */
  detail?(config: NotificationConfig): string | undefined;
  /** 数值/时间项的输入框解析（预设之外的 `custom…`） */
  parseInput?(text: string): { ok: true; value: SettingValue } | { ok: false; message: string };
}

const LEVELS: NotifyLevel[] = ["info", "warning", "error"];

/** `custom…` 候选行的固定标签（UI 与测试共用）。 */
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

/** 带单位的展示（单位为空时就是值本身）。 */
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
  /** 集合型字段的空值展示 */
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

/** 时间项的预设候选：覆盖常见作息，其余走 `custom…`。 */
const TIME_PRESETS = ["00:00", "07:00", "08:00", "12:00", "18:00", "22:00", "23:00"];

/**
 * 构建当前配置的配置项列表（含渠道）。顺序即渲染顺序，分组即信息架构里的分类。
 * `config` 只用于渠道枚举，其余候选项与配置无关。
 */
export function buildSettingItems(config: NotificationConfig): SettingItem[] {
  const items: SettingItem[] = [];

  // 基础
  items.push(makeItem({ group: "基础", label: "总开关", path: "enabled", kind: "boolean" }));
  items.push(makeItem({
    group: "基础",
    label: "最低等级",
    path: "minLevel",
    kind: "enum",
    candidates: () => valuesToCandidates(LEVELS),
  }));

  // 通知规则
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
        // `custom` 永久排除（config.ts 会拦），所以不出现在候选里。
        candidates: () => valuesToCandidates(["select", "confirm", "input", "editor"]),
        emptyLabel: "（不等待任何类型）",
      }));
    }
  }

  // 内容
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

  // 静默与频率
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

  // 投递
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

  // 渠道：只开关；options（url/headers/密钥引用）保持 JSON 编辑
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
 * 用户文件里是否**显式保存过**这一项。
 * 渠道是数组，所以按 id 找条目并检查 `enabled` 是否存在。
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

/** 把用户文件里保存过的这一项读出来（没有则 undefined）。 */
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
 * 候选项与当前值是否同一项。集合项比较「是否属于集合」。
 */
export function isCurrentValue(kind: SettingKind, current: unknown, candidate: SettingValue): boolean {
  if (kind === "collection") return Array.isArray(current) && current.some((item) => item === candidate);
  return current === candidate;
}

/**
 * Enter 的提交语义：集合项切换成员，其余项整体替换。
 * 成员顺序稳定（新成员追加到末尾），避免每次切换都重排候选顺序。
 */
export function collectionValue(current: unknown, candidate: SettingValue): SettingValue[] {
  const members: SettingValue[] = Array.isArray(current) ? [...current] as SettingValue[] : [];
  const index = members.findIndex((item) => item === candidate);
  if (index >= 0) members.splice(index, 1);
  else members.push(candidate);
  return members;
}

/** 界面进入详情页时的候选快照（避免每次渲染都重建）。 */
export function candidatesOf(item: SettingItem, config: NotificationConfig): SettingCandidate[] {
  return item.candidates(config);
}
