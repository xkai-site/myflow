import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { codexAuthFile, readCodexUsageCredential } from "../extensions/codex-auth.ts";

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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-usage-openai-auth-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "auth.json");
}

function writeAuth(authPath: string, accountId: string, options: { accessToken?: string; authMode?: string } = {}): void {
  fs.writeFileSync(authPath, JSON.stringify({
    auth_mode: options.authMode ?? "chatgpt",
    tokens: {
      access_token: options.accessToken ?? jwt(accountId),
      account_id: accountId,
    },
  }));
}

test("reads a valid live ChatGPT usage credential without requiring a refresh token", (t) => {
  const authPath = fixture(t);
  writeAuth(authPath, "account-a");
  assert.deepEqual(readCodexUsageCredential(authPath, NOW), {
    access: jwt("account-a"),
    accountId: "account-a",
  });
});

test("rejects a missing or malformed auth file without exposing token content", (t) => {
  const authPath = fixture(t);
  assert.throws(() => readCodexUsageCredential(authPath, NOW), /读取失败/);
  fs.writeFileSync(authPath, "{not-json secret-token-value");
  assert.throws(() => readCodexUsageCredential(authPath, NOW), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /读取失败/);
    assert.doesNotMatch(error.message, /secret-token-value/);
    return true;
  });
});

test("rejects non-ChatGPT auth mode and missing token fields", (t) => {
  const authPath = fixture(t);
  writeAuth(authPath, "account-a", { authMode: "apikey" });
  assert.throws(() => readCodexUsageCredential(authPath, NOW), /auth_mode 不是 chatgpt/);
  fs.writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: {} }));
  assert.throws(() => readCodexUsageCredential(authPath, NOW), /tokens\.access_token/);
});

test("rejects expired or nearly expired access tokens", (t) => {
  const authPath = fixture(t);
  writeAuth(authPath, "account-a", { accessToken: jwt("account-a", NOW - 1) });
  assert.throws(() => readCodexUsageCredential(authPath, NOW), /已过期或将在 60 秒内过期/);
  writeAuth(authPath, "account-a", { accessToken: jwt("account-a", NOW + 60_000) });
  assert.throws(() => readCodexUsageCredential(authPath, NOW), /已过期或将在 60 秒内过期/);
});

test("rejects malformed JWTs and missing required claims", (t) => {
  const authPath = fixture(t);
  writeAuth(authPath, "account-a", { accessToken: "not-a-jwt" });
  assert.throws(() => readCodexUsageCredential(authPath, NOW), /不是有效 JWT/);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = `${encode({ alg: "none" })}.${encode({ exp: Math.floor((NOW + 3_600_000) / 1000) })}.sig`;
  writeAuth(authPath, "account-a", { accessToken: token });
  assert.throws(() => readCodexUsageCredential(authPath, NOW), /JWT 缺少/);
});

test("uses CODEX_HOME when resolving auth.json", (t) => {
  const previous = process.env.CODEX_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  });
  process.env.CODEX_HOME = "relative-codex";
  assert.equal(codexAuthFile(), path.join(path.resolve("relative-codex"), "auth.json"));
  delete process.env.CODEX_HOME;
  assert.equal(codexAuthFile(), path.join(os.homedir(), ".codex", "auth.json"));
});

test("rejects account identity mismatches", (t) => {
  const authPath = fixture(t);
  writeAuth(authPath, "account-a", { accessToken: jwt("account-b") });
  assert.throws(() => readCodexUsageCredential(authPath, NOW), /账号不一致/);
});
