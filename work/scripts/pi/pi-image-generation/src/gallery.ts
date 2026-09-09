import { randomUUID } from "node:crypto";
import { lstat, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureSafeOutputDirectory } from "./image-files.ts";
import type { GeneratedImageEntryData } from "./types.ts";

/** Creates a local-only gallery; callers must preserve saved images if this fails. */
export async function saveImageGallery(cwd: string, entries: readonly GeneratedImageEntryData[]): Promise<string> {
	if (!entries.length) throw new Error("Cannot create an empty image gallery");
	const directory = path.resolve(cwd, ".pi", "generated-images");
	await ensureSafeOutputDirectory(cwd, directory);
	for (const entry of entries) {
		if (!path.isAbsolute(entry.path) || path.dirname(path.resolve(entry.path)) !== directory) {
			throw new Error("Gallery images must be in the current project's generated-images directory");
		}
		const stats = await lstat(entry.path);
		if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("Gallery image must be a regular file, not a symbolic link");
	}
	const filename = `gallery-${randomUUID()}.html`;
	const finalPath = path.join(directory, filename);
	const temporaryPath = path.join(directory, `.${filename}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporaryPath, renderGallery(entries), { flag: "wx", encoding: "utf8" });
		await rename(temporaryPath, finalPath);
		return finalPath;
	} catch (error) {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function renderGallery(entries: readonly GeneratedImageEntryData[]): string {
	const number = new Intl.NumberFormat("zh-CN");
	const count = number.format(entries.length);
	const single = entries.length === 1;
	const cards = entries.map((entry, index) => {
		const filename = path.basename(entry.path);
		const href = escapeHtml(`./${encodeURIComponent(filename)}`);
		const position = number.format(index + 1);
		// Dimensions reserve the viewing box; object-fit preserves each original's ratio.
		return `<figure>
<a class="image-link" href="${href}" target="_blank" rel="noopener noreferrer" aria-label="查看原图 ${position}（新标签页）"><img src="${href}" alt="生成图片 ${position}" width="1600" height="1000" loading="${index === 0 ? "eager" : "lazy"}" fetchpriority="${index === 0 ? "high" : "auto"}" decoding="async"></a>
<figcaption>
${single ? "" : `<span class="image-number" aria-label="第 ${position} 张，共 ${count} 张">${position} / ${count}</span>`}
<a class="action" href="${href}" target="_blank" rel="noopener noreferrer" aria-label="查看原图 ${position}（新标签页）">查看原图 <span aria-hidden="true">↗</span></a>
</figcaption>
</figure>`;
	}).join("\n");
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#111214">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<title>图片预览${single ? "" : ` · ${count} 张`}</title>
<style>
:root {
  color-scheme: dark;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  background: #111214;
  color: #f0f0f1;
  --muted: #a7a9b0;
  --gutter: clamp(12px, 2vw, 32px);
  -webkit-tap-highlight-color: #ffffff26;
}
* { box-sizing: border-box; }
body {
  max-width: 1800px;
  margin: 0 auto;
  padding: env(safe-area-inset-top, 0px) max(var(--gutter), env(safe-area-inset-right, 0px)) max(12px, env(safe-area-inset-bottom, 0px)) max(var(--gutter), env(safe-area-inset-left, 0px));
}
a { color: inherit; text-decoration: none; touch-action: manipulation; }
a:focus-visible { outline: 2px solid #a8c7fa; outline-offset: 4px; }
.skip-link { position: absolute; top: -100px; left: var(--gutter); padding: 12px 16px; background: #f0f0f1; color: #111214; z-index: 1; }
.skip-link:focus { top: max(12px, env(safe-area-inset-top, 0px)); }
header { min-height: 64px; display: flex; align-items: center; gap: 12px; }
h1 { margin: 0; font-size: 14px; font-weight: 500; letter-spacing: .02em; text-wrap: balance; }
.count, .image-number { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.gallery { display: grid; grid-template-columns: minmax(0, 1fr); gap: 24px; scroll-margin-top: 12px; }
figure { margin: 0; min-width: 0; }
.image-link {
  display: block;
  height: clamp(240px, 65vh, 800px);
  height: clamp(240px, 65svh, 800px);
  background: #191a1d;
  cursor: zoom-in;
}
.image-link:hover { outline: 1px solid #696c74; outline-offset: 0; }
.image-link:focus-visible { outline: 2px solid #a8c7fa; outline-offset: 4px; }
img { display: block; width: 100%; height: 100%; object-fit: contain; }
figcaption { min-height: 52px; display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; padding-top: 4px; overflow-wrap: anywhere; }
.image-number { margin-right: auto; }
.action { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: 44px; min-height: 44px; padding: 8px 12px; border-radius: 6px; color: var(--muted); font-size: 13px; }
.action:hover, .action:active { background: #2a2c31; color: #fff; }
.gallery--single .image-link {
  height: max(240px, calc(100vh - 128px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px)));
  height: max(240px, calc(100svh - 128px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px)));
}
.gallery--many figure { content-visibility: auto; contain-intrinsic-size: auto 600px; }
@media (min-width: 960px) {
  .gallery:not(.gallery--single) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (forced-colors: active) {
  .action { border: 1px solid ButtonText; }
  .image-link { border: 1px solid CanvasText; }
}
</style>
</head>
<body>
<a class="skip-link" href="#gallery">跳至图片</a>
<header><h1>图片预览</h1>${single ? "" : `<span class="count">${count} 张</span>`}</header>
<main id="gallery" class="gallery${single ? " gallery--single" : ""}${entries.length > 50 ? " gallery--many" : ""}" aria-label="图片预览" tabindex="-1">
${cards}
</main>
</body>
</html>
`;
}
