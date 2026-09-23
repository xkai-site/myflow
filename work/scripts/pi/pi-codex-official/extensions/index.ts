import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { createLiveCodexOAuthConfig, readLiveCodexCredential } from "./codex-auth.ts";
import { readCodexModels } from "./codex-models.ts";
import { fetchCodexUsage, formatCodexUsage, parseCodexUsage } from "./codex-usage.ts";

const PROVIDER_ID = "openai-codex";
const API = "openai-codex-responses";
const BASE_URL = "https://chatgpt.com/backend-api";

export default function (pi: ExtensionAPI) {
  // Validate the whole cache before registering anything. The factory runs again
  // on /reload; no module-level snapshot or background watcher is needed.
  let models: ReturnType<typeof readCodexModels>;
  try {
    models = readCodexModels(getBuiltinModels(PROVIDER_ID));
  } catch (error) {
    // --list-models does not display the loader's collected extension errors.
    // Our cache errors contain only the path and validation reason, never JSON.
    console.error(`[pi-codex-official] ${error instanceof Error ? error.message : "模型加载失败"}`);
    throw error;
  }
  // Reuse Pi's compatibility registration and transport; do not create a second
  // provider/auth/stream runtime just to read built-in model metadata.
  pi.registerProvider(PROVIDER_ID, {
    name: "OpenAI Codex (Codex 本地凭据)",
    baseUrl: BASE_URL,
    api: API,
    authHeader: true,
    oauth: createLiveCodexOAuthConfig(),
    models,
  });
  pi.registerCommand("usage-openai", {
    description: "查询当前 Codex / ChatGPT 账号的用量",
    handler: async (_args, ctx) => {
      const widgetKey = "usage-openai-progress";
      const frames = ["|", "/", "-", "\\"];
      let frame = 0;
      let animation: ReturnType<typeof setInterval> | undefined;
      try {
        if (ctx.hasUI) {
          const updateProgress = () => {
            ctx.ui.setWidget(widgetKey, [`正在查询当前账号用量 ${frames[frame]}`]);
            frame = (frame + 1) % frames.length;
          };
          updateProgress();
          animation = setInterval(updateProgress, 180);
        }
        const credential = readLiveCodexCredential();
        const response = await fetchCodexUsage(credential.access, credential.accountId);
        ctx.ui.notify(formatCodexUsage(parseCodexUsage(response)), "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : "查询 OpenAI 用量失败。";
        ctx.ui.notify(message, "error");
      } finally {
        if (animation) clearInterval(animation);
        if (ctx.hasUI) ctx.ui.setWidget(widgetKey, undefined);
      }
    },
  });
  // Pi retains dynamic providers across reload even if the next factory fails.
  // Remove our previous override first; this restores (not disables) the builtin.
  pi.on("session_shutdown", (event) => {
    if (event.reason === "reload") pi.unregisterProvider(PROVIDER_ID);
  });
}
