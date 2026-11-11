/** Offline credential contracts. No SDK, native binding, SMTP, DNS or user configuration. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createQqCredentials, QQ_AUTH_ENV } from "../src/mail/credentials.ts";
import { systemCredentialStore, QQ_VAULT_SERVICE, QQ_VAULT_ACCOUNT } from "../src/infrastructure/keyring.ts";
import { emailReadiness } from "../src/channels.ts";
import { defaultConfig } from "../src/config.ts";
let passed = 0;
function step(name, run) { run(); passed++; console.log(`  ✓ ${name}`); }
function memory() {
  let value, failure;
  const calls = [];
  const check = (op) => { calls.push(op); if (failure === op) throw new Error("fake-sensitive-raw-diagnostic"); };
  return { calls, fail: (op) => { failure = op; }, store: {
    status: () => ({ available: true }), get() { check("read"); return value; },
    set(next) { check("write"); value = next; }, delete() { check("delete"); value = undefined; },
  } };
}
step("Windows/macOS/Linux use native entries through the same contract; Linux requires persistent Secret Service", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    let value, constructions = 0;
    const store = systemCredentialStore(() => ({ Entry: class {
      constructor(service, account, options) {
        constructions++;
        assert.equal(service, QQ_VAULT_SERVICE); assert.equal(account, QQ_VAULT_ACCOUNT);
        assert.deepEqual(options, { linux: { store: "secret-service" } });
        // Represents the native binding selecting its trusted OS backend, not application dispatch.
        assert.ok(["win32", "darwin", "linux"].includes(platform));
      }
      getPassword() { return value ?? null; }
      setPassword(next) { value = next; }
      deletePassword() { value = undefined; }
    } }));
    assert.equal(constructions, 0, "native binding must be lazy");
    const core = createQqCredentials(store, () => undefined);
    assert.equal(core.status().state, "missing");
    assert.equal(core.save("fake-native-code").ok, true);
    assert.equal(core.read().value, "fake-native-code");
    assert.equal(core.delete().ok, true);
    assert.equal(core.status().state, "missing");
    assert.equal(constructions, 1);
  }
});
step("No system service/native module: explicit unavailable result, safe injection, no file fallback", () => {
  let unavailable = true;
  const fake = memory();
  const store = systemCredentialStore(() => {
    if (unavailable) throw new Error("fake-sensitive-raw-diagnostic");
    return { Entry: class {
      getPassword() { return fake.store.get() ?? null; }
      setPassword(value) { fake.store.set(value); }
      deletePassword() { fake.store.delete(); }
    } };
  });
  const core = createQqCredentials(store, () => undefined);
  assert.equal(core.status().state, "unavailable");
  for (const result of [core.status(), core.save("fake-code"), core.delete()]) {
    assert.match(JSON.stringify(result), /Secret Service/);
    assert.match(JSON.stringify(result), new RegExp(QQ_AUTH_ENV));
    assert.doesNotMatch(JSON.stringify(result), /fake-sensitive/);
  }
  const injected = createQqCredentials(store, () => "fake-injected");
  assert.equal(injected.read().value, "fake-injected");
  assert.equal(injected.status().source, "environment");
  unavailable = false;
  assert.equal(core.save("fake-recovered").ok, true, "service availability can recover without restart");
});
step("Explicit environment wins; deleting/updating vault never mutates injection and never reads the vault for delivery", () => {
  const fake = memory(); let injected = "fake-env";
  const core = createQqCredentials(fake.store, () => injected);
  assert.equal(core.save("fake-vault").ok, true);
  fake.calls.length = 0;
  assert.equal(core.read().value, "fake-env"); assert.deepEqual(fake.calls, []);
  fake.fail("read"); assert.equal(core.read().value, "fake-env");
  fake.fail(undefined);
  assert.match(core.delete().message, /注入来源单独移除/);
  assert.equal(core.read().value, "fake-env");
  injected = undefined;
  assert.equal(core.status().state, "missing");
  assert.equal(core.save("fake-new-vault").ok, true);
  assert.equal(core.read().value, "fake-new-vault");
  assert.equal(core.status().source, "vault");
});
step("Malformed explicit injection is rejected without falling back to the vault", () => {
  const fake = memory(); fake.store.set("fake-stored"); fake.calls.length = 0;
  const core = createQqCredentials(fake.store, () => "fake invalid\n");
  assert.equal(core.status().state, "read-failed");
  assert.equal(core.read().value, undefined);
  assert.deepEqual(fake.calls, []);
  assert.doesNotMatch(JSON.stringify(core.status()), /fake invalid|fake-stored/);
});
step("Read/write/delete failures stay distinct and never expose native diagnostics or secrets", () => {
  const fake = memory(), core = createQqCredentials(fake.store, () => undefined);
  assert.equal(core.save("fake-old").ok, true);
  for (const [operation, run, expected] of [
    ["read", () => core.status(), /读取失败/],
    ["write", () => core.save("fake-new"), /保存.*失败/],
    ["delete", () => core.delete(), /删除.*失败/],
  ]) {
    fake.fail(operation);
    const result = run();
    assert.match(result.message, expected);
    assert.doesNotMatch(JSON.stringify(result), /fake-sensitive|fake-old|fake-new/);
  }
  fake.fail(undefined);
  assert.equal(core.read().value, "fake-old", "failed writes/deletes do not pretend success");
  fake.fail("read");
  const failedVerification = core.save("fake-verification");
  assert.equal(failedVerification.ok, false);
  assert.doesNotMatch(JSON.stringify(failedVerification), /fake-verification|fake-sensitive/);
});
step("Silent failed write/delete is detected by fresh reads; mutation attempts invalidate prior test state", () => {
  const store = { status: () => ({ available: true }), get: () => "fake-unchanged", set() {}, delete() {} };
  const core = createQqCredentials(store, () => undefined), before = core.status().revision;
  assert.equal(core.save("fake-replacement").ok, false);
  assert.ok(core.status().revision > before);
  assert.equal(core.delete().ok, false);
  assert.ok(core.status().revision > before + 1);
  for (const value of ["", "has space", "line\nbreak", "x".repeat(129)]) assert.equal(core.save(value).ok, false);
});
step("Readiness distinguishes addresses, code, unavailable store, off, unused, and in-use", () => {
  const config = defaultConfig(), fake = memory(), core = createQqCredentials(fake.store, () => undefined);
  const email = config.providers.find((p) => p.id === "email");
  assert.match(emailReadiness(config, core.status()).label, /发件地址/);
  email.options.from = "fake@qq.com";
  assert.match(emailReadiness(config, core.status()).label, /收件地址/);
  email.options.to = ["reader@example.com"];
  assert.match(emailReadiness(config, core.status()).label, /缺授权码/);
  fake.fail("read"); assert.match(emailReadiness(config, core.status()).label, /凭据读取失败/);
  fake.fail(undefined); core.save("fake-ready");
  assert.match(emailReadiness(config, core.status()).label, /配置就绪但渠道关闭/);
  email.enabled = true; assert.match(emailReadiness(config, core.status()).label, /渠道开启但未被规则使用/);
  config.channels = ["email"]; assert.match(emailReadiness(config, core.status()).label, /已就绪且正在被规则使用/);
});
step("Core and native boundary cannot import Pi or dispatch by platform; no home-grown encryption", () => {
  const core = fs.readFileSync(new URL("../src/mail/credentials.ts", import.meta.url), "utf8");
  const native = fs.readFileSync(new URL("../src/infrastructure/keyring.ts", import.meta.url), "utf8");
  assert.doesNotMatch(core, /process\.|node:|pi-coding-agent|pi-tui|keyring|writeFile|encrypt/);
  assert.doesNotMatch(native, /process.platform|win32|explorer|writeFile|encrypt/);
});
console.log(`Credentials: ${passed} passed`);
