import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { resolveSdkEntry, resolveSdkUrl, siblingEntry } from "./sdk.mjs";

test("host tests resolve explicit paths, URLs, managed releases and PATH installations", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-sdk 测试 "));
  try {
    const relative = path.join("node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
    const managed = path.join(root, "install");
    const entry = path.join(managed, "releases", "1.4.0", relative);
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, "export {};\n");
    writeFileSync(path.join(managed, "current-version"), "1.4.0\n");
    const sibling = path.resolve(path.dirname(entry), "../../pi-ai");
    mkdirSync(path.join(sibling, "dist"), { recursive: true });
    writeFileSync(path.join(sibling, "package.json"), JSON.stringify({ type: "module", exports: { ".": { import: "./dist/index.js" } } }));
    writeFileSync(path.join(sibling, "dist", "index.js"), "export {};\n");
    assert.equal(siblingEntry(pathToFileURL(entry).href, "@earendil-works/pi-ai"), path.join(sibling, "dist", "index.js"));
    const from = pathToFileURL(path.join(root, "test.mjs")).href;
    const env = { PI_MANAGED_INSTALL_ROOT: managed, PATH: "" };
    assert.equal(resolveSdkEntry({ from, env }), entry);
    assert.equal(resolveSdkEntry({ from, env, candidate: entry }), entry);
    assert.equal(resolveSdkEntry({ from, env: { ...env, PI_SDK: entry } }), entry);
    assert.equal(resolveSdkUrl({ from, env, candidate: pathToFileURL(entry).href }), pathToFileURL(entry).href);
    assert.throws(() => resolveSdkEntry({ from, env, candidate: path.join(root, "missing.js") }), /does not exist/);
    assert.equal(resolveSdkEntry({ from, env: { PI_MANAGED_INSTALL_ROOT: path.join(root, "absent"), PATH: path.join(managed, "releases", "1.4.0") } }), entry);
    assert.throws(() => resolveSdkEntry({ from, env: { PI_MANAGED_INSTALL_ROOT: path.join(root, "absent"), PATH: "" } }), /set PI_SDK/);
    const local = path.join(root, "local", relative);
    mkdirSync(path.dirname(local), { recursive: true });
    writeFileSync(local, "export {};\n");
    writeFileSync(path.join(path.dirname(local), "..", "package.json"), JSON.stringify({ type: "module", exports: { ".": { import: "./dist/index.js" } } }));
    assert.equal(resolveSdkEntry({ from: pathToFileURL(path.join(root, "local", "test.mjs")).href, env }), local);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
