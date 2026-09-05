import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { createLiveCodexOAuthConfig } from "./codex-auth.ts";
import { readCodexModels } from "./codex-models.ts";

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
  // Pi retains dynamic providers across reload even if the next factory fails.
  // Remove our previous override first; this restores (not disables) the builtin.
  pi.on("session_shutdown", (event) => {
    if (event.reason === "reload") pi.unregisterProvider(PROVIDER_ID);
  });
}
