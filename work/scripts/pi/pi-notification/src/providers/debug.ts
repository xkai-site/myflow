/**
 * Diagnostic channel: renders a notification as one sanitized plain-text line in
 * the logger instead of touching the terminal or the network.
 *
 * It deliberately does not emit escape sequences (that needs terminal capability
 * detection and platform branches) and does not retry or apply its own timeout:
 * the service and the reliability decorators own both.
 */

import { sanitize } from "../log.ts";
import type { Logger, Notifier, NotificationRequest } from "../types.ts";

export interface DebugNotifierOptions {
  log: Logger;
  /** Body length cap, taken from `config.content.maxMessageChars`. */
  maxChars: number;
}

export function createDebugNotifier(id: string, options: DebugNotifierOptions): Notifier {
  const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 0 ? options.maxChars : 300;

  return {
    id,
    type: "debug",

    validate(): string | undefined {
      return undefined;
    },

    async send(req: NotificationRequest, signal: AbortSignal): Promise<void> {
      if (signal.aborted) throw new Error("投递已取消");
      const title = sanitize(req.title, maxChars).replace(/\n/g, " ");
      const body = sanitize(req.body, maxChars).replace(/\n/g, " ");
      options.log.log(req.level, `[${req.kind}] ${title}${body ? ` — ${body}` : ""}`, {
        kind: req.kind,
        dedupeKey: req.dedupeKey,
      });
    },

    async dispose(): Promise<void> {},
  };
}
