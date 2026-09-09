import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deleteImageKey, getAccountStatus, getCredentialPath, readSavedKey, saveImageKey } from "./credentials.ts";
import { MODEL_CONFIG_PATH, type ImageConfig } from "./model-config.ts";
import { promptSecret } from "./secret-input.ts";

export async function runAccountSettings(ctx: ExtensionContext, config: ImageConfig | undefined, agentDir: string): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Open /image --settings in TUI to save a Token Plan CN Key, or set the environment variable declared in models.jsonc. Never pass a Key as a command argument.", "info");
		return;
	}
	if (!config) {
		ctx.ui.notify(`Restore valid model configuration first: ${MODEL_CONFIG_PATH}\nThen /reload. Existing account credentials are unchanged.`, "warning");
		return;
	}
	const statuses = await Promise.all(config.providers.map((p) => getAccountStatus(p, agentDir, ctx.modelRegistry)));
	const labels = config.providers.map((p, i) => `${p.name} (${p.id}) — ${statuses[i].source}`);
	const showPaths = "Show config and credential paths";
	const selected = await ctx.ui.select("Image account settings", [...labels, showPaths]);
	if (selected === undefined) return;
	if (selected === showPaths) {
		ctx.ui.notify(`Models: ${MODEL_CONFIG_PATH}\nCredentials: ${getCredentialPath(agentDir)}\nCredentials are local plaintext protected by file permissions, not encrypted.`, "info");
		return;
	}
	const index = labels.indexOf(selected);
	const provider = config.providers[index];
	if (!provider) return;
	if (provider.auth.type === "provider") {
		ctx.ui.notify(`OpenAI uses pi-codex-official.\n${statuses[index].source}\nInstall the extension and use /login → Codex local credentials. Refresh expired credentials through Codex / CC Switch, then retry. Image generation does not log in or refresh tokens independently.`, "info");
		return;
	}
	if (statuses[index].error) ctx.ui.notify(statuses[index].error!, "warning");
	const action = await ctx.ui.select("Qwen Token Plan CN — saved Key overrides existing Pi credentials", [
		"Set or replace image API Key", "Remove saved image API Key", "Keep current account",
	]);
	if (!action || action === "Keep current account") return;
	if (action === "Set or replace image API Key") {
		const key = await promptSecret(ctx, "Qwen Token Plan CN API Key (not a regular DashScope Key)");
		if (key === undefined) return;
		const confirmed = await ctx.ui.confirm("Save image API Key?", `Current source: ${statuses[index].source}\nSave locally at ${getCredentialPath(agentDir)}. The file is not encrypted. This affects images only; no network validation will run.`);
		if (!confirmed) return;
		await saveImageKey(agentDir, provider.id, key);
		ctx.ui.notify("Image API Key saved; ready for the next /image request. Remote validity has not been tested.", "info");
	} else if (action === "Remove saved image API Key") {
		if (!await readSavedKey(agentDir, provider.id)) { ctx.ui.notify("No saved image API Key to remove; existing Provider credentials are unchanged.", "info"); return; }
		const fallback = await getAccountStatus(provider, agentDir, ctx.modelRegistry, process.env, true);
		if (!await ctx.ui.confirm("Remove saved image API Key?", `After removal: ${fallback.source}. Existing Pi / Codex credentials will not be deleted.`)) return;
		await deleteImageKey(agentDir, provider.id);
		ctx.ui.notify(`Saved image API Key removed. Current source: ${(await getAccountStatus(provider, agentDir, ctx.modelRegistry)).source}`, "info");
	}
}
