import type { OAuthCredential, OAuthCredentials } from "@earendil-works/pi-ai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const MINIMUM_ACCESS_VALIDITY_MS = 60_000;

interface CodexLiveAuth {
  auth_mode?: unknown;
  tokens?: unknown;
}

interface CodexLiveTokens {
  access_token?: unknown;
  refresh_token?: unknown;
  account_id?: unknown;
}

interface AccessTokenClaims {
  exp?: unknown;
  [OPENAI_AUTH_CLAIM]?: unknown;
}

interface OpenAIAuthClaims {
  chatgpt_account_id?: unknown;
}

export function codexAuthFile(): string {
  const configuredHome = process.env.CODEX_HOME?.trim();
  return path.join(configuredHome ? path.resolve(configuredHome) : path.join(os.homedir(), ".codex"), "auth.json");
}

function authError(authPath: string, detail: string): Error {
  return new Error(
    `无法使用 Codex 本地登录 (${authPath})：${detail}。` +
      "请通过 Codex 更新登录，或在 CC Switch 中重新选择/刷新 OpenAI Official 账号，然后重试。",
  );
}

function requiredString(value: unknown, field: string, authPath: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw authError(authPath, `缺少 ${field}`);
  }
  return value.trim();
}

function parseAccessClaims(accessToken: string, authPath: string): AccessTokenClaims {
  const parts = accessToken.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw authError(authPath, "access token 不是有效 JWT");
  }

  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
      throw new Error("JWT payload must be an object");
    }
    return claims as AccessTokenClaims;
  } catch {
    throw authError(authPath, "access token 的 JWT payload 无法解析");
  }
}

export function readLiveCodexCredential(
  authPath: string = codexAuthFile(),
  now: number = Date.now(),
): OAuthCredential {
  let parsed: CodexLiveAuth;
  try {
    parsed = JSON.parse(fs.readFileSync(authPath, "utf8")) as CodexLiveAuth;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw authError(authPath, `读取失败 (${detail})`);
  }

  if (parsed.auth_mode !== "chatgpt") {
    throw authError(authPath, "auth_mode 不是 chatgpt");
  }
  if (typeof parsed.tokens !== "object" || parsed.tokens === null || Array.isArray(parsed.tokens)) {
    throw authError(authPath, "缺少 tokens 对象");
  }

  const tokens = parsed.tokens as CodexLiveTokens;
  const access = requiredString(tokens.access_token, "tokens.access_token", authPath);
  const refresh = requiredString(tokens.refresh_token, "tokens.refresh_token", authPath);
  const accountId = requiredString(tokens.account_id, "tokens.account_id", authPath);
  const claims = parseAccessClaims(access, authPath);
  const authClaims = claims[OPENAI_AUTH_CLAIM];
  if (typeof authClaims !== "object" || authClaims === null || Array.isArray(authClaims)) {
    throw authError(authPath, `JWT 缺少 ${OPENAI_AUTH_CLAIM} claim`);
  }

  const tokenAccountId = requiredString(
    (authClaims as OpenAIAuthClaims).chatgpt_account_id,
    `${OPENAI_AUTH_CLAIM}.chatgpt_account_id`,
    authPath,
  );
  if (tokenAccountId !== accountId) {
    throw authError(authPath, "tokens.account_id 与 access token 账号不一致");
  }

  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= 0) {
    throw authError(authPath, "JWT 缺少有效 exp claim");
  }
  const expires = claims.exp * 1000;
  if (expires <= now + MINIMUM_ACCESS_VALIDITY_MS) {
    throw authError(authPath, "access token 已过期或将在 60 秒内过期");
  }

  return {
    type: "oauth",
    access,
    refresh,
    expires,
    accountId,
  };
}

interface LiveCodexOAuthConfig {
  name: string;
  isSubscription: boolean;
  login(): Promise<OAuthCredentials>;
  refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials>;
  getApiKey(credentials: OAuthCredentials): string;
}

export function createLiveCodexOAuthConfig(authPath: string = codexAuthFile()): LiveCodexOAuthConfig {
  return {
    name: "OpenAI Codex (Codex 本地凭据)",
    isSubscription: true,
    async login(): Promise<OAuthCredentials> {
      return readLiveCodexCredential(authPath);
    },
    async refreshToken(_credentials, signal): Promise<OAuthCredentials> {
      signal.throwIfAborted();
      return readLiveCodexCredential(authPath);
    },
    getApiKey(_credentials) {
      // Pi 的 credential 只用于满足 OAuth 生命周期。实际请求始终重新读取
      // Codex live auth，因此账号切换无需 /login 或重启 Pi。
      return readLiveCodexCredential(authPath).access;
    },
  };
}
