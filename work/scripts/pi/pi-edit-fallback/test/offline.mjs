// Reproduce verification without personal config, project node_modules, cached npm packages or network.
// Only the explicitly prepared SDK installation and TypeScript compiler are reused, read-only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSdk } from "./sdk.mjs";

const sdk = resolveSdk();
const compiler = process.env.PI_TSC && path.resolve(process.env.PI_TSC);
const npm = process.env.npm_execpath;
if (!compiler || !existsSync(compiler)) throw new Error("Prepare TypeScript first; set PI_TSC to typescript/bin/tsc (see README).");
if (!npm || !existsSync(npm)) throw new Error("Run with npm run test:offline.");
const reportIndex = process.argv.indexOf("--report");
if (reportIndex >= 0 && !process.argv[reportIndex + 1]) throw new Error("--report requires an output path");
const report = reportIndex < 0 ? null : path.resolve(process.argv[reportIndex + 1]);
const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = mkdtempSync(path.join(tmpdir(), "pi-edit-fallback-offline-"));
const clean = path.join(temporary, "pi-edit-fallback");
const attempts = path.join(temporary, "network-attempts.log");
const lines = [];
function log(text) {
  let safe = text;
  for (const [value, replacement] of [[temporary, "<clean-room>"], [path.dirname(path.dirname(sdk)), "<pi-sdk>"]]) {
    safe = safe.replaceAll(value, replacement).replaceAll(value.replaceAll("\\", "/"), replacement);
  }
  lines.push(safe);
  console.log(safe);
}
try {
  mkdirSync(clean);
  for (const name of ["package.json", "extensions", "test"]) {
    cpSync(path.join(root, name), path.join(clean, name), {
      recursive: true, filter: (source) => !["results", "node_modules"].includes(path.basename(source)),
    });
  }
  for (const dir of ["home", "agent", "sessions", "npm-cache", "appdata", "localappdata"]) mkdirSync(path.join(temporary, dir));
  const npmConfig = path.join(temporary, "npmrc");
  const globalNpmConfig = path.join(temporary, "global-npmrc");
  writeFileSync(npmConfig, "");
  writeFileSync(globalNpmConfig, "");
  writeFileSync(attempts, "");
  const env = {};
  const allowed = new Set(["path", "systemroot", "windir", "comspec", "pathext", "temp", "tmp", "systemdrive", "processor_architecture", "number_of_processors"]);
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key.toLowerCase())) env[key] = value;
  Object.assign(env, {
    HOME: path.join(temporary, "home"), USERPROFILE: path.join(temporary, "home"),
    APPDATA: path.join(temporary, "appdata"), LOCALAPPDATA: path.join(temporary, "localappdata"),
    PI_CODING_AGENT_DIR: path.join(temporary, "agent"),
    PI_CODING_AGENT_SESSION_DIR: path.join(temporary, "sessions"),
    PI_SDK: sdk, PI_TSC: compiler, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    PI_OFFLINE_ATTEMPTS: attempts,
    NODE_OPTIONS: `--require ${JSON.stringify(path.join(clean, "test", "offline-guard.cjs"))}`,
    npm_config_cache: path.join(temporary, "npm-cache"), npm_config_offline: "true",
    npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false",
    npm_config_userconfig: npmConfig, npm_config_globalconfig: globalNpmConfig,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(temporary, "gitconfig"),
    CI: "1", NO_COLOR: "1",
  });
  const run = (args) => spawnSync(process.execPath, args, { cwd: clean, env, encoding: "utf8" });
  log(`Offline verification: ${new Date().toISOString()}`);
  log(`Platform: ${process.platform}/${process.arch}; Node ${process.version}`);
  log(`Pi: ${JSON.parse(readFileSync(path.join(path.dirname(sdk), "..", "package.json"), "utf8")).version}`);
  for (const [label, args] of [["npm", [npm, "--version"]], ["TypeScript", [compiler, "--version"]]]) {
    const result = run(args);
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    log(`${label}: ${result.stdout.trim()}`);
  }
  assert.ok(!existsSync(path.join(clean, "node_modules")));
  log("Isolation: fresh source copy; empty HOME/agent/npm cache; no project node_modules or inherited credentials/config.");
  log("Prerequisites: pre-provisioned Pi SDK/dependencies and TypeScript only (outside clean source).");
  // Prove the inherited preload guard works before running the actual suite.
  for (const expression of ["fetch('https://offline.invalid')", "require('node:net').connect(443, 'offline.invalid')", "require('node:https').get('https://offline.invalid')", "require('node:dns').lookup('offline.invalid')"]) {
    assert.notEqual(run(["-e", expression]).status, 0);
  }
  assert.equal(readFileSync(attempts, "utf8").trim().split("\n").length, 4);
  writeFileSync(attempts, "");
  log("PASS network guard self-check: fetch, TCP, HTTPS and DNS blocked; probe counters reset.");
  for (const [label, args] of [["npm test", [npm, "test"]], ["npm run test:host", [npm, "run", "test:host"]], ["npm run typecheck", [npm, "run", "typecheck"]]]) {
    log(`\n$ ${label}`);
    const result = run(args);
    log(`${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd());
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${label} failed`);
    log(`PASS ${label} (exit 0)`);
  }
  assert.equal(readFileSync(attempts, "utf8"), "", "No network API may be attempted, even if the caller catches its error");
  log("\nPASS all three commands; zero network attempts in Node processes (including npm/CLI children).");
  log("Scope: application-level network guard, not OS-level network isolation; no real model or interactive TUI used.");
} catch (error) {
  log(`FAIL ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  if (report) {
    mkdirSync(path.dirname(report), { recursive: true });
    writeFileSync(report, `${lines.join("\n")}\n`);
  }
  rmSync(temporary, { recursive: true, force: true });
}
