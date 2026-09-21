/**
 * 测试用的宿主解析工具（与两个回归脚本共用）。
 *
 * 目标：脚本既能在仓库里直接跑（`node test/host-lifecycle.mjs`），也能显式传路径跑
 * （`node test/host-lifecycle.mjs <pi-coding-agent/dist/index.js>`），
 * 且解析到的 SDK 与 PATH 上 `pi` 实际使用的那一份保持一致。
 *
 * 解析顺序：argv[2] → PI_SDK → `pi` 可执行文件同目录 → 全局 npm root。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const SDK_RELATIVE_ENTRY = path.join("node_modules", PACKAGE_NAME, "dist", "index.js");
const CLI_RELATIVE_ENTRY = path.join("node_modules", PACKAGE_NAME, "dist", "bundle", "cli.js");

/** Windows 下把 MSYS 风格路径 `/d/Nodejs` 归一为 `D:\Nodejs`。 */
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

/** 定位 PATH 上的 `pi`（Windows 上是 `pi.cmd`）。 */
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
    // 不是路径 → 继续按包名处理
  }
  if (isFile(normalized)) return normalized;
  // 裸包名（例如 "@earendil-works/pi-coding-agent"）
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
 * 返回 `@earendil-works/pi-coding-agent` 的 ESM 入口绝对路径。
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
 * 解析「怎么真正启动 `pi`」。
 *
 * `pi` 与 `pi.cmd` 都只是壳：它们最终 exec 的是
 * `<pi 目录>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`。
 *
 * 这里刻意优先直接 `node <cli.js>`，而不是通过 shell 跑壳脚本：
 *  - `spawn(..., {shell:true})` 会走 cmd.exe，**带空格的 prompt 会被拆成多个位置参数**，
 *    Pi 会把它当成多条用户消息，从而真的多跑一次 agent run（多一条通知）；
 *  - 直接传 argv 还顺带绕开了 MSYS 对 `/cmd` 的路径改写。
 * 仅当 bundle 入口不存在时才回退到壳脚本。
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

/** 把入口路径转成可 `await import()` 的 URL。 */
/**
 * 解析 pi 安装内的兄弟包（如 `@earendil-works/pi-tui`）的 dist 入口。
 *
 * 直接 `import("@earendil-works/pi-tui")` 在本 plugin 目录下跑不通（package 没有 node_modules），
 * 但在 pi/SDK 加载器里能解析——本函数就是给需要**脱离宿主直接驱动组件**的脚本补上这条路。
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

export function sdkUrl(entry) {
  return pathToFileURL(entry).href;
}
