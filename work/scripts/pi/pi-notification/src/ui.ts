/**
 * 通知设置界面（UX 方案 §信息架构 / §列表与标记规则 / §键盘与 Ctrl+S）。
 *
 * 两级列表：
 *  - **配置项列表**：一行一项，内联展示「当前值」与「用户级默认值」，不进入详情就能读到状态。
 *  - **候选项列表**：一行一个候选值，标记位固定占位（焦点 2 列 + 当前值 2 列），
 *    行尾 ` · default` 是独立的「用户级默认」通道，可与 `✓`/`→ ` 共存。
 *
 * 本模块只有渲染与按键；写盘/生效/静默判定都在命令层（见 commands.ts 的 SettingsHost 实现），
 * 因此可以脱离宿主直接驱动（test/settings-ui.mjs 就是这么测的）。
 *
 * 三条刻意的设计：
 *  1. 标记单元格不带颜色，保证 `✓` 出现/消失时文本不横向跳动（等宽由终端保证）。
 *  2. 行尾 ` · default` 与焦点/当前值列**先于**值文本分配宽度，溢出只截断值，不吞标记。
 *  3. Ctrl+S 只在组件持有输入时消费（不注册全局快捷键），与宿主 app.models.save 的同名键不冲突。
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

/** 只用到的主题能力（方法签名，避免绑死 SDK 的调色板类型）。 */
export interface SettingsTheme {
  fg(color: "accent" | "muted" | "dim" | "success" | "error" | "warning" | "text", text: string): string;
  bold(text: string): string;
}

/** 注入的按键解析器（真实宿主给 KeybindingsManager，测试给桩）。 */
export interface SettingsKeybindings {
  matches(data: string, keybinding: string): boolean;
}

export type ItemValue = SettingValue | SettingValue[];

export interface SettingsHost {
  /** 生效配置（已含本对话覆盖） */
  config(): NotificationConfig;
  /** 原始用户文件（稀疏用户默认的「存在性/取值」） */
  userRaw(): unknown;
  /** Enter：写入本对话覆盖并立即生效 */
  setValue(item: SettingItem, value: ItemValue): { ok: boolean; message: string };
  /** Ctrl+S：固化为用户级默认（单项稀疏写盘） */
  saveDefault(item: SettingItem, value: ItemValue): { ok: boolean; message: string };
  /** Ctrl+T：发送测试通知 */
  test(): { ok: boolean; message: string };
  /** Ctrl+R：重新读盘（不重载扩展） */
  reload(): { ok: boolean; message: string };
  /** Ctrl+O：状态总览文本（分页只读） */
  statusLines(): string[];
}

interface FooterHint {
  text: string;
}

/** 列表可视行数（组件自己控制高度，不依赖终端高度）。 */
const BODY_ROWS = 12;
/** 焦点列与当前值列各占 2 个终端显示列，未命中也要占位。 */
const FOCUS_CELL = (focused: boolean): string => (focused ? "→ " : "  ");
const CURRENT_CELL = (current: boolean): string => (current ? "✓ " : "  ");
/** 父级列表：列可见性的整表阀值（≥30 两列、16–29 只留当前值、<16 只留标签）。 */
const DETAIL_MIN_WIDTH = 28;
/** 窄于这个宽度就放弃行尾 ` · default`（先保焦点/当前值标记与值文本）。 */
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
  /** 通过 Ctrl+S 成功写盘的次数 */
  savedDefaults: number;
  /** 在本对话里改过值的次数 */
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

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------

  /** 重建配置项列表（配置可能被 Ctrl+R 重读，渠道也可能变化）。 */
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

  /** 当前值（本对话生效值）。 */
  private value(item: SettingItem): unknown {
    return item.read(this.host.config());
  }

  private hasDefault(item: SettingItem): boolean {
    return hasUserDefault(this.host.userRaw(), item);
  }

  private defaultValue(item: SettingItem): unknown {
    return userDefaultValue(this.host.userRaw(), item);
  }

  /** 是把「当前值」提交给 host 的统一入口（集合项在那里切成数组）。 */
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

  // -------------------------------------------------------------------------
  // 候选项
  // -------------------------------------------------------------------------

  private candidates(item: SettingItem): Candidate[] {
    const config = this.host.config();
    const rows: Candidate[] = item.candidates(config).map((candidate) => ({ value: candidate.value, label: candidate.label }));
    if (item.kind !== "collection") {
      // 当前值/用户默认可能不在预设集里：补一行，保证标记位总有落脚处。
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

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

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

  /** 列表位置提示（超出可视窗口时才有）——不占用列表行宽，所以不会被截断。 */
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

  /** 详情页的滚动位置由焦点推导：焦点总在可视窗口内。 */
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

  /** 取焦点所在的窗口（位置提示走 hintLine，不用挤占行宽）。 */
  private window(rows: string[], scroll: number): string[] {
    if (rows.length <= BODY_ROWS) return rows;
    const start = Math.min(Math.max(0, scroll), Math.max(0, rows.length - BODY_ROWS));
    return rows.slice(start, start + BODY_ROWS);
  }

  /**
   * 父级行：`→ 分组 · 标签   ✓ 当前值   default 用户默认`。
   *
   * 降级顺序（先保「能认出来是哪一项」，再保标记，最后才截值）：
   *  1. 标签至少留 14 列（或它的完整长度），剩下的宽度先给 `✓ 当前值`、再给 `default X`；
   *  2. 两列放不下时只留 `✓ 当前值`（用户默认仍在详情页与宽终端可见）；
   *  3. 还放不下就截值，但保留 `✓ ` / `default ` 前缀，所以标记不会被“截掉”。
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
   * 候选项行：焦点列 + 当前值列（各 2 列，固定占位）+ 值 [+ 附加信息] + 行尾 ` · default`。
   * 宽度先分配给标记与尾标，值文本拿剩余宽度并用 `…` 截断。
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

  /** 候选项是不是「用户级默认那一项」（集合按成员判断）。 */
  private isDefaultCandidate(item: SettingItem, candidate: Candidate, current: unknown): boolean {
    if (!this.hasDefault(item)) return false;
    const fallback = this.defaultValue(item);
    if (item.kind === "collection") {
      return Array.isArray(fallback) && fallback.includes(candidate.value as SettingValue);
    }
    if (fallback === candidate.value) return true;
    // 数值/时间：默认值可能不在预设集里，靠 format 对齐（新补的行会走到这里）
    return current !== undefined && item.format(fallback) === candidate.label && isCurrentValue(item.kind, current, candidate.value as SettingValue);
  }

  // -------------------------------------------------------------------------
  // 输入
  // -------------------------------------------------------------------------

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
      // 重读会改变生效配置 → 重建列表，但保持当前视图与焦点。
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

  /** 进入详情时把焦点放到当前值那一行（用户最可能想改的就是它）。 */
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

  /** Ctrl+S：把焦点项的当前值固化为用户级默认。 */
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

  /** 测试与排障用：当前视图与焦点。 */
  debugState(): { view: View; listFocus: number; items: string[]; message?: { text: string; tone: Tone } } {
    return {
      view: this.view,
      listFocus: this.listFocus,
      items: this.items.map((item) => item.id),
      ...(this.message ? { message: this.message } : {}),
    };
  }
}

/** 供命令层交给 `ctx.ui.custom()` 的工厂。 */
export function createNotifySettingsComponent(
  options: NotifySettingsComponentOptions,
): NotifySettingsComponent {
  return new NotifySettingsComponent(options);
}
