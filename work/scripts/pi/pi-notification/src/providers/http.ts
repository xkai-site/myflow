/** Shared single-attempt HTTP transport. No notifications, queues or retry policy. */
import { createHmac } from "node:crypto";
import { sanitizeError } from "../log.ts";
import type { Logger } from "../types.ts";

export interface HttpOptions { url?: unknown; secretEnv?: unknown; headers?: unknown }
const RESERVED = new Set(["content-type", "content-length", "host", "user-agent",
  "x-pi-notify-event", "x-pi-notify-signature", "x-pi-message-event", "x-pi-message-id", "x-pi-message-signature"]);
const asString = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

export function validateHttpOptions(raw: unknown, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "options 必须是对象";
  const options = raw as HttpOptions;
  const url = asString(options.url);
  if (!url) return "缺少 url（必须是非空字符串）";
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "url 不是合法 URL"; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "url 协议必须是 http/https";
  if (parsed.username || parsed.password) return "url 不允许内嵌凭据（用户名/密码），请用 secretEnv + HMAC 签名";
  if (options.headers !== undefined) {
    if (!options.headers || typeof options.headers !== "object" || Array.isArray(options.headers)) return "headers 必须是对象（字符串 → 字符串）";
    for (const [key, value] of Object.entries(options.headers)) {
      if (typeof value !== "string") return "请求头的值必须是字符串";
      if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) return "请求头含换行符";
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) return "请求头名称不合法";
      if (RESERVED.has(key.toLowerCase())) return "请求头不可覆盖协议保留头";
      try { new Headers({ [key]: value }); } catch { return "请求头的值不合法"; }
    }
  }
  if (options.secretEnv !== undefined && typeof options.secretEnv !== "string") return "secretEnv 必须是环境变量名字符串";
  const secretEnv = asString(options.secretEnv);
  if (secretEnv) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secretEnv)) return "secretEnv 不是合法的环境变量名";
    if (!env[secretEnv]?.trim()) return `环境变量 ${secretEnv} 未设置或为空（配置只存变量名）`;
  }
  return undefined;
}

export function signHttpBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}
export function redactUrl(url: string): string {
  try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}`; }
  catch { return "(invalid url)"; }
}
export class HttpDeliveryError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  constructor(message: string, retryable: boolean, status?: number) {
    super(message); this.name = "HttpDeliveryError"; this.retryable = retryable; this.status = status;
  }
}

/** Bound bytes BEFORE decoding/sanitizing, even when a server streams an infinite error page. */
async function responseSnippet(response: Response, secrets: string[]): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let remaining = 1024;
  try {
    while (remaining > 0) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, remaining);
      remaining -= chunk.length;
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
  // A receiver may echo credentials without a recognizable key name. Mask the actual
  // configured values as well as the generic families recognized by sanitizeError.
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, "***");
  return sanitizeError(text, 200);
}

export async function sendHttpBody(options: HttpOptions, body: string, protocolHeaders: Record<string, string>, signal: AbortSignal,
  deps: { fetchImpl?: typeof fetch; log?: Logger; event?: "webhook" | "api"; providerId?: string } = {}): Promise<number> {
  const problem = validateHttpOptions(options);
  if (problem) throw new HttpDeliveryError(problem, false);
  const url = asString(options.url)!;
  const secretEnv = asString(options.secretEnv);
  const secret = secretEnv ? process.env[secretEnv] : undefined;
  const event = deps.event ?? "api";
  const headers: Record<string, string> = { ...(options.headers as Record<string, string> ?? {}),
    "content-type": "application/json; charset=utf-8", "user-agent": "pi-notification/0.1", ...protocolHeaders };
  if (secret) headers[event === "webhook" ? "X-Pi-Notify-Signature" : "X-Pi-Message-Signature"] = signHttpBody(body, secret);
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new HttpDeliveryError("当前运行时没有 fetch，HTTP 不可用", false);
  let response: Response;
  try { response = await fetchImpl(url, { method: "POST", body, headers, signal, redirect: "error" }); }
  catch (error) {
    const cause = (error as { cause?: { message?: string } })?.cause?.message ?? "";
    throw new HttpDeliveryError(signal.aborted ? "HTTP 请求已取消" : "HTTP 请求失败（含拒绝重定向）", !signal.aborted && !/redirect/i.test(cause));
  }
  const meta = { ...(deps.providerId ? { providerId: deps.providerId } : {}), status: response.status, url: redactUrl(url), signed: Boolean(secret) };
  if (!response.ok) {
    let snippet = "";
    const extraHeaders = Object.values(options.headers as Record<string, string> ?? {});
    const secrets = [secret ?? "", ...extraHeaders, ...extraHeaders.map((value) => value.replace(/^(?:Bearer|Basic)\s+/i, "")),
      ...new URL(url).searchParams.values()];
    try { snippet = await responseSnippet(response, secrets); } catch { /* A failed body read does not hide the HTTP status. */ }
    deps.log?.record({ event: `${event}_response`, ...meta, snippet });
    throw new HttpDeliveryError(`${event} 返回 HTTP ${response.status}${snippet ? `: ${snippet}` : ""}`,
      response.status === 408 || response.status === 429 || (response.status >= 500 && response.status < 600), response.status);
  }
  // Cancel rather than consume arbitrary success bodies: transport success is the status code.
  await response.body?.cancel().catch(() => {});
  deps.log?.record({ event: `${event}_sent`, ...meta });
  return response.status;
}
