import { readFileSync } from "node:fs";
import path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, getCapabilities, Image, Spacer, Text } from "@earendil-works/pi-tui";
import { detectImage, isGeneratedImagePath } from "./image-files.ts";
import { sanitizeError } from "./http.ts";
import { formatImageLink } from "./preview-link.ts";
import type { GeneratedImageEntryData } from "./types.ts";

/** Read the saved image once; rebuild themed text on render, including historical entries. */
export function createResultView(data: GeneratedImageEntryData | undefined, theme: Theme, modelName?: string): Container {
	const container = new Container();
	const text = (content: () => string) => ({
		render: (width: number) => new Text(content(), 0, 0).render(width),
		invalidate() {},
	});
	if (!data || typeof data.path !== "string" || !path.isAbsolute(data.path) || !isGeneratedImagePath(data.path)) {
		container.addChild(text(() => theme.fg("error", "图片记录的保存路径无效")));
		return container;
	}
	container.addChild(text(() => theme.fg("success", "图片已生成") + "\n" + theme.fg("muted", modelName ?? data.model)));
	container.addChild(text(() => `保存路径：${data.path}`));
	container.addChild(text(() => theme.fg("dim", "打开原图：Ctrl+点击链接，或复制 URL") + `\n${formatImageLink(data.path, theme)}`));
	try {
		const bytes = readFileSync(data.path);
		const detected = detectImage(bytes);
		if (!detected || detected.mimeType !== data.mimeType) throw new Error("stored image format mismatch");
		const preview = new Image(bytes.toString("base64"), detected.mimeType,
			{ fallbackColor: (value) => theme.fg("dim", value) },
			{ filename: path.basename(data.path), maxWidthCells: 72, maxHeightCells: 28 });
		container.addChild(new Spacer(1));
		container.addChild({
			render: (width) => getCapabilities().images ? preview.render(width) : new Text(theme.fg("dim", "当前终端不支持图片预览"), 0, 0).render(width),
			invalidate: () => preview.invalidate(),
		});
	} catch (error) {
		container.addChild(text(() => theme.fg("warning", `图片预览不可用：${sanitizeError((error as Error).message)}`)));
	}
	return container;
}
