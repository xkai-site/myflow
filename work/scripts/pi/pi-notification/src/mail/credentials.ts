import { createRequire } from "node:module";

export const QQ_AUTH_ENV = "PI_NOTIFY_QQ_SMTP_AUTH_CODE";
export const QQ_VAULT_SERVICE = "pi-notification.qq-smtp";
export const QQ_VAULT_ACCOUNT = "authorization-code";

interface VaultEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): void;
}

export interface CredentialStore {
  get(): string | undefined;
  set(value: string): void;
  delete(): void;
}

/** Lazy native load: unsupported platforms/builds must not stop the entire extension loading. */
export function systemCredentialStore(): CredentialStore | undefined {
  if (process.platform !== "win32") return undefined;
  try {
    const { Entry } = createRequire(import.meta.url)("@napi-rs/keyring") as { Entry: new (service: string, account: string) => VaultEntry };
    const entry = new Entry(QQ_VAULT_SERVICE, QQ_VAULT_ACCOUNT);
    return {
      get: () => entry.getPassword() || undefined,
      set: (value) => entry.setPassword(value),
      delete: () => entry.deletePassword(),
    };
  } catch {
    return undefined;
  }
}

export type CredentialSource = "vault" | "environment" | "missing";

/** The OS vault always wins; a legacy environment variable remains a fallback only. */
export function resolveQqCredential(
  env: NodeJS.ProcessEnv = process.env,
  store: CredentialStore | undefined = systemCredentialStore(),
): { source: CredentialSource; value?: string } {
  try {
    const value = store?.get();
    if (value?.trim()) return { source: "vault", value };
  } catch {
    // Vault unavailable: legacy env fallback, never leak the OS error or secret.
  }
  const value = env[QQ_AUTH_ENV];
  return value?.trim() ? { source: "environment", value } : { source: "missing" };
}

/** These operations never return the secret or the underlying OS error to the UI/log. */
export function saveQqCredential(value: string, store: CredentialStore | undefined = systemCredentialStore()): boolean {
  if (!store || !value || value.length > 128 || /[^\x21-\x7e]/.test(value)) return false;
  try {
    store.set(value);
    // Do not report success unless a fresh OS-vault read confirms the exact secret was persisted.
    return store.get() === value;
  } catch { return false; }
}

export function deleteQqCredential(store: CredentialStore | undefined = systemCredentialStore()): boolean {
  if (!store) return false;
  try {
    if (!store.get()) return true;
    store.delete();
    return true;
  } catch { return false; }
}
