export type ImageProviderChoice = "openai" | "wan" | "wan-pro";
export type OpenAIImageQuality = "auto" | "low" | "medium" | "high";

export interface ParsedImageCommand {
	provider?: ImageProviderChoice;
	prompt: string;
	size?: string;
	quality?: OpenAIImageQuality;
	help: boolean;
}

export interface ResolvedImageCommand extends Omit<ParsedImageCommand, "provider" | "size"> {
	provider: ImageProviderChoice;
	size: string;
	model: "gpt-image-2" | "wan2.7-image" | "wan2.7-image-pro";
}

export interface InputImage {
	data: string;
	mimeType: string;
}

export interface GeneratedImage {
	data: string;
	mimeType: string;
}

export interface ImageTransportResult {
	images: GeneratedImage[];
	texts: string[];
	responseId?: string;
}

export interface ImageTransportOptions {
	apiKey: string;
	baseUrl: string;
	prompt: string;
	images: readonly InputImage[];
	model: string;
	size: string;
	quality?: OpenAIImageQuality;
	headers?: Record<string, string | null>;
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
}

export interface SavedImage {
	path: string;
	mimeType: string;
	bytes: number;
}

export interface GeneratedImageEntryData {
	provider: ImageProviderChoice;
	model: string;
	prompt: string;
	path: string;
	mimeType: string;
	bytes: number;
	createdAt: number;
}

export interface GenerationOutcome {
	entries: GeneratedImageEntryData[];
	texts: string[];
}
