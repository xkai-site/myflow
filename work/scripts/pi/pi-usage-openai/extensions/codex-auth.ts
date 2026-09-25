import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const MINIMUM_ACCESS_VALIDITY_MS = 60_000;

interface CodexAuthFile {
  auth_mode?: unknown;
  tokens?: unknown;
}

interface AccessTokenClaims {
  exp?: unknown;
  [OPENAI_AUTH_CLAIM]?: unknown;
}

export interface CodexUsageCredential {
  access: string;
  accountId: string;
}

export function codexAuthFile(): string {
  const configuredHome = process.env.CODEX_HOME?.trim();
  return path.join(configuredHome ? path.resolve(configuredHome) : path.join(os.homedir(), ".codex"), "auth.json");
}

function authError(authPath: string, detail: string): Error {
  return new Error(
    `无法使用 Codex 本地登录 (${authPath})：${detail}。请通过 Codex 更新登录后重试。`,
  );
}

function requiredString(value: unknown, field: string, authPath: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw authError(authPath, `缺少 ${field}`);
  }
  return value.trim();
}

/** Read the current Codex ChatGPT access token without refreshing or modifying auth.json. */
export function readCodexUsageCredential(
  authPath: string = codexAuthFile(),
  now: number = Date.now(),
): CodexUsageCredential {
  let parsed: CodexAuthFile;
  try {
    parsed = JSON.parse(fs.readFileSync(authPath, "utf8")) as CodexAuthFile;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw authError(authPath, `读取失败 (${detail})`);
  }

  if (parsed.auth_mode !== "chatgpt") throw authError(authPath, "auth_mode 不是 chatgpt");
  if (typeof parsed.tokens !== "object" || parsed.tokens === null || Array.isArray(parsed.tokens)) {
    throw authError(authPath, "缺少 tokens 对象");
  }

  const tokens = parsed.tokens as Record<string, unknown>;
  const access = requiredString(tokens.access_token, "tokens.access_token", authPath);
  const accountId = requiredString(tokens.account_id, "tokens.account_id", authPath);
  const parts = access.split(".");
  if (parts.length !== 3 || !parts[1]) throw authError(authPath, "access token 不是有效 JWT");

  let claims: AccessTokenClaims;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("invalid JWT payload");
    claims = payload as AccessTokenClaims;
  } catch {
    throw authError(authPath, "access token 的 JWT payload 无法解析");
  }

  const authClaims = claims[OPENAI_AUTH_CLAIM];
  if (typeof authClaims !== "object" || authClaims === null || Array.isArray(authClaims)) {
    throw authError(authPath, `JWT 缺少 ${OPENAI_AUTH_CLAIM} claim`);
  }
  const tokenAccountId = requiredString(
    (authClaims as Record<string, unknown>).chatgpt_account_id,
    `${OPENAI_AUTH_CLAIM}.chatgpt_account_id`,
    authPath,
  );
  if (tokenAccountId !== accountId) throw authError(authPath, "tokens.account_id 与 access token 账号不一致");
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= 0) {
    throw authError(authPath, "JWT 缺少有效 exp claim");
  }
  if (claims.exp * 1000 <= now + MINIMUM_ACCESS_VALIDITY_MS) {
    throw authError(authPath, "access token 已过期或将在 60 秒内过期");
  }

  return { access, accountId };
}
