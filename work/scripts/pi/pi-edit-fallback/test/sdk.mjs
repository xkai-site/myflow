// Test-only helper. The extension itself has no runtime imports or dependencies.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function resolveSdk() {
  if (process.env.PI_SDK) return path.resolve(process.env.PI_SDK);
  const installRoot = process.env.PI_MANAGED_INSTALL_ROOT ?? path.join(homedir(), ".pi", "agent", "install");
  const current = path.join(installRoot, "current-version");
  if (existsSync(current)) {
    const version = readFileSync(current, "utf8").trim();
    const entry = path.join(installRoot, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
    if (existsSync(entry)) return entry;
  }
  try {
    return createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent");
  } catch {
    throw new Error("Set PI_SDK to the installed pi-coding-agent/dist/index.js path.");
  }
}

export function siblingEntry(sdkEntry, name) {
  return createRequire(pathToFileURL(sdkEntry)).resolve(name);
}
