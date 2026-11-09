/** Credential-only input. Never put a credential in a page snapshot, native Input undo/kill
 * history, feedback text, or debug state. Accept bounded (including split) bracketed paste. */
import { CURSOR_MARKER, decodeKittyPrintable, Key, matchesKey, renderFakeCursor, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { SettingsKeybindings } from "./ui.ts";
const START = "\x1b[200~", END = "\x1b[201~";
export class SecretPrompt {
  #value = "";
  #pending = "";
  #paste = "";
  #pasting = false;
  #error?: string;
  clear(): void { this.#value = ""; this.#pending = ""; this.#paste = ""; this.#pasting = false; this.#error = undefined; }
  handleInput(data: string, keys: SettingsKeybindings): { cancelled?: boolean; submitted?: string } {
    if (keys.matches(data, "tui.select.cancel")) { this.clear(); return { cancelled: true }; }
    const receiving = this.#pasting || this.#pending.length > 0;
    if (!receiving && (keys.matches(data, "tui.select.confirm") || data === "\n")) {
      if (this.#error || !this.#value) { this.#error ??= "请输入 1–128 位 QQ 邮箱授权码"; return {}; }
      const submitted = this.#value;
      this.clear();
      return { submitted };
    }
    if (!receiving && (matchesKey(data, Key.backspace) || data === "\x7f" || data === "\b")) {
      this.#value = this.#value.slice(0, -1); this.#error = undefined; return {};
    }
    this.#pending += receiving ? data : decodeKittyPrintable(data) ?? data;
    while (this.#pending) {
      const marker = this.#pasting ? END : START;
      const index = this.#pending.indexOf(marker);
      if (index >= 0) {
        this.consume(this.#pending.slice(0, index));
        this.#pending = this.#pending.slice(index + marker.length);
        if (this.#pasting) { this.add(this.#paste.trim()); this.#paste = ""; }
        this.#pasting = !this.#pasting;
        continue;
      }
      let retained = 0;
      for (let n = 1; n < marker.length && n <= this.#pending.length; n++) if (this.#pending.endsWith(marker.slice(0, n))) retained = n;
      this.consume(this.#pending.slice(0, this.#pending.length - retained));
      this.#pending = this.#pending.slice(this.#pending.length - retained);
      break;
    }
    return {};
  }
  private consume(text: string): void {
    if (this.#pasting) this.#paste = this.#paste.length + text.length > 144 ? "\0" : this.#paste + text;
    else this.add(text);
  }
  private add(text: string): void {
    if (!text) return;
    if (this.#value.length + text.length > 128 || /[^\x21-\x7e]/u.test(text)) { this.#error = "授权码含空格或控制字符，或超过 128 位；请重新输入"; return; }
    this.#error = undefined; this.#value += text;
  }
  render(width: number, focused: boolean): string[] {
    return [
      ...wrapTextWithAnsi("QQ 邮箱生成的专用发送凭据，不是登录密码。", width),
      ...wrapTextWithAnsi("安全保存到此设备，供所有对话使用。", width),
      `› ${"●".repeat(Math.min(this.#value.length, Math.max(0, width - 3)))}${focused ? CURSOR_MARKER : ""}${renderFakeCursor(" ")}`,
      ...(this.#error ? wrapTextWithAnsi(this.#error, width) : []),
    ];
  }
}
