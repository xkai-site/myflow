/** Setting descriptions: identity, presentation, input parsing and owned write operations.
 * Session/default state and transaction semantics live in settings-state.ts. No IO here.
 */
import { getPathValue } from "./patch.ts";
import { resolveChannels } from "./rules.ts";
import type { NotificationConfig, NotifyLevel } from "./types.ts";

export type SettingKind = "boolean" | "enum" | "number" | "time" | "collection";
export type SettingValue = string | number | boolean;
export type SimpleSettingPatch =
  | { kind: "path"; path: string; value: unknown }
  | { kind: "providers"; id: string; value: boolean }
  | { kind: "providerOption"; id: string; optionPath: string; value: unknown };
export type SettingPatch = SimpleSettingPatch | { kind: "compound"; operations: SimpleSettingPatch[] };
export interface SettingCandidate {
  value: SettingValue;
  label: string;
}
export interface SettingItem {
  id: string;
  group: string;
  label: string;
  kind: SettingKind;
  read(config: NotificationConfig): unknown;
  patch(value: SettingValue | readonly SettingValue[]): SettingPatch;
  candidates(config: NotificationConfig): SettingCandidate[];
  format(value: unknown): string;
  userPath: string;
  /** Composite items own these paths and combine their values consistently across all layers. */
  paths?: string[];
  combine?(values: unknown[]): unknown;
  destinations?: boolean;
  snapshot?(config: NotificationConfig): SettingPatch;
  providerId?: string;
  providerOptionPath?: string;
  rule?: { key: keyof NotificationConfig["rules"]; label: string };
  parseInput?(text: string): { ok: true; value: SettingValue | SettingValue[] } | { ok: false; message: string };
  inputHint?: string;
}
const LEVELS: NotifyLevel[] = ["info", "warning", "error"];
const LEVEL_LABELS = { info: "提示", warning: "警告", error: "错误" };
const THRESHOLD_LABELS = { info: "所有等级", warning: "警告及错误", error: "仅错误" };
const CHANNEL_LABELS: Record<string, string> = {
  terminal: "本机通知",
  email: "邮箱通知",
  hook: "Webhook",
  debug: "调试渠道",
  noop: "不投递",
};
export function channelLabel(id: string): string {
  return CHANNEL_LABELS[id] ?? id;
}
export function booleanLabel(value: unknown): string {
  return value === "mixed"
    ? "部分开启"
    : value === "partial"
    ? "部分已修改"
    : value === true
    ? "开启"
    : "关闭";
}
const BOOLEAN_CANDIDATES: SettingCandidate[] = [
  { value: true, label: "开启" },
  { value: false, label: "关闭" },
];
export const CUSTOM_ROW_LABEL = "自定义…";
export const RULE_INFOS: ReadonlyArray<{ key: keyof NotificationConfig["rules"]; label: string }> = [
  { key: "runCompleted", label: "运行完成" },
  { key: "runFailed", label: "运行失败" },
  { key: "runAborted", label: "运行中止" },
  { key: "toolFailed", label: "工具失败" },
  { key: "compactFailed", label: "压缩失败" },
  { key: "waitingForUser", label: "等待输入" },
];
export function routingExceptions(config: NotificationConfig): string[] {
  return RULE_INFOS.filter((rule) => config.rules[rule.key].channels !== "inherit").map((rule) => rule.label);
}
interface ItemSpec {
  id?: string;
  group: string;
  label: string;
  path: string;
  kind: SettingKind;
  candidates?: (config: NotificationConfig) => SettingCandidate[];
  presets?: number[];
  min?: number;
  max?: number;
  emptyLabel?: string;
  labels?: Record<string, string>;
}
function makeItem(spec: ItemSpec): SettingItem {
  const display = (value: unknown) => spec.labels?.[String(value)] ?? String(value);
  const format = (value: unknown): string => {
    if (value === undefined) return "—";
    if (spec.kind === "collection") {
      if (value === "inherit") return "跟随统一接收方式";
      return Array.isArray(value) && value.length ? value.map(display).join("、") : spec.emptyLabel ?? "（空）";
    }
    return spec.kind === "boolean" ? booleanLabel(value) : display(value);
  };
  const item: SettingItem = {
    id: spec.id ?? spec.path,
    group: spec.group,
    label: spec.label,
    kind: spec.kind,
    userPath: spec.path,
    read: (config) => getPathValue(config, spec.path),
    patch: (value) => ({ kind: "path", path: spec.path, value }),
    format,
    candidates:
      spec.candidates ??
      (spec.kind === "boolean"
        ? () => BOOLEAN_CANDIDATES.map((entry) => ({ ...entry }))
        : () => (spec.presets ?? []).map((value) => ({ value, label: format(value) }))),
  };
  if (spec.kind === "number") {
    const min = spec.min!,
      max = spec.max!,
      range = `${min}..${max}`;
    item.inputHint = `整数 ${range}`;
    item.parseInput = (text) => {
      const trimmed = text.trim();
      if (!/^\d+$/.test(trimmed)) return { ok: false, message: "必须是整数" };
      const value = Number(trimmed);
      return Number.isInteger(value) && value >= min && value <= max
        ? { ok: true, value }
        : { ok: false, message: `必须是 ${range} 的整数` };
    };
  }
  if (spec.kind === "time") {
    item.inputHint = "HH:MM（00:00–23:59）";
    item.parseInput = (text) =>
      /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text.trim())
        ? { ok: true, value: text.trim() }
        : { ok: false, message: "请输入 HH:MM 格式的时间（00:00–23:59）" };
  }
  return item;
}
function compositeItem(item: SettingItem, paths: string[], combine: (values: unknown[]) => unknown): SettingItem {
  return {
    ...item,
    paths,
    combine,
    read: (config) => combine(paths.map((path) => getPathValue(config, path))),
    patch: (value) => ({ kind: "compound", operations: paths.map((path) => ({ kind: "path", path, value })) }),
    snapshot: (config) => ({
      kind: "compound",
      operations: paths.map((path) => ({ kind: "path", path, value: getPathValue(config, path) })),
    }),
  };
}
/** Only settings reachable in the current product are constructed; JSON-only policies stay JSON-only. */
export function buildSettingItems(config: NotificationConfig): SettingItem[] {
  const items: SettingItem[] = [];
  const add = (spec: ItemSpec) => items.push(makeItem(spec));
  add({ group: "基础", label: "通知总开关", path: "enabled", kind: "boolean" });
  add({
    id: "reminders.completed",
    group: "提醒时机",
    label: "执行完成",
    path: "rules.runCompleted.enabled",
    kind: "boolean",
  });
  add({
    group: "基础",
    label: "提醒级别",
    path: "minLevel",
    kind: "enum",
    labels: THRESHOLD_LABELS,
    candidates: () => LEVELS.map((value) => ({ value, label: THRESHOLD_LABELS[value] })),
  });
  items.push(
    compositeItem(
      makeItem({
        id: "reminders.failed",
        group: "提醒时机",
        label: "执行失败",
        path: "rules.runFailed.enabled",
        kind: "boolean",
      }),
      ["rules.runFailed.enabled", "rules.compactFailed.enabled"],
      (values) =>
        values.every((value) => value === true) ? true : values.every((value) => value === false) ? false : "mixed"
    )
  );
  add({
    id: "reminders.waiting",
    group: "提醒时机",
    label: "等待输入",
    path: "rules.waitingForUser.enabled",
    kind: "boolean",
  });
  const channelCandidates = (): SettingCandidate[] =>
    [
      ...new Set([
        ...config.providers.map((provider) => provider.id),
        ...config.channels,
        ...Object.values(config.rules).flatMap((rule) => (rule.channels === "inherit" ? [] : rule.channels)),
      ]),
    ].map((id) => ({
      value: id,
      label: `${channelLabel(id)}${
        config.providers.some((provider) => provider.id === id) ? "" : "（未找到，可取消选择）"
      }`,
    }));
  const channelLabels = Object.fromEntries(
    config.providers.map((provider) => [provider.id, channelLabel(provider.id)])
  );
  items.push({
    ...makeItem({
      group: "接收",
      label: "统一接收选择",
      path: "channels",
      kind: "collection",
      candidates: channelCandidates,
      labels: channelLabels,
      emptyLabel: "不投递",
    }),
    destinations: true,
    patch: (value) => ({
      kind: "compound",
      operations: [
        { kind: "path", path: "channels", value },
        ...(Array.isArray(value)
          ? value.filter(
              (id) => !config.channels.includes(String(id)) && config.providers.some((provider) => provider.id === id)
            )
          : []
        ).map((id) => ({ kind: "providers" as const, id: String(id), value: true })),
      ],
    }),
    snapshot: (current) => ({
      kind: "compound",
      operations: [
        { kind: "path", path: "channels", value: [...current.channels] },
        ...current.providers
          .filter((provider) => current.channels.includes(provider.id))
          .map((provider) => ({ kind: "providers" as const, id: provider.id, value: provider.enabled })),
      ],
    }),
  });
  const routes = compositeItem(
    makeItem({
      id: "routes.unify",
      group: "接收",
      label: "让所有提醒跟随统一接收方式",
      path: "rules.runCompleted.channels",
      kind: "enum",
    }),
    RULE_INFOS.map((rule) => `rules.${rule.key}.channels`),
    (values) => (values.every((value) => value === "inherit") ? "inherit" : "custom")
  );
  items.push({
    ...routes,
    candidates: () => [{ value: "inherit", label: "所有提醒使用统一接收方式（不改变提醒时机）" }],
    format: (value) =>
      value === "inherit" ? "全部使用统一接收方式" : value === "partial" ? "部分已修改" : "有提醒单独设置了接收方式",
    patch: () => ({
      kind: "compound",
      operations: routes.paths!.map((path) => ({ kind: "path", path, value: "inherit" })),
    }),
  });
  for (const rule of RULE_INFOS) {
    const base = `rules.${rule.key}`;
    add({ group: "通知规则", label: `${rule.label}：开关`, path: `${base}.enabled`, kind: "boolean" });
    add({
      group: "通知规则",
      label: `${rule.label}：重要程度`,
      path: `${base}.level`,
      kind: "enum",
      labels: LEVEL_LABELS,
      candidates: () => LEVELS.map((value) => ({ value, label: LEVEL_LABELS[value] })),
    });
    add({
      group: "通知规则",
      label: `${rule.label}：接收方式`,
      path: `${base}.channels`,
      kind: "collection",
      candidates: channelCandidates,
      labels: channelLabels,
      emptyLabel: "（不发送提醒）",
    });
    for (const item of items.slice(-3)) item.rule = rule;
  }
  for (const [path, label] of [
    ["includeDuration", "包含耗时"],
    ["includeToolFailureNames", "包含失败工具名"],
    ["includeSessionLabel", "标题包含窗口标识"],
    ["includeAssistantExcerpt", "包含助手摘录"],
    ["includeCost", "包含成本与上下文"],
  ])
    add({ group: "内容", label, path: `content.${path}`, kind: "boolean" });
  add({
    group: "内容",
    label: "正文最大长度",
    path: "content.maxMessageChars",
    kind: "number",
    presets: [100, 300, 600, 1200],
    min: 20,
    max: 2000,
  });
  add({ group: "免打扰", label: "启用免打扰", path: "quietHours.enabled", kind: "boolean" });
  for (const [path, label] of [
    ["start", "开始时间"],
    ["end", "结束时间"],
  ])
    add({
      group: "免打扰",
      label,
      path: `quietHours.${path}`,
      kind: "time",
      candidates: () =>
        ["00:00", "07:00", "08:00", "12:00", "18:00", "22:00", "23:00"].map((value) => ({ value, label: value })),
    });
  add({
    group: "免打扰",
    label: "免打扰期间仍要接收",
    path: "quietHours.exceptLevels",
    kind: "collection",
    labels: LEVEL_LABELS,
    candidates: () => LEVELS.map((value) => ({ value, label: LEVEL_LABELS[value] })),
    emptyLabel: "（无例外）",
  });
  for (const provider of config.providers) {
    items.push({
      id: `provider:${provider.id}`,
      group: "渠道",
      label: channelLabel(provider.id),
      kind: "boolean",
      providerId: provider.id,
      read: (current) => current.providers.find((entry) => entry.id === provider.id)?.enabled,
      patch: (value) => ({ kind: "providers", id: provider.id, value: value === true }),
      candidates: () => BOOLEAN_CANDIDATES.map((entry) => ({ ...entry })),
      format: booleanLabel,
      userPath: `providers.${provider.id}.enabled`,
    });
    if (provider.id === "email" && provider.type === "email") {
      items.push(
        emailOption("from", "发件 QQ 邮箱"),
        emailOption("to", "收件邮箱（多个）"),
        emailOption("subjectPrefix", "主题前缀")
      );
    }
  }
  return items;
}
function emailOption(optionPath: "from" | "to" | "subjectPrefix", label: string): SettingItem {
  const list = optionPath === "to";
  return {
    id: `provider:email:${optionPath}`,
    group: optionPath === "subjectPrefix" ? "邮箱专业" : "邮箱",
    label,
    kind: list ? "collection" : "enum",
    providerId: "email",
    providerOptionPath: optionPath,
    userPath: `providers.email.options.${optionPath}`,
    read: (config) => getPathValue(config.providers.find((entry) => entry.id === "email")?.options, optionPath),
    patch: (value) => ({
      kind: "providerOption",
      id: "email",
      optionPath,
      value: list ? (Array.isArray(value) ? value : []) : value,
    }),
    candidates: () => [],
    format: (value) =>
      Array.isArray(value)
        ? value.length
          ? value.join(", ")
          : "（未配置）"
        : value === undefined || value === ""
        ? "（未配置）"
        : String(value),
    inputHint: list
      ? "最多 50 个收件地址，逗号分隔；留空清除"
      : optionPath === "from"
      ? "发件邮箱地址，最长 254 字符；留空清除"
      : "主题前缀，最长 254 字符；可留空",
    parseInput: (text) => {
      const value = text.trim();
      if (value.length > (list ? 12700 : 254) || /[\r\n\0]/.test(value))
        return { ok: false, message: "输入过长或包含换行" };
      if (list) {
        const addresses = [
          ...new Set(
            value
              .split(/[,，]/)
              .map((part) => part.trim())
              .filter(Boolean)
          ),
        ];
        if (
          addresses.length > 50 ||
          addresses.some((address) => !/^[^\s@,，<>]+@[^\s@,，<>]+\.[^\s@,，<>]+$/.test(address))
        )
          return { ok: false, message: "请提供最多 50 个有效邮箱地址，以逗号分隔" };
        return { ok: true, value: addresses };
      }
      return optionPath === "from" && value && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)
        ? { ok: false, message: "请输入有效发件邮箱地址" }
        : { ok: true, value };
    },
  };
}
export function ruleSummary(config: NotificationConfig, items: readonly SettingItem[], ruleKey: string): string {
  if (!config.rules[ruleKey as keyof NotificationConfig["rules"]].enabled) return "关闭";
  return ["level", "channels"]
    .map((suffix) => items.find((item) => item.id === `rules.${ruleKey}.${suffix}`))
    .filter((item): item is SettingItem => item !== undefined)
    .map((item) =>
      item.id.endsWith(".channels")
        ? `${item.read(config) === "inherit" ? "跟随统一：" : "单独设置："}${
            resolveChannels(config, config.rules[item.rule!.key])
              .map(
                (id) =>
                  `${channelLabel(id)}${
                    config.providers.find((provider) => provider.id === id)?.enabled ? "" : "（关闭或不可用）"
                  }`
              )
              .join("、") || "不发送"
          }`
        : item.format(item.read(config))
    )
    .join("，");
}
export interface SettingCategory {
  id: string;
  label: string;
  kind: "rules" | "fields" | "sections";
  group?: string;
  sections?: readonly string[];
  summary(config: NotificationConfig): string;
  collapsed?: { when(config: NotificationConfig): boolean; label: string; note: string; ids: readonly string[] };
  actions?: ReadonlyArray<{ key: string; action: "status" | "reload" | "search" | "preview" | "help" }>;
}
export function categoryPageItems(
  category: SettingCategory,
  items: readonly SettingItem[],
  config: NotificationConfig
): { items: SettingItem[]; collapsed: SettingItem[] } {
  const fields = items.filter((item) => item.group === category.group);
  if (!category.collapsed?.when(config)) return { items: fields, collapsed: [] };
  const ids = new Set(category.collapsed.ids);
  return { items: fields.filter((item) => !ids.has(item.id)), collapsed: fields.filter((item) => ids.has(item.id)) };
}
export const SETTING_CATEGORIES: readonly SettingCategory[] = [
  {
    id: "expertRules",
    label: "逐规则设置",
    kind: "rules",
    summary: (config) => `${routingExceptions(config).length} 类单独设置接收方式`,
  },
  {
    id: "providers",
    label: "接收方式开关",
    kind: "fields",
    group: "渠道",
    summary: (config) =>
      config.providers
        .filter((entry) => entry.enabled)
        .map((entry) => channelLabel(entry.id))
        .join("、") || "无启用渠道",
  },
  { id: "emailAdvanced", label: "邮箱主题", kind: "fields", group: "邮箱专业", summary: () => "主题前缀" },
  {
    id: "rules",
    label: "提醒时机",
    kind: "fields",
    group: "提醒时机",
    summary: (config) =>
      [
        config.rules.runCompleted.enabled ? "完成" : "",
        config.rules.runFailed.enabled || config.rules.compactFailed.enabled ? "失败" : "",
        config.rules.waitingForUser.enabled ? "等待输入" : "",
        config.rules.toolFailed.enabled ? "工具失败" : "",
        config.rules.runAborted.enabled ? "中止" : "",
      ]
        .filter(Boolean)
        .join("、") || "全部关闭",
  },
  {
    id: "content",
    label: "内容与隐私",
    kind: "fields",
    group: "内容",
    summary: () => "",
    actions: [{ key: "action:preview", action: "preview" }],
  },
  {
    id: "quietHours",
    label: "免打扰时段",
    kind: "fields",
    group: "免打扰",
    summary: (config) => (config.quietHours.enabled ? `${config.quietHours.start}–${config.quietHours.end}` : "未开启"),
    collapsed: {
      when: (config) => !config.quietHours.enabled,
      label: "静默时间与例外",
      note: "启用后生效",
      ids: ["quietHours.start", "quietHours.end", "quietHours.exceptLevels"],
    },
  },
  {
    id: "channels",
    label: "接收方式",
    kind: "fields",
    group: "接收",
    summary: (config) =>
      `${
        config.channels
          .map((id) => {
            const provider = config.providers.find((entry) => entry.id === id);
            return `${channelLabel(id)}${!provider ? "（未找到）" : !provider.enabled ? "（已关闭）" : ""}`;
          })
          .join("、") || "未选择"
      }${routingExceptions(config).length ? "（有提醒单独设置）" : ""}`,
  },
  {
    id: "professional",
    label: "专业设置",
    kind: "sections",
    sections: ["channels", "expertRules", "providers", "emailAdvanced"],
    summary: () => "",
  },
  {
    id: "more",
    label: "更多设置",
    kind: "sections",
    sections: ["content", "quietHours", "professional"],
    summary: () => "",
    actions: [
      { key: "action:status", action: "status" },
      { key: "action:reload", action: "reload" },
      { key: "action:search", action: "search" },
      { key: "action:help", action: "help" },
    ],
  },
];
export function isCurrentValue(kind: SettingKind, current: unknown, candidate: SettingValue): boolean {
  return kind === "collection" ? Array.isArray(current) && current.includes(candidate) : current === candidate;
}
export function collectionValue(current: unknown, candidate: SettingValue): SettingValue[] {
  const members: SettingValue[] = Array.isArray(current) ? [...current] : [];
  const index = members.indexOf(candidate);
  if (index >= 0) members.splice(index, 1);
  else members.push(candidate);
  return members;
}
