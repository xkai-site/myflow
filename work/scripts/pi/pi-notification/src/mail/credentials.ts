/** Harness- and OS-independent QQ SMTP credential operations. No persistence defaults or UI API. */
export const QQ_AUTH_ENV = "PI_NOTIFY_QQ_SMTP_AUTH_CODE";
export const QQ_MAIL_URL = "https://mail.qq.com/";
export const SECURE_INJECTION_HELP = `可在启动前通过 ${QQ_AUTH_ENV} 或外部安全凭据服务注入；不会回退到明文文件。`;

export type StoreStatus = { available: true } | { available: false; reason: string };
/** get/set/delete throw on IO failure. status never returns a secret. */
export interface CredentialStore {
  status(): StoreStatus;
  get(): string | undefined;
  set(value: string): void;
  delete(): void;
}
export type CredentialSource = "vault" | "environment" | "missing";
export interface CredentialStatus {
  source: CredentialSource;
  state: "configured" | "missing" | "unavailable" | "read-failed";
  storage: StoreStatus;
  revision: number;
  message: string;
}
export interface CredentialResult { ok: boolean; message: string }
export interface QqCredentials {
  status(): CredentialStatus;
  /** Only the mail transport should request the value. Never serialize the result. */
  read(): { value?: string; status: CredentialStatus };
  save(value: string): CredentialResult;
  delete(): CredentialResult;
}

function validCode(value: string): boolean { return value.length > 0 && value.length <= 128 && !/[^\x21-\x7e]/u.test(value); }

export function createQqCredentials(store: CredentialStore, environment: () => string | undefined): QqCredentials {
  let revision = 0;
  const read = (): { value?: string; status: CredentialStatus } => {
    const storage = store.status();
    const injected = environment();
    // Explicit malformed injection is an error, not an invitation to use a different account secret.
    if (injected?.trim() && !validCode(injected)) return { status: { source: "environment", state: "read-failed", storage, revision,
      message: `环境注入授权码无效，需为 1–128 位且不含空格或控制字符。请修正 ${QQ_AUTH_ENV}。` } };
    // Explicit injection wins, deterministically, without reading a possibly locked OS vault.
    if (injected?.trim()) return { value: injected, status: { source: "environment", state: "configured", storage, revision,
      message: "由启动环境提供（优先于系统存储）" } };
    if (!storage.available) return { status: { source: "missing", state: "unavailable", storage, revision,
      message: `安全存储不可用：${storage.reason}。${SECURE_INJECTION_HELP}` } };
    try {
      const value = store.get();
      return { value, status: { source: value ? "vault" : "missing", state: value ? "configured" : "missing", storage, revision,
        message: value ? "已保存于系统安全存储" : `未配置授权码。${SECURE_INJECTION_HELP}` } };
    } catch {
      return { status: { source: "missing", state: "read-failed", storage, revision,
        message: `凭据读取失败，请检查系统存储是否锁定或拒绝访问。${SECURE_INJECTION_HELP}` } };
    }
  };
  const unavailable = (): CredentialResult | undefined => {
    const status = store.status();
    return !status.available ? { ok: false, message: `安全存储不可用：${status.reason}。${SECURE_INJECTION_HELP}` } : undefined;
  };
  return {
    read,
    status: () => read().status,
    save(value) {
      if (!validCode(value)) return { ok: false, message: "请输入 1–128 位不含空格或控制字符的 QQ 邮箱授权码。" };
      const issue = unavailable();
      if (issue) return issue;
      // Invalidate tests even if a partially successful write cannot be verified.
      revision++;
      try {
        store.set(value);
        if (store.get() !== value) return { ok: false, message: "授权码写入后校验失败，无法确认保存结果。请重试。" };
        return { ok: true, message: `授权码已安全保存，供当前系统用户的所有对话使用。${environment()?.trim() ? "当前仍优先使用启动环境中的授权码。" : ""}` };
      } catch { return { ok: false, message: "授权码保存或读取校验失败，请检查系统存储权限。" }; }
    },
    delete() {
      const issue = unavailable();
      if (issue) return issue;
      revision++;
      try {
        store.delete();
        if (store.get()) return { ok: false, message: "授权码删除后校验失败，系统存储中仍有凭据。" };
        return { ok: true, message: `已删除当前系统用户的本插件授权码，影响所有对话；不改变渠道开关或路由。${environment()?.trim() ? "启动环境中的授权码仍有效，需在注入来源单独移除。" : ""}` };
      } catch { return { ok: false, message: "授权码删除或读取校验失败，请检查系统存储权限。" }; }
    },
  };
}
