/**
 * Host resolution helper shared by the regression scripts.
 *
 * A script must run both from the repository (`node test/host-lifecycle.mjs`) and with an explicit
 * path (`node test/host-lifecycle.mjs <pi-coding-agent/dist/index.js>`), and the SDK it resolves
 * must be the same one the `pi` on PATH actually uses.
 *
 * Resolution order: argv[2], then PI_SDK, then the directory of the `pi` executable, then the
 * global npm root.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const SDK_RELATIVE_ENTRY = path.join("node_modules", PACKAGE_NAME, "dist", "index.js");
const CLI_RELATIVE_ENTRY = path.join("node_modules", PACKAGE_NAME, "dist", "bundle", "cli.js");

/** Normalises an MSYS-style path such as `/d/Nodejs` to `D:\Nodejs` on Windows. */
function normalizeDir(candidate) {
  if (process.platform !== "win32") return candidate;
  const msys = /^\/([a-zA-Z])\/(.*)$/.exec(candidate);
  if (!msys) return candidate;
  return `${msys[1].toUpperCase()}:\\${msys[2].replace(/\//g, "\\")}`;
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Locates `pi` on PATH (`pi.cmd` on Windows). */
export function resolvePiBin(env = process.env) {
  if (env.PI_BIN) return env.PI_BIN;
  const names = process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi"] : ["pi"];
  for (const rawDir of (env.PATH ?? "").split(path.delimiter)) {
    if (!rawDir) continue;
    const dir = normalizeDir(rawDir);
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function resolveCandidate(candidate) {
  if (!candidate) return undefined;
  const normalized = normalizeDir(candidate);
  try {
    if (fs.statSync(normalized).isDirectory()) {
      const entry = path.join(normalized, "dist", "index.js");
      return isFile(entry) ? entry : undefined;
    }
  } catch {
    // Not a path: keep treating it as a package name.
  }
  if (isFile(normalized)) return normalized;
  // Bare package name, for example "@earendil-works/pi-coding-agent".
  if (!normalized.includes("/") && !normalized.includes("\\")) {
    const entry = path.join(process.cwd(), "node_modules", normalized, "dist", "index.js");
    if (isFile(entry)) return entry;
  }
  return undefined;
}

function globalNpmRoot(env) {
  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const root = execFileSync(npm, ["root", "-g"], { encoding: "utf8", env, windowsHide: true }).trim();
    return root === "" ? undefined : root;
  } catch {
    return undefined;
  }
}

/**
 * Absolute ESM entry of `@earendil-works/pi-coding-agent`.
 * @param {{ argv?: string[], env?: NodeJS.ProcessEnv }} [options]
 */
export function resolveSdkEntry({ argv = process.argv, env = process.env } = {}) {
  const candidates = [argv[2], env.PI_SDK];
  const piBin = resolvePiBin(env);
  if (piBin) candidates.push(path.join(path.dirname(piBin), SDK_RELATIVE_ENTRY));
  const npmRoot = globalNpmRoot(env);
  if (npmRoot) candidates.push(path.join(npmRoot, PACKAGE_NAME, "dist", "index.js"));

  for (const candidate of candidates) {
    const resolved = resolveCandidate(candidate);
    if (resolved) return resolved;
  }

  throw new Error(
    "无法定位 @earendil-works/pi-coding-agent。"
    + "请显式传入：node test/host-lifecycle.mjs <.../pi-coding-agent/dist/index.js>，"
    + "或设置 PI_SDK / PI_BIN 环境变量。",
  );
}

/**
 * Resolves how to actually start `pi`.
 *
 * `pi` and `pi.cmd` are only shims; what they exec is
 * `<pi dir>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`.
 *
 * `node <cli.js>` is deliberately preferred over running the shim through a shell:
 *  - `spawn(..., {shell:true})` goes through cmd.exe, where a prompt containing spaces is split
 *    into several positional arguments. Pi would then treat it as several user messages and
 *    really run the agent again, producing one notification too many;
 *  - passing argv directly also avoids MSYS rewriting `/cmd` as a path.
 * The shim is only a fallback for when the bundle entry does not exist.
 */
export function resolvePiLaunch({ env = process.env } = {}) {
  const piBin = resolvePiBin(env);
  if (!piBin) return undefined;
  const cliEntry = path.join(path.dirname(piBin), CLI_RELATIVE_ENTRY);
  if (isFile(cliEntry)) {
    return {
      launcher: "node+bundle",
      piBin,
      command: process.execPath,
      args: [cliEntry],
      shell: false,
    };
  }
  return {
    launcher: "shim",
    piBin,
    command: piBin,
    args: [],
    shell: process.platform === "win32",
  };
}

/**
 * Resolves the dist entry of a sibling package inside the pi installation, such as
 * `@earendil-works/pi-tui`.
 *
 * Importing that package directly does not resolve from this plugin directory (it has no
 * node_modules), yet it does resolve inside the pi/SDK loader; this function gives scripts that
 * drive components without a host the same access.
 */
export function resolvePiPackageEntry(pkg, { sdkEntry = resolveSdkEntry() } = {}) {
  const packageDir = pkg.split("/");
  const candidates = [
    path.join(path.dirname(sdkEntry), "..", "node_modules", ...packageDir, "dist", "index.js"),
    path.join(path.dirname(sdkEntry), "..", "..", ...packageDir, "dist", "index.js"),
  ];
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  throw new Error(`无法定位 ${pkg}（已查找：${candidates.join(", ")}）`);
}

/** Turns an entry path into a URL that `await import()` accepts. */
export function sdkUrl(entry) {
  return pathToFileURL(entry).href;
}
