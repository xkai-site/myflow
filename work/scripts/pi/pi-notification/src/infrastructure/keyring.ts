/** Native boundary only. No platform policy leaks into authorization, settings or SMTP. */
import { createRequire } from "node:module";
import type { CredentialStore, StoreStatus } from "../mail/credentials.ts";

// Preserve the existing Windows entry identity; no migration or credential copy is needed.
export const QQ_VAULT_SERVICE = "pi-notification.qq-smtp";
export const QQ_VAULT_ACCOUNT = "authorization-code";
interface NativeEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
  deletePassword(): unknown;
}
interface KeyringBinding {
  Entry: new (service: string, account: string, options: { linux: { store: "secret-service" } }) => NativeEntry;
}

/** Lazy construction allows injected environments to work without a native module/service.
 * Options are accepted on every platform by keyring 2.1.0, and ignored outside Linux.
 * Pin Linux to persistent Secret Service instead of silently selecting volatile keyutils.
 * A failed initialization is retried on the next operation (e.g. after unlocking a session).
 */
export function systemCredentialStore(load: () => KeyringBinding = () => createRequire(import.meta.url)("@napi-rs/keyring")): CredentialStore {
  let entry: NativeEntry | undefined;
  const connect = () => entry ??= new (load().Entry)(QQ_VAULT_SERVICE, QQ_VAULT_ACCOUNT, { linux: { store: "secret-service" } });
  return {
    status(): StoreStatus {
      try { connect(); return { available: true }; }
      catch { return { available: false, reason: "系统凭据服务或原生 keyring 模块不可用；Linux 需要可访问的 Secret Service" }; }
    },
    get: () => connect().getPassword() || undefined,
    set: (value) => connect().setPassword(value),
    delete: () => { connect().deletePassword(); },
  };
}
