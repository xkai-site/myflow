/**
 * Settings UI.
 *
 * Three levels, entered from a fixed home page (never a flat dump of every field):
 *  - the home page: the global switch and threshold, then one row per category, then the two
 *    actions; a category row carries a summary so its state is readable without opening it;
 *  - a category page: either the fields of one group (内容/免打扰/渠道/高级设置) or one row per
 *    notification rule;
 *  - the candidate list of one field, with fixed marker columns (two columns for focus, two for the
 *    current value); the trailing ` · 默认` is a separate channel and can coexist with the markers.
 *
 * Esc pops one level of a `history` stack, so the parent page and its focus come back exactly as
 * they were; the read-only `?` field details are part of the same stack.
 *
 * This module only renders and handles keys; persistence, activation and the silence checks
 * live in the command layer, so the component can be driven without a host.
 *
 * Deliberate choices:
 *  1. Marker cells carry no colour, so a marker appearing or disappearing never shifts text
 *     horizontally.
 *  2. The trailing ` · 默认` and the marker columns are given width before the value text;
 *     overflow truncates the value and never swallows a marker.
 *  3. Ctrl+S is consumed only while the component holds input; no global shortcut is
 *     registered, so it cannot collide with the host's own save binding.
 *  4. Space is the quick toggle (booleans on a page, the focused candidate in a candidate list);
 *     Enter is the explicit open/select, so a boolean can still be opened to read its source.
 */

import { CURSOR_MARKER, decodeKittyPrintable, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import {
  CUSTOM_ROW_LABEL,
  RULE_INFOS,
  SETTING_CATEGORIES,
  buildSettingItems,
  builtinDefaultValue,
  categoryPageItems,
  collectionValue,
  hasUserDefault,
  isCurrentValue,
  providerDefinitionSource,
  ruleSummary,
  userDefaultValue,
  type SettingCategory,
  type SettingItem,
  type SettingValue,
} from "./settings.ts";
import type { NotificationConfig } from "./types.ts";

/** Only the theme capabilities used here, as method signatures, to stay SDK-palette agnostic. */
export interface SettingsTheme {
  fg(color: "accent" | "muted" | "dim" | "success" | "error" | "warning" | "text", text: string): string;
  bold(text: string): string;
}

/** Injected key parser: the host passes its keybindings manager, tests pass a stub. */
export interface SettingsKeybindings {
  matches(data: string, keybinding: string): boolean;
}

export type ItemValue = SettingValue | SettingValue[];

/**
 * Session-level restriction that overrides the user's own setting, such as forced silence.
 * Kept separate from the three value layers so the UI shows it as an extra limit instead of
 * reporting it as a user default that was turned off.
 */
export interface SettingsRestriction {
  label: string;
  reason: string;
}

export interface SettingsHost {
  /** Effective config, including this conversation's overlay. */
  config(): NotificationConfig;
  /** Raw user file, used for the presence and value of sparse user defaults. */
  userRaw(): unknown;
  /**
   * Value this conversation's overlay set for the item, or undefined when Enter never touched it.
   * Presence decides "this conversation changed it"; comparing values cannot tell an override that
   * happens to equal the user default from an inherited one.
   */
  sessionOverride(item: SettingItem): unknown;
  /** Session-level restrictions that override the user's setting; empty when none apply. */
  restrictions(): SettingsRestriction[];
  /** Enter: writes the per-conversation overlay, effective immediately. */
  setValue(item: SettingItem, value: ItemValue): { ok: boolean; message: string };
  /** Ctrl+S: freezes the value as a user default with a single sparse write. */
  saveDefault(item: SettingItem, value: ItemValue): { ok: boolean; message: string };
  /** Ctrl+T: sends a test notification. */
  test(): { ok: boolean; message: string };
  /** Ctrl+R: re-reads the config without reloading the extension. */
  reload(): { ok: boolean; message: string };
  /** Ctrl+O: read-only, paged status text. */
  statusLines(): string[];
}

/** Visible list rows; the component sizes itself instead of reading the terminal height. */
const BODY_ROWS = 12;
/**
 * Content column cap: rows stop at this width even on a very wide terminal, so a label and its
 * value stay together instead of drifting apart across a 200-column window. The component still
 * respects the caller's width when the terminal is narrower.
 */
const MAX_CONTENT_WIDTH = 80;
/** Focus and current-value cells are two display columns each and stay reserved when unset. */
const FOCUS_CELL = (focused: boolean): string => (focused ? "→ " : "  ");
const CURRENT_CELL = (current: boolean): string => (current ? "✓ " : "  ");
/** Above this width the candidate row also shows the channel type in brackets. */
const DETAIL_MIN_WIDTH = 28;
/** Below this width the trailing ` · 默认` is dropped so the value label keeps its room. */
const DEFAULT_SUFFIX_MIN_WIDTH = 24;
/** Trailing marker of a row that opens another page. */
const OPEN_MARK = " ›";

const FOOTER_KEY_HINTS = "更多设置中可进行测试、重读与诊断";
const STATUS_KEY_HINTS = "Ctrl+T 自检   Ctrl+R 重读   Ctrl+O 状态与诊断";

const ACTION_LABELS: Record<"test" | "status" | "reload" | "search" | "preview", string> = {
  test: "发送测试通知",
  status: "状态与诊断",
  reload: "重新读取配置",
  search: "搜索设置",
  preview: "通知预览",
};

/** One row of a menu page (home, a category, or a rule's fields). */
type MenuRow =
  | { key: string; kind: "field"; item: SettingItem; label: string }
  | { key: string; kind: "rule"; rule: { key: string; label: string } }
  | { key: string; kind: "category"; category: SettingCategory }
  /** One row that opens the parameters a disabled feature collapsed. */
  | { key: string; kind: "subgroup"; category: SettingCategory }
  /** Read-only information row on the status page. */
  | { key: string; kind: "text"; text: string }
  | { key: string; kind: "action"; action: "test" | "status" | "reload" | "search" | "preview" };

/** Pages that are a list of rows; `id` is stable so a refresh can rebuild the same page. */
interface MenuPage {
  kind: "menu";
  id: string;
  title: string;
  rows: MenuRow[];
  focus: number;
}

type View =
  | MenuPage
  | { kind: "detail"; itemId: string; focus: number }
  | { kind: "input"; itemId: string; buffer: string; error?: string }
  /** Read-only, pageable full field details; `a`/`d` run the restore actions. */
  | { kind: "help"; itemId: string; offset: number }
  /** Search over the complete field table; Enter opens a result even when it is otherwise hidden. */
  | { kind: "search"; query: string; focus: number }
  /** Confirmation page for the destructive restore; default focus is cancel. */
  | { kind: "confirm"; itemId: string; focus: number }
  /** Read-only example notification body. */
  | { kind: "preview"; lines: string[]; offset: number };

type Tone = "info" | "success" | "error";

interface Candidate {
  value: ItemValue;
  label: string;
  custom?: boolean;
}

export interface NotifySettingsComponentOptions {
  theme: SettingsTheme;
  keybindings: SettingsKeybindings;
  host: SettingsHost;
  requestRender(): void;
  done(summary?: NotifySettingsSummary): void;
}

export interface NotifySettingsSummary {
  /** Number of successful Ctrl+S writes. */
  savedDefaults: number;
  /** Number of values changed in this conversation. */
  changed: number;
}

export class NotifySettingsComponent {
  private readonly theme: SettingsTheme;
  private readonly keybindings: SettingsKeybindings;
  private readonly host: SettingsHost;
  private readonly requestRender: () => void;
  private readonly finish: (summary?: NotifySettingsSummary) => void;

  private items: SettingItem[] = [];
  private view: View;
  /** Parent pages, most recent last; Esc pops so a page returns with its exact focus. */
  private history: View[] = [];
  private message?: { text: string; tone: Tone };
  private summary: NotifySettingsSummary = { savedDefaults: 0, changed: 0 };
  private cachedWidth?: number;
  private cachedLines?: string[];
  /** Content column of the last render; input handling clamps paging against it. */
  private contentWidth = MAX_CONTENT_WIDTH;

  constructor(options: NotifySettingsComponentOptions) {
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.host = options.host;
    this.requestRender = options.requestRender;
    this.finish = options.done;
    this.items = buildSettingItems(this.host.config());
    this.view = this.buildHomePage();
  }

  /** Rebuilds the setting list and the current page: Ctrl+R may have changed providers or values. */
  private refresh(): void {
    this.items = buildSettingItems(this.host.config());
    if (this.view.kind === "menu") this.view = this.rebuildPage(this.view);
    else if (this.itemById(this.view.itemId) === undefined) {
      // The field or provider disappeared (config edited on disk): return to a valid page rather
      // than leaving a focus on a row that no longer exists.
      this.history = [];
      this.view = this.buildHomePage();
    }
    this.invalidate();
  }

  private itemById(id: string): SettingItem | undefined {
    return this.items.find((item) => item.id === id);
  }

  /** Current value, as effective in this conversation. */
  private value(item: SettingItem): unknown {
    return item.read(this.host.config());
  }

  private hasDefault(item: SettingItem): boolean {
    return hasUserDefault(this.host.userRaw(), item);
  }

  private defaultValue(item: SettingItem): unknown {
    return userDefaultValue(this.host.userRaw(), item);
  }

  private sessionValue(item: SettingItem): unknown {
    return this.host.sessionOverride(item);
  }

  // -------------------------------------------------------------------------
  // Page construction
  // -------------------------------------------------------------------------

  private buildHomePage(): MenuPage {
    const rows: MenuRow[] = [];
    const field = (id: string): MenuRow | undefined => {
      const item = this.itemById(id);
      return item ? { key: `item:${item.id}`, kind: "field", item, label: item.label } : undefined;
    };
    for (const id of ["enabled", "minLevel"]) {
      const row = field(id);
      if (row) rows.push(row);
    }
    for (const category of SETTING_CATEGORIES) {
      rows.push({ key: `category:${category.id}`, kind: "category", category });
    }
    return { kind: "menu", id: "home", title: "通知", rows, focus: 0 };
  }

  private buildCategoryPage(category: SettingCategory): MenuPage {
    if (category.kind === "rules") {
      const rows: MenuRow[] = RULE_INFOS.map((rule) => ({ key: `rule:${rule.key}`, kind: "rule", rule }));
      return { kind: "menu", id: `category:${category.id}`, title: category.label, rows, focus: 0 };
    }
    const { items, collapsed } = categoryPageItems(category, this.items, this.host.config());
    const rows: MenuRow[] = items.map((item) => ({ key: `item:${item.id}`, kind: "field", item, label: item.label }));
    if (category.collapsed && collapsed.length > 0) {
      rows.push({ key: `subgroup:${category.id}`, kind: "subgroup", category });
    }
    for (const action of category.actions ?? []) rows.push({ key: action.key, kind: "action", action: action.action });
    return { kind: "menu", id: `category:${category.id}`, title: category.label, rows, focus: 0 };
  }

  /** Sub-page of the parameters a disabled feature collapsed; the rows are the hidden fields. */
  private buildSubgroupPage(category: SettingCategory): MenuPage {
    const ids = new Set(category.collapsed?.ids ?? []);
    const rows: MenuRow[] = this.items
      .filter((item) => ids.has(item.id))
      .map((item) => ({ key: `item:${item.id}`, kind: "field", item, label: item.label }));
    const label = category.collapsed?.label ?? category.label;
    return { kind: "menu", id: `subgroup:${category.id}`, title: label, rows, focus: 0 };
  }

  /** Read-only status page: one actionable row (reload) plus the host's status lines as text rows. */
  private buildStatusPage(): MenuPage {
    const rows: MenuRow[] = [{ key: "action:reload", kind: "action", action: "reload" }];
    this.host.statusLines().forEach((text, index) => rows.push({ key: `text:${index}`, kind: "text", text }));
    return { kind: "menu", id: "status", title: "状态与诊断", rows, focus: 0 };
  }

  private buildRulePage(rule: { key: string; label: string }): MenuPage {
    const rows: MenuRow[] = this.items
      .filter((item) => item.rule?.key === rule.key)
      // The page title already names the rule, so the row label drops the repeated prefix.
      .map((item) => ({ key: `item:${item.id}`, kind: "field" as const, item, label: item.label.replace(`${rule.label} · `, "") }));
    return { kind: "menu", id: `rule:${rule.key}`, title: rule.label, rows, focus: 0 };
  }

  /** Rebuilds a menu page from its stable id and keeps the focused row key when it still exists. */
  private rebuildPage(page: MenuPage): MenuPage {
    const focusedKey = page.rows[page.focus]?.key;
    let rebuilt: MenuPage;
    if (page.id === "home") rebuilt = this.buildHomePage();
    else if (page.id === "status") rebuilt = this.buildStatusPage();
    else if (page.id.startsWith("category:")) {
      const category = SETTING_CATEGORIES.find((candidate) => `category:${candidate.id}` === page.id);
      rebuilt = category ? this.buildCategoryPage(category) : this.buildHomePage();
    } else if (page.id.startsWith("subgroup:")) {
      const category = SETTING_CATEGORIES.find((candidate) => `subgroup:${candidate.id}` === page.id);
      rebuilt = category ? this.buildSubgroupPage(category) : this.buildHomePage();
    } else {
      const rule = RULE_INFOS.find((candidate) => `rule:${candidate.key}` === page.id);
      rebuilt = rule ? this.buildRulePage(rule) : this.buildHomePage();
    }
    const index = focusedKey === undefined ? -1 : rebuilt.rows.findIndex((row) => row.key === focusedKey);
    rebuilt.focus = index >= 0 ? index : Math.min(page.focus, Math.max(0, rebuilt.rows.length - 1));
    return rebuilt;
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  private push(view: View): void {
    this.history.push(this.view);
    this.view = view;
    this.invalidate();
    this.requestRender();
  }

  private pop(): void {
    const previous = this.history.pop();
    if (!previous) {
      this.finish(this.summary);
      return;
    }
    this.view = previous;
    this.invalidate();
    this.requestRender();
  }

  /** Field item the focus currently sits on: a field row on a menu page, or the open field. */
  private focusedFieldItem(): SettingItem | undefined {
    if (this.view.kind === "menu") {
      const row = this.view.rows[this.view.focus];
      return row?.kind === "field" ? row.item : undefined;
    }
    if (this.view.kind === "detail" || this.view.kind === "input" || this.view.kind === "help") {
      return this.itemById(this.view.itemId);
    }
    return undefined;
  }

  private openFocusedRow(): void {
    const view = this.view;
    if (view.kind !== "menu") return;
    const row = view.rows[view.focus];
    if (!row) return;
    if (row.kind === "field") {
      this.push({ kind: "detail", itemId: row.item.id, focus: this.initialDetailFocus(row.item) });
      return;
    }
    if (row.kind === "rule") {
      this.push(this.buildRulePage(row.rule));
      return;
    }
    if (row.kind === "category") {
      this.push(this.buildCategoryPage(row.category));
      return;
    }
    if (row.kind === "subgroup") {
      this.push(this.buildSubgroupPage(row.category));
      return;
    }
    if (row.action === "status") {
      this.push(this.buildStatusPage());
      return;
    }
    if (row.action === "reload") {
      const result = this.host.reload();
      this.refresh();
      this.report(result);
      return;
    }
    if (row.action === "search") {
      this.openSearch();
      return;
    }
    if (row.action === "preview") {
      const result = this.host.preview();
      this.push({ kind: "preview", lines: result.lines, offset: 0 });
      return;
    }
    this.report(this.host.test());
  }

  private openSearch(): void {
    this.push({ kind: "search", query: "", focus: 0 });
  }

  /**
   * Space: quick toggle. A boolean field flips in place; a collection or other complex field opens
   * its candidate list so a member can still be toggled there. Category, rule and action rows do
   * nothing, because Space must never trigger navigation or an external action.
   */
  private quickToggle(): void {
    const item = this.focusedFieldItem();
    if (!item) return;
    if (this.view.kind === "detail") {
      const row = this.view;
      const focused = this.candidates(item)[row.focus];
      if (!focused || focused.custom) return;
      this.selectCandidate(item, focused);
      return;
    }
    if (item.kind === "boolean") {
      this.commit(item, this.value(item) !== true, false);
      this.requestRender();
      return;
    }
    this.push({ kind: "detail", itemId: item.id, focus: this.initialDetailFocus(item) });
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    // Never wider than the caller's width; the cap only shortens wide terminals. A non-positive
    // width yields a single empty row so the row-width contract still holds.
    const content = Math.min(width, MAX_CONTENT_WIDTH);
    if (content <= 0) {
      this.cachedWidth = width;
      this.cachedLines = [""];
      return this.cachedLines;
    }
    this.contentWidth = content;
    const lines: string[] = [];
    lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold(this.titleText())), content));
    lines.push("");
    lines.push(...this.bodyLines(content));
    while (lines.length < 2 + BODY_ROWS) lines.push("");
    lines.push(...this.helpLines(content));
    lines.push(this.hintLine(content));
    for (const line of this.restrictionLines(content)) lines.push(line);
    for (const hint of this.footerHints()) lines.push(truncateToWidth(this.theme.fg("dim", hint), content));
    const message = this.message;
    const paint = message ? this.colorForTone(message.tone) : (text: string) => this.theme.fg("dim", text);
    const fieldFocused = this.focusedFieldItem() !== undefined && (this.view.kind === "menu" || this.view.kind === "detail");
    const messageText = message
      ? message.text
      : fieldFocused
        ? "Enter 修改本次对话；Ctrl+S 设为以后默认"
        : "";
    // Bounded and wrapped, so the item name, scope and failure text stay readable without a long
    // message pushing the list off screen.
    for (const line of this.boundedWrap(messageText, content, 3)) lines.push(truncateToWidth(paint(line), content));
    this.cachedWidth = width;
    this.cachedLines = lines;
    return this.cachedLines;
  }

  /**
   * Wraps `text` and keeps at most `maxLines` rows. A very long channel id or a long collection
   * value therefore cannot turn the help into dozens of rows and squeeze out the interaction area;
   * the clipped tail ends in an ellipsis.
   */
  private boundedWrap(text: string, width: number, maxLines: number): string[] {
    const limit = Math.max(1, maxLines * width - 2);
    const clipped = truncateToWidth(text, limit, "…");
    return wrapTextWithAnsi(clipped, width).slice(0, maxLines);
  }

  private colorForTone(tone: Tone): (text: string) => string {
    if (tone === "success") return (text) => this.theme.fg("success", text);
    if (tone === "error") return (text) => this.theme.fg("error", text);
    return (text) => this.theme.fg("muted", text);
  }

  /**
   * Footer keys available for the current focus: a category/rule/text row cannot be saved or
   * toggled, so its footer does not advertise those keys.
   */
  private footerHints(): string[] {
    const view = this.view;
    if (view.kind === "input") return ["Enter 应用   Esc 取消"];
    if (view.kind === "search") return ["输入以筛选   ↑↓ 选择   Enter 打开   Esc 返回"];
    if (view.kind === "confirm") return ["↑↓ 选择   Enter 确认   Esc 取消（默认取消）"];
    if (view.kind === "preview") return ["↑↓ 滚动   Esc 返回"];
    if (view.kind === "help") return ["a 沿用以后默认   d 恢复内置默认   ↑↓ 滚动   Esc 返回", FOOTER_KEY_HINTS];
    if (view.kind === "menu" && view.id === "status") return ["↑↓ 滚动   Enter 重读配置   Esc 返回", STATUS_KEY_HINTS];
    if (view.kind === "menu" && view.rows[view.focus]?.kind !== "field") {
      return ["↑↓ 移动   Enter 打开   Esc 返回", FOOTER_KEY_HINTS];
    }
    return ["↑↓ 移动   Enter 修改   Space 快速切换   Esc 返回", "Ctrl+S 设为以后默认"];
  }

  /**
   * Always-visible extra restrictions (forced silence). They override the switches below, so they
   * are labelled as limits instead of being folded into the value or reported as a user default.
   */
  private restrictionLines(width: number): string[] {
    const restrictions = this.host.restrictions();
    if (restrictions.length === 0) return [];
    const text = `额外限制：${restrictions.map((item) => `${item.label}（${item.reason}）`).join("、")} — 会话级限制，覆盖开关，不代表你的默认被关闭`;
    return this.boundedWrap(text, width, 2).map((line) => truncateToWidth(this.theme.fg("warning", line), width));
  }

  private titleText(): string {
    const view = this.view;
    if (view.kind === "menu") return view.title;
    if (view.kind === "search") return "搜索设置";
    if (view.kind === "preview") return "通知预览";
    const item = this.itemById(view.itemId);
    if (!item) return "通知";
    if (view.kind === "input") return "自定义输入";
    if (view.kind === "help") return `字段说明 · ${item.label}`;
    if (view.kind === "confirm") return `恢复默认 · ${item.label}`;
    return item.label;
  }

  /**
   * Short summary under the body: the full name, the current value and where it comes from. The
   * complete three layers live in the pageable `?` field-details view, so a narrow terminal never
   * loses them.
   */
  private helpLines(width: number): string[] {
    const view = this.view;
    if (view.kind === "help" || view.kind === "input" || view.kind === "search" || view.kind === "confirm" || view.kind === "preview") return [];
    const lines: string[] = [];
    if (view.kind === "menu" && view.id.startsWith("rule:")) {
      const ruleKey = view.id.slice("rule:".length);
      const rule = (this.host.config().rules as Record<string, { enabled?: boolean }>)[ruleKey];
      // A disabled rule keeps its fields editable; the note explains when they take effect instead
      // of hiding them or implying they do something right now.
      if (rule && rule.enabled !== true) lines.push("该规则已关闭：下面的开关与参数仍可配置，启用后生效");
    }
    const item = this.focusedFieldItem();
    if (item) {
      const current = item.format(this.value(item));
      const source = this.sessionValue(item) === undefined ? "跟随用户默认/内置默认" : "本对话已覆盖";
      lines.push(`字段 ${item.group} · ${item.label} · 当前 ${current} · ${source} · ? 查看完整来源`);
    }
    if (lines.length === 0) return [];
    return this.dim(this.boundedWrap(lines.join("  "), width, 3), width);
  }

  private dim(lines: string[], width: number): string[] {
    return lines.map((line) => truncateToWidth(this.theme.fg("dim", line), width));
  }

  /**
   * Logical rows of the read-only field details. Every layer is spelled out; the rows are wrapped
   * at render time without truncation (a long channel id breaks across rows but is never cut), and
   * paging shows them a page at a time.
   */
  private helpTextLines(item: SettingItem): string[] {
    const current = item.format(this.value(item));
    const override = this.sessionValue(item);
    const lines = [
      `字段：${item.group} · ${item.label}`,
      `当前值：${current}`,
      override === undefined
        ? "本对话：未覆盖（跟随用户默认或内置默认）"
        : `本对话：已覆盖（${item.format(override)}），仅本会话生效`,
      this.hasDefault(item)
        ? `用户默认：${item.format(this.defaultValue(item))}（已写入用户文件，Enter 改本对话、Ctrl+S 更新用户默认）`
        : "用户默认：未设置（跟随内置默认；Ctrl+S 把当前值写为以后默认）",
      item.providerId !== undefined
        // Distinguish “the switch's built-in default” from “the channel definition is user-provided”:
        // a missing `enabled` is treated as true, so deleting the field returns the channel to on.
        ? "内置默认：开启（渠道开关未显式写入 enabled 时的内置缺省）"
        : `内置默认：${item.format(builtinDefaultValue(item))}`,
    ];
    if (item.id === "enabled") {
      // Forced silence is a session-level limit over the switch, not a user default of "off"; the
      // detail view says so instead of letting the two read as one setting.
      for (const restriction of this.host.restrictions()) {
        lines.push(`额外限制：${restriction.label}（${restriction.reason}）—— 会话级限制，覆盖上面的开关，不等于你把通知默认关掉了`);
      }
    }
    if (item.providerId !== undefined) {
      const fromUser = providerDefinitionSource(item, this.host.userRaw()) === "user";
      lines.push(`渠道定义：${fromUser ? "由用户配置（用户文件中定义，可能与同名内置渠道不同）" : "出厂默认"}`);
      const detail = item.detail?.(this.host.config());
      if (detail !== undefined) lines.push(`渠道类型：${detail}`);
      lines.push("说明：渠道凭据（URL、headers、密钥引用）只存在于配置文件，界面不显示也不写入");
    }
    if (item.inputHint) lines.push(`输入：${item.inputHint}`);
    // “Not effective right now” is spelled out instead of hiding the field: search and the restored
    // pages must be able to reach a parameter a disabled feature currently ignores.
    const inactive = this.inactiveReason(item);
    if (inactive !== undefined) lines.push(`尚未生效：${inactive}`);
    // Independent action area of the field detail page.
    const overridden = this.sessionValue(item) !== undefined;
    lines.push(`操作：a 沿用以后默认（只清除本对话覆盖${overridden ? "" : "；当前未覆盖"}）`);
    lines.push("操作：d 恢复此项内置默认（确认后同时清除用户默认与本对话覆盖）");
    return lines;
  }

  /** Why an item is currently ignored, or undefined when it is live. */
  private inactiveReason(item: SettingItem): string | undefined {
    const config = this.host.config();
    if (item.visible && !item.visible(config)) {
      return item.id === "coalesce.toolFailureWindowMs"
        ? "当前工具失败策略为“并入结果”，此参数只在“立即提醒”下生效"
        : "当前配置下此参数不生效";
    }
    if (item.rule) {
      const rule = (config.rules as Record<string, { enabled?: boolean }>)[item.rule.key];
      if (rule && rule.enabled !== true) return `所属规则“${item.rule.label}”已关闭，启用后生效`;
    }
    if (item.id.startsWith("quietHours.") && item.id !== "quietHours.enabled" && !config.quietHours.enabled) {
      return "免打扰未开启，启用后生效";
    }
    return undefined;
  }

  /** Full-detail rows wrapped to `width`; nothing is truncated here. */
  private helpRows(item: SettingItem, width: number): string[] {
    const rows: string[] = [];
    const wrapWidth = Math.max(1, width);
    for (const logical of this.helpTextLines(item)) {
      for (const line of wrapTextWithAnsi(logical, wrapWidth)) rows.push(line);
    }
    return rows;
  }

  private hintLine(width: number): string {
    const hints: string[] = [];
    // Actionable hints go first so they survive truncation on a narrow terminal; the position
    // counter is informational and is pushed last.
    if (this.focusedFieldItem() && (this.view.kind === "menu" || this.view.kind === "detail")) hints.push("? 字段详情");
    if (this.view.kind === "menu" && this.view.rows[this.view.focus]?.kind === "field") hints.push("Space 快速切换");
    if (this.view.kind === "detail") {
      const item = this.itemById(this.view.itemId);
      if (item?.kind === "collection") hints.push("集合字段：Enter/Space 切换成员（可多选）");
    }
    if (this.view.kind === "help") hints.push("a 沿用以后默认 · d 恢复内置默认 · ↑↓ 滚动");
    if (this.view.kind === "search") hints.push("输入以筛选 · Enter 打开结果 · Esc 返回");
    if (this.view.kind === "confirm") hints.push("默认取消：Enter 取消，↓ 再选确认恢复");
    if (this.view.kind === "preview") hints.push("示例，不会发送 · ↑↓ 滚动 · Esc 返回");
    const position = this.positionInfo();
    if (position) hints.push(position);
    return truncateToWidth(this.theme.fg("dim", hints.join("   ")), width);
  }

  /** Position hint, present only when the list overflows; it never takes row width. */
  private positionInfo(): string | undefined {
    const total = this.totalRows();
    if (total <= BODY_ROWS) return undefined;
    const visible = Math.min(BODY_ROWS, total);
    const start = Math.min(Math.max(0, this.scrollOf()), Math.max(0, total - BODY_ROWS));
    return `${start + 1}–${start + visible}/${total}`;
  }

  private totalRows(): number {
    if (this.view.kind === "menu") return this.view.rows.length;
    if (this.view.kind === "detail") {
      const item = this.itemById(this.view.itemId);
      return item ? this.candidates(item).length : 0;
    }
    if (this.view.kind === "help") {
      const item = this.itemById(this.view.itemId);
      return item ? this.helpRows(item, this.contentWidth).length : 0;
    }
    if (this.view.kind === "search") return this.searchResults().length;
    if (this.view.kind === "confirm") return 2;
    if (this.view.kind === "preview") return this.view.lines.length;
    return 0;
  }

  private scrollOf(): number {
    if (this.view.kind === "menu") return this.centeredScroll(this.view.focus, this.totalRows());
    if (this.view.kind === "detail") return this.centeredScroll(this.view.focus, this.totalRows());
    if (this.view.kind === "search") return this.centeredScroll(this.view.focus, this.totalRows());
    if (this.view.kind === "help") return this.view.offset;
    if (this.view.kind === "preview") return this.view.offset;
    return 0;
  }

  private bodyLines(width: number): string[] {
    if (this.view.kind === "menu") return this.menuLines(width);
    if (this.view.kind === "detail") return this.detailLines(width);
    if (this.view.kind === "input") return this.inputLines(width);
    if (this.view.kind === "help") return this.helpViewLines(width);
    if (this.view.kind === "search") return this.searchLines(width);
    if (this.view.kind === "confirm") return this.confirmLines(width);
    if (this.view.kind === "preview") return this.previewLines(width);
    return [];
  }

  /** Complete-table search: id, group, label, provider id, rule label and the input hint. */
  private searchResults(): SettingItem[] {
    const view = this.view;
    if (view.kind !== "search") return [];
    const query = view.query.trim().toLowerCase();
    if (query === "") return this.items;
    return this.items.filter((item) => [item.id, item.group, item.label, item.providerId ?? "", item.rule?.label ?? "", item.inputHint ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(query));
  }

  private searchLines(width: number): string[] {
    const view = this.view;
    if (view.kind !== "search") return [];
    const results = this.searchResults();
    const lines: string[] = [
      truncateToWidth(this.theme.fg("accent", `搜索：${view.query}`) + CURSOR_MARKER, width),
      truncateToWidth(this.theme.fg("dim", results.length === 0 ? "没有匹配的设置" : `${results.length} 项匹配（含当前不生效的字段）`), width),
    ];
    const rows = results.map((item, index) => {
      const path = item.rule ? `通知规则 › ${item.rule.label}` : item.group;
      const inactive = this.inactiveReason(item);
      const mark = inactive === undefined ? "" : " · 未生效";
      const head = `${FOCUS_CELL(index === view.focus)}${item.label}${mark}`;
      const tail = `  ${path}`;
      const room = width - visibleWidth(tail);
      const text = visibleWidth(head) > room ? truncateToWidth(head, Math.max(3, room), "…") : head;
      return truncateToWidth(`${text}${tail}`, width);
    });
    return [...lines, ...this.window(rows, this.centeredScroll(view.focus, rows.length))];
  }

  /** Confirmation page: field, current value, resulting value, then cancel (default) and confirm. */
  private confirmLines(width: number): string[] {
    const view = this.view;
    if (view.kind !== "confirm") return [];
    const item = this.itemById(view.itemId);
    if (!item) return [];
    const lines = [
      `字段：${item.group} · ${item.label}`,
      `当前值：${item.format(this.value(item))}`,
      item.providerId !== undefined
        ? "恢复后：内置默认（开启），并清除用户文件里这一项的 enabled 与本对话覆盖"
        : `恢复后：${item.format(builtinDefaultValue(item))}，并清除用户默认与本对话覆盖`,
      "影响范围：仅此字段；用户文件的其他字段与渠道定义不动",
      "",
      `${FOCUS_CELL(view.focus === 0)}取消`,
      `${FOCUS_CELL(view.focus === 1)}确认恢复`,
    ];
    return lines.slice(0, BODY_ROWS).map((line) => truncateToWidth(line, width));
  }

  private previewLines(width: number): string[] {
    const view = this.view;
    if (view.kind !== "preview") return [];
    const rows = view.lines.map((line) => truncateToWidth(line, width));
    return this.window(rows, view.offset);
  }

  /** Read-only details page: the wrapped rows, windowed by the stored offset. */
  private helpViewLines(width: number): string[] {
    const view = this.view;
    if (view.kind !== "help") return [];
    const item = this.itemById(view.itemId);
    if (!item) return [];
    const rows = this.helpRows(item, width).map((line) => truncateToWidth(line, width));
    return this.window(rows, view.offset);
  }

  private menuLines(width: number): string[] {
    const view = this.view;
    if (view.kind !== "menu") return [];
    const rows = view.rows.map((row, index) => this.menuRow(row, index === view.focus, width));
    return this.window(rows, this.centeredScroll(view.focus, rows.length));
  }

  private detailLines(width: number): string[] {
    const view = this.view;
    if (view.kind !== "detail") return [];
    const item = this.itemById(view.itemId);
    if (!item) return [];
    const rows = this.candidates(item).map((candidate, index) => this.candidateRow(item, candidate, index, view.focus, width));
    return this.window(rows, this.centeredScroll(view.focus, rows.length));
  }

  /** Scroll offset that keeps the focused row visible, roughly centered below the first rows. */
  private centeredScroll(focus: number, total: number): number {
    if (total <= BODY_ROWS) return 0;
    const half = Math.floor(BODY_ROWS / 2);
    return Math.min(Math.max(0, focus - half), total - BODY_ROWS);
  }

  private inputLines(width: number): string[] {
    const view = this.view;
    if (view.kind !== "input") return [];
    const item = this.itemById(view.itemId);
    if (!item) return [];
    const lines: string[] = [];
    // Field name and the unit/range are rendered as their own wrapped rows, never as a single
    // truncatable title, so the constraint stays reachable at any width.
    const heading = [`字段：${item.group} · ${item.label}`, `范围：${item.inputHint ?? "自由输入"}`];
    for (const logical of heading) {
      for (const line of wrapTextWithAnsi(logical, Math.max(1, width))) {
        lines.push(truncateToWidth(this.theme.fg("muted", line), width));
      }
    }
    const prefix = this.theme.fg("accent", "› ");
    lines.push(`${prefix}${truncateToWidth(view.buffer, Math.max(1, width - 2))}${CURSOR_MARKER}`);
    if (view.error) {
      for (const line of wrapTextWithAnsi(view.error, width)) lines.push(truncateToWidth(this.theme.fg("error", line), width));
    }
    return lines.slice(0, BODY_ROWS);
  }

  /** Slice around the focused row; the position hint lives in the hint line, not on these rows. */
  private window(rows: string[], scroll: number): string[] {
    if (rows.length <= BODY_ROWS) return rows;
    const start = Math.min(Math.max(0, scroll), Math.max(0, rows.length - BODY_ROWS));
    return rows.slice(start, start + BODY_ROWS);
  }

  /** Marker of a row that opens another page, appended after the label. */
  private openMark(row: MenuRow): string {
    if (row.kind === "category" || row.kind === "rule" || row.kind === "subgroup") return OPEN_MARK;
    if (row.kind === "action" && row.action === "status") return OPEN_MARK;
    return "";
  }

  /**
   * Menu row: `→ label   summary ›`.
   *
   * The label wins the width: the summary yields first and is truncated with an ellipsis, so at a
   * narrow terminal a category or rule is still identifiable instead of every row starting with
   * `…`. The value/summary sits directly after the label rather than at the terminal edge.
   */
  private menuRow(row: MenuRow, focused: boolean, width: number): string {
    const focus = FOCUS_CELL(focused);
    const mark = this.openMark(row);
    if (row.kind === "action") {
      return truncateToWidth(`${focus}${ACTION_LABELS[row.action]}${mark}`, width);
    }
    if (row.kind === "text") {
      return truncateToWidth(`${focus}${row.text}`, width);
    }
    const summary = row.kind === "field"
      ? row.item.format(this.value(row.item))
      : row.kind === "rule"
        ? ruleSummary(this.host.config(), this.items, row.rule.key)
        : row.kind === "subgroup"
          ? row.category.collapsed?.note ?? ""
          : row.category.summary(this.host.config());
    const label = row.kind === "field"
      ? row.label
      : row.kind === "rule"
        ? row.rule.label
        : row.kind === "subgroup"
          ? row.category.collapsed?.label ?? row.category.label
          : row.category.label;
    const gap = "  ";
    if (row.kind === "field") {
      // A field's current value is its headline: the value keeps its room and the label yields.
      const head = `${focus}${label}`;
      const suffix = `${gap}${summary}`;
      const available = width - visibleWidth(suffix) - visibleWidth(mark);
      const text = visibleWidth(head) > available ? truncateToWidth(head, Math.max(3, available), "…") : head;
      return truncateToWidth(`${text}${suffix}${mark}`, width);
    }
    // Category/rule/subgroup rows: the label is the identity and wins; the summary is auxiliary and
    // is the part that gets truncated.
    const head = `${focus}${label}`;
    const labelText = visibleWidth(head) > width - visibleWidth(mark)
      ? truncateToWidth(head, Math.max(3, width - visibleWidth(mark)), "…")
      : head;
    const remaining = width - visibleWidth(labelText) - visibleWidth(mark);
    let tail = summary === "" ? "" : `${gap}${summary}`;
    if (visibleWidth(tail) > remaining) {
      const room = remaining - visibleWidth(gap);
      tail = room <= 1 ? "" : `${gap}${truncateToWidth(summary, room, "…")}`;
    }
    return truncateToWidth(`${labelText}${tail}${mark}`, width);
  }

  /**
   * Candidate row: focus and current-value cells (two columns each, always reserved), then the
   * value with optional detail, then a trailing ` · 默认`. Markers and suffix are given width
   * first; the label takes what is left and is truncated with an ellipsis.
   */
  private candidateRow(item: SettingItem, candidate: Candidate, index: number, focusIndex: number, width: number): string {
    const config = this.host.config();
    const current = this.value(item);
    const isCurrent = !candidate.custom && isCurrentValue(item.kind, current, candidate.value as SettingValue);
    const isDefault = !candidate.custom && this.isDefaultCandidate(item, candidate, current);
    const detail = item.detail?.(config);
    const suffix = isDefault && width >= DEFAULT_SUFFIX_MIN_WIDTH ? " · 默认" : "";
    const reserved = visibleWidth(suffix);
    let label = candidate.label;
    if (detail !== undefined && width >= DETAIL_MIN_WIDTH && !candidate.custom) label = `${label} [${detail}]`;
    const room = Math.max(2, width - 4 - reserved - 1);
    if (visibleWidth(label) > room) label = truncateToWidth(label, room, "…");
    const head = `${FOCUS_CELL(index === focusIndex)}${CURRENT_CELL(isCurrent)}${label}`;
    const pad = Math.max(1, width - reserved - visibleWidth(head));
    return truncateToWidth(`${head}${" ".repeat(pad)}${suffix}`, width);
  }

  /** True when this candidate is the saved user default; collections match by membership. */
  private isDefaultCandidate(item: SettingItem, candidate: Candidate, current: unknown): boolean {
    if (!this.hasDefault(item)) return false;
    const fallback = this.defaultValue(item);
    if (item.kind === "collection") {
      return Array.isArray(fallback) && fallback.includes(candidate.value as SettingValue);
    }
    if (fallback === candidate.value) return true;
    // Numbers and times: the saved default may be outside the preset list, so align by the
    // formatted text; rows added for exactly that case land here.
    return current !== undefined && item.format(fallback) === candidate.label && isCurrentValue(item.kind, current, candidate.value as SettingValue);
  }

  private candidates(item: SettingItem): Candidate[] {
    const config = this.host.config();
    const rows: Candidate[] = item.candidates(config).map((candidate) => ({ value: candidate.value, label: candidate.label }));
    if (item.kind !== "collection") {
      // The current value or the saved default may be outside the preset list: add a row so the
      // marker column always has somewhere to land.
      const known = new Set(rows.map((row) => String(row.value)));
      for (const extra of [this.value(item), this.defaultValue(item)]) {
        if (extra === undefined || known.has(String(extra))) continue;
        known.add(String(extra));
        rows.push({ value: extra as SettingValue, label: item.format(extra) });
      }
    }
    if (item.parseInput) rows.push({ value: "", label: CUSTOM_ROW_LABEL, custom: true });
    return rows;
  }

  /** On entering the detail view, focus the row holding the current value: that is what users
   * most often want to change. */
  private initialDetailFocus(item: SettingItem): number {
    const current = this.value(item);
    const index = this.candidates(item)
      .findIndex((row) => !row.custom && isCurrentValue(item.kind, current, row.value as SettingValue));
    return index >= 0 ? index : 0;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  handleInput(data: string): void {
    if (this.view.kind === "input") {
      this.handleInputView(data);
      return;
    }
    if (this.view.kind === "search") {
      // A text field: Ctrl+S/T/R/O are not handled here, so typing a query can never save or send.
      this.handleSearchInput(data);
      return;
    }
    if (this.view.kind === "confirm") {
      this.handleConfirmInput(data);
      return;
    }
    if (this.view.kind === "preview") {
      this.handlePreviewInput(data);
      return;
    }
    if (this.view.kind === "help") {
      // Read-only paging plus the two restore actions; nothing here writes unless a/d is pressed.
      this.handleHelpInput(data);
      return;
    }
    if (data === "/") {
      // `/` is a local shortcut inside the component (no global shortcut is registered).
      this.openSearch();
      return;
    }
    if (matchesKey(data, Key.ctrl("s"))) {
      this.saveFocusedDefault();
      return;
    }
    if (matchesKey(data, Key.ctrl("t"))) {
      this.report(this.host.test());
      return;
    }
    if (matchesKey(data, Key.ctrl("r"))) {
      // Re-reading changes the effective config, so the page is rebuilt while the current view
      // and focus are preserved.
      const result = this.host.reload();
      this.refresh();
      this.report(result);
      return;
    }
    if (matchesKey(data, Key.ctrl("o"))) {
      this.push(this.buildStatusPage());
      return;
    }
    if (data === "?") {
      // Explicit entry to the pageable field details; this view is kept on the history stack so
      // Esc restores it.
      const item = this.focusedFieldItem();
      if (item) {
        this.push({ kind: "help", itemId: item.id, offset: 0 });
        return;
      }
    }
    if (data === " ") {
      this.quickToggle();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.pop();
      return;
    }
    if (this.view.kind === "menu") this.handleMenuInput(data);
    else this.handleDetailInput(data);
  }

  /** Search is a text input: characters filter, Enter opens the focused result, Esc returns. */
  private handleSearchInput(data: string): void {
    const view = this.view;
    if (view.kind !== "search") return;
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.pop();
      return;
    }
    const results = this.searchResults();
    if (this.keybindings.matches(data, "tui.select.up")) this.moveSearch(view.focus - 1, results.length);
    else if (this.keybindings.matches(data, "tui.select.down")) this.moveSearch(view.focus + 1, results.length);
    else if (this.keybindings.matches(data, "tui.select.pageUp")) this.moveSearch(view.focus - BODY_ROWS, results.length);
    else if (this.keybindings.matches(data, "tui.select.pageDown")) this.moveSearch(view.focus + BODY_ROWS, results.length);
    else if (this.keybindings.matches(data, "tui.select.confirm")) {
      const item = results[view.focus];
      if (item) this.push({ kind: "detail", itemId: item.id, focus: this.initialDetailFocus(item) });
    } else if (matchesKey(data, Key.backspace) || data === "\x7f" || data === "\b") {
      this.setSearchQuery([...view.query].slice(0, -1).join(""));
    } else {
      const printable = decodeKittyPrintable(data) ?? data;
      const clean = [...printable].filter((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 0x7f;
      }).join("");
      if (clean !== "") this.setSearchQuery(view.query + clean);
    }
  }

  private setSearchQuery(query: string): void {
    if (this.view.kind !== "search") return;
    this.view = { ...this.view, query, focus: 0 };
    this.invalidate();
    this.requestRender();
  }

  private moveSearch(next: number, total: number): void {
    if (this.view.kind !== "search") return;
    this.view = { ...this.view, focus: Math.min(Math.max(0, next), Math.max(0, total - 1)) };
    this.invalidate();
    this.requestRender();
  }

  /** Confirmation page: default focus is cancel, so Enter never destroys anything by accident. */
  private handleConfirmInput(data: string): void {
    const view = this.view;
    if (view.kind !== "confirm") return;
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.pop();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) this.setConfirmFocus(0);
    else if (this.keybindings.matches(data, "tui.select.down")) this.setConfirmFocus(1);
    else if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (view.focus === 0) {
        this.pop();
        return;
      }
      const item = this.itemById(view.itemId);
      this.pop();
      if (item) {
        this.report(this.host.restoreBuiltinDefault(item));
        this.requestRender();
      }
    }
  }

  private setConfirmFocus(focus: number): void {
    if (this.view.kind !== "confirm") return;
    this.view = { ...this.view, focus: focus === 0 ? 0 : 1 };
    this.invalidate();
    this.requestRender();
  }

  private handlePreviewInput(data: string): void {
    const view = this.view;
    if (view.kind !== "preview") return;
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.pop();
      return;
    }
    const maxOffset = Math.max(0, view.lines.length - BODY_ROWS);
    let next: number | undefined;
    if (this.keybindings.matches(data, "tui.select.up")) next = view.offset - 1;
    else if (this.keybindings.matches(data, "tui.select.down")) next = view.offset + 1;
    else if (this.keybindings.matches(data, "tui.select.pageUp")) next = view.offset - BODY_ROWS;
    else if (this.keybindings.matches(data, "tui.select.pageDown")) next = view.offset + BODY_ROWS;
    if (next === undefined) return;
    this.view = { ...view, offset: Math.min(Math.max(0, next), maxOffset) };
    this.invalidate();
    this.requestRender();
  }

  private report(result: { ok: boolean; message: string }): void {
    this.message = { text: result.message, tone: result.ok ? "success" : "error" };
    this.invalidate();
    this.requestRender();
  }

  private handleMenuInput(data: string): void {
    const view = this.view;
    if (view.kind !== "menu" || view.rows.length === 0) return;
    if (this.keybindings.matches(data, "tui.select.up")) this.moveMenu(view.focus - 1);
    else if (this.keybindings.matches(data, "tui.select.down")) this.moveMenu(view.focus + 1);
    else if (this.keybindings.matches(data, "tui.select.pageUp")) this.moveMenu(view.focus - BODY_ROWS);
    else if (this.keybindings.matches(data, "tui.select.pageDown")) this.moveMenu(view.focus + BODY_ROWS);
    else if (this.keybindings.matches(data, "tui.select.confirm")) this.openFocusedRow();
  }

  private moveMenu(next: number): void {
    const view = this.view;
    if (view.kind !== "menu") return;
    this.view = { ...view, focus: Math.min(Math.max(0, next), Math.max(0, view.rows.length - 1)) };
    this.invalidate();
    this.requestRender();
  }

  private handleDetailInput(data: string): void {
    const view = this.view;
    if (view.kind !== "detail") return;
    const item = this.itemById(view.itemId);
    if (!item) return;
    const rows = this.candidates(item);
    if (rows.length === 0) return;
    if (this.keybindings.matches(data, "tui.select.up")) this.moveDetail(item, view.focus - 1, rows.length);
    else if (this.keybindings.matches(data, "tui.select.down")) this.moveDetail(item, view.focus + 1, rows.length);
    else if (this.keybindings.matches(data, "tui.select.pageUp")) this.moveDetail(item, view.focus - BODY_ROWS, rows.length);
    else if (this.keybindings.matches(data, "tui.select.pageDown")) this.moveDetail(item, view.focus + BODY_ROWS, rows.length);
    else if (this.keybindings.matches(data, "tui.select.confirm")) {
      const candidate = rows[view.focus];
      if (!candidate) return;
      if (candidate.custom) {
        this.push({ kind: "input", itemId: item.id, buffer: String(this.value(item) ?? "") });
        return;
      }
      this.selectCandidate(item, candidate);
    }
  }

  private selectCandidate(item: SettingItem, candidate: Candidate): void {
    const current = this.value(item);
    const value = item.kind === "collection"
      ? collectionValue(current, candidate.value as SettingValue)
      : candidate.value;
    this.commit(item, value, false);
    this.requestRender();
  }

  private moveDetail(item: SettingItem, next: number, total: number): void {
    const view = this.view;
    if (view.kind !== "detail") return;
    this.view = { ...view, itemId: item.id, focus: Math.min(Math.max(0, next), total - 1) };
    this.invalidate();
    this.requestRender();
  }

  /** Read-only details page: paging only; Esc returns to the page it was opened from. */
  private handleHelpInput(data: string): void {
    const view = this.view;
    if (view.kind !== "help") return;
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.pop();
      return;
    }
    const item = this.itemById(view.itemId);
    if (data === "a") {
      // “follow the user default again”: clears only this conversation's override.
      if (!item) return;
      this.report(this.host.followUserDefault(item));
      this.requestRender();
      return;
    }
    if (data === "d") {
      // Destructive, so it goes through the confirmation page (default focus: cancel).
      if (!item) return;
      this.push({ kind: "confirm", itemId: item.id, focus: 0 });
      return;
    }
    const maxOffset = Math.max(0, this.totalRows() - BODY_ROWS);
    let next: number | undefined;
    if (this.keybindings.matches(data, "tui.select.up")) next = view.offset - 1;
    else if (this.keybindings.matches(data, "tui.select.down")) next = view.offset + 1;
    else if (this.keybindings.matches(data, "tui.select.pageUp")) next = view.offset - BODY_ROWS;
    else if (this.keybindings.matches(data, "tui.select.pageDown")) next = view.offset + BODY_ROWS;
    if (next === undefined) return;
    this.view = { ...view, offset: Math.min(Math.max(0, next), maxOffset) };
    this.invalidate();
    this.requestRender();
  }

  private handleInputView(data: string): void {
    const view = this.view;
    if (view.kind !== "input") return;
    const item = this.itemById(view.itemId);
    if (!item?.parseInput) {
      this.pop();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.pop();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm") || data === "\n") {
      const parsed = item.parseInput(view.buffer);
      if (!parsed.ok) {
        this.view = { ...view, error: parsed.message };
        this.invalidate();
        this.requestRender();
        return;
      }
      this.pop();
      this.commit(item, parsed.value, false);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.backspace) || data === "\x7f" || data === "\b") {
      this.view = { ...view, buffer: [...view.buffer].slice(0, -1).join(""), error: undefined };
      this.invalidate();
      this.requestRender();
      return;
    }
    const printable = decodeKittyPrintable(data) ?? data;
    const clean = [...printable].filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 0x7f;
    }).join("");
    if (clean !== "") {
      this.view = { ...view, buffer: view.buffer + clean, error: undefined };
      this.invalidate();
      this.requestRender();
    }
  }

  /** Enter: submits the value; collection kinds are turned into an array by the callers. */
  private commit(item: SettingItem, value: ItemValue, viaSave: boolean): void {
    const result = viaSave ? this.host.saveDefault(item, value) : this.host.setValue(item, value);
    if (result.ok) {
      if (viaSave) this.summary.savedDefaults += 1;
      else this.summary.changed += 1;
    }
    this.message = { text: result.message, tone: result.ok ? "success" : "error" };
    this.refresh();
  }

  /**
   * Ctrl+S: freezes the focused field's **already effective** value as the user default. It never
   * saves a candidate the cursor merely hovers over, and it does nothing on a category, rule or
   * action row (those rows are navigation, not settings).
   */
  private saveFocusedDefault(): void {
    const item = this.focusedFieldItem();
    if (!item) return;
    this.commit(item, this.value(item) as ItemValue, true);
    this.requestRender();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  /** Current view, focus, row keys and message; used by tests and for debugging. */
  debugState(): {
    view: View;
    focus: number;
    rows: string[];
    items: string[];
    message?: { text: string; tone: Tone };
  } {
    const focus = this.view.kind === "menu" || this.view.kind === "detail" || this.view.kind === "search" || this.view.kind === "confirm"
      ? this.view.focus
      : this.view.kind === "help" || this.view.kind === "preview"
        ? this.view.offset
        : 0;
    return {
      view: this.view,
      focus,
      rows: this.view.kind === "menu"
        ? this.view.rows.map((row) => row.key)
        : this.view.kind === "search"
          ? this.searchResults().map((item) => `item:${item.id}`)
          : [],
      items: this.items.map((item) => item.id),
      ...(this.message ? { message: this.message } : {}),
    };
  }
}

/** Factory handed to `ctx.ui.custom()` by the command layer. */
export function createNotifySettingsComponent(
  options: NotifySettingsComponentOptions,
): NotifySettingsComponent {
  return new NotifySettingsComponent(options);
}
