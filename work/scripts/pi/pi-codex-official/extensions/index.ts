/**
 * OpenAI Codex 官方 (ChatGPT 账号 OAuth) 接入 pi.
 *
 * 背景:
 *  - cc-switch 的 "codex / OpenAI Official" 走 ChatGPT 账号 OAuth(auth_mode=chatgpt),
 *    凭据是会话令牌而非 API key, pi-ccs 无法直连 -> pi 里原本不可用。
 *  - 本扩展复用 cc-switch 托管的 refresh_token(
 *    ~/.cc-switch/codex_oauth_auth.json), 通过官方 OAuth 端点刷新出 access_token,
 *    由 pi 内置的 openai-codex-responses API(默认
 *    https://chatgpt.com/backend-api/codex/responses)完成流式对话。
 *
 * 关键事实(来自 cc-switch 源码 codex_oauth_auth.rs 与实测):
 *  - OAuth client_id 是官方客户端的公开应用标识，不是用户凭据。
 *  - 刷新必须带正确 scope，否则令牌会缺少 api.responses.write 权限。
 *    (实测 → 401 Missing scopes)
 *  - refresh_token 一次性/轮换: 刷新后旧 token 失效(refresh_token_reused)。
 *  - Pi 的 auth.json 仅作一级缓存；缓存明确失效时，只回退到 cc-switch 当前
 *    default_account_id 对应账号。刷新成功后同步回写该账号的 refresh_token。
 *    注意: cc-switch 与 Pi 同时刷新同一账号时仍可能发生跨进程竞争。
 *  - 上游是 chatgpt.com 后端(openai-codex-responses 已处理 store:false /
 *    stream:true / zstd / WebSocket 等全部细节), 不是 api.openai.com。
 *  - 可用模型及上下文参数统一维护在 ../config/models.json。
 *
 * 依赖: node 内置 + 全局 fetch。pi 的 outbound 通过 EnvHttpProxyAgent 使用
 * settings.json 的 httpProxy(Clash 等), 需代理可达 auth.openai.com/chatgpt.com。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_SCOPES = "openid profile email";
const BASE_URL = "https://chatgpt.com/backend-api";
const OAUTH_TIMEOUT_MS = 30_000;

interface LocalModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

const CONFIG_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "config",
);

function readModels(): LocalModelConfig[] {
  const configPath = path.join(CONFIG_DIR, "models.json");
  try {
    const data = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error("根节点必须是非空数组");
    }
    const models = data.map((value, index) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`第 ${index + 1} 个模型必须是对象`);
      }
      const model = value as Partial<LocalModelConfig>;
      const cost = model.cost as Partial<LocalModelConfig["cost"]> | undefined;
      if (
        typeof model.id !== "string" ||
        model.id.trim() === "" ||
        typeof model.name !== "string" ||
        model.name.trim() === "" ||
        typeof model.reasoning !== "boolean" ||
        !Array.isArray(model.input) ||
        model.input.length === 0 ||
        !model.input.every((item) => item === "text" || item === "image") ||
        typeof model.contextWindow !== "number" ||
        model.contextWindow <= 0 ||
        typeof model.maxTokens !== "number" ||
        model.maxTokens <= 0 ||
        !cost ||
        typeof cost.input !== "number" ||
        typeof cost.output !== "number" ||
        typeof cost.cacheRead !== "number" ||
        typeof cost.cacheWrite !== "number"
      ) {
        throw new Error(`第 ${index + 1} 个模型配置不完整或类型错误`);
      }
      return model as LocalModelConfig;
    });
    const ids = new Set(models.map((model) => model.id));
    if (ids.size !== models.length) {
      throw new Error("模型 id 不能重复");
    }
    return models;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取模型配置 ${configPath}。原因: ${detail}`);
  }
}

const MODELS = readModels();

interface CodexOAuthCredentials extends OAuthCredentials {
  accountId?: string;
}

interface CcSwitchAccount {
  refresh_token?: string;
  token_updated_at_ms?: number;
}

interface CcSwitchAuthStore {
  default_account_id?: string;
  accounts?: Record<string, CcSwitchAccount>;
}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

class OAuthRefreshError extends Error {
  constructor(
    message: string,
    readonly tokenInvalid: boolean,
  ) {
    super(message);
    this.name = "OAuthRefreshError";
  }
}

/** cc-switch 的 Codex OAuth 账号文件，也是回退凭据的唯一标准源。 */
function ccsAuthFile(): string {
  return path.join(os.homedir(), ".cc-switch", "codex_oauth_auth.json");
}

/** 只读取 cc-switch 当前选中的默认账号，不回退到其他账号或数据库。 */
function readSelectedCcSwitchAccount(): { refreshToken: string; accountId: string } {
  const configPath = ccsAuthFile();
  let data: CcSwitchAuthStore;
  try {
    data = JSON.parse(fs.readFileSync(configPath, "utf8")) as CcSwitchAuthStore;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取 cc-switch OAuth 文件 ${configPath}。原因: ${detail}`);
  }

  const accountId = data.default_account_id?.trim();
  if (!accountId) {
    throw new Error("cc-switch 尚未设置默认 Codex OAuth 账号");
  }
  const refreshToken = data.accounts?.[accountId]?.refresh_token?.trim();
  if (!refreshToken) {
    throw new Error(`cc-switch 当前 Codex 账号 ${accountId} 没有 refresh_token`);
  }
  return { refreshToken, accountId };
}

type SyncResult = "updated" | "unchanged" | "conflict" | "account-missing" | "failed";

/**
 * 以旧 token 为 CAS 条件原子回写新 token，避免覆盖 cc-switch 已写入的更新一代。
 * 回写失败不能丢弃 OpenAI 已签发的新 token，因此由 Pi 继续缓存并输出警告。
 */
function syncCcSwitchRefreshToken(
  accountId: string,
  usedRefreshToken: string,
  newRefreshToken: string,
): SyncResult {
  if (newRefreshToken === usedRefreshToken) return "unchanged";

  const configPath = ccsAuthFile();
  let tempPath = "";
  try {
    const data = JSON.parse(fs.readFileSync(configPath, "utf8")) as CcSwitchAuthStore;
    const account = data.accounts?.[accountId];
    if (!account) return "account-missing";
    if (account.refresh_token === newRefreshToken) return "unchanged";
    if (account.refresh_token !== usedRefreshToken) return "conflict";

    account.refresh_token = newRefreshToken;
    account.token_updated_at_ms = Date.now();

    tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
    const mode = fs.statSync(configPath).mode;
    fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode });
    fs.renameSync(tempPath, configPath);
    return "updated";
  } catch {
    return "failed";
  } finally {
    if (tempPath) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {}
    }
  }
}

function warnIfSyncFailed(result: SyncResult, accountId: string): void {
  if (result === "conflict") {
    console.warn(
      `[pi-codex-official] cc-switch 账号 ${accountId} 已出现更新一代 token，未覆盖其凭据。`,
    );
  } else if (result === "account-missing" || result === "failed") {
    console.warn(
      `[pi-codex-official] 无法同步 cc-switch 账号 ${accountId} 的 refresh token；` +
        "Pi 将暂时使用 auth.json 中的新 token。",
    );
  }
}

function extractOAuthErrorCode(text: string): string {
  try {
    const data = JSON.parse(text) as {
      code?: unknown;
      error?: unknown | { code?: unknown };
    };
    if (typeof data.error === "string") return data.error.toLowerCase();
    if (data.error && typeof data.error === "object") {
      const code = (data.error as { code?: unknown }).code;
      if (typeof code === "string") return code.toLowerCase();
    }
    if (typeof data.code === "string") return data.code.toLowerCase();
  } catch {}
  return "";
}

async function exchange(
  refreshToken: string,
  signal?: AbortSignal,
): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    scope: OAUTH_SCOPES,
  });
  const timeoutSignal = AbortSignal.timeout(OAUTH_TIMEOUT_MS);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "pi-codex-official/0.1.0",
    },
    body,
    signal: requestSignal,
  });
  const text = await res.text();
  if (!res.ok) {
    const code = extractOAuthErrorCode(text);
    const tokenInvalid =
      res.status === 401 ||
      res.status === 403 ||
      /refresh_token_(reused|invalidated|expired)|invalid_grant/.test(code);
    throw new OAuthRefreshError(
      `OpenAI OAuth 刷新失败：HTTP ${res.status}${code ? ` (${code})` : ""}`,
      tokenInvalid,
    );
  }

  let data: Partial<OAuthTokenResponse>;
  try {
    data = JSON.parse(text) as Partial<OAuthTokenResponse>;
  } catch {
    throw new Error("OpenAI OAuth 刷新响应不是有效 JSON");
  }
  if (typeof data.access_token !== "string" || data.access_token.trim() === "") {
    throw new Error("OpenAI OAuth 刷新响应缺少 access_token");
  }
  return {
    access_token: data.access_token,
    refresh_token:
      typeof data.refresh_token === "string" && data.refresh_token.trim()
        ? data.refresh_token
        : undefined,
    expires_in:
      typeof data.expires_in === "number" && data.expires_in > 0
        ? data.expires_in
        : undefined,
  };
}

function toCredentials(
  tokens: OAuthTokenResponse,
  usedRefreshToken: string,
  accountId?: string,
): CodexOAuthCredentials {
  const refresh = tokens.refresh_token ?? usedRefreshToken;
  const expiresIn = tokens.expires_in ?? 3600;
  const refreshBufferSeconds = Math.min(60, Math.floor(expiresIn / 10));
  return {
    refresh,
    access: tokens.access_token,
    expires: Date.now() + (expiresIn - refreshBufferSeconds) * 1000,
    ...(accountId ? { accountId } : {}),
  };
}

async function refreshAndSync(
  refreshToken: string,
  accountId: string | undefined,
  signal?: AbortSignal,
): Promise<CodexOAuthCredentials> {
  const tokens = await exchange(refreshToken, signal);
  if (accountId && tokens.refresh_token) {
    const result = syncCcSwitchRefreshToken(accountId, refreshToken, tokens.refresh_token);
    warnIfSyncFailed(result, accountId);
  }
  return toCredentials(tokens, refreshToken, accountId);
}

function cachedAccountId(credentials: OAuthCredentials): string | undefined {
  if (typeof credentials.accountId === "string" && credentials.accountId.trim()) {
    return credentials.accountId.trim();
  }
  // 兼容升级前没有 accountId 的 Pi 缓存：仅在 token 与当前账号一致时安全关联。
  try {
    const selected = readSelectedCcSwitchAccount();
    return selected.refreshToken === credentials.refresh ? selected.accountId : undefined;
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("openai-codex", {
    name: "OpenAI Codex (ChatGPT 官方)",
    baseUrl: BASE_URL,
    api: "openai-codex-responses",
    authHeader: true,
    oauth: {
      name: "OpenAI Codex (ChatGPT 账号, cc-switch 令牌)",
      async login(): Promise<OAuthCredentials> {
        const selected = readSelectedCcSwitchAccount();
        return refreshAndSync(selected.refreshToken, selected.accountId);
      },
      async refreshToken(
        credentials: OAuthCredentials,
        signal?: AbortSignal,
      ): Promise<OAuthCredentials> {
        // Pi auth.json 是一级缓存：先刷新自身 token，并尽可能同步回原账号。
        try {
          return await refreshAndSync(
            credentials.refresh,
            cachedAccountId(credentials),
            signal,
          );
        } catch (error) {
          // 只有缓存 token 明确失效时，才采用 cc-switch 当前默认账号；网络、
          // 超时、限流及服务端错误均直接上抛，避免无意义地消费另一枚 token。
          if (!(error instanceof OAuthRefreshError) || !error.tokenInvalid) {
            throw error;
          }
          const selected = readSelectedCcSwitchAccount();
          if (selected.refreshToken === credentials.refresh) {
            throw error;
          }
          return refreshAndSync(selected.refreshToken, selected.accountId, signal);
        }
      },
      getApiKey(credentials: OAuthCredentials): string {
        return credentials.access;
      },
    },
    models: MODELS,
  });
}