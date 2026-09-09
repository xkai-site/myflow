import type { ImageModelConfig, ImageProviderConfig } from "./model-config.ts";
import type { DiagnosticWriter } from "./diagnostics.ts";

export interface ParsedImageCommand {
	modelKey?: string;
	prompt: string;
	size?: string;
	quality?: string;
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
	headers?: Record<string, string | null>;
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
	onDiagnostic?: DiagnosticWriter;
}
export interface SavedImage { path: string; mimeType: string; bytes: number }
export interface GeneratedImageEntryData {
	provider: string;
	model: string;
	prompt: string;
	path: string;
	mimeType: string;
	bytes: number;
	createdAt: number;
	galleryPath?: string;
}
export interface GenerationOutcome { entries: GeneratedImageEntryData[]; texts: string[] }
