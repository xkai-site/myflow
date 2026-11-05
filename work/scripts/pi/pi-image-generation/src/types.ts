import type { ImageModelConfig, ImageProviderConfig } from "./model-config.ts";
import type { DiagnosticWriter } from "./diagnostics.ts";

export interface ParsedImageCommand {
	modelKey?: string;
	prompt: string;
	size?: string;
	quality?: string;
	complexity?: string;
	background?: string;
	outputFormat?: string;
	frameCount?: number;
	frameDurationMs?: number;
	/** Optional local paths for RPC editing; overlay is never a reference image. */
	referencePaths?: string[];
	markupPath?: string;
	markup?: InputImage;
	help: boolean;
}

export interface ResolvedImageCommand extends ParsedImageCommand {
	modelKey: string;
	provider: string;
	model: string;
	size: string;
	modelConfig: ImageModelConfig;
	providerConfig: ImageProviderConfig;
}

export interface InputImage { data: string; mimeType: string }
export interface GeneratedImage { data: string; mimeType: string }
export interface ImageTransportResult { images: GeneratedImage[]; texts: string[]; responseId?: string }
export interface ImageTransportOptions {
	apiKey: string;
	baseUrl: string;
	prompt: string;
	images: readonly InputImage[];
	model: string;
	size: string;
	quality?: string;
	complexity?: string;
	background?: string;
	outputFormat?: string;
	frameCount?: number;
	frameDurationMs?: number;
	markup?: InputImage;
	modelConfig?: ImageModelConfig;
	headers?: Record<string, string | null>;
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
	onDiagnostic?: DiagnosticWriter;
}
export interface SavedImage { path: string; mimeType: string; bytes: number; kind?: "animation" | "vector" }
export interface GeneratedImageEntryData {
	provider: string;
	model: string;
	prompt: string;
	path: string;
	mimeType: string;
	bytes: number;
	createdAt: number;
	/** Optional for backward-compatible histories; GIF/SVG are file-only outputs. */
	kind?: "animation" | "vector";
}
export interface GenerationOutcome { entries: GeneratedImageEntryData[]; texts: string[] }
