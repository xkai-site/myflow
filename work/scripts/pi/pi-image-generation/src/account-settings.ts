import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deleteImageKey, getAccountStatus, getCredentialPath, readSavedKey, saveImageKey } from "./credentials.ts";
import { MODEL_CONFIG_PATH, type ImageConfig } from "./model-config.ts";
import { promptSecret } from "./secret-input.ts";

export async function runAccountSettings(ctx: ExtensionContext, config: ImageConfig | undefined, agentDir: string): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("请在 TUI 中打开 /image --settings 保存 Token Plan CN Key，或设置 models.jsonc 声明的环境变量。不要将 Key 写入命令参数。", "info");
		return;
	}
	if (!config) {
		ctx.ui.notify(`请先修复模型配置：${MODEL_CONFIG_PATH}\n然后执行 /reload。现有账户凭据不会改变。`, "warning");
		return;
	}
	const statuses = await Promise.all(config.providers.map((p) => getAccountStatus(p, agentDir, ctx.modelRegistry)));
	const labels = config.providers.map((p, i) => `${p.name} (${p.id}) — ${statuses[i].source}`);
	const showPaths = "查看配置与凭据路径";
	const selected = await ctx.ui.select("图片账户设置", [...labels, showPaths]);
	if (selected === undefined) return;
	if (selected === showPaths) {
		ctx.ui.notify(`模型配置：${MODEL_CONFIG_PATH}\n账户凭据：${getCredentialPath(agentDir)}\n凭据以明文保存在本地，由文件权限保护，未加密。`, "info");
		return;
	}
	const index = labels.indexOf(selected);
	const provider = config.providers[index];
	if (!provider) return;
	if (provider.auth.type === "provider") {
		ctx.ui.notify(`此账户使用 Pi provider ${provider.auth.providerId}。\n${statuses[index].source}\n请通过对应扩展或设置完成认证。本插件不提供 provider 注册、登录或 token 刷新。`, "info");
		return;
	}
	if (statuses[index].error) ctx.ui.notify(statuses[index].error!, "warning");
	const action = await ctx.ui.select("Qwen Token Plan CN（专用 Key 优先）", [
		"设置或替换图片 API Key", "删除已保存的图片 API Key", "保持当前设置",
	]);
	if (!action || action === "保持当前设置") return;
	if (action === "设置或替换图片 API Key") {
		const key = await promptSecret(ctx, "Qwen Token Plan CN API Key（非普通百炼 Key）");
		if (key === undefined) return;
		const confirmed = await ctx.ui.confirm("保存图片 API Key？", `当前来源：${statuses[index].source}\n保存位置：${getCredentialPath(agentDir)}\n文件未加密，仅影响图片请求，不执行联网验证。`);
		if (!confirmed) return;
		await saveImageKey(agentDir, provider.id, key);
		ctx.ui.notify("图片 API Key 已保存，下次 /image 请求生效。尚未验证服务端有效性。", "info");
	} else if (action === "删除已保存的图片 API Key") {
		if (!await readSavedKey(agentDir, provider.id)) { ctx.ui.notify("没有已保存的图片 API Key，现有 provider 凭据不会改变。", "info"); return; }
		const fallback = await getAccountStatus(provider, agentDir, ctx.modelRegistry, process.env, true);
		if (!await ctx.ui.confirm("删除已保存的图片 API Key？", `删除后来源：${fallback.source}\n不会删除现有 Pi 或 Codex 凭据。`)) return;
		await deleteImageKey(agentDir, provider.id);
		ctx.ui.notify(`图片 API Key 已删除。当前来源：${(await getAccountStatus(provider, agentDir, ctx.modelRegistry)).source}`, "info");
	}
}
