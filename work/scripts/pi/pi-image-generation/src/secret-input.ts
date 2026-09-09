import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_KEY_CHARS, validateKey } from "./credentials.ts";

const START = "\x1b[200~";
const END = "\x1b[201~";
export class SecretInputState {
	private value = "";
	private pending = "";
	private paste = "";
	private pasting = false;
	error: string | undefined;
	get entered(): boolean { return this.value.length > 0; }
	get receivingPaste(): boolean { return this.pasting || this.pending.length > 0; }
	clear(): void { this.value = ""; this.pending = ""; this.paste = ""; this.pasting = false; this.error = undefined; }
	backspace(): void { this.value = this.value.slice(0, -1); this.error = undefined; }
	submit(): string | undefined {
		if (this.receivingPaste) { this.error = "Wait for paste to finish, or Esc to cancel"; return undefined; }
		if (this.error) return undefined;
		try { return validateKey(this.value); }
		catch { this.error = "Enter a non-empty API Key without spaces"; return undefined; }
	}
	feed(data: string): void {
		this.pending += data;
		while (this.pending) {
			const marker = this.pasting ? END : START;
			const index = this.pending.indexOf(marker);
			if (index >= 0) {
				this.consume(this.pending.slice(0, index));
				this.pending = this.pending.slice(index + marker.length);
				if (this.pasting) { this.add(this.paste.trim()); this.paste = ""; }
				this.pasting = !this.pasting;
				continue;
			}
			let retained = 0;
			for (let n = 1; n < marker.length && n <= this.pending.length; n++) {
				if (this.pending.endsWith(marker.slice(0, n))) retained = n;
			}
			this.consume(this.pending.slice(0, this.pending.length - retained));
			this.pending = this.pending.slice(this.pending.length - retained);
			break;
		}
	}
	private consume(text: string): void {
		if (this.pasting) {
			if (this.paste.length + text.length > MAX_KEY_CHARS + 16) {
				this.error = "API Key is too long";
				// Keep the entire paste invalid rather than saving a truncated key.
				this.paste = "\x00";
			} else this.paste += text;
		} else this.add(text);
	}
	private add(text: string): void {
		if (!text) return;
		if (this.value.length + text.length > MAX_KEY_CHARS || /[^\x21-\x7e]/u.test(text)) {
			this.error = "API Key input contains spaces/control characters or is too long";
			return;
		}
		this.error = undefined;
		this.value += text;
	}
}

export async function promptSecret(ctx: ExtensionContext, title: string): Promise<string | undefined> {
	if (ctx.mode !== "tui") throw new Error("API Key input requires TUI mode; use the configured environment variable otherwise");
	const { CURSOR_MARKER, decodeKittyPrintable, truncateToWidth } = await import("@earendil-works/pi-tui");
	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		const state = new SecretInputState();
		const finish = (value: string | undefined) => { state.clear(); done(value); };
		return {
			focused: false,
			render(width: number): string[] {
				return [
					truncateToWidth(theme.fg("accent", title), width),
					truncateToWidth(`> ${state.entered ? "[secret entered]" : "[paste or type secret]"}${CURSOR_MARKER}`, width),
					truncateToWidth(theme.fg(state.error ? "warning" : "dim", state.error ?? "Enter save • Esc cancel • input is never displayed"), width),
				];
			},
			invalidate() {},
			handleInput(data: string): void {
				if (keybindings.matches(data, "tui.select.cancel")) { finish(undefined); return; }
				if (!state.receivingPaste && (keybindings.matches(data, "tui.input.submit") || data === "\n")) {
					const value = state.submit();
					if (value !== undefined) { finish(value); return; }
				} else if (!state.receivingPaste && keybindings.matches(data, "tui.editor.deleteCharBackward")) state.backspace();
				else state.feed(state.receivingPaste ? data : decodeKittyPrintable(data) ?? data);
				tui.requestRender();
			},
		};
	});
}
