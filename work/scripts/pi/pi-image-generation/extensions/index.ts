import { readFileSync } from "node:fs";
import path from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { BorderedLoader, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Image, Spacer, Text } from "@earendil-works/pi-tui";
import { inferModelForSingleAccount, isImageCommand, parseImageCommand, resolveImageCommand, usageText } from "../src/command.ts";
import { detectImage, isGeneratedImagePath, loadInputImages, parseReferenceImagePaths, validateInputImages } from "../src/image-files.ts";
import { sanitizeError } from "../src/http.ts";
import { readImageConfig, sizeForTask, type ChoicePolicy, type ImageConfig, type ImageModelConfig, type ImageProviderConfig } from "../src/model-config.ts";
import { generateAndSave } from "../src/runtime.ts";
import { formatImageLink } from "../src/preview-link.ts";
import { getAccountStatus, resolveImageAuth } from "../src/credentials.ts";
import { runAccountSettings } from "../src/account-settings.ts";
import type { GeneratedImageEntryData, GenerationOutcome, ResolvedImageCommand } from "../src/types.ts";

const ENTRY_TYPE = "pi-image-generation";
export default async function imageGenerationExtension(pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let config: ImageConfig | undefined;
	let configError: string | undefined;
	try { config = await readImageConfig(); }
	catch (error) { configError = (error as Error).message; }
	let busy = false;

	pi.registerEntryRenderer<GeneratedImageEntryData>(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		const container = new Container();
		if (!data || typeof data.path !== "string" || !path.isAbsolute(data.path) || !isGeneratedImagePath(data.path)) {
			container.addChild(new Text(theme.fg("error", "Generated image entry has an invalid path"), 0, 0));
			return container;
		}
		container.addChild(new Text(theme.fg("success", `${data.provider}/${data.model}`) + "\n" + theme.fg("dim", data.path), 0, 0));
		// Derive the original-image link from saved metadata, including historical entries.
		// Resolve theme/capabilities on every render, including after /reload or a theme change.
		container.addChild({
			render: (width) => new Text(`Open original image (Ctrl+click in supported terminals; otherwise copy URL):\n${formatImageLink(data.path, theme)}`, 0, 0).render(width),
			invalidate() {},
		});
		try {
			const bytes = readFileSync(data.path);
			const detected = detectImage(bytes);
			if (!detected || detected.mimeType !== data.mimeType) throw new Error("stored image format mismatch");
			container.addChild(new Spacer(1));
			container.addChild(new Image(bytes.toString("base64"), detected.mimeType,
				{ fallbackColor: (text) => theme.fg("dim", text) },
				{ filename: path.basename(data.path), maxWidthCells: 72, maxHeightCells: 28 }));
		} catch (error) {
			container.addChild(new Text(theme.fg("warning", `Image preview unavailable: ${sanitizeError((error as Error).message)}`), 0, 0));
		}
		return container;
	});

	async function handle(args: string, images: readonly ImageContent[], ctx: ExtensionContext, wizard: boolean): Promise<void> {
		if (busy || !ctx.isIdle()) {
			ctx.ui.notify("Wait for the current operation to finish before using /image", "warning");
			return;
		}
		busy = true;
		try {
			if (["--help", "-h"].includes(args.trim())) { ctx.ui.notify(usageText(config), "info"); return; }
			if (args.trim() === "--settings") { await runAccountSettings(ctx, config, agentDir); return; }
			if (wizard && !args.trim()) {
				const action = await ctx.ui.select("Image", ["Generate / edit image", "Account settings"]);
				if (action === undefined) return;
				if (action === "Account settings") { await runAccountSettings(ctx, config, agentDir); return; }
			}
			if (!config) throw new Error(configError ?? "Image config is unavailable; fix models.jsonc and /reload");
			if (wizard) await runImageWizard(pi, args, ctx, config, agentDir);
			else await runRawImageRequest(pi, `/image ${args}`.trimEnd(), images, ctx, config, agentDir);
		} catch (error) { ctx.ui.notify(sanitizeError((error as Error).message), "error"); }
		finally { busy = false; }
	}
	pi.registerCommand("image", {
		description: "Generate/edit images or manage image accounts (--settings)",
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
		ctx.ui.notify("No image account configured. Set up an account to continue.", "warning");
		await runAccountSettings(ctx, config, agentDir);
		available = await getAvailableProviders(ctx, config, agentDir);
		if (!available.length) return;
	}
	const prompt = (await ctx.ui.editor("Image prompt", args.trim()))?.trim();
	if (prompt === undefined) return notifyCancelled(ctx);
	if (!prompt) throw new Error("Image prompt must not be empty");
	const task = await selectItem(ctx, "Image task", [
		{ key: "generate" as const, name: "Generate a new image" },
		{ key: "edit" as const, name: "Edit using reference image files" },
	]);
	if (!task) return notifyCancelled(ctx);
	const candidates = config.models.filter((model) => model.enabled !== false && available.some((p) => p.id === model.provider) && model.tasks.includes(task.key));
	if (!candidates.length) throw new Error("No configured model supports this task");
	const provider = await selectItem(ctx, "Image account", available.filter((p) => candidates.some((m) => m.provider === p.id)).map((p) => ({ ...p, key: p.id })));
	if (!provider) return notifyCancelled(ctx);
	const model = await selectItem(ctx, "Image model", candidates.filter((m) => m.provider === provider.id));
	if (!model) return notifyCancelled(ctx);
	let inputImages: ImageContent[] = [];
	if (task.key === "edit") {
		const paths = await ctx.ui.editor("Reference image files — one path per line; drag files here", "");
		if (paths === undefined) return notifyCancelled(ctx);
		const references = parseReferenceImagePaths(paths);
		if (!references.length) throw new Error("Editing requires at least one reference image");
		inputImages = (await loadInputImages(ctx.cwd, references, model.inputImages)).map((image) => ({ type: "image", ...image }));
	}
	const size = await selectPolicy(ctx, "Image size", sizeForTask(model, task.key));
	if (size === undefined) return notifyCancelled(ctx);
	const quality = model.quality ? await selectPolicy(ctx, "Image quality", model.quality) : undefined;
	if (model.quality && quality === undefined) return notifyCancelled(ctx);
	const command = resolveImageCommand({ prompt, size, quality, help: false }, model, inputImages.length, config);
	await runImageGeneration(pi, command, inputImages, ctx, config, agentDir);
}

async function runRawImageRequest(pi: ExtensionAPI, text: string, images: readonly ImageContent[], ctx: ExtensionContext, config: ImageConfig, agentDir: string): Promise<void> {
	const parsed = parseImageCommand(text, config);
	if (parsed.help || !parsed.prompt) { ctx.ui.notify(usageText(config), parsed.help ? "info" : "warning"); return; }
	const available = await getAvailableProviders(ctx, config, agentDir);
	let model: ImageModelConfig | undefined;
	if (parsed.modelKey) model = config.models.find((m) => m.key === parsed.modelKey);
	else model = inferModelForSingleAccount(config, available.map((p) => p.id));
	if (!model) throw new Error(available.length ? "Multiple image accounts configured; specify a model key from /image --help" : "No image account configured");
	if (!available.some((p) => p.id === model.provider)) throw new Error("Selected image account is not configured");
	const command = resolveImageCommand(parsed, model, images.length, config);
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
	const result = await ctx.ui.custom<GenerationOutcome | { error: string } | null>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, `Generating with ${command.model}...`);
		let settled = false;
		const finish = (value: GenerationOutcome | { error: string } | null) => {
			if (settled) return;
			settled = true; done(value);
		};
		loader.onAbort = () => finish(null);
		void generate(loader.signal).then(finish).catch((error: unknown) => {
			if (loader.signal.aborted) finish(null);
			else finish({ error: sanitizeError((error as Error).message) });
		});
		return loader;
	});
	if (!result) return notifyCancelled(ctx);
	if ("error" in result) throw new Error(result.error);
	await publishOutcome(pi, ctx, result);
}

async function getAvailableProviders(ctx: ExtensionContext, config: ImageConfig, agentDir: string): Promise<ImageProviderConfig[]> {
	const statuses = await Promise.all(config.providers.map((provider) => getAccountStatus(provider, agentDir, ctx.modelRegistry)));
	for (const [index, status] of statuses.entries()) {
		if (status.error) ctx.ui.notify(`${config.providers[index].name}: ${status.error}`, "warning");
	}
	return config.providers.filter((_provider, index) => statuses[index].configured);
}
export async function selectItem<T extends { key: string; name: string }>(ctx: Pick<ExtensionContext, "ui">, title: string, items: T[]): Promise<T | undefined> {
	if (items.length === 1) return items[0];
	const labels = items.map((item) => `${item.name} (${item.key})`);
	const choice = await ctx.ui.select(title, labels);
	return choice === undefined ? undefined : items[labels.indexOf(choice)];
}
async function selectPolicy(ctx: ExtensionContext, title: string, policy: ChoicePolicy): Promise<string | undefined> {
	const options = [...policy.options].sort((a, b) => Number(b.value === policy.default) - Number(a.value === policy.default));
	return (await selectItem(ctx, title, options.map((o) => ({ key: o.value, name: o.label }))))?.key;
}
function notifyCancelled(ctx: ExtensionContext): void { ctx.ui.notify("Image generation cancelled", "info"); }
export async function publishOutcome(pi: ExtensionAPI, ctx: ExtensionContext, outcome: GenerationOutcome): Promise<void> {
	for (const entry of outcome.entries) pi.appendEntry(ENTRY_TYPE, entry);
	// TUI already renders a durable link per image. Non-TUI consumers need plain URLs.
	const links = ctx.mode !== "tui" && outcome.entries.length
		? `\n\nOpen original image(s) (open manually):\n${outcome.entries.map((entry) => formatImageLink(entry.path)).join("\n")}` : "";
	ctx.ui.notify(`Saved ${outcome.entries.length} image(s):\n${outcome.entries.map((entry) => entry.path).join("\n")}${links}`, "info");
}
