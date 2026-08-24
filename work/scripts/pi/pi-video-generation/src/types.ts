export type VideoTaskType = "t2v" | "i2v" | "r2v";
export type AdapterId = "dashscope";

export interface SelectParameterDefinition {
	key: string;
	label: string;
	type: "select";
	values: string[];
	default: string;
	hidden?: boolean;
}

export interface IntegerParameterDefinition {
	key: string;
	label: string;
	type: "integer";
	minimum: number;
	maximum: number;
	step?: number;
	default?: number;
	optional?: boolean;
	hidden?: boolean;
}

export interface BooleanParameterDefinition {
	key: string;
	label: string;
	type: "boolean";
	default: boolean;
	hidden?: boolean;
}

export type ParameterDefinition =
	| SelectParameterDefinition
	| IntegerParameterDefinition
	| BooleanParameterDefinition;

export interface InputImageLimits {
	minimum: number;
	maximum: number;
	maxBytes: number;
	mimeTypes: string[];
	minWidth?: number;
	minHeight?: number;
	minShortSide?: number;
	minAspectRatio?: number;
	maxAspectRatio?: number;
}

export interface PromptLimits {
	maxChars: number;
	maxCjkChars?: number;
}

export interface VideoProviderConfig {
	id: string;
	name: string;
	adapter: AdapterId;
	baseUrl: string;
	apiKey: string;
	pollIntervalMs: number;
	taskTimeoutMs: number;
	maxOutputBytes: number;
}

export interface VideoModelConfig {
	id: string;
	name: string;
	provider: string;
	task: VideoTaskType;
	prompt: PromptLimits;
	inputImages: InputImageLimits;
	parameters: ParameterDefinition[];
	referenceLabelTemplate?: string;
}

export interface VideoGenerationConfig {
	version: 1;
	providers: VideoProviderConfig[];
	models: VideoModelConfig[];
}

export interface InputImage {
	path: string;
	data: string;
	mimeType: string;
	bytes: number;
	width: number;
	height: number;
}

export interface ParsedVideoCommand {
	operation: "generate" | "config" | "tasks" | "resume" | "help";
	task?: VideoTaskType;
	model?: string;
	prompt: string;
	images: string[];
	parameters: Record<string, string>;
	taskId?: string;
}

export interface ResolvedVideoRequest {
	provider: VideoProviderConfig;
	model: VideoModelConfig;
	prompt: string;
	images: InputImage[];
	parameters: Record<string, string | number | boolean>;
}

export type RemoteTaskStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "UNKNOWN";

export interface SubmittedTask {
	taskId: string;
	requestId?: string;
	status: RemoteTaskStatus;
}

export interface CompletedTask {
	taskId: string;
	requestId?: string;
	videoUrl: string;
}

export interface StoredVideoTask {
	taskId: string;
	providerId: string;
	modelId: string;
	task: VideoTaskType;
	createdAt: number;
	status: "PENDING" | "RUNNING" | "UNKNOWN";
	parameters: Record<string, string | number | boolean>;
}

export interface SavedVideo {
	path: string;
	mimeType: "video/mp4";
	bytes: number;
}

export interface GeneratedVideoEntryData {
	provider: string;
	model: string;
	task: VideoTaskType;
	taskId: string;
	prompt?: string;
	parameters: Record<string, string | number | boolean>;
	path: string;
	mimeType: "video/mp4";
	bytes: number;
	createdAt: number;
}

export interface GenerationOutcome {
	entry: GeneratedVideoEntryData;
}
