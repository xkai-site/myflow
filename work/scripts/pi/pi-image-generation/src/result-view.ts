import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { validateAnimatedGif, type GifMetadata } from "./gif.ts";
import { SVG_MAX_BYTES, validateStaticSvg } from "./svg.ts";
import path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, getCapabilities, Image, Spacer, Text } from "@earendil-works/pi-tui";
import { detectImage, isGeneratedImagePath } from "./image-files.ts";
import { sanitizeError } from "./http.ts";
import { formatImageLink } from "./preview-link.ts";
import type { GeneratedImageEntryData } from "./types.ts";

const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EXTENSIONS: Record<string, readonly string[]> = {
	"image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"], "image/webp": [".webp"],
	"image/bmp": [".bmp"], "image/svg+xml": [".svg"], "image/gif": [".gif"],
};
// Persisted paths/model labels must not inject their own OSC 8 links or terminal controls.
const plain = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** Read once, before exposing a link. Validation describes this snapshot only;
 * an external process can still change the pathname/content after these checks.
 * Historical entries carry an absolute project path, not necessarily process.cwd().
 */
export function createResultView(data: GeneratedImageEntryData | undefined, theme: Theme, modelName?: string): Container {
	const container = new Container();
	const text = (content: () => string) => ({
		render: (width: number) => new Text(content(), 0, 0).render(width),
		invalidate() {},
	});
	// Capture primitives: later mutation of the entry must not redirect a validated link.
	const entry = data && typeof data === "object" && !Array.isArray(data) ? { ...data } : undefined;
	const savedPath = typeof entry?.path === "string" ? entry.path : undefined;
	const warning = (message: string) => container.addChild(text(() => theme.fg("warning", `图片预览不可用：当前历史文件无法安全预览；${plain(sanitizeError(message))}`)));
	if (!entry || typeof entry.provider !== "string" || !IDENTIFIER.test(entry.provider) ||
		typeof entry.model !== "string" || !IDENTIFIER.test(entry.model) || typeof entry.prompt !== "string" ||
		typeof entry.mimeType !== "string" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 ||
		!Number.isFinite(entry.createdAt) || entry.createdAt < 0 ||
		(entry.kind !== undefined && entry.kind !== "animation" && entry.kind !== "vector")) {
		if (savedPath !== undefined) container.addChild(text(() => `保存路径：${plain(savedPath)}`));
		warning("图片记录的数据结构无效");
		return container;
	}
	if (savedPath === undefined || /[\u0000-\u001f\u007f-\u009f]/.test(savedPath) || !path.isAbsolute(savedPath) || !isGeneratedImagePath(savedPath)) {
		if (savedPath !== undefined) container.addChild(text(() => `保存路径：${plain(savedPath)}`));
		warning("图片记录的保存路径无效");
		return container;
	}
	container.addChild(text(() => theme.fg("success", entry.mimeType === "image/gif" ? "动画文件已生成" : "图片已生成") + "\n" + theme.fg("muted", plain(modelName ?? entry.model))));
	container.addChild(text(() => `保存路径：${plain(savedPath)}`));
	try {
		const filePath = path.resolve(savedPath);
		if (!Object.hasOwn(EXTENSIONS, entry.mimeType) || !EXTENSIONS[entry.mimeType].includes(path.extname(filePath).toLowerCase()) ||
			(entry.kind === "vector" && entry.mimeType !== "image/svg+xml") || (entry.kind === "animation" && entry.mimeType !== "image/gif")) {
			throw new Error("stored image metadata/type mismatch");
		}
		const { bytes, gif } = readCheckedHistory(filePath, entry.mimeType);
		// No URI/OSC 8 entry is created until filesystem and actual-content checks pass.
		container.addChild(text(() => theme.fg("dim", "打开原图：Ctrl+点击链接，或复制 URL") + `\n${formatImageLink(filePath, theme)}`));
		if (entry.mimeType === "image/svg+xml") {
			container.addChild(text(() => theme.fg("dim", "SVG 矢量文件：已通过静态 XML 白名单校验；终端不渲染，请手动打开原文件")));
			return container;
		}
		if (gif) {
			container.addChild(text(() => theme.fg("dim", `GIF 动画：${gif.frames} 帧，${gif.width}x${gif.height}；终端不播放动画，请手动打开原文件`)));
			return container;
		}
		const preview = new Image(bytes.toString("base64"), entry.mimeType,
			{ fallbackColor: (value) => theme.fg("dim", value) },
			{ filename: path.basename(filePath), maxWidthCells: 72, maxHeightCells: 28 });
		container.addChild(new Spacer(1));
		container.addChild({
			render: (width) => getCapabilities().images ? preview.render(width) : new Text(theme.fg("dim", "当前终端不支持图片预览"), 0, 0).render(width),
			invalidate: () => preview.invalidate(),
		});
	} catch (error) {
		warning(error instanceof Error ? error.message : "stored image check failed");
	}
	return container;
}

function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
	return b.isFile() && !b.isSymbolicLink() && sameIdentity(a, b) &&
		a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function samePath(a: string, b: string): boolean { return path.relative(a, b) === ""; }

function readCheckedHistory(filePath: string, mimeType: string): { bytes: Buffer; gif?: GifMetadata } {
	const output = path.dirname(filePath), root = path.dirname(path.dirname(output));
	if (!samePath(output, path.join(root, ".pi", "generated-images"))) throw new Error("stored image directory mismatch");
	// Mirror the writer's project/.pi/generated-images layout. Ancestors of the
	// project may be canonical OS aliases; the project and both managed dirs may not be symlinks/junctions.
	const directories = [root, path.join(root, ".pi"), output].map(directory => {
		const stats = lstatSync(directory, { bigint: true });
		if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("stored image directory is not a regular directory (symbolic links refused)");
		return { directory, stats, real: realpathSync(directory) };
	});
	for (const item of directories) {
		if (!samePath(item.real, path.resolve(directories[0].real, path.relative(root, item.directory)))) throw new Error("stored image directory resolves outside the project");
	}
	const expectedReal = path.join(directories[2].real, path.basename(filePath));
	const before = lstatSync(filePath, { bigint: true });
	if (!before.isFile() || before.isSymbolicLink()) throw new Error("stored image is not a regular file (symbolic links refused)");
	const maximum = mimeType === "image/svg+xml" ? SVG_MAX_BYTES : MAX_HISTORY_BYTES;
	if (before.size < 1n || before.size > BigInt(maximum)) throw new Error("stored image exceeds preview size limit");
	if (!samePath(realpathSync(filePath), expectedReal)) throw new Error("stored image resolves outside the generated directory");
	// O_NOFOLLOW/O_NONBLOCK are effective on platforms that provide them. The
	// lstat/fstat and post-read path checks remain required (notably on Windows).
	const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		if (!sameFile(before, fstatSync(fd, { bigint: true }))) throw new Error("stored image changed before reading");
		// One extra byte detects growth, without an unbounded readFile after stat.
		const buffer = Buffer.alloc(Number(before.size) + 1);
		let count = 0;
		while (count < buffer.length) {
			const read = readSync(fd, buffer, count, buffer.length - count, null);
			if (!read) break;
			count += read;
		}
		if (count !== Number(before.size)) throw new Error("stored image changed while reading");
		const bytes = buffer.subarray(0, count);
		let gif: GifMetadata | undefined;
		if (mimeType === "image/svg+xml") validateStaticSvg(bytes);
		else if (mimeType === "image/gif") gif = validateAnimatedGif(bytes);
		else if (detectImage(bytes)?.mimeType !== mimeType) throw new Error("stored image format mismatch");
		if (!sameFile(before, fstatSync(fd, { bigint: true })) || !sameFile(before, lstatSync(filePath, { bigint: true })) ||
			!samePath(realpathSync(filePath), expectedReal)) throw new Error("stored image changed during validation");
		for (const item of directories) {
			const current = lstatSync(item.directory, { bigint: true });
			if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(item.stats, current) || !samePath(realpathSync(item.directory), item.real)) {
				throw new Error("stored image directory changed during validation");
			}
		}
		return { bytes, gif };
	} finally { closeSync(fd); }
}
