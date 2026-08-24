import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, decodeKittyPrintable, truncateToWidth } from "@earendil-works/pi-tui";
import {
	getVideoConfigPath,
	mergeEditedConfig,
	readTemplateConfig,
	readVideoConfig,
	sanitizeConfigForEditing,
	writeVideoConfig,
} from "./config.ts";
import type { VideoGenerationConfig, VideoProviderConfig } from "./types.ts";

export async function ensureVideoConfig(
	agentDir: string,
	templatePath: string,
	ctx: ExtensionContext,
): Promise<VideoGenerationConfig | undefined> {
	const configPath = getVideoConfigPath(agentDir);
	const existing = await readVideoConfig(configPath);
	if (existing?.providers.some((provider) => provider.apiKey && provider.baseUrl)) return existing;
	if (ctx.mode !== "tui") return existing;
	ctx.ui.notify("Video generation needs an API Key and Base URL before first use", "warning");
	return runMinimumSetup(agentDir, templatePath, existing, ctx);
}

export async function runVideoConfigUi(
	agentDir: string,
	templatePath: string,
	ctx: ExtensionContext,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`Edit video config at ${getVideoConfigPath(agentDir)}`, "info");
		return;
	}
	const configPath = getVideoConfigPath(agentDir);
	const existing = await readVideoConfig(configPath);
	if (!existing) {
		const created = await runMinimumSetup(agentDir, templatePath, undefined, ctx);
		if (created) ctx.ui.notify(`Video config created: ${configPath}`, "info");
		return;
	}
	const action = await ctx.ui.select("Video configuration", [
		"Edit providers and models JSON",
		"Set or replace a Provider API Key",
		"Set or replace a Provider Base URL",
		"Show active config path",
	]);
	if (!action) return;
	if (action === "Show active config path") {
		ctx.ui.notify(configPath, "info");
		return;
	}
	if (action === "Edit providers and models JSON") {
		const edited = await ctx.ui.editor(
			`Video model config — ${configPath}\nExisting API keys use a keep-existing placeholder`,
			sanitizeConfigForEditing(existing),
		);
		if (edited === undefined) return;
		const merged = mergeEditedConfig(edited, existing);
		await writeVideoConfig(configPath, merged);
		ctx.ui.notify("Video configuration saved", "info");
		return;
	}
	const provider = await selectProvider(existing.providers, ctx);
	if (!provider) return;
	if (action === "Set or replace a Provider API Key") {
		const apiKey = await promptSecret(ctx, `API Key for ${provider.name}`);
		if (apiKey === undefined) return;
		if (!apiKey.trim()) throw new Error("API Key must not be empty");
		await replaceProvider(configPath, existing, provider.id, { apiKey: apiKey.trim() });
		ctx.ui.notify(`API Key updated for ${provider.name}`, "info");
		return;
	}
	const baseUrl = await ctx.ui.editor(`Base URL for ${provider.name}`, provider.baseUrl);
	if (baseUrl === undefined) return;
	if (!baseUrl.trim()) throw new Error("Base URL must not be empty");
	await replaceProvider(configPath, existing, provider.id, { baseUrl: baseUrl.trim() });
	ctx.ui.notify(`Base URL updated for ${provider.name}`, "info");
}

async function runMinimumSetup(
	agentDir: string,
	templatePath: string,
	existing: VideoGenerationConfig | undefined,
	ctx: ExtensionContext,
): Promise<VideoGenerationConfig | undefined> {
	const template = existing ?? (await readTemplateConfig(templatePath));
	const provider = await selectProvider(template.providers, ctx);
	if (!provider) return undefined;
	const apiKey = await promptSecret(ctx, `API Key for ${provider.name}`);
	if (apiKey === undefined) return undefined;
	if (!apiKey.trim()) throw new Error("API Key must not be empty");
	const baseUrl = await ctx.ui.editor(`Base URL for ${provider.name}`, provider.baseUrl);
	if (baseUrl === undefined) return undefined;
	if (!baseUrl.trim()) throw new Error("Base URL must not be empty");
	const configured: VideoGenerationConfig = {
		...template,
		providers: template.providers.map((item) =>
			item.id === provider.id ? { ...item, apiKey: apiKey.trim(), baseUrl: baseUrl.trim() } : item,
		),
	};
	await writeVideoConfig(getVideoConfigPath(agentDir), configured);
	ctx.ui.notify("Minimum video configuration saved", "info");
	return configured;
}

async function replaceProvider(
	configPath: string,
	config: VideoGenerationConfig,
	providerId: string,
	patch: Partial<Pick<VideoProviderConfig, "apiKey" | "baseUrl">>,
): Promise<void> {
	await writeVideoConfig(configPath, {
		...config,
		providers: config.providers.map((provider) =>
			provider.id === providerId ? { ...provider, ...patch } : provider,
		),
	});
}

async function selectProvider(
	providers: readonly VideoProviderConfig[],
	ctx: ExtensionContext,
): Promise<VideoProviderConfig | undefined> {
	if (providers.length === 1) return providers[0];
	const labels = providers.map((provider) => `${provider.name} (${provider.id})`);
	const selected = await ctx.ui.select("Video Provider", labels);
	const index = selected === undefined ? -1 : labels.indexOf(selected);
	return index >= 0 ? providers[index] : undefined;
}

async function promptSecret(ctx: ExtensionContext, title: string): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		let value = "";
		let pasteBuffer = "";
		let pasting = false;
		return {
			render(width: number): string[] {
				const state = value ? theme.fg("accent", "[secret entered]") : theme.fg("dim", "[paste or type secret]");
				return [
					truncateToWidth(theme.fg("accent", title), width),
					truncateToWidth(`> ${state}${CURSOR_MARKER}`, width),
					truncateToWidth(theme.fg("dim", "Enter save • Esc cancel • input is never displayed"), width),
				];
			},
			invalidate() {},
			handleInput(data: string): void {
				if (data.includes("\x1b[200~")) {
					pasting = true;
					pasteBuffer = "";
					data = data.replace("\x1b[200~", "");
				}
				if (pasting) {
					pasteBuffer += data;
					const end = pasteBuffer.indexOf("\x1b[201~");
					if (end >= 0) {
						value += pasteBuffer.slice(0, end).replace(/[\r\n\t]/gu, "");
						pasting = false;
						pasteBuffer = "";
						tui.requestRender();
					}
					return;
				}
				if (keybindings.matches(data, "tui.select.cancel")) {
					done(undefined);
					return;
				}
				if (keybindings.matches(data, "tui.input.submit") || data === "\n") {
					done(value);
					return;
				}
				if (keybindings.matches(data, "tui.editor.deleteCharBackward")) {
					value = value.slice(0, -1);
					tui.requestRender();
					return;
				}
				const printable = decodeKittyPrintable(data) ?? data;
				if (![...printable].some((character) => {
					const code = character.charCodeAt(0);
					return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
				})) {
					value += printable;
					tui.requestRender();
				}
			},
		};
	});
}
