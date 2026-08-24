import { fileURLToPath } from "node:url";
import {
	BorderedLoader,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { pollVideoTask } from "../src/adapters.ts";
import { parseVideoCommand, resolveParameters, resolveVideoRequest, usageText, validateImageCount, validatePrompt, isVideoCommand } from "../src/command.ts";
import { getVideoConfigPath, isProviderConfigured, readVideoConfig } from "../src/config.ts";
import { ensureVideoConfig, runVideoConfigUi } from "../src/config-ui.ts";
import { sanitizeError } from "../src/http.ts";
import { cancelPersistedVideoTask, submitAndPersistVideoTask } from "../src/submission.ts";
import { findStoredTask, listStoredTasks, removeStoredTask, upsertStoredTask } from "../src/task-store.ts";
import type {
	GeneratedVideoEntryData,
	GenerationOutcome,
	InputImage,
	ParsedVideoCommand,
	ResolvedVideoRequest,
	StoredVideoTask,
	VideoGenerationConfig,
	VideoModelConfig,
	VideoProviderConfig,
	VideoTaskType,
} from "../src/types.ts";
import { downloadAndSaveVideo, isGeneratedVideoPath, loadInputImages, parseImagePaths } from "../src/video-files.ts";

const ENTRY_TYPE = "pi-video-generation";
const TEMPLATE_PATH = fileURLToPath(new URL("../model.json", import.meta.url));
const TASK_LABELS: Record<VideoTaskType, string> = {
	t2v: "Text to video",
	i2v: "Image to video — exactly one first frame",
	r2v: "Reference images to video — one or more images",
};

interface GenerationUiError {
	error: string;
}

interface GenerationUiCancelled {
	cancelled: string;
}

type GenerationUiResult = GenerationOutcome | GenerationUiError | GenerationUiCancelled;

class VideoGenerationCancelledError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VideoGenerationCancelledError";
	}
}

export default function videoGenerationExtension(pi: ExtensionAPI) {
	pi.registerEntryRenderer<GeneratedVideoEntryData>(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		const container = new Container();
		if (!data || !isGeneratedVideoPath(data.path)) {
			container.addChild(new Text(theme.fg("error", "Generated video entry has an invalid path"), 0, 0));
			return container;
		}
		container.addChild(
			new Text(
				theme.fg("success", `${data.provider}/${data.model} · ${data.task}`) +
					"\n" +
					theme.fg("dim", `task ${data.taskId}`) +
					"\n" +
					theme.fg("accent", data.path),
				0,
				0,
			),
		);
		return container;
	});

	pi.registerCommand("video", {
		description: "Generate video or manage video-generation configuration and tasks",
		handler: async (args, ctx) => {
			await handleVideoCommand(pi, args, ctx);
		},
	});

	pi.on("input", async (event, ctx) => {
		if (!isVideoCommand(event.text)) return { action: "continue" };
		await runRawVideoRequest(pi, event.text, ctx);
		return { action: "handled" };
	});
}

async function handleVideoCommand(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
	if (!ctx.isIdle()) {
		ctx.ui.notify("Wait for the current agent operation to finish before using /video", "warning");
		return;
	}
	const trimmed = args.trim();
	try {
		if (["--help", "-h", "help"].includes(trimmed)) {
			ctx.ui.notify(usageText(), "info");
			return;
		}
		if (trimmed === "config") {
			await runVideoConfigUi(getAgentDir(), TEMPLATE_PATH, ctx);
			return;
		}
		if (trimmed === "tasks") {
			await showStoredTasks(pi, ctx);
			return;
		}
		if (trimmed.startsWith("resume ")) {
			await resumeStoredTask(pi, trimmed.slice("resume ".length).trim(), ctx);
			return;
		}
		if (ctx.mode !== "tui" || /^(?:t2v|i2v|r2v)(?:\s|$)/u.test(trimmed)) {
			await runRawVideoRequest(pi, `/video ${trimmed}`.trimEnd(), ctx);
			return;
		}
		await runVideoWizard(pi, trimmed, ctx);
	} catch (error) {
		notifyError(ctx, error);
	}
}

async function runVideoWizard(pi: ExtensionAPI, initialPrompt: string, ctx: ExtensionContext): Promise<void> {
	const config = await ensureVideoConfig(getAgentDir(), TEMPLATE_PATH, ctx);
	if (!config || configuredModels(config).length === 0) {
		ctx.ui.notify(`No configured video Provider. Run /video config or edit ${getVideoConfigPath(getAgentDir())}`, "warning");
		return;
	}
	const promptInput = await ctx.ui.editor("Video prompt", initialPrompt);
	if (promptInput === undefined) return notifyCancelled(ctx, "Video generation cancelled");
	let prompt = promptInput.trim();
	if (!prompt) {
		ctx.ui.notify("Video prompt must not be empty", "warning");
		return;
	}
	const tasks = [...new Set(configuredModels(config).map((model) => model.task))];
	const task = await selectTask(tasks, ctx);
	if (!task) return notifyCancelled(ctx, "Video generation cancelled");
	const model = await selectModel(configuredModels(config).filter((item) => item.task === task), ctx);
	if (!model) return notifyCancelled(ctx, "Video generation cancelled");
	const provider = config.providers.find((item) => item.id === model.provider);
	if (!provider || !isProviderConfigured(provider)) throw new Error(`Provider ${model.provider} is not configured`);

	let images: InputImage[] = [];
	if (task !== "t2v") {
		const pathInput = await ctx.ui.editor(
			task === "i2v"
				? "First-frame image — paste or drag exactly one path"
				: `Reference images — one path per line, ${model.inputImages.minimum}-${model.inputImages.maximum}`,
			"",
		);
		if (pathInput === undefined) return notifyCancelled(ctx, "Video generation cancelled");
		images = await loadInputImages(ctx.cwd, parseImagePaths(pathInput), model);
		if (task === "r2v" && model.referenceLabelTemplate) {
			const mapping = images
				.map((image, index) => `${model.referenceLabelTemplate?.replace("{index}", String(index + 1))}: ${image.path}`)
				.join("\n");
			const revised = await ctx.ui.editor(`Reference mapping\n${mapping}\nEdit prompt if needed`, prompt);
			if (revised === undefined) return notifyCancelled(ctx, "Video generation cancelled");
			prompt = revised.trim();
			if (!prompt) throw new Error("Video prompt must not be empty");
		}
	}
	validatePrompt(prompt, model);
	validateImageCount(images.length, model);
	const rawParameters = await selectModelParameters(model, ctx);
	if (!rawParameters) return notifyCancelled(ctx, "Video generation cancelled");
	const parameters = resolveParameters(model.parameters, rawParameters);
	const confirmed = await ctx.ui.confirm(
		"Generate video?",
		[
			`${provider.name}/${model.name}`,
			`Task: ${task}`,
			`Images: ${images.length}`,
			...Object.entries(parameters).map(([key, value]) => `${key}: ${String(value)}`),
		].join("\n"),
	);
	if (!confirmed) return notifyCancelled(ctx, "Video generation cancelled");
	await runVideoGeneration(pi, { provider, model, prompt, images, parameters }, ctx);
}

async function runRawVideoRequest(pi: ExtensionAPI, text: string, ctx: ExtensionContext): Promise<void> {
	if (!ctx.isIdle()) {
		ctx.ui.notify("Wait for the current agent operation to finish before using /video", "warning");
		return;
	}
	let parsed: ParsedVideoCommand;
	try {
		parsed = parseVideoCommand(text);
	} catch (error) {
		notifyError(ctx, error);
		return;
	}
	if (parsed.operation === "help" || (parsed.operation === "generate" && !parsed.prompt)) {
		ctx.ui.notify(usageText(), parsed.operation === "help" ? "info" : "warning");
		return;
	}
	if (parsed.operation === "config") {
		await runVideoConfigUi(getAgentDir(), TEMPLATE_PATH, ctx);
		return;
	}
	if (parsed.operation === "tasks") {
		await showStoredTasks(pi, ctx);
		return;
	}
	if (parsed.operation === "resume") {
		await resumeStoredTask(pi, parsed.taskId ?? "", ctx);
		return;
	}
	try {
		const config = await readVideoConfig(getVideoConfigPath(getAgentDir()));
		if (!config) throw new Error(`Video configuration is missing. Run /video config or edit ${getVideoConfigPath(getAgentDir())}`);
		const model = findRawModel(parsed, config);
		const images = await loadInputImages(ctx.cwd, parsed.images, model);
		const request = resolveVideoRequest(parsed, config, images);
		await runVideoGeneration(pi, request, ctx);
	} catch (error) {
		notifyError(ctx, error);
	}
}

async function runVideoGeneration(pi: ExtensionAPI, request: ResolvedVideoRequest, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		try {
			const signal = AbortSignal.timeout(request.provider.taskTimeoutMs + 120_000);
			const outcome = await submitPollAndSave(request, ctx, signal);
			publishOutcome(pi, ctx, outcome);
		} catch (error) {
			notifyError(ctx, error, [request.provider.apiKey]);
		}
		return;
	}
	const result = await ctx.ui.custom<GenerationUiResult>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, `Generating with ${request.model.id}...`);
		let settled = false;
		const finish = (value: GenerationUiResult) => {
			if (settled) return;
			settled = true;
			done(value);
		};
		loader.onAbort = () => undefined;
		void submitPollAndSave(request, ctx, loader.signal)
			.then((outcome) => finish(outcome))
			.catch((error: unknown) => {
				if (error instanceof VideoGenerationCancelledError) finish({ cancelled: error.message });
				else finish({ error: sanitizeError(error instanceof Error ? error.message : String(error), [request.provider.apiKey]) });
			});
		return loader;
	});
	if ("cancelled" in result) {
		ctx.ui.notify(result.cancelled, "info");
		return;
	}
	if ("error" in result) {
		ctx.ui.notify(result.error, "error");
		return;
	}
	publishOutcome(pi, ctx, result);
}

async function submitPollAndSave(
	request: ResolvedVideoRequest,
	ctx: ExtensionContext,
	signal: AbortSignal,
): Promise<GenerationOutcome> {
	let stored: StoredVideoTask | undefined;
	try {
		stored = await submitAndPersistVideoTask(request, ctx.cwd);
		if (signal.aborted) throw await cancellationError(request.provider, stored, ctx);
		return await pollDownloadAndPublish(request.provider, request.model, stored, request.prompt, ctx, signal);
	} catch (error) {
		if (error instanceof VideoGenerationCancelledError) throw error;
		if (signal.aborted && stored) throw await cancellationError(request.provider, stored, ctx);
		throw error;
	}
}

async function pollDownloadAndPublish(
	provider: VideoProviderConfig,
	model: VideoModelConfig,
	stored: StoredVideoTask,
	prompt: string | undefined,
	ctx: ExtensionContext,
	signal: AbortSignal,
): Promise<GenerationOutcome> {
	try {
		const completed = await pollVideoTask(provider, stored.taskId, {
			signal,
			onStatus: async (status) => {
				if (status === "PENDING" || status === "RUNNING" || status === "UNKNOWN") {
					stored = { ...stored, status };
					await upsertStoredTask(ctx.cwd, stored);
				} else if (status === "FAILED" || status === "CANCELED") {
					await removeStoredTask(ctx.cwd, stored.taskId);
				} else if (status === "SUCCEEDED") {
					stored = { ...stored, status: "UNKNOWN" };
					await upsertStoredTask(ctx.cwd, stored);
				}
			},
		});
		const saved = await downloadAndSaveVideo(completed.videoUrl, {
			cwd: ctx.cwd,
			provider: provider.id,
			model: model.id,
			maxBytes: provider.maxOutputBytes,
			signal,
		});
		await removeStoredTask(ctx.cwd, stored.taskId);
		return {
			entry: {
				provider: provider.id,
				model: model.id,
				task: model.task,
				taskId: stored.taskId,
				prompt,
				parameters: stored.parameters,
				path: saved.path,
				mimeType: saved.mimeType,
				bytes: saved.bytes,
				createdAt: Date.now(),
			},
		};
	} catch (error) {
		if (signal.aborted) throw await cancellationError(provider, stored, ctx);
		throw error;
	}
}

async function cancellationError(
	provider: VideoProviderConfig,
	stored: StoredVideoTask,
	ctx: ExtensionContext,
): Promise<VideoGenerationCancelledError> {
	const result = await cancelPersistedVideoTask(provider, stored, ctx.cwd);
	if (result === "cancelled") {
		return new VideoGenerationCancelledError(`Video task ${stored.taskId} was cancelled before it started`);
	}
	return new VideoGenerationCancelledError(
		`Stopped waiting for ${stored.taskId}. The remote task may still run and incur charges; use /video resume ${stored.taskId}`,
	);
}

async function resumeStoredTask(pi: ExtensionAPI, taskId: string, ctx: ExtensionContext): Promise<void> {
	if (!taskId) throw new Error("Usage: /video resume <task-id>");
	const stored = await findStoredTask(ctx.cwd, taskId);
	if (!stored) throw new Error(`No unfinished video task found: ${taskId}`);
	const config = await readVideoConfig(getVideoConfigPath(getAgentDir()));
	if (!config) throw new Error(`Video configuration is missing; task ${taskId} was kept for later recovery`);
	const provider = config.providers.find((item) => item.id === stored.providerId);
	const model = config.models.find(
		(item) => item.provider === stored.providerId && item.id === stored.modelId && item.task === stored.task,
	);
	if (!provider || !isProviderConfigured(provider) || !model) {
		throw new Error(`Provider/model configuration for task ${taskId} is unavailable; the task record was kept`);
	}
	if (ctx.mode !== "tui") {
		try {
			const outcome = await pollDownloadAndPublish(
				provider,
				model,
				stored,
				undefined,
				ctx,
				AbortSignal.timeout(provider.taskTimeoutMs + 120_000),
			);
			publishOutcome(pi, ctx, outcome);
		} catch (error) {
			notifyError(ctx, error, [provider.apiKey]);
		}
		return;
	}
	const result = await ctx.ui.custom<GenerationUiResult>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, `Resuming video task ${taskId}...`);
		loader.onAbort = () => undefined;
		void pollDownloadAndPublish(provider, model, stored, undefined, ctx, loader.signal)
			.then(done)
			.catch((error: unknown) => {
				if (error instanceof VideoGenerationCancelledError) done({ cancelled: error.message });
				else done({ error: sanitizeError(error instanceof Error ? error.message : String(error), [provider.apiKey]) });
			});
		return loader;
	});
	if ("cancelled" in result) ctx.ui.notify(result.cancelled, "info");
	else if ("error" in result) ctx.ui.notify(result.error, "error");
	else publishOutcome(pi, ctx, result);
}

async function showStoredTasks(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const tasks = await listStoredTasks(ctx.cwd);
	if (tasks.length === 0) {
		ctx.ui.notify("No unfinished video tasks in this project", "info");
		return;
	}
	const labels = tasks.map(
		(task) => `${task.taskId} · ${task.providerId}/${task.modelId} · ${task.status} · ${new Date(task.createdAt).toLocaleString()}`,
	);
	if (ctx.mode !== "tui") {
		ctx.ui.notify(labels.join("\n"), "info");
		return;
	}
	const selected = await ctx.ui.select("Unfinished video tasks — select one to resume", labels);
	const index = selected === undefined ? -1 : labels.indexOf(selected);
	if (index >= 0) await resumeStoredTask(pi, tasks[index].taskId, ctx);
}

async function selectTask(tasks: readonly VideoTaskType[], ctx: ExtensionContext): Promise<VideoTaskType | undefined> {
	if (tasks.length === 1) return tasks[0];
	const labels = tasks.map((task) => TASK_LABELS[task]);
	const selected = await ctx.ui.select("Video task", labels);
	const index = selected === undefined ? -1 : labels.indexOf(selected);
	return index >= 0 ? tasks[index] : undefined;
}

async function selectModel(models: readonly VideoModelConfig[], ctx: ExtensionContext): Promise<VideoModelConfig | undefined> {
	if (models.length === 1) return models[0];
	const labels = models.map((model) => `${model.name} (${model.provider}/${model.id})`);
	const selected = await ctx.ui.select("Video model", labels);
	const index = selected === undefined ? -1 : labels.indexOf(selected);
	return index >= 0 ? models[index] : undefined;
}

async function selectModelParameters(
	model: VideoModelConfig,
	ctx: ExtensionContext,
): Promise<Record<string, string> | undefined> {
	const values: Record<string, string> = {};
	for (const definition of model.parameters) {
		if (definition.hidden) {
			if (definition.type === "select") values[definition.key] = definition.default;
			else if (definition.type === "boolean") values[definition.key] = String(definition.default);
			else if (definition.default !== undefined) values[definition.key] = String(definition.default);
			continue;
		}
		if (definition.type === "select") {
			const options = definition.values.map((value) => (value === definition.default ? `${value} — default` : value));
			const selected = await ctx.ui.select(definition.label, options);
			if (selected === undefined) return undefined;
			values[definition.key] = definition.values[options.indexOf(selected)];
			continue;
		}
		if (definition.type === "boolean") {
			const enabled = definition.default ? "Enabled — default" : "Enabled";
			const disabled = definition.default ? "Disabled" : "Disabled — default";
			const selected = await ctx.ui.select(definition.label, [enabled, disabled]);
			if (selected === undefined) return undefined;
			values[definition.key] = String(selected === enabled);
			continue;
		}
		const step = definition.step ?? 1;
		const count = Math.floor((definition.maximum - definition.minimum) / step) + 1;
		if (count <= 30) {
			const numbers = Array.from({ length: count }, (_, index) => definition.minimum + index * step);
			const options = numbers.map((value) => (value === definition.default ? `${value} — default` : String(value)));
			if (definition.optional) options.unshift("Automatic — omit parameter");
			const selected = await ctx.ui.select(definition.label, options);
			if (selected === undefined) return undefined;
			if (selected !== "Automatic — omit parameter") {
				const optionIndex = options.indexOf(selected) - (definition.optional ? 1 : 0);
				values[definition.key] = String(numbers[optionIndex]);
			}
			continue;
		}
		const entered = await ctx.ui.input(
			definition.label,
			definition.optional
				? `${definition.minimum}-${definition.maximum}; blank = automatic`
				: `${definition.minimum}-${definition.maximum}${definition.default === undefined ? "" : `; default ${definition.default}`}`,
		);
		if (entered === undefined) return undefined;
		if (entered.trim()) values[definition.key] = entered.trim();
		else if (!definition.optional && definition.default !== undefined) values[definition.key] = String(definition.default);
		else if (!definition.optional) throw new Error(`${definition.label} is required`);
	}
	return values;
}

function configuredModels(config: VideoGenerationConfig): VideoModelConfig[] {
	const configuredProviders = new Set(config.providers.filter(isProviderConfigured).map((provider) => provider.id));
	return config.models.filter((model) => configuredProviders.has(model.provider));
}

function findRawModel(parsed: ParsedVideoCommand, config: VideoGenerationConfig): VideoModelConfig {
	let models = configuredModels(config);
	if (parsed.task) models = models.filter((model) => model.task === parsed.task);
	if (parsed.model) models = models.filter((model) => model.id === parsed.model);
	if (models.length === 0) throw new Error("No configured video model matches the requested task/model");
	if (models.length > 1) throw new Error("Multiple video models match; specify task and --model explicitly");
	return models[0];
}

function publishOutcome(pi: ExtensionAPI, ctx: ExtensionContext, outcome: GenerationOutcome): void {
	pi.appendEntry(ENTRY_TYPE, outcome.entry);
	ctx.ui.notify(`Saved video: ${outcome.entry.path}`, "info");
}

function notifyCancelled(ctx: ExtensionContext, message: string): void {
	ctx.ui.notify(message, "info");
}

function notifyError(ctx: ExtensionContext, error: unknown, secrets: readonly string[] = []): void {
	ctx.ui.notify(sanitizeError(error instanceof Error ? error.message : String(error), secrets), "error");
}
