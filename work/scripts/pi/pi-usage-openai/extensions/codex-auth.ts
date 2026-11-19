import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexUsageUnauthorizedError, fetchCodexUsage, type UsageFetch } from "./codex-usage.ts";

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const MINIMUM_ACCESS_VALIDITY_MS = 60_000;
const TOKEN_ISSUER = "https://auth.openai.com";
// The public OAuth client used by Codex CLI; the refresh token is bound to this client.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_TIMEOUT_MS = 15_000;
const LOGIN_AGAIN = "请重新登录 Codex 后重试。";

interface CodexUsageCredential {
  access: string;
  accountId: string;
  expiresAt: number;
}

interface AuthSnapshot {
  path: string;
  source: string;
  file: Record<string, unknown>;
  tokens: Record<string, unknown>;
  credential: CodexUsageCredential;
}

export function codexAuthFile(): string {
  const configuredHome = process.env.CODEX_HOME?.trim();
  return path.join(configuredHome ? path.resolve(configuredHome) : path.join(os.homedir(), ".codex"), "auth.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function authError(authPath: string, detail: string): Error {
  return new Error(`无法使用 Codex 本地登录 (${authPath})：${detail}。${LOGIN_AGAIN}`);
}

function requiredString(value: unknown, field: string, authPath: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw authError(authPath, `缺少 ${field}`);
  }
  return value.trim();
}

function parseCredential(accessValue: unknown, accountId: string, authPath: string): CodexUsageCredential {
  const access = requiredString(accessValue, "tokens.access_token", authPath);
  const parts = access.split(".");
  if (parts.length !== 3 || !parts[1]) throw authError(authPath, "access token 不是有效 JWT");

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw authError(authPath, "access token 的 JWT payload 无法解析");
  }
  if (!isRecord(claims)) throw authError(authPath, "access token 的 JWT payload 不是对象");
  const authClaims = claims[OPENAI_AUTH_CLAIM];
  if (!isRecord(authClaims)) throw authError(authPath, `JWT 缺少 ${OPENAI_AUTH_CLAIM} claim`);
  const tokenAccountId = requiredString(authClaims.chatgpt_account_id, `${OPENAI_AUTH_CLAIM}.chatgpt_account_id`, authPath);
  if (tokenAccountId !== accountId) throw authError(authPath, "tokens.account_id 与 access token 账号不一致");
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= 0) {
    throw authError(authPath, "JWT 缺少有效 exp claim");
  }
  return { access, accountId, expiresAt: claims.exp * 1000 };
}

function readAuth(authPath: string): AuthSnapshot {
  let resolvedPath: string;
  let source: string;
  try {
    resolvedPath = fs.realpathSync(authPath);
    source = fs.readFileSync(resolvedPath, "utf8");
  } catch (error) {
    const detail = (error as NodeJS.ErrnoException).code === "ENOENT" ? "登录文件不存在" : "无法读取登录文件";
    throw authError(authPath, `读取失败（${detail}）`);
  }
  let file: unknown;
  try {
    file = JSON.parse(source);
  } catch {
    // JSON parser errors can quote the credential file.
    throw authError(authPath, "读取失败（JSON 无效）");
  }
  if (!isRecord(file) || file.auth_mode !== "chatgpt") throw authError(authPath, "auth_mode 不是 chatgpt");
  const tokens = file.tokens;
  if (!isRecord(tokens)) throw authError(authPath, "缺少 tokens 对象");
  const accountId = requiredString(tokens.account_id, "tokens.account_id", authPath);
  const credential = parseCredential(tokens.access_token, accountId, authPath);
  return { path: resolvedPath, source, file, tokens, credential };
}

function expiresSoon(credential: CodexUsageCredential, now: number): boolean {
  return credential.expiresAt <= now + MINIMUM_ACCESS_VALIDITY_MS;
}

/** Adopt a concurrent renewal for this account, but never overwrite a changed login file. */
function newerCredential(authPath: string, original: AuthSnapshot, now: number): CodexUsageCredential | undefined {
  const latest = readAuth(authPath);
  if (latest.path === original.path && latest.source === original.source) return undefined;
  const { credential } = latest;
  if (credential.accountId === original.credential.accountId && credential.access !== original.credential.access &&
      !expiresSoon(credential, now)) return credential;
  throw new Error("Codex 登录文件已在查询期间变更。未覆盖现有凭据，请重新运行 /usage-openai。");
}

function refreshRejection(status: number, body: unknown): Error {
  const rawCode = isRecord(body) ? (isRecord(body.error) ? body.error.code : body.error) ?? body.code : undefined;
  const prefix = `OpenAI 登录续期失败（HTTP ${status}）`;
  switch (typeof rawCode === "string" ? rawCode.toLowerCase() : undefined) {
    case "refresh_token_expired": return new Error(`${prefix}：refresh token 已过期。${LOGIN_AGAIN}`);
    case "refresh_token_reused": return new Error(`${prefix}：refresh token 已被使用，且未发现同账号的新凭据。${LOGIN_AGAIN}`);
    case "refresh_token_invalidated": return new Error(`${prefix}：refresh token 已被撤销。${LOGIN_AGAIN}`);
    case "invalid_grant": return new Error(`${prefix}：refresh token 无效（invalid_grant）。${LOGIN_AGAIN}`);
    case "invalid_client": return new Error(`${prefix}：OAuth 客户端未获接受（invalid_client）。`);
  }
  if (status === 429 || status >= 500) return new Error(`${prefix}，请稍后重试。`);
  return new Error(`${prefix}：服务未返回可识别的认证原因。`);
}

async function requestRefresh(refreshToken: string, fetchImpl: UsageFetch): Promise<Record<string, unknown>> {
  let response: Response;
  let body: unknown;
  try {
    response = await fetchImpl(`${TOKEN_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken }),
      redirect: "error", // Never forward the refresh token to a redirected URL.
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    body = await response.json().catch((error: unknown) => {
      if (!(error instanceof SyntaxError)) throw error;
      return undefined;
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("OpenAI 登录续期超时，请稍后重试。");
    }
    throw new Error("无法完成 OpenAI 登录续期请求，请检查网络后重试。");
  }
  if (!response.ok) throw refreshRejection(response.status, body);
  if (!isRecord(body)) throw new Error("OpenAI 登录续期返回了无效的凭据响应。");
  return body;
}

async function refreshAndSave(
  authPath: string, original: AuthSnapshot, fetchImpl: UsageFetch, now: () => number,
): Promise<CodexUsageCredential> {
  const newer = newerCredential(authPath, original, now());
  if (newer) return newer;
  const { tokens, credential } = original;
  const refreshToken = requiredString(tokens.refresh_token, "tokens.refresh_token（无法自动续期）", authPath);
  const provenance = tokens.oauth_provenance;
  if (provenance != null && (!isRecord(provenance) || typeof provenance.issuer !== "string" ||
      provenance.issuer.replace(/\/+$/, "") !== TOKEN_ISSUER || provenance.client_id !== CLIENT_ID)) {
    throw new Error("当前 Codex 凭据不是由默认 OpenAI OAuth 客户端签发，无法自动续期。请通过原登录方式更新凭据。");
  }

  // Check that we can stage a private replacement before redeeming a potentially single-use token.
  const tempPath = `${original.path}.${randomUUID()}.tmp`;
  let fd: number;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
  } catch {
    throw new Error("无法在 Codex 登录文件目录创建续期文件；未请求登录续期，请检查目录权限。");
  }
  try {
    let refreshed: Record<string, unknown>;
    try {
      refreshed = await requestRefresh(refreshToken, fetchImpl);
    } catch (error) {
      // Another writer may have already redeemed the token and saved its replacement.
      const latest = newerCredential(authPath, original, now());
      if (latest) return latest;
      throw error;
    }
    const access = requiredString(refreshed.access_token, "续期响应的 access_token", authPath);
    const next = parseCredential(access, credential.accountId, authPath);
    if (expiresSoon(next, now())) throw new Error("OpenAI 登录续期返回的 access token 已过期或即将过期。");
    const updatedTokens: Record<string, unknown> = { ...tokens, access_token: access };
    for (const field of ["refresh_token", "id_token"] as const) {
      if (refreshed[field] !== undefined) updatedTokens[field] = requiredString(refreshed[field], `续期响应的 ${field}`, authPath);
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({
        ...original.file, tokens: updatedTokens, last_refresh: new Date(now()).toISOString(),
      }, null, 2));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = -1;
    } catch {
      throw new Error("OpenAI 已返回续期凭据，但无法写入 Codex 登录文件；请检查权限，必要时重新登录 Codex。");
    }
    const latest = newerCredential(authPath, original, now());
    if (latest) return latest;
    try {
      fs.renameSync(tempPath, original.path);
    } catch {
      throw new Error("OpenAI 已返回续期凭据，但无法替换 Codex 登录文件；请检查权限，必要时重新登录 Codex。");
    }
    return next;
  } finally {
    if (fd !== -1) fs.closeSync(fd);
    fs.rmSync(tempPath, { force: true });
  }
}

// Share one refresh per file in this Pi process; Codex and other processes do not share this lock.
const refreshes = new Map<string, { accountId: string; pending: Promise<CodexUsageCredential> }>();

function refreshCredential(authPath: string, auth: AuthSnapshot, fetchImpl: UsageFetch, now: () => number) {
  const { accountId } = auth.credential;
  const inProgress = refreshes.get(auth.path);
  if (inProgress) {
    if (inProgress.accountId !== accountId) throw new Error("Codex 账号已在续期期间切换，请重新运行 /usage-openai。");
    return inProgress.pending;
  }
  const pending = refreshAndSave(authPath, auth, fetchImpl, now).finally(() => refreshes.delete(auth.path));
  refreshes.set(auth.path, { accountId, pending });
  return pending;
}

/** Query the current ChatGPT subscription using at most one renewal and one usage retry. */
export async function queryCodexUsage(
  authPath: string = codexAuthFile(), fetchImpl: UsageFetch = fetch, now: () => number = Date.now,
) {
  const auth = readAuth(authPath);
  const query = ({ access, accountId }: CodexUsageCredential) => fetchCodexUsage(access, accountId, fetchImpl);
  if (!expiresSoon(auth.credential, now())) {
    try {
      return await query(auth.credential);
    } catch (error) {
      if (!(error instanceof CodexUsageUnauthorizedError) || error.reason === "revoked") throw error;
    }
  }
  const credential = await refreshCredential(authPath, auth, fetchImpl, now);
  try {
    return await query(credential);
  } catch (error) {
    if (!(error instanceof CodexUsageUnauthorizedError)) throw error;
    throw new Error(`使用更新后的凭据查询仍失败：${error.message}`);
  }
}
