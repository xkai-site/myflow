/**
 * Generic HTTP POST webhook channel.
 *
 * It is the shared base for Telegram / Discord / Slack and it exercises the channel boundary:
 * this file imports neither the judgement layer nor the config layer, the payload shape is owned
 * by `format()` and retry policy by the reliability decorators, and the service knows nothing
 * about it.
 *
 * Four security rules:
 *  1. Never store a secret: the config may only name an environment variable (`secretEnv`), and
 *     its value is read at delivery time.
 *  2. `validate()` must state why the channel is unusable (bad URL, wrong protocol, missing
 *     variable) so the registry can degrade to Noop; silently posting to the wrong place is not
 *     an option.
 *  3. Only structured metadata is sent, never user input or full replies.
 *  4. Redirects are refused: a signed payload must not follow a redirect to another host.
 */

import { createHmac } from "node:crypto";

import { sanitize, sanitizeError } from "../log.ts";
import type { Logger, Notifier, NotificationRequest } from "../types.ts";

const EVENT_HEADER = "X-Pi-Notify-Event";
const SIGNATURE_HEADER = "X-Pi-Notify-Signature";
/** Truncation applied before a response snippet reaches an error or the log, to avoid logging a whole page. */
const BODY_SNIPPET_CHARS = 200;

export interface WebhookOptions {
  url?: unknown;
  /** Environment variable **name** only, for example `PI_NOTIFY_WEBHOOK_SECRET`. */
  secretEnv?: unknown;
  /** Extra request headers; values must not contain newlines, which `validate` enforces. */
  headers?: unknown;
}

export interface WebhookNotifierOptions {
  log: Logger;
  maxChars: number;
  /** Injectable for tests (global fetch by default); resolved per call so tests can swap it. */
  fetchImpl?: typeof fetch;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function headerEntries(raw: unknown): Array<[string, string]> | string {
  if (raw === undefined) return [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "必须是对象（字符串 → 字符串）";
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") return `请求头 ${key} 的值必须是字符串`;
    if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) return `请求头 ${key} 含换行符`;
    entries.push([key, value]);
  }
  return entries;
}

/** Parses and validates the URL; a returned string means the channel is unusable. */
export function validateWebhookOptions(raw: unknown, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "options 必须是对象";
  const options = raw as WebhookOptions;

  const url = asString(options.url);
  if (!url) return "缺少 url（必须是非空字符串）";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `url 不是合法 URL: ${url.slice(0, 120)}`;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return `url 协议必须是 http/https，实际是 ${parsed.protocol}`;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "url 不允许内嵌凭据（用户名/密码），请用 secretEnv + HMAC 签名";
  }
  const headers = headerEntries(options.headers);
  if (typeof headers === "string") return headers;

  const secretEnv = asString(options.secretEnv);
  if (secretEnv !== undefined) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secretEnv)) return `secretEnv 不是合法的环境变量名: ${secretEnv}`;
    const secret = env[secretEnv];
    if (!secret || secret.trim() === "") {
      return `环境变量 ${secretEnv} 未设置或为空（配置里只存变量名，值请放环境变量）`;
    }
  }
  return undefined;
}

/**
 * Channel-specific formatting.
 * Carries only delivery metadata: title and body (already sanitized upstream), level, kind and
 * the session and run identifiers.
 */
export function buildWebhookPayload(req: NotificationRequest, at: number = Date.now()): Record<string, unknown> {
  return {
    source: "pi-notification",
    version: 1,
    event: req.kind,
    level: req.level,
    title: req.title,
    body: req.body,
    dedupeKey: req.dedupeKey,
    sessionId: req.meta.sessionId,
    runId: req.meta.runId,
    ...(req.meta.durationMs !== undefined ? { durationMs: req.meta.durationMs } : {}),
    at,
  };
}

/** HMAC-SHA256 signature as `sha256=<hex>` over the exact bytes sent, so a receiver can verify directly. */
export function signWebhookBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/** Logs keep only origin and pathname: a query string is commonly used to carry a token. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(invalid url)";
  }
}

export function createWebhookNotifier(id: string, options: WebhookOptions, deps: WebhookNotifierOptions): Notifier {
  const log = deps.log;
  const maxChars = Number.isFinite(deps.maxChars) && deps.maxChars > 0 ? deps.maxChars : 300;
  const rawHeaders = headerEntries(options.headers);
  /** The payload shape is defined once here and shared by `format()` and `send()`. */
  const format = (req: NotificationRequest): Record<string, unknown> => buildWebhookPayload(req);

  return {
    id,
    type: "webhook",

    /** Called by the registry; returning a reason degrades the channel to Noop with that reason. */
    validate(raw: unknown): string | undefined {
      return validateWebhookOptions(raw ?? options);
    },

    /** Structured payload: the channel-specific shape appears here only and never flows back into rules. */
    format,

    async send(req: NotificationRequest, signal: AbortSignal): Promise<void> {
      const url = asString(options.url);
      if (!url) throw new Error("webhook 缺少 url");

      const title = sanitize(req.title, maxChars);
      const body = sanitize(req.body, maxChars);
      const text = JSON.stringify(format({ ...req, title, body }));

      const headers: Record<string, string> = {
        "content-type": "application/json; charset=utf-8",
        "user-agent": "pi-notification/0.1",
        [EVENT_HEADER]: req.kind,
      };
      if (Array.isArray(rawHeaders)) {
        for (const [key, value] of rawHeaders) headers[key] = value;
      }

      const secretEnv = asString(options.secretEnv);
      const secret = secretEnv ? process.env[secretEnv] : undefined;
      if (secretEnv && secret) headers[SIGNATURE_HEADER] = signWebhookBody(text, secret);

      const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
      if (typeof fetchImpl !== "function") throw new Error("当前运行时没有 fetch，webhook 渠道不可用");

      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: text,
        signal,
        // Refuse redirects: a signed payload must not be carried to another host.
        redirect: "error",
      });

      if (!response.ok) {
        let snippet = "";
        try {
          // A response body can echo credentials, so sanitize and redact before it reaches a log or error.
          snippet = sanitizeError(await response.text(), BODY_SNIPPET_CHARS);
        } catch {
          snippet = "";
        }
        log.record({
          event: "webhook_response",
          providerId: id,
          status: response.status,
          url: redactUrl(url),
          signed: Boolean(secret),
          snippet,
        });
        throw new Error(`webhook 返回 HTTP ${response.status}${snippet ? `: ${snippet}` : ""}`);
      }
      // Consume the body even on success, otherwise a keep-alive connection stays open.
      try {
        await response.arrayBuffer();
      } catch {
        // A read failure does not change the delivery verdict.
      }
      log.record({ event: "webhook_sent", providerId: id, status: response.status, url: redactUrl(url), signed: Boolean(secret) });
    },

    async dispose(): Promise<void> {},
  };
}
