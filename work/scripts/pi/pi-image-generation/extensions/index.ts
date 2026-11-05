import type { ImageContent } from "@earendil-works/pi-ai";
import { BorderedLoader, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { inferModelForSingleAccount, isImageCommand, parseImageCommand, resolveImageCommand, usageText } from "../src/command.ts";
import { loadInputImages, parseReferenceImagePaths, validateInputImages } from "../src/image-files.ts";
import { sanitizeError } from "../src/http.ts";
import { readImageConfig, type ImageConfig, type ImageProviderConfig } from "../src/model-config.ts";
import { generateAndSave } from "../src/runtime.ts";
import { formatImageLink } from "../src/preview-link.ts";
import { getAccountStatus, resolveImageAuth } from "../src/credentials.ts";
import { runAccountSettings } from "../src/account-settings.ts";
import { selectItem, selectParameters } from "../src/tui-options.ts";
import { createResultView } from "../src/result-view.ts";
import type { GeneratedImageEntryData, GenerationOutcome, ResolvedImageCommand } from "../src/types.ts";

const ENTRY_TYPE = "pi-image-generation";
// A reload must not bypass a still-running request. No timer may release this execution lock.
const TASK_STATE_KEY = Symbol.for("pi-image-generation.task-state");
const processScope = globalThis as typeof globalThis & { [TASK_STATE_KEY]?: { busy: boolean; cancelling: boolean } };
const taskState = processScope[TASK_STATE_KEY] ??= { busy: false, cancelling: false };
export default async function imageGenerationExtension(pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let config: ImageConfig | undefined;
	let configError: string | undefined;
	try { config = await readImageConfig(); }
	catch (error) { configError = (error as Error).message; }

	pi.registerEntryRenderer<GeneratedImageEntryData>(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		const model = config?.models.find((model) => model.id === data?.model && model.provider === data?.provider);
		return createResultView(data, theme, model?.name);
	});

	async function handle(args: string, images: readonly ImageContent[], ctx: ExtensionContext, wizard: boolean): Promise<void> {
		if (taskState.busy || !ctx.isIdle()) {
			ctx.ui.notify(taskState.cancelling
				? "取消后的底层操作尚未结束。为避免重复请求，暂不能生成；若长期无响应，请退出 Pi，确认服务端状态后重启。/reload 不会解除此保护。"
				: "当前操作尚未结束，请稍后再使用 /image", "warning");
			return;
		}
		taskState.busy = true;
		try {
			if (["--help", "-h"].includes(args.trim())) { ctx.ui.notify(usageText(config), "info"); return; }
			if (args.trim() === "--settings") { await runAccountSettings(ctx, config, agentDir); return; }
			if (!config) throw new Error(configError ?? "Image config is unavailable; fix models.jsonc and /reload");
			if (wizard) await runImageWizard(pi, args, ctx, config, agentDir);
			else await runRawImageRequest(pi, `/image ${args}`.trimEnd(), images, ctx, config, agentDir);
		} catch (error) { ctx.ui.notify(sanitizeError(error instanceof Error ? error.message : "图片生成失败"), "error"); }
		finally { taskState.cancelling = false; taskState.busy = false; }
	}
	pi.registerCommand("image", {
		description: "生成或编辑图片，使用 --settings 管理账户",
		handler: (args, ctx) => handle(args, [], ctx, ctx.mode === "tui"),
	});
	pi.on("input", async (event, ctx) => {
		if (!isImageCommand(event.text)) return { action: "continue" };
		await handle(event.text.slice("/image".length).trim(), event.images ?? [], ctx, false);
		return { action: "handled" };
	});
}

async function runImageWizard(pi: ExtensionAPI, args: string, ctx: ExtensionContext, config: ImageConfig, agentDir: string): Promise<void> {
	let available = await getAvailableProviders(ctx, config, agentDir);
	if (!available.length) {
		ctx.ui.notify("尚未配置图片账户，请先完成账户设置", "warning");
		await runAccountSettings(ctx, config, agentDir);
		available = await getAvailableProviders(ctx, config, agentDir);
		if (!available.length) return;
	}
	const task = await selectItem(ctx, "图片任务", [
		{ key: "generate" as const, name: "生成新图片" },
		{ key: "edit" as const, name: "编辑参考图" },
	]);
	if (!task) return notifyCancelled(ctx);
	const prompt = (await ctx.ui.editor(task.key === "edit" ? "描述需要修改的内容" : "描述要生成的图片", args.trim()))?.trim();
	if (prompt === undefined) return notifyCancelled(ctx);
	if (!prompt) throw new Error("图片提示词不能为空");
	const candidates = config.models.filter((model) => model.enabled !== false && available.some((p) => p.id === model.provider) && model.tasks.includes(task.key));
	if (!candidates.length) throw new Error("当前没有支持此任务的可用模型");
	const provider = await selectItem(ctx, "图片账户", available.filter((p) => candidates.some((m) => m.provider === p.id)).map((p) => ({ ...p, key: p.id })));
	if (!provider) return notifyCancelled(ctx);
	const model = await selectItem(ctx, "图片模型", candidates.filter((m) => m.provider === provider.id), provider.defaultModel);
	if (!model) return notifyCancelled(ctx);
	let inputImages: ImageContent[] = [];
	if (task.key === "edit") {
		const paths = await ctx.ui.editor("参考图路径（每行一个，可拖入文件）", "");
		if (paths === undefined) return notifyCancelled(ctx);
		const references = parseReferenceImagePaths(paths);
		if (!references.length) throw new Error("编辑至少需要一张参考图");
		inputImages = (await loadInputImages(ctx.cwd, references, model.inputImages)).map((image) => ({ type: "image", ...image }));
	}
	const parameters = await selectParameters(ctx, model, task.key);
	if (!parameters) return notifyCancelled(ctx);
	const command = resolveImageCommand({ prompt, ...parameters, help: false }, model, inputImages.length, config);
	await runImageGeneration(pi, command, inputImages, ctx, config, agentDir);
}

async function runRawImageRequest(pi: ExtensionAPI, text: string, images: readonly ImageContent[], ctx: ExtensionContext, config: ImageConfig, agentDir: string): Promise<void> {
	const parsed = parseImageCommand(text, config);
	if (parsed.help || !parsed.prompt) { ctx.ui.notify(usageText(config), parsed.help ? "info" : "warning"); return; }
	let model = parsed.modelKey ? config.models.find((m) => m.key === parsed.modelKey) : undefined;
	// Explicit selectors can fail parameter validation even before account-status lookup.
	let command = model ? resolveImageCommand(parsed, model, images.length, config) : undefined;
	const available = await getAvailableProviders(ctx, config, agentDir);
	if (!model) model = inferModelForSingleAccount(config, available.map((p) => p.id));
	if (!model) throw new Error(available.length ? "Multiple image accounts configured; specify a model key from /image --help" : "No image account configured");
	if (!available.some((p) => p.id === model.provider)) throw new Error("Selected image account is not configured");
	command ??= resolveImageCommand(parsed, model, images.length, config);
	validateInputImages(images, model.inputImages);
	await runImageGeneration(pi, command, images, ctx, config, agentDir);
}

async function runImageGeneration(pi: ExtensionAPI, command: ResolvedImageCommand, images: readonly ImageContent[], ctx: ExtensionContext, config: ImageConfig, agentDir: string): Promise<void> {
	const generate = (signal: AbortSignal) => generateAndSave(config, command, images, ctx.cwd,
		() => resolveImageAuth(command.providerConfig, agentDir, ctx.modelRegistry), signal);
	if (ctx.mode !== "tui") {
		await publishOutcome(pi, ctx, await generate(AbortSignal.timeout(300_000)));
		return;
	}
	let pending: Promise<void> | undefined;
	let settled = false;
	const teardown = new AbortController();
	try {
		const result = await ctx.ui.custom<GenerationOutcome | { error: string } | null>((tui, theme, _keybindings, done) => {
			const loader = new BorderedLoader(tui, theme, `${images.length ? "正在编辑" : "正在生成"}：${command.modelConfig.name}`);
			const signal = AbortSignal.any([loader.signal, teardown.signal]);
			const finish = (value: GenerationOutcome | { error: string } | null) => {
				if (settled) return;
				settled = true; done(value);
			};
			loader.onAbort = () => {
				if (settled) return;
				taskState.cancelling = true;
				finish(null);
			};
			pending = generate(signal).then((outcome) => {
				if (signal.aborted) finish(null);
				else finish(outcome);
			}).catch((error: unknown) => {
				if (signal.aborted) finish(null);
				else finish({ error: sanitizeError(error instanceof Error ? error.message : "图片生成失败") });
			});
			return loader;
		});
		if (!result) {
			ctx.ui.notify("已取消图片生成，正在等待底层操作结束；期间不会接受新任务。", "info");
			return;
		}
		if ("error" in result) throw new Error(result.error);
		await publishOutcome(pi, ctx, result);
	} finally {
		// UI completion/teardown is not execution completion, including a rejected custom UI.
		// Never release the caller's lock while HTTP/filesystem work can still run.
		if (!settled && pending) taskState.cancelling = true;
		settled = true;
		teardown.abort();
		await pending;
	}
}

async function getAvailableProviders(ctx: ExtensionContext, config: ImageConfig, agentDir: string): Promise<ImageProviderConfig[]> {
	const statuses = await Promise.all(config.providers.map((provider) => getAccountStatus(provider, agentDir, ctx.modelRegistry)));
	for (const [index, status] of statuses.entries()) {
		if (status.error) ctx.ui.notify(`${config.providers[index].name}: ${status.error}`, "warning");
	}
	return config.providers.filter((_provider, index) => statuses[index].configured);
}
function notifyCancelled(ctx: ExtensionContext): void { ctx.ui.notify("已取消图片生成", "info"); }
export async function publishOutcome(pi: ExtensionAPI, ctx: ExtensionContext, outcome: GenerationOutcome): Promise<void> {
	for (const entry of outcome.entries) pi.appendEntry(ENTRY_TYPE, entry);
	// TUI already renders a durable link per image. Non-TUI consumers need plain URLs.
	const links = ctx.mode !== "tui" && outcome.entries.length
		? `\n\nOpen original image(s) (open manually):\n${outcome.entries.map((entry) => formatImageLink(entry.path)).join("\n")}` : "";
	ctx.ui.notify(ctx.mode === "tui" ? `已保存 ${outcome.entries.length} 张图片` : `Saved ${outcome.entries.length} image(s):\n${outcome.entries.map((entry) => entry.path).join("\n")}${links}`, "info");
}
