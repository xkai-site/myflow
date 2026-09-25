import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readCodexUsageCredential } from "./codex-auth.ts";
import { fetchCodexUsage, formatCodexUsage, parseCodexUsage } from "./codex-usage.ts";

export default function (pi: ExtensionAPI) {
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
            ctx.ui.setWidget(widgetKey, [`正在查询 OpenAI 用量 ${frames[frame]}`]);
            frame = (frame + 1) % frames.length;
          };
          updateProgress();
          animation = setInterval(updateProgress, 180);
        }
        const credential = readCodexUsageCredential();
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
}
