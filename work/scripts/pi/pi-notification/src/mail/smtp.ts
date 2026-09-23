import { lookup as systemLookup } from "node:dns/promises";
import { isIP } from "node:net";
import nodemailer from "nodemailer";
import type { MailMessage, MailSender } from "./sender.ts";
import { QQ_AUTH_ENV, resolveQqCredential, type CredentialStore } from "./credentials.ts";
export { QQ_AUTH_ENV } from "./credentials.ts";
const QQ_SMTP_HOST = "smtp.qq.com";
const MAX_TIMEOUT_MS = 120_000;
const MAX_SMTP_PHASE_TIMEOUT_MS = 15_000;
const MAX_DNS_LOOKUP_TIMEOUT_MS = 5_000;

type SmtpAddress = { address: string; family: number };
type SmtpLookup = (hostname: string, options: { all: true }) => Promise<SmtpAddress[]>;

async function resolveSmtpAddress(
  signal: AbortSignal,
  timeoutMs: number,
  lookup: SmtpLookup,
): Promise<string> {
  if (signal.aborted) throw new Error(abortCode(signal));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const addresses = Promise.resolve()
    .then(() => {
      if (signal.aborted) throw new Error(abortCode(signal));
      return lookup(QQ_SMTP_HOST, { all: true });
    })
    .then((resolved) => {
      const address = resolved.find((candidate) => isIP(candidate.address) === candidate.family);
      if (!address) throw smtpFailure("SMTP_DNS_ERROR");
      return address.address;
    })
    .catch(() => {
      if (signal.aborted) throw new Error(abortCode(signal));
      throw smtpFailure("SMTP_DNS_ERROR");
    });
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error(abortCode(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(smtpFailure("SMTP_DNS_TIMEOUT")), timeoutMs);
  });
  try {
    if (signal.aborted) throw new Error(abortCode(signal));
    const address = await Promise.race([addresses, aborted, timedOut]);
    if (signal.aborted) throw new Error(abortCode(signal));
    return address;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function abortCode(signal: AbortSignal): "SMTP_TIMEOUT" | "SMTP_CANCELLED" {
  const reason = signal.reason;
  return reason instanceof Error && reason.name === "TimeoutError" ? "SMTP_TIMEOUT" : "SMTP_CANCELLED";
}

function smtpFailure(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

export interface SmtpTransportLike {
  sendMail(message: MailMessage): Promise<{ accepted?: unknown[]; rejected?: unknown[] }>;
  close?(): void;
}
export type SmtpTransportFactory = (options: Record<string, unknown>) => SmtpTransportLike;

function validEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
}

export function validateQqSmtp(options: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env, store?: CredentialStore): string | undefined {
  if (!validEmail(options.from)) return "缺少有效的发件邮箱地址";
  if (!Array.isArray(options.to) || options.to.length === 0 || options.to.length > 50 || options.to.some((to) => !validEmail(to))) {
    return "缺少有效收件地址（至少一个，最多 50 个）";
  }
  if (resolveQqCredential(env, store).source === "missing") return `Windows 凭据管理器未设置授权码，且环境变量 ${QQ_AUTH_ENV} 未设置或为空`;
  return undefined;
}

function safeCode(error: unknown): string {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "SMTP_ERROR";
}

export function createQqSmtpSender(
  options: Record<string, unknown>,
  deps: { env?: NodeJS.ProcessEnv; credentialStore?: CredentialStore; timeoutMs?: number; transportFactory?: SmtpTransportFactory; lookup?: SmtpLookup } = {},
): MailSender {
  const env = deps.env ?? process.env;
  const timeout = Math.max(250, Math.min(MAX_SMTP_PHASE_TIMEOUT_MS, Math.floor(deps.timeoutMs ?? 30000)));
  const lookup = deps.lookup ?? ((hostname, options) => systemLookup(hostname, options));
  const factory = deps.transportFactory ?? ((transportOptions) => nodemailer.createTransport(transportOptions) as unknown as SmtpTransportLike);
  let disposed = false;
  return {
    validate: () => disposed ? "邮箱发送器已关闭" : validateQqSmtp(options, env, deps.credentialStore),
    async send(message, signal) {
      if (disposed) throw new Error("邮箱发送器已关闭");
      if (signal.aborted) throw new Error(abortCode(signal));
      const invalid = validateQqSmtp({ ...options, to: [message.to] }, env, deps.credentialStore);
      if (invalid) throw new Error("SMTP_NOT_CONFIGURED");
      const auth = resolveQqCredential(env, deps.credentialStore).value;
      if (!auth) throw new Error("SMTP_NOT_CONFIGURED");
      let transport: SmtpTransportLike | undefined;
      let onAbort: (() => void) | undefined;
      try {
        const host = await resolveSmtpAddress(signal, Math.min(timeout, MAX_DNS_LOOKUP_TIMEOUT_MS), lookup);
        if (signal.aborted) throw new Error(abortCode(signal));
        transport = factory({
          host,
          port: 465,
          secure: true,
          auth: { user: options.from, pass: auth },
          connectionTimeout: timeout,
          greetingTimeout: timeout,
          socketTimeout: timeout,
          logger: false,
          debug: false,
          disableFileAccess: true,
          disableUrlAccess: true,
          tls: { servername: QQ_SMTP_HOST, rejectUnauthorized: true },
        });
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => { transport?.close?.(); reject(new Error(abortCode(signal))); };
          signal.addEventListener("abort", onAbort, { once: true });
        });
        if (signal.aborted) onAbort?.();
        if (signal.aborted) throw new Error(abortCode(signal));
        const sending = transport.sendMail(message);
        const info = await Promise.race([sending, aborted]);
        const accepted = Array.isArray(info.accepted) && info.accepted.length > 0;
        const rejected = Array.isArray(info.rejected) && info.rejected.length > 0;
        if (!accepted || rejected) throw smtpFailure("SMTP_RECIPIENT_REJECTED");
      } catch (error) {
        if (signal.aborted) throw new Error(abortCode(signal));
        throw new Error(`QQ SMTP 发送失败 (${safeCode(error)})`);
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
        transport?.close?.();
      }
    },
    async dispose() { disposed = true; },
  };
}
