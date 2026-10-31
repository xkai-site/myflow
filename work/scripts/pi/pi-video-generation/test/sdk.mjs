/** Pi host-test support: resolve an installed SDK without downloading dependencies. */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageEntry = path.join("node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");

export function resolveSdkEntry({ candidate, from = import.meta.url, env = process.env } = {}) {
  const explicit = candidate || env.PI_SDK;
  if (explicit) {
    const entry = String(explicit).startsWith("file:") ? fileURLToPath(explicit) : path.resolve(explicit);
    if (!existsSync(entry)) throw new Error(`Pi SDK entry does not exist: ${entry}`);
    return entry;
  }

  try { return siblingEntry(from, "@earendil-works/pi-coding-agent"); } catch { /* Try installed layouts. */ }

  const installRoot = env.PI_MANAGED_INSTALL_ROOT || path.join(homedir(), ".pi", "agent", "install");
  const current = path.join(installRoot, "current-version");
  if (existsSync(current)) {
    const version = readFileSync(current, "utf8").trim();
    const entry = path.join(installRoot, "releases", version, packageEntry);
    if (existsSync(entry)) return entry;
  }

  for (const directory of (env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const entry = path.join(directory, packageEntry);
    if (existsSync(entry)) return entry;
  }
  throw new Error("Cannot locate Pi SDK; set PI_SDK to pi-coding-agent/dist/index.js.");
}

export function resolveSdkUrl(options) {
  return pathToFileURL(resolveSdkEntry(options)).href;
}

export function siblingEntry(sdk, name) {
  const require = createRequire(sdk);
  try { return require.resolve(name); } catch {
    // Some Pi packages expose only an ESM import entry, which require.resolve cannot select.
    for (const directory of require.resolve.paths(name) || []) {
      const entry = path.join(directory, name, "dist", "index.js");
      if (existsSync(entry)) return entry;
    }
    throw new Error(`Cannot locate ${name} beside Pi SDK ${sdk}`);
  }
}
