import { sanitize } from "../log.ts";
import type { Logger, Notifier, NotificationRequest } from "../types.ts";
import { createMailSender, registerMailSender, type MailSender } from "../mail/sender.ts";
import { createQqSmtpSender, validateQqSmtp } from "../mail/smtp.ts";

registerMailSender("smtp", "qq", (options, timeoutMs) => createQqSmtpSender(options, { timeoutMs }));

const MAX_DEDUPE_KEYS = 512;
const SAFE_PRE_SEND_ERRORS = new Set(["SMTP_NOT_CONFIGURED", "SMTP_TIMEOUT", "SMTP_CANCELLED", "邮箱发送已取消", "邮箱发送器已关闭"]);

export function createEmailNotifier(
  id: string,
  options: Record<string, unknown>,
  deps: { log: Logger; maxChars: number; timeoutMs?: number; sender?: MailSender },
): Notifier {
  const sender = deps.sender ?? createMailSender(options, deps.timeoutMs);
  const acceptedByKey = new Map<string, Set<string>>();
  const maxChars = Number.isFinite(deps.maxChars) && deps.maxChars > 0 ? deps.maxChars : 300;
  const parseOptions = (raw: Record<string, unknown>) => ({
    from: typeof raw.from === "string" ? raw.from.trim() : "",
    to: Array.isArray(raw.to) ? [...new Set(raw.to.filter((value): value is string => typeof value === "string").map((value) => value.trim()))] : [],
    subjectPrefix: typeof raw.subjectPrefix === "string" ? raw.subjectPrefix : "[Pi]",
  });
  const parsed = parseOptions(options);
  const validation = (): string | undefined => {
    const base = validateQqSmtp({ ...parsed, transport: options.transport }, process.env);
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
    format(req: NotificationRequest) {
      return { subject: `${parsed.subjectPrefix}${sanitize(req.title, maxChars)}`, text: sanitize(req.body, maxChars) };
    },
    async send(req, signal) {
      if (signal.aborted) throw new Error("邮箱发送已取消");
      const ready = validation();
      if (ready) throw new Error("邮箱渠道不可用，请检查地址与授权码（Windows 凭据管理器或环境变量）");
      const accepted = acceptedByKey.get(req.dedupeKey) ?? new Set<string>();
      acceptedByKey.delete(req.dedupeKey);
      acceptedByKey.set(req.dedupeKey, accepted); // refresh insertion order for bounded eviction
      while (acceptedByKey.size > MAX_DEDUPE_KEYS) acceptedByKey.delete(acceptedByKey.keys().next().value!);
      const title = `${parsed.subjectPrefix}${sanitize(req.title, maxChars)}`;
      const text = sanitize(req.body, maxChars);
      let failed = 0;
      const failureCodes = new Set<string>();
      for (const recipient of parsed.to) {
        if (accepted.has(recipient)) continue;
        if (signal.aborted) throw new Error("邮箱发送已取消");
        try {
          await sender.send({ from: parsed.from, to: recipient, subject: title, text }, signal);
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
