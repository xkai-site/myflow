/**
 * Diagnostic channel: renders a notification as one sanitized plain-text line in
 * the logger instead of touching the terminal or the network.
 *
 * It deliberately does not emit escape sequences (that needs terminal capability
 * detection and platform branches) and does not retry or apply its own timeout:
 * the service and the reliability decorators own both.
 */

import { singleLine } from "../log.ts";
import type { Logger, Notifier, NotificationRequest } from "../types.ts";

export interface DebugNotifierOptions {
  log: Logger;

}

export function createDebugNotifier(id: string, options: DebugNotifierOptions): Notifier {
  return {
    id,
    type: "debug",

    validate(): string | undefined {
      return undefined;
    },

    async send(req: NotificationRequest, signal: AbortSignal): Promise<void> {
      if (signal.aborted) throw new Error("投递已取消");
      const title = singleLine(req.title);
      const body = singleLine(req.body);
      options.log.log(req.level, `[${req.kind}] ${title}${body ? ` — ${body}` : ""}`, {
        kind: req.kind,
        dedupeKey: req.dedupeKey,
      });
    },

    async dispose(): Promise<void> {},
  };
}
