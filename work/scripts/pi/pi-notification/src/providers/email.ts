import { emailContent } from "../content.ts";
import { singleLine } from "../log.ts";
import type { Logger, Notifier, NotificationRequest } from "../types.ts";
import { createMailSender, type MailSender } from "../mail/sender.ts";
import type { QqCredentials } from "../mail/credentials.ts";
import { escapeHtml, renderMailMarkdown } from "../mail/markdown.ts";
import { createQqSmtpSender, validateQqSmtp } from "../mail/smtp.ts";

const MAX_DEDUPE_KEYS = 512;
// Bound the combined UTF-8 rendering before MIME encoding and recipient fan-out.
export const MAX_MAIL_CONTENT_BYTES = 1024 * 1024;
const MAIL_TOO_LARGE = "通知邮件超过 1 MiB 内容上限，未发送";

function formatMail(req: NotificationRequest, subjectPrefix: string) {
  const subject = singleLine(`${subjectPrefix}${req.title}`);
  const { supplements, reply, text } = emailContent(req);
  const bytes = Buffer.byteLength(subject) + Buffer.byteLength(text);
  if (bytes > MAX_MAIL_CONTENT_BYTES) throw new Error(MAIL_TOO_LARGE);
  const supplement = supplements.map((part) => `<p>${escapeHtml(part)}</p>`).join("");
  const final = reply ? `<p><strong>${escapeHtml(reply.heading)}</strong></p>${renderMailMarkdown(reply.text)}` : "";
  const html = text ? `<div lang="zh-CN" style="font:16px/1.6 system-ui,sans-serif;overflow-wrap:anywhere">${supplement}${final}</div>` : "";
  if (bytes + Buffer.byteLength(html) > MAX_MAIL_CONTENT_BYTES) throw new Error(MAIL_TOO_LARGE);
  return { subject, text, html };
}
const SAFE_PRE_SEND_ERRORS = new Set(["SMTP_NOT_CONFIGURED", "SMTP_TIMEOUT", "SMTP_CANCELLED", "邮箱发送已取消", "邮箱发送器已关闭"]);

export function createEmailNotifier(
  id: string,
  options: Record<string, unknown>,
  deps: { log: Logger; timeoutMs?: number } & ({ sender: MailSender; credentials?: QqCredentials } | { credentials: QqCredentials; sender?: undefined }),
): Notifier {
  const sender = deps.sender ?? createMailSender(options, (value, timeoutMs) => createQqSmtpSender(value, { credentials: deps.credentials!, timeoutMs }), deps.timeoutMs);
  const acceptedByKey = new Map<string, Set<string>>();
  const parseOptions = (raw: Record<string, unknown>) => ({
    from: typeof raw.from === "string" ? raw.from.trim() : "",
    to: Array.isArray(raw.to) ? [...new Set(raw.to.filter((value): value is string => typeof value === "string").map((value) => value.trim()))] : [],
    subjectPrefix: typeof raw.subjectPrefix === "string" ? raw.subjectPrefix : "[Pi]",
  });
  const parsed = parseOptions(options);
  const format = (req: NotificationRequest) => formatMail(req, parsed.subjectPrefix);
  const validation = (): string | undefined => {
    const base = validateQqSmtp({ ...parsed, transport: options.transport });
    return base ?? sender.validate();
  };
  return {
    id,
    type: "email",
    validate(raw) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "邮箱 options 必须是对象";
      const supplied = parseOptions(raw as Record<string, unknown>);
      if (!supplied.from || !supplied.to.length) return "缺少发件邮箱或收件邮箱";
      if (supplied.to.some((address) => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address))) return "收件邮箱格式无效";
      return validation();
    },
    format,
    async send(req, signal) {
      if (signal.aborted) throw new Error("邮箱发送已取消");
      const ready = validation();
      if (ready) throw new Error("邮箱渠道不可用，请检查地址与授权码（系统安全存储或环境注入）");
      const content = format(req);
      const accepted = acceptedByKey.get(req.dedupeKey) ?? new Set<string>();
      acceptedByKey.delete(req.dedupeKey);
      acceptedByKey.set(req.dedupeKey, accepted); // refresh insertion order for bounded eviction
      while (acceptedByKey.size > MAX_DEDUPE_KEYS) acceptedByKey.delete(acceptedByKey.keys().next().value!);
      let failed = 0;
      const failureCodes = new Set<string>();
      for (const recipient of parsed.to) {
        if (accepted.has(recipient)) continue;
        if (signal.aborted) throw new Error("邮箱发送已取消");
        try {
          await sender.send({ from: parsed.from, to: recipient, ...content }, signal);
          accepted.add(recipient);
        } catch (error) {
          // Expose only our sender's bounded, allowlisted SMTP code; never propagate server text,
          // recipient addresses, or credentials into logs/status.
          const message = error instanceof Error ? error.message : "";
          const wrappedCode = /^QQ SMTP 发送失败 \(([A-Z0-9_]{1,32})\)$/.exec(message)?.[1];
          const code = wrappedCode ?? (SAFE_PRE_SEND_ERRORS.has(message) ? message : undefined);
          if (code) failureCodes.add(code);
          failed += 1;
        }
      }
      if (failed > 0) {
        const codes = [...failureCodes].sort();
        deps.log.log("warning", `email delivery partially failed (${failed} recipient(s))${codes.length ? ` [${codes.join(",")}]` : ""}`, { provider: id, ...(codes.length ? { smtpCodes: codes } : {}) });
        throw new Error(`邮箱发送失败（${failed} 个收件人发送未成功或结果未确认）${codes.length ? `，SMTP 错误代码：${codes.join(",")}` : ""}`);
      }
      acceptedByKey.delete(req.dedupeKey);
    },
    async dispose() {
      acceptedByKey.clear();
      await sender.dispose();
    },
  };
}
