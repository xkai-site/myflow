/**
 * 阶段 2 渠道：通用 HTTP POST Webhook（设计 §17.1 P2 / §17.4 / §13 第 2、16 项）。
 *
 * 它是 Telegram / Discord / Slack 的**通用底座**，也是「§17.3 的渠道抽象是否真的成立」的
 * 第一次真正测试：本文件不 import `lifecycle` / `rules` / `config`，格式与重试分别由
 * `format()` 与 `decorators.ts` 负责，`services` 对它一无所知。
 *
 * 四条安全纪律：
 *  1. **不存密钥明文**：配置里只允许出现环境变量**名**（`secretEnv`），值在投递时读环境变量。
 *  2. `validate()` 负责把「不可用」说清楚（URL 非法 / 协议不对 / 环境变量不存在），
 *     由 `registry` 降级为 Noop —— 不存在「静默发到一个错地方」。
 *  3. 只发**结构化元数据**，不含用户输入原文与完整回复（§13 第 16 项）。
 *  4. 不跟随重定向（`redirect: "error"`）：否则凭据可能被转到另一个主机。
 */

import { createHmac } from "node:crypto";

import { sanitize, sanitizeError } from "../log.ts";
import type { Logger, Notifier, NotificationRequest } from "../types.ts";

const EVENT_HEADER = "X-Pi-Notify-Event";
const SIGNATURE_HEADER = "X-Pi-Notify-Signature";
/** 响应体片段进入错误消息前的截断长度（防止把整个页面塞进日志） */
const BODY_SNIPPET_CHARS = 200;

export interface WebhookOptions {
  url?: unknown;
  /** **只允许环境变量名**，例如 `PI_NOTIFY_WEBHOOK_SECRET` */
  secretEnv?: unknown;
  /** 额外请求头（值不得含换行；由 validate 把关） */
  headers?: unknown;
}

export interface WebhookNotifierOptions {
  log: Logger;
  maxChars: number;
  /** 供测试注入（默认全局 fetch）；在调用时才取，便于测试挂载陷阱/存根 */
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

/** 解析并校验 URL；返回错误字符串表示不可用。 */
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
 * 渠道特定格式化（§17.4 的 `format?`）。
 * 只包含投递所需的元数据：标题/正文（业务层已清洗）、等级、kind、会话与运行标识。
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

/** HMAC-SHA256 签名（`sha256=<hex>`）。签名对象是**实际发送的字节**，便于接收方直接校验。 */
export function signWebhookBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/** 日志里只留 origin + pathname：query 常被用来传 token。 */
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
  /** payload 形状只在这个函数里定义一次：`format()` 与 `send()` 共用它。 */
  const format = (req: NotificationRequest): Record<string, unknown> => buildWebhookPayload(req);

  return {
    id,
    type: "webhook",

    /** 由 `registry.create()` 调用；同时给出「配置不可用」的明确原因（§17.4）。 */
    validate(raw: unknown): string | undefined {
      return validateWebhookOptions(raw ?? options);
    },

    /** 结构化 payload：渠道特定形状只在这里出现，不回流到 `rules`（§17.3 规则 4）。 */
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
        // 不跟随重定向：避免把签名/载荷带到另一个主机
        redirect: "error",
      });

      if (!response.ok) {
        let snippet = "";
        try {
          // 响应体可能回显凭据：先用 `sanitizeError`（清洗 + 脱敏）再入日志/错误消息。
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
      // 成功也要读掉响应体，否则 keep-alive 连接会挂住。
      try {
        await response.arrayBuffer();
      } catch {
        // 读取失败不影响投递判定
      }
      log.record({ event: "webhook_sent", providerId: id, status: response.status, url: redactUrl(url), signed: Boolean(secret) });
    },

    async dispose(): Promise<void> {},
  };
}
