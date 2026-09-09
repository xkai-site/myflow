import { pathToFileURL } from "node:url";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";

/** Keep the full URI visible for copying even when the terminal cannot open links. */
export function formatGalleryLink(filePath: string, theme?: Pick<Theme, "fg" | "underline">): string {
	const url = pathToFileURL(filePath).href;
	if (!theme) return url; // RPC / non-TUI output must not contain terminal escapes.
	const styled = theme.fg("mdLink", theme.underline(url));
	return getCapabilities().hyperlinks ? hyperlink(styled, url) : styled;
}
