import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createLiveCodexOAuthConfig, readLiveCodexCredential } from "../extensions/codex-auth.ts";

const NOW = 2_000_000_000_000;
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

function jwt(accountId: string, expiresAt: number = NOW + 3_600_000): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    exp: Math.floor(expiresAt / 1000),
    [OPENAI_AUTH_CLAIM]: { chatgpt_account_id: accountId },
  })}.signature`;
}

function fixture(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codex-auth-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "auth.json");
}

function writeAuth(
  authPath: string,
  accountId: string,
  options: { accessToken?: string; authMode?: string; refreshToken?: string } = {},
): void {
  fs.writeFileSync(
    authPath,
    JSON.stringify({
      auth_mode: options.authMode ?? "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        access_token: options.accessToken ?? jwt(accountId),
        refresh_token: options.refreshToken ?? `refresh-${accountId}`,
        account_id: accountId,
      },
    }),
  );
}

test("reads a valid live ChatGPT credential", (t) => {
  const authPath = fixture(t);
  writeAuth(authPath, "account-a");

  const credential = readLiveCodexCredential(authPath, NOW);

  assert.equal(credential.type, "oauth");
  assert.equal(credential.accountId, "account-a");
  assert.equal(credential.access, jwt("account-a"));
  assert.equal(credential.refresh, "refresh-account-a");
  assert.equal(credential.expires, NOW + 3_600_000);
});

test("getApiKey rereads live auth and ignores a stale Pi credential", (t) => {
  const authPath = fixture(t);
  writeAuth(authPath, "account-a");
  const oauth = createLiveCodexOAuthConfig(authPath);
  const staleCredential = readLiveCodexCredential(authPath, NOW);

  writeAuth(authPath, "account-b");
  const apiKey = oauth.getApiKey(staleCredential);

  assert.equal(apiKey, jwt("account-b"));
});

test("login and refresh both use the current live account", async (t) => {
  const authPath = fixture(t);
  const oauth = createLiveCodexOAuthConfig(authPath);
  const refreshAbort = new AbortController();

  writeAuth(authPath, "account-a");
  const loggedIn = await oauth.login();

  writeAuth(authPath, "account-b");
  const refreshed = await oauth.refreshToken(loggedIn, refreshAbort.signal);

  assert.equal(loggedIn.accountId, "account-a");
  assert.equal(refreshed.accountId, "account-b");
});

test("rejects a missing or malformed live auth file without exposing token content", (t) => {
  const authPath = fixture(t);
  assert.throws(() => readLiveCodexCredential(authPath, NOW), /读取失败/);

  fs.writeFileSync(authPath, "{not-json secret-token-value");
  assert.throws(
    () => readLiveCodexCredential(authPath, NOW),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /读取失败/);
      assert.doesNotMatch(error.message, /secret-token-value/);
      return true;
    },
  );
});

test("rejects non-ChatGPT auth mode and missing token fields", (t) => {
  const authPath = fixture(t);
  writeAuth(authPath, "account-a", { authMode: "apikey" });
  assert.throws(() => readLiveCodexCredential(authPath, NOW), /auth_mode 不是 chatgpt/);

  fs.writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: {} }));
  assert.throws(() => readLiveCodexCredential(authPath, NOW), /tokens\.access_token/);
});

test("rejects expired or nearly expired access tokens", (t) => {
  const authPath = fixture(t);
  writeAuth(authPath, "account-a", { accessToken: jwt("account-a", NOW - 1) });
  assert.throws(() => readLiveCodexCredential(authPath, NOW), /已过期或将在 60 秒内过期/);

  writeAuth(authPath, "account-a", { accessToken: jwt("account-a", NOW + 60_000) });
  assert.throws(() => readLiveCodexCredential(authPath, NOW), /已过期或将在 60 秒内过期/);
});

test("rejects malformed JWTs and missing required claims", (t) => {
  const authPath = fixture(t);
  writeAuth(authPath, "account-a", { accessToken: "not-a-jwt" });
  assert.throws(() => readLiveCodexCredential(authPath, NOW), /不是有效 JWT/);

  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const missingClaims = `${encode({ alg: "none" })}.${encode({ exp: Math.floor((NOW + 3_600_000) / 1000) })}.sig`;
  writeAuth(authPath, "account-a", { accessToken: missingClaims });
  assert.throws(() => readLiveCodexCredential(authPath, NOW), /JWT 缺少/);
});

test("rejects account identity mismatches", (t) => {
  const authPath = fixture(t);
  writeAuth(authPath, "account-a", { accessToken: jwt("account-b") });

  assert.throws(() => readLiveCodexCredential(authPath, NOW), /账号不一致/);
});
