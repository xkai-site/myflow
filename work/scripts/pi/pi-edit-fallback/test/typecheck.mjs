import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSdk, siblingEntry } from "./sdk.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const sdk = resolveSdk();
const temporary = mkdtempSync(path.join(tmpdir(), "pi-edit-fallback-types-"));
try {
  const config = path.join(temporary, "tsconfig.json");
  const nodeTypes = path.dirname(siblingEntry(sdk, "@types/node/package.json"));
  writeFileSync(config, JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      types: ["node"],
      typeRoots: [path.dirname(nodeTypes)],
      paths: { "@earendil-works/pi-coding-agent": [sdk.replace(/\.js$/, ".d.ts")] },
    },
    include: [path.join(root, "extensions", "*.ts"), path.join(root, "test", "*.test.ts")],
  }, (_key, value) => typeof value === "string" ? value.replaceAll("\\", "/") : value, 2));

  // PI_TSC may point to an existing compiler; otherwise use tsc on PATH (e.g. npm exec).
  // No compiler or host dependency is added to the deployed extension.
  const compiler = process.env.PI_TSC;
  let result;
  if (compiler) {
    result = spawnSync(process.execPath, [compiler, "-p", config], { stdio: "inherit" });
  } else {
    const dirs = (process.env.PATH ?? "").split(path.delimiter);
    let tsc;
    for (const dir of dirs) {
      try { tsc = createRequire(path.join(dir, "resolve.cjs")).resolve("typescript/bin/tsc"); break; } catch { /* continue */ }
    }
    if (!tsc) {
      try { tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc"); } catch { /* reported below */ }
    }
    if (!tsc) throw new Error("Set PI_TSC to typescript/bin/tsc, or run: npm exec --package=typescript@5.9.3 -- node test/typecheck.mjs");
    result = spawnSync(process.execPath, [tsc, "-p", config], { stdio: "inherit" });
  }
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else console.log(`Typecheck passed against ${sdk}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
