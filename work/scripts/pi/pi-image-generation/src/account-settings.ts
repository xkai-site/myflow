import path from "node:path";
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
		ctx.ui.notify(configurationPaths(agentDir), "info");
		return;
	}
	const index = labels.indexOf(selected);
	const provider = config.providers[index];
	if (!provider) return;
	if (provider.auth.type === "provider") {
		const providerId = provider.auth.providerId;
		const command = `/login ${providerId}`;
		const login = `登录 / 重新认证（填入 ${command}，回车执行）`;
		const details = "查看认证说明与凭据路径";
		const refresh = "刷新账户状态";
		for (;;) {
			const status = await getAccountStatus(provider, agentDir, ctx.modelRegistry);
			const registered = ctx.modelRegistry.getProvider(providerId) !== undefined;
			const source = registered ? status.source : `未注册 Pi provider：${providerId}`;
			const action = await ctx.ui.select(`OpenAI 图片账户（${providerId}）— ${source}`, [
				login, refresh, details, "保持当前设置",
			]);
			if (action === login) {
				if (!registered) {
					ctx.ui.notify(`当前 Pi 未注册 ${providerId}。请先使用包含该 provider 的 Pi 版本或安装相应 provider 扩展，完成后 /reload。`, "warning");
					continue;
				}
				const draft = ctx.ui.getEditorText();
				if (draft.trim() && !await ctx.ui.confirm("替换当前输入？", "将当前输入替换为 Pi 登录命令，不会自动提交。")) continue;
				// Built-in /login is interactive-only, not an extension command. Never send it to the LLM.
				ctx.ui.setEditorText(command);
				ctx.ui.notify("已填入登录命令，按 Enter 打开 Pi 认证流程。完成后重新运行 /image 即可，无需重启；普通 OpenAI / Codex CLI 登录不会自动复用到此账户。", "info");
				return;
			}
			if (action === details) {
				ctx.ui.notify(`此账户复用 Pi provider ${providerId}。\n认证入口：${command}（由 Pi 处理登录、保存及刷新）。\n普通 openai 与 openai-codex 是不同账户配置；不会直接读取 Codex CLI 的 auth.json，也不接受 OpenAI Platform API Key。\n${configurationPaths(agentDir)}`, "info");
				continue;
			}
			if (action === refresh) continue;
			return;
		}
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

function configurationPaths(agentDir: string): string {
	return `模型配置：${MODEL_CONFIG_PATH}\nPi provider 登录凭据：${path.join(agentDir, "auth.json")}\n图片专用 Key（仅千问）：${getCredentialPath(agentDir)}\n凭据以明文保存在本地，由文件权限保护，未加密。不要手动粘贴 OpenAI token 到图片专用 Key 文件。`;
}
