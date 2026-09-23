/** Transport-independent mail boundary; provider policy and SMTP implementation stay separate. */
export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface MailSender {
  /** Resolve only after this single recipient is accepted by the configured transport. */
  send(message: MailMessage, signal: AbortSignal): Promise<void>;
  validate(): string | undefined;
  dispose(): Promise<void>;
}

export type MailSenderFactory = (options: Record<string, unknown>, timeoutMs?: number) => MailSender;

const factories = new Map<string, MailSenderFactory>();

export function registerMailSender(type: string, profile: string, factory: MailSenderFactory): void {
  const key = `${type}/${profile}`;
  if (factories.has(key)) throw new Error(`Mail sender already registered: ${key}`);
  factories.set(key, factory);
}

export function createMailSender(options: unknown, timeoutMs?: number): MailSender {
  if (!options || typeof options !== "object" || Array.isArray(options)) return unusable("邮箱传输配置必须是对象");
  const transport = (options as Record<string, unknown>).transport;
  if (!transport || typeof transport !== "object" || Array.isArray(transport)) return unusable("缺少邮箱 transport 配置");
  const { type, profile } = transport as Record<string, unknown>;
  if (typeof type !== "string" || typeof profile !== "string") return unusable("邮箱 transport type/profile 无效");
  const factory = factories.get(`${type}/${profile}`);
  return factory ? factory(options as Record<string, unknown>, timeoutMs) : unusable(`不支持的邮箱传输：${type}/${profile}`);
}

function unusable(reason: string): MailSender {
  return {
    validate: () => reason,
    async send() { throw new Error("邮箱传输不可用"); },
    async dispose() {},
  };
}
