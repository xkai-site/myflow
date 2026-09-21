/**
 * Settings UI.
 *
 * Two levels:
 *  - the setting list: one row per setting, showing the current value and the saved user
 *    default inline so the state is readable without opening a detail view;
 *  - the candidate list: one row per candidate value with fixed marker columns (two columns
 *    for focus, two for the current value); the trailing ` · default` is a separate channel
 *    and can coexist with the markers.
 *
 * This module only renders and handles keys; persistence, activation and the silence checks
 * live in the command layer, so the component can be driven without a host.
 *
 * Three deliberate choices:
 *  1. Marker cells carry no colour, so a marker appearing or disappearing never shifts text
 *     horizontally.
 *  2. The trailing ` · default` and the marker columns are given width before the value text;
 *     overflow truncates the value and never swallows a marker.
 *  3. Ctrl+S is consumed only while the component holds input; no global shortcut is
 *     registered, so it cannot collide with the host's own save binding.
 */

import { CURSOR_MARKER, decodeKittyPrintable, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
  CUSTOM_ROW_LABEL,
  buildSettingItems,
  collectionValue,
  hasUserDefault,
  isCurrentValue,
  userDefaultValue,
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

export interface SettingsHost {
  /** Effective config, including this conversation's overlay. */
  config(): NotificationConfig;
  /** Raw user file, used for the presence and value of sparse user defaults. */
  userRaw(): unknown;
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

interface FooterHint {
  text: string;
}

/** Visible list rows; the component sizes itself instead of reading the terminal height. */
const BODY_ROWS = 12;
/** Focus and current-value cells are two display columns each and stay reserved when unset. */
const FOCUS_CELL = (focused: boolean): string => (focused ? "→ " : "  ");
const CURRENT_CELL = (current: boolean): string => (current ? "✓ " : "  ");
/** Parent list: width thresholds for column visibility (>=30 shows both, 16-29 only the
 * current value, <16 only the label). */
const DETAIL_MIN_WIDTH = 28;
/** Below this width the trailing ` · default` is dropped to keep the markers and the value. */
const DEFAULT_SUFFIX_MIN_WIDTH = 18;

const FOOTER_HINTS: FooterHint[] = [
  { text: "↑↓ move   Enter select   Esc back   Ctrl+S  save as default" },
  { text: "Ctrl+T test   Ctrl+R reload   Ctrl+O status" },
];

type View =
  | { kind: "list" }
  | { kind: "detail"; itemId: string; focus: number }
  | { kind: "input"; itemId: string; buffer: string; error?: string }
  | { kind: "status" };

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
  private listFocus = 0;
  private listScroll = 0;
  private statusOffset = 0;
  private view: View = { kind: "list" };
  private message?: { text: string; tone: Tone };
  private summary: NotifySettingsSummary = { savedDefaults: 0, changed: 0 };
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(options: NotifySettingsComponentOptions) {
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.host = options.host;
    this.requestRender = options.requestRender;
    this.finish = options.done;
    this.refresh();
  }

  /** Rebuilds the setting list: Ctrl+R may have re-read the config and changed providers. */
  private refresh(): void {
    const focusedId = this.items[this.listFocus]?.id;
    this.items = buildSettingItems(this.host.config());
    if (focusedId !== undefined) {
      const index = this.items.findIndex((item) => item.id === focusedId);
      if (index >= 0) this.listFocus = index;
    }
    this.listFocus = Math.min(this.listFocus, Math.max(0, this.items.length - 1));
    this.invalidate();
  }

  private itemById(id: string): SettingItem | undefined {
    return this.items.find((item) => item.id === id);
  }

  private focusedItem(): SettingItem | undefined {
    return this.items[this.listFocus];
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

  /** Single entry point for submitting the current value; collection kinds are turned into an array there. */
  private commit(item: SettingItem, value: ItemValue, viaSave: boolean): void {
    const result = viaSave ? this.host.saveDefault(item, value) : this.host.setValue(item, value);
    if (result.ok) {
      if (viaSave) this.summary.savedDefaults += 1;
      else this.summary.changed += 1;
    }
    this.message = { text: result.message, tone: result.ok ? "success" : "error" };
    this.refresh();
  }

  private hint(text: string, tone: Tone = "info"): void {
    this.message = { text, tone };
    this.invalidate();
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

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const lines: string[] = [];
    lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold(this.titleText())), width));
    lines.push("");
    lines.push(...this.bodyLines(width));
    while (lines.length < 2 + BODY_ROWS) lines.push("");
    lines.push(this.hintLine(width));
    for (const hint of FOOTER_HINTS) lines.push(truncateToWidth(this.theme.fg("dim", hint.text), width));
    const message = this.message;
    lines.push(truncateToWidth(
      message ? this.colorForTone(message.tone)(message.text) : this.theme.fg("dim", "当前值仅本对话生效；Ctrl+S 固化到用户默认"),
      width,
    ));
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private colorForTone(tone: Tone): (text: string) => string {
    if (tone === "success") return (text) => this.theme.fg("success", text);
    if (tone === "error") return (text) => this.theme.fg("error", text);
    return (text) => this.theme.fg("muted", text);
  }

  private titleText(): string {
    if (this.view.kind === "list") return "通知设置";
    if (this.view.kind === "status") return "通知设置 › 状态总览";
    const item = this.itemById(this.view.itemId);
    if (!item) return "通知设置";
    if (this.view.kind === "input") return `通知设置 › ${item.group} · ${item.label} · 自定义值`;
    return `通知设置 › ${item.group} · ${item.label}`;
  }

  private hintLine(width: number): string {
    const hints: string[] = [];
    const position = this.positionInfo();
    if (position) hints.push(position);
    if (this.view.kind === "detail") {
      const item = this.itemById(this.view.itemId);
      if (item?.kind === "collection") hints.push("集合字段：Enter 切换成员（可多选）");
    }
    if (this.view.kind === "status") hints.push("只读视图：↑↓/PageUp/PageDown 滚动，Esc 返回");
    return truncateToWidth(this.theme.fg("dim", hints.join("   ")), width);
  }

  /** Position hint, present only when the list overflows; it never takes row width. */
  private positionInfo(): string | undefined {
    const visible = Math.min(BODY_ROWS, this.totalRows());
    const total = this.totalRows();
    if (total <= BODY_ROWS) return undefined;
    const start = Math.min(Math.max(0, this.scrollOf()), Math.max(0, total - BODY_ROWS));
    return `${start + 1}–${start + visible}/${total}`;
  }

  private totalRows(): number {
    if (this.view.kind === "list") return this.items.length;
    if (this.view.kind === "detail") {
      const item = this.itemById(this.view.itemId);
      return item ? this.candidates(item).length : 0;
    }
    if (this.view.kind === "status") return this.host.statusLines().length;
    return 0;
  }

  private scrollOf(): number {
    if (this.view.kind === "list") return this.listScroll;
    if (this.view.kind === "detail") return this.detailScroll(this.view.focus, this.totalRows());
    return this.statusOffset;
  }

  private bodyLines(width: number): string[] {
    if (this.view.kind === "list") return this.listLines(width);
    if (this.view.kind === "detail") return this.detailLines(width);
    if (this.view.kind === "input") return this.inputLines(width);
    return this.statusLines(width);
  }

  private listLines(width: number): string[] {
    const rows = this.items.map((item, index) => this.itemRow(item, index, width));
    return this.window(rows, this.listScroll);
  }

  private detailLines(width: number): string[] {
    const view = this.view;
    if (view.kind !== "detail") return [];
    const item = this.itemById(view.itemId);
    if (!item) return [];
    const rows = this.candidates(item).map((candidate, index) => this.candidateRow(item, candidate, index, view.focus, width));
    return this.window(rows, this.detailScroll(view.focus, rows.length));
  }

  /** The detail view derives its scroll offset from the focused row, which then stays visible. */
  private detailScroll(focus: number, total: number): number {
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
    lines.push(truncateToWidth(this.theme.fg("muted", `输入 ${item.label}（Enter 应用 · Esc 取消）`), width));
    lines.push(truncateToWidth(`${this.theme.fg("accent", "› ")}${view.buffer}${CURSOR_MARKER}`, width));
    if (view.error) lines.push(truncateToWidth(this.theme.fg("error", view.error), width));
    return lines;
  }

  private statusLines(width: number): string[] {
    const rows = this.host.statusLines().map((line) => truncateToWidth(line, width));
    return this.window(rows, this.statusOffset);
  }

  /** Slice around the focused row; the position hint lives in the hint line, not on these rows. */
  private window(rows: string[], scroll: number): string[] {
    if (rows.length <= BODY_ROWS) return rows;
    const start = Math.min(Math.max(0, scroll), Math.max(0, rows.length - BODY_ROWS));
    return rows.slice(start, start + BODY_ROWS);
  }

  /**
   * Parent row: `→ group · label   ✓ current value   default saved value`.
   *
   * Degradation order, keeping "which setting is this" first, then the markers, then the value:
   *  1. keep at least 14 columns for the label (or its full width), then give width to
   *     `✓ current` and afterwards to `default X`;
   *  2. when both do not fit, keep only `✓ current`; the saved default stays visible in the
   *     detail view and on wide terminals;
   *  3. only then truncate the value, keeping the `✓ ` / `default ` prefixes so a marker is
   *     never cut away.
   */
  private itemRow(item: SettingItem, index: number, width: number): string {
    const focused = index === this.listFocus;
    const head = `${FOCUS_CELL(focused)}${item.group} · ${item.label}`;
    const currentCell = `✓ ${item.format(this.value(item))}`;
    const defaultCell = this.hasDefault(item) ? `default ${item.format(this.defaultValue(item))}` : "— 未保存";

    const labelRoom = Math.min(visibleWidth(head), 14);
    const budget = width - 2 - labelRoom;
    let right = "";
    if (budget >= visibleWidth(currentCell) + 3 + visibleWidth(defaultCell)) {
      right = `  ${currentCell}   ${defaultCell}`;
    } else if (budget >= 2) {
      right = `  ${truncateToWidth(currentCell, budget, "…")}`;
    }

    const rightWidth = visibleWidth(right);
    const room = width - rightWidth - 2;
    const text = visibleWidth(head) > room ? truncateToWidth(head, Math.max(3, room), "…") : head;
    const pad = Math.max(1, width - rightWidth - visibleWidth(text));
    return truncateToWidth(`${text}${" ".repeat(pad)}${right}`, width);
  }

  /**
   * Candidate row: focus and current-value cells (two columns each, always reserved), then the
   * value with optional detail, then a trailing ` · default`. Markers and suffix are given width
   * first; the label takes what is left and is truncated with an ellipsis.
   */
  private candidateRow(item: SettingItem, candidate: Candidate, index: number, focusIndex: number, width: number): string {
    const config = this.host.config();
    const current = this.value(item);
    const isCurrent = !candidate.custom && isCurrentValue(item.kind, current, candidate.value as SettingValue);
    const isDefault = !candidate.custom && this.isDefaultCandidate(item, candidate, current);
    const detail = item.detail?.(config);
    const suffix = isDefault && width >= DEFAULT_SUFFIX_MIN_WIDTH ? " · default" : "";
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

  handleInput(data: string): void {
    if (this.view.kind === "input") {
      this.handleInputView(data);
      return;
    }
    if (this.view.kind === "status") {
      this.handleStatusView(data);
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
      // Re-reading changes the effective config, so the list is rebuilt while the current
      // view and focus are preserved.
      const result = this.host.reload();
      this.refresh();
      this.report(result);
      return;
    }
    if (matchesKey(data, Key.ctrl("o"))) {
      this.view = { kind: "status" };
      this.statusOffset = 0;
      this.invalidate();
      this.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.view.kind === "detail") {
        this.view = { kind: "list" };
        this.invalidate();
        this.requestRender();
        return;
      }
      this.finish(this.summary);
      return;
    }
    if (this.view.kind === "list") this.handleListInput(data);
    else this.handleDetailInput(data);
  }

  private report(result: { ok: boolean; message: string }): void {
    this.message = { text: result.message, tone: result.ok ? "success" : "error" };
    this.invalidate();
    this.requestRender();
  }

  private handleListInput(data: string): void {
    const total = this.items.length;
    if (total === 0) return;
    if (this.keybindings.matches(data, "tui.select.up")) this.moveList(this.listFocus - 1);
    else if (this.keybindings.matches(data, "tui.select.down")) this.moveList(this.listFocus + 1);
    else if (this.keybindings.matches(data, "tui.select.pageUp")) this.moveList(this.listFocus - BODY_ROWS);
    else if (this.keybindings.matches(data, "tui.select.pageDown")) this.moveList(this.listFocus + BODY_ROWS);
    else if (this.keybindings.matches(data, "tui.select.confirm")) {
      const item = this.focusedItem();
      if (!item) return;
      this.view = { kind: "detail", itemId: item.id, focus: this.initialDetailFocus(item) };
      this.invalidate();
      this.requestRender();
    }
  }

  /** On entering the detail view, focus the row holding the current value: that is what users
   * most often want to change. */
  private initialDetailFocus(item: SettingItem): number {
    const current = this.value(item);
    const index = this.candidates(item)
      .findIndex((row) => !row.custom && isCurrentValue(item.kind, current, row.value as SettingValue));
    return index >= 0 ? index : 0;
  }

  private moveList(next: number): void {
    this.listFocus = Math.min(Math.max(0, next), this.items.length - 1);
    this.listScroll = Math.min(this.listScroll, Math.max(0, this.items.length - BODY_ROWS));
    if (this.listFocus < this.listScroll) this.listScroll = Math.min(this.listFocus, Math.max(0, this.items.length - BODY_ROWS));
    if (this.listFocus >= this.listScroll + BODY_ROWS) this.listScroll = this.listFocus - BODY_ROWS + 1;
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
        this.view = { kind: "input", itemId: item.id, buffer: String(this.value(item) ?? "") };
        this.invalidate();
        this.requestRender();
        return;
      }
      const current = this.value(item);
      const value = item.kind === "collection"
        ? collectionValue(current, candidate.value as SettingValue)
        : candidate.value;
      this.commit(item, value, false);
      this.requestRender();
    }
  }

  private moveDetail(item: SettingItem, next: number, total: number): void {
    const view = this.view;
    if (view.kind !== "detail") return;
    this.view = { ...view, itemId: item.id, focus: Math.min(Math.max(0, next), total - 1) };
    this.invalidate();
    this.requestRender();
  }

  private handleStatusView(data: string): void {
    const total = this.host.statusLines().length;
    const maxOffset = Math.max(0, total - BODY_ROWS);
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.view = { kind: "list" };
      this.invalidate();
      this.requestRender();
      return;
    }
    let next: number | undefined;
    if (this.keybindings.matches(data, "tui.select.up")) next = this.statusOffset - 1;
    else if (this.keybindings.matches(data, "tui.select.down")) next = this.statusOffset + 1;
    else if (this.keybindings.matches(data, "tui.select.pageUp")) next = this.statusOffset - BODY_ROWS;
    else if (this.keybindings.matches(data, "tui.select.pageDown")) next = this.statusOffset + BODY_ROWS;
    if (next === undefined) return;
    this.statusOffset = Math.min(Math.max(0, next), maxOffset);
    this.invalidate();
    this.requestRender();
  }

  private handleInputView(data: string): void {
    const view = this.view;
    if (view.kind !== "input") return;
    const item = this.itemById(view.itemId);
    if (!item?.parseInput) {
      this.view = { kind: "list" };
      this.invalidate();
      this.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.view = { kind: "detail", itemId: item.id, focus: this.initialDetailFocus(item) };
      this.invalidate();
      this.requestRender();
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
      this.view = { kind: "detail", itemId: item.id, focus: this.initialDetailFocus(item) };
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

  /** Ctrl+S: freezes the focused item's current value as the user default. */
  private saveFocusedDefault(): void {
    const item = this.view.kind === "detail" || this.view.kind === "input"
      ? this.itemById(this.view.itemId)
      : this.focusedItem();
    if (!item) return;
    this.commit(item, this.value(item) as ItemValue, true);
    this.requestRender();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  /** Current view and focus; used by tests and for debugging. */
  debugState(): { view: View; listFocus: number; items: string[]; message?: { text: string; tone: Tone } } {
    return {
      view: this.view,
      listFocus: this.listFocus,
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
