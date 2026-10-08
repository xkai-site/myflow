/** Legacy notification Webhook v1 serializer. HTTP safety is shared with the machine API. */
import { sanitize } from "../log.ts";
import { sendHttpBody, validateHttpOptions, signHttpBody } from "./http.ts";
import type { HttpOptions } from "./http.ts";
import type { Logger, Notifier, NotificationRequest } from "../types.ts";

export type WebhookOptions = HttpOptions;
export interface WebhookNotifierOptions {
  log: Logger;
  maxChars: number;
  fetchImpl?: typeof fetch;
}
// Keep these public names and their argument contracts for v1 callers.
export const validateWebhookOptions = validateHttpOptions;
export const signWebhookBody = signHttpBody;
export { redactUrl } from "./http.ts";

export function buildWebhookPayload(req: NotificationRequest, at: number = Date.now()): Record<string, unknown> {
  return {
    source: "pi-notification", version: 1, event: req.kind, level: req.level,
    title: req.title, body: req.body, dedupeKey: req.dedupeKey,
    sessionId: req.meta.sessionId, runId: req.meta.runId,
    ...(req.meta.durationMs !== undefined ? { durationMs: req.meta.durationMs } : {}), at,
  };
}

export function createWebhookNotifier(id: string, options: WebhookOptions, deps: WebhookNotifierOptions): Notifier {
  const maxChars = Number.isFinite(deps.maxChars) && deps.maxChars > 0 ? deps.maxChars : 300;
  const format = (req: NotificationRequest) => buildWebhookPayload(req);
  return {
    id, type: "webhook",
    validate: (raw) => validateWebhookOptions(raw ?? options),
    format,
    async send(req, signal) {
      const body = JSON.stringify(format({ ...req, title: sanitize(req.title, maxChars), body: sanitize(req.body, maxChars) }));
      await sendHttpBody(options, body, { "X-Pi-Notify-Event": req.kind }, signal,
        { ...deps, event: "webhook", providerId: id });
    },
    async dispose() {},
  };
}
