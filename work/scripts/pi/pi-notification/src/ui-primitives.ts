/** Small native Pi adapters; semantic themes are evaluated on every render. */
import { Input, SelectList, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { SettingsKeybindings, SettingsTheme } from "./ui.ts";

export function menuList(labels: string[], focus: number, width: number, rows: number, theme: SettingsTheme): string[] {
  if (!labels.length) return [];
  const list = new SelectList(labels.map((label, index) => ({ value: String(index), label })), rows, {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", theme.bold(text)),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("warning", text),
  });
  list.setSelectedIndex(focus);
  return list.render(Math.max(5, width)).map((line) => truncateToWidth(line, width));
}

/** Input owns cursor movement, horizontal scrolling, IME marker and bracketed paste.
 * It is intentionally never used for credentials. */
export function textInput(value: string): Input {
  const input = new Input();
  // setValue preserves the previous cursor (zero on a new Input). Native paste initializes
  // both the value and end cursor without assuming any user-configured End keybinding.
  if (value) input.handleInput(`\x1b[200~${value}\x1b[201~`);
  return input;
}

/** Save review is independent of the settings navigation state. All items are reachable before
 * confirming; cancel is the initial choice, and no shortcuts can save/send behind this page. */
export class SaveReview {
  private focus = 0;
  private offset = 0;
  private wrappedRows: string[] = [];
  constructor(readonly labels: string[], private readonly bindings: SettingsKeybindings, private readonly complete: (save: boolean) => void) {}
  handleInput(data: string): void {
    if (this.bindings.matches(data, "tui.select.cancel")) { this.complete(false); return; }
    if (this.bindings.matches(data, "tui.select.up")) this.focus = 0;
    else if (this.bindings.matches(data, "tui.select.down")) this.focus = 1;
    else if (this.bindings.matches(data, "tui.select.pageUp")) this.offset = Math.max(0, this.offset - 5);
    else if (this.bindings.matches(data, "tui.select.pageDown")) this.offset = Math.min(Math.max(0, this.wrappedRows.length - 5), this.offset + 5);
    else if (this.bindings.matches(data, "tui.select.confirm")) this.complete(this.focus === 1);
  }
  render(width: number, theme: SettingsTheme): string[] {
    this.wrappedRows = this.labels.flatMap((label) => wrapTextWithAnsi(`  ${label}`, width));
    this.offset = Math.min(this.offset, Math.max(0, this.wrappedRows.length - 5));
    return [
      ...wrapTextWithAnsi("将保存以下修改，用于以后对话。其他已打开对话不变。", width),
      ...this.wrappedRows.slice(this.offset, this.offset + 5),
      ...(this.wrappedRows.length > 5 ? [theme.fg("dim", `${this.offset + 1}–${Math.min(this.offset + 5, this.wrappedRows.length)}/${this.wrappedRows.length}  PgUp/PgDn 翻页`)] : []),
      ...menuList(["取消", `确认保存 ${this.labels.length} 项`], this.focus, width, 2, theme),
      ...wrapTextWithAnsi(theme.fg("dim", "↑↓ 选择   Enter 确认   Esc 取消"), width),
    ];
  }
}
