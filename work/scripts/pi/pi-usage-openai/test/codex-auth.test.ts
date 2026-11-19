import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { codexAuthFile, queryCodexUsage } from "../extensions/codex-auth.ts";
import type { UsageFetch } from "../extensions/codex-usage.ts";

const NOW = 2_000_000_000_000;
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const NO_FETCH: UsageFetch = async () => assert.fail("no request expected");

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

function writeAuth(authPath: string, accountId: string, options: {
  accessToken?: string; refreshToken?: string; authMode?: string; provenance?: object;
} = {}) {
  const auth = {
    auth_mode: options.authMode ?? "chatgpt",
    OPENAI_API_KEY: null,
    last_refresh: "2026-01-01T00:00:00.000Z",
    tokens: {
      access_token: options.accessToken ?? jwt(accountId),
      refresh_token: options.refreshToken,
      id_token: "original-id-token",
      account_id: accountId,
      oauth_provenance: options.provenance,
      other_field: "preserved",
    },
  };
  const content = JSON.stringify(auth);
  fs.writeFileSync(authPath, content);
  return content;
}

function hasUsageRequest(input: string | URL | Request, init: RequestInit | undefined, token: string, accountId = "account-a") {
  assert.equal(input, USAGE_URL);
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${token}`);
  assert.equal(headers.get("chatgpt-account-id"), accountId);
}

test("uses a live ChatGPT access token without requiring a refresh token or writing auth.json", async (t) => {
  const authPath = fixture(t);
  const original = writeAuth(authPath, "account-a");
  assert.deepEqual(await queryCodexUsage(authPath, async (input, init) => {
    hasUsageRequest(input, init, jwt("account-a"));
    return Response.json({ plan_type: "plus" });
  }, () => NOW), { plan_type: "plus" });
  assert.equal(fs.readFileSync(authPath, "utf8"), original);
});

test("rejects a missing or malformed auth file without exposing token content", async (t) => {
  const authPath = fixture(t);
  await assert.rejects(queryCodexUsage(authPath, NO_FETCH), /读取失败/);
  fs.writeFileSync(authPath, '{"tokens":{"access_token":"secret-token-value"}, invalid}');
  await assert.rejects(queryCodexUsage(authPath, NO_FETCH), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /读取失败/);
    assert.doesNotMatch(error.message, /secret-token-value/);
    return true;
  });
});

test("rejects non-ChatGPT auth mode and missing token fields", async (t) => {
  const authPath = fixture(t);
  writeAuth(authPath, "account-a", { authMode: "apikey" });
  await assert.rejects(queryCodexUsage(authPath, NO_FETCH), /auth_mode 不是 chatgpt/);
  fs.writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "account-a" } }));
  await assert.rejects(queryCodexUsage(authPath, NO_FETCH), /tokens\.access_token/);
});

test("rejects malformed JWTs, missing claims, and account mismatches without refreshing", async (t) => {
  const authPath = fixture(t);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const [accessToken, reason] of [
    ["not-a-jwt", /不是有效 JWT/],
    [`${encode({ alg: "none" })}.${encode({ exp: (NOW + 3_600_000) / 1000 })}.sig`, /JWT 缺少/],
    [jwt("account-b"), /账号不一致/],
  ] as const) {
    writeAuth(authPath, "account-a", { accessToken, refreshToken: "old-refresh" });
    await assert.rejects(queryCodexUsage(authPath, NO_FETCH, () => NOW), reason);
  }
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

test("refreshes expired or nearly expired access before querying, persisting rotation for future runs", async (t) => {
  const authPath = fixture(t);
  const nextAccess = jwt("account-a");
  for (const expiration of [NOW - 1000, NOW + 60_000]) {
    const original = JSON.parse(writeAuth(authPath, "account-a", {
      accessToken: jwt("account-a", expiration), refreshToken: "old-refresh",
    }));
    const urls: unknown[] = [];
    const fetchImpl: UsageFetch = async (input, init) => {
      urls.push(input);
      if (input === TOKEN_URL) {
        assert.equal(init?.method, "POST");
        assert.equal(init?.redirect, "error");
        assert.ok(init?.signal instanceof AbortSignal);
        assert.equal(new Headers(init?.headers).get("Content-Type"), "application/json");
        assert.deepEqual(JSON.parse(String(init?.body)), {
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
          grant_type: "refresh_token",
          refresh_token: "old-refresh",
        });
        return Response.json({ access_token: nextAccess, id_token: "new-id", refresh_token: "rotated-refresh" });
      }
      hasUsageRequest(input, init, nextAccess);
      assert.deepEqual(JSON.parse(fs.readFileSync(authPath, "utf8")), {
        ...original,
        last_refresh: new Date(NOW).toISOString(),
        tokens: { ...original.tokens, access_token: nextAccess, id_token: "new-id", refresh_token: "rotated-refresh" },
      });
      return Response.json({ plan_type: "plus" });
    };
    assert.deepEqual(await queryCodexUsage(authPath, fetchImpl, () => NOW), { plan_type: "plus" });
    await queryCodexUsage(authPath, fetchImpl, () => NOW);
    assert.deepEqual(urls, [TOKEN_URL, USAGE_URL, USAGE_URL]);
    assert.deepEqual(fs.readdirSync(path.dirname(authPath)), ["auth.json"]);
    if (process.platform !== "win32") assert.equal(fs.statSync(authPath).mode & 0o777, 0o600);
  }
});

test("on 401, refreshes once and retries usage once, keeping omitted optional token fields", async (t) => {
  const authPath = fixture(t);
  const original = JSON.parse(writeAuth(authPath, "account-a", { refreshToken: "old-refresh" }));
  const nextAccess = jwt("account-a", NOW + 7_200_000);
  const urls: unknown[] = [];
  const fetchImpl: UsageFetch = async (input, init) => {
    urls.push(input);
    if (urls.length === 1) {
      hasUsageRequest(input, init, original.tokens.access_token);
      return Response.json({ error: { code: "token_expired" } }, { status: 401 });
    }
    if (input === TOKEN_URL) return Response.json({ access_token: nextAccess });
    hasUsageRequest(input, init, nextAccess);
    return Response.json({ plan_type: "pro" });
  };
  assert.deepEqual(await queryCodexUsage(authPath, fetchImpl, () => NOW), { plan_type: "pro" });
  assert.deepEqual(urls, [USAGE_URL, TOKEN_URL, USAGE_URL]);
  assert.deepEqual(JSON.parse(fs.readFileSync(authPath, "utf8")).tokens, { ...original.tokens, access_token: nextAccess });
});

test("stops after a second 401 instead of classifying it as refresh-token expiry", async (t) => {
  const authPath = fixture(t);
  writeAuth(authPath, "account-a", { refreshToken: "old-refresh" });
  const urls: unknown[] = [];
  await assert.rejects(queryCodexUsage(authPath, async (input) => {
    urls.push(input);
    return input === TOKEN_URL ? Response.json({ access_token: jwt("account-a", NOW + 7_200_000) })
      : new Response("unrecognized failure", { status: 401 });
  }, () => NOW), /使用更新后的凭据查询仍失败.*401.*未返回可识别的认证原因/);
  assert.deepEqual(urls, [USAGE_URL, TOKEN_URL, USAGE_URL]);
});

test("does not refresh a revoked session or non-401 usage failure", async (t) => {
  const authPath = fixture(t);
  const original = writeAuth(authPath, "account-a", { refreshToken: "old-refresh" });
  for (const [status, reason] of [[401, /凭据已撤销或失效.*重新登录/], [403, /无权/], [429, /频繁/]] as const) {
    await assert.rejects(queryCodexUsage(authPath, async (input) => {
      assert.equal(input, USAGE_URL);
      return Response.json({ error: { type: "token_revoked" } }, { status });
    }, () => NOW), reason);
  }
  assert.equal(fs.readFileSync(authPath, "utf8"), original);
});

test("reports that an expired credential without a refresh token cannot be renewed", async (t) => {
  const authPath = fixture(t);
  writeAuth(authPath, "account-a", { accessToken: jwt("account-a", NOW - 1000) });
  await assert.rejects(queryCodexUsage(authPath, NO_FETCH, () => NOW), /缺少 tokens\.refresh_token.*重新登录/);
});

test("does not send a token issued by a different OAuth authority to the default endpoint", async (t) => {
  const authPath = fixture(t);
  writeAuth(authPath, "account-a", {
    accessToken: jwt("account-a", NOW - 1000), refreshToken: "old-refresh",
    provenance: { issuer: "https://example.com", client_id: "other-client" },
  });
  await assert.rejects(queryCodexUsage(authPath, NO_FETCH, () => NOW), /不是由默认 OpenAI OAuth 客户端签发/);
});

test("classifies terminal refresh failures without exposing credentials or changing the file", async (t) => {
  const authPath = fixture(t);
  const original = writeAuth(authPath, "account-a", {
    accessToken: jwt("account-a", NOW - 1000), refreshToken: "old-refresh",
  });
  for (const [status, error, reason] of [
    [401, { code: "refresh_token_expired" }, /refresh token 已过期/],
    [400, { code: "refresh_token_reused" }, /refresh token 已被使用/],
    [401, { code: "refresh_token_invalidated" }, /refresh token 已被撤销/],
    [400, "invalid_grant", /refresh token 无效/],
  ] as const) {
    let requests = 0;
    await assert.rejects(queryCodexUsage(authPath, async (input) => {
      requests++;
      assert.equal(input, TOKEN_URL);
      return Response.json({ error, error_description: "echo of old-refresh, private remote detail" }, { status });
    }, () => NOW), (failure: unknown) => {
      assert.ok(failure instanceof Error);
      assert.match(failure.message, reason);
      assert.match(failure.message, /重新登录/);
      assert.doesNotMatch(failure.message, /old-refresh|private remote detail/);
      return true;
    });
    assert.equal(requests, 1);
    assert.equal(fs.readFileSync(authPath, "utf8"), original);
    assert.deepEqual(fs.readdirSync(path.dirname(authPath)), ["auth.json"]);
  }
});

test("reports refresh outages and unknown rejection without demanding re-login or using the stale access token", async (t) => {
  const authPath = fixture(t);
  const original = writeAuth(authPath, "account-a", {
    accessToken: jwt("account-a", NOW - 1000), refreshToken: "old-refresh",
  });
  const failures = [
    [() => new Response("private remote detail", { status: 503 }), /HTTP 503.*稍后重试/],
    [() => Response.json({ error: { code: "old-refresh" } }, { status: 401 }), /HTTP 401.*未返回可识别/],
    [() => { throw new DOMException("old-refresh", "TimeoutError"); }, /续期超时/],
    [() => { throw new Error("old-refresh"); }, /检查网络/],
  ] as const;
  for (const [response, reason] of failures) {
    await assert.rejects(queryCodexUsage(authPath, async (input) => {
      assert.equal(input, TOKEN_URL);
      return response();
    }, () => NOW), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, reason);
      assert.doesNotMatch(error.message, /重新登录|old-refresh|private remote detail/);
      return true;
    });
    assert.equal(fs.readFileSync(authPath, "utf8"), original);
  }
});

test("does not persist a malformed refresh response or a token for a different account", async (t) => {
  const authPath = fixture(t);
  const original = writeAuth(authPath, "account-a", {
    accessToken: jwt("account-a", NOW - 1000), refreshToken: "old-refresh",
  });
  for (const [response, reason] of [
    [new Response("private remote detail"), /无效的凭据响应/],
    [Response.json({ access_token: jwt("account-b"), refresh_token: "new-refresh" }), /账号不一致/],
    [Response.json({ access_token: jwt("account-a", NOW - 1000) }), /已过期或即将过期/],
  ] as const) {
    await assert.rejects(queryCodexUsage(authPath, async (input) => {
      assert.equal(input, TOKEN_URL);
      return response;
    }, () => NOW), reason);
    assert.equal(fs.readFileSync(authPath, "utf8"), original);
  }
});

test("reuses a concurrently persisted same-account token after rotation by another writer", async (t) => {
  const authPath = fixture(t);
  writeAuth(authPath, "account-a", { accessToken: jwt("account-a", NOW - 1000), refreshToken: "old-refresh" });
  let replacement: string | undefined;
  let refreshRequests = 0;
  await queryCodexUsage(authPath, async (input, init) => {
    if (input === TOKEN_URL) {
      refreshRequests++;
      replacement = writeAuth(authPath, "account-a", { refreshToken: "other-writer-refresh" });
      return Response.json({ error: { code: "refresh_token_reused" } }, { status: 401 });
    }
    hasUsageRequest(input, init, jwt("account-a"));
    return Response.json({ plan_type: "plus" });
  }, () => NOW);
  assert.equal(refreshRequests, 1);
  assert.equal(fs.readFileSync(authPath, "utf8"), replacement);
});

test("does not overwrite a different account signed in while refresh is in flight", async (t) => {
  const authPath = fixture(t);
  writeAuth(authPath, "account-a", { accessToken: jwt("account-a", NOW - 1000), refreshToken: "old-refresh" });
  let replacement: string | undefined;
  await assert.rejects(queryCodexUsage(authPath, async (input) => {
    assert.equal(input, TOKEN_URL);
    replacement = writeAuth(authPath, "account-b", { refreshToken: "other-account-refresh" });
    return Response.json({ access_token: jwt("account-a"), refresh_token: "rotated-refresh" });
  }, () => NOW), /登录文件已在查询期间变更.*未覆盖/);
  assert.equal(fs.readFileSync(authPath, "utf8"), replacement);
});

test("shares an in-flight refresh across concurrent usage queries in the same Pi process", async (t) => {
  const authPath = fixture(t);
  writeAuth(authPath, "account-a", { accessToken: jwt("account-a", NOW - 1000), refreshToken: "old-refresh" });
  const { promise, resolve } = Promise.withResolvers<Response>();
  const urls: unknown[] = [];
  const fetchImpl: UsageFetch = async (input, init) => {
    urls.push(input);
    if (input === TOKEN_URL) return promise;
    hasUsageRequest(input, init, jwt("account-a"));
    return Response.json({ plan_type: "plus" });
  };
  const first = queryCodexUsage(authPath, fetchImpl, () => NOW);
  const second = queryCodexUsage(authPath, fetchImpl, () => NOW);
  resolve(Response.json({ access_token: jwt("account-a"), refresh_token: "rotated-refresh" }));
  await Promise.all([first, second]);
  assert.deepEqual(urls, [TOKEN_URL, USAGE_URL, USAGE_URL]);
});
