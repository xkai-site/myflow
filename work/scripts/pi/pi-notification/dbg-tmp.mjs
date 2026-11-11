import "./test/fixtures/isolate-keyring.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSettingsHost } from "./src/settings-actions.ts";
import { createQqCredentials, QQ_AUTH_ENV } from "./src/mail/credentials.ts";
import { loadConfig, readUserConfigRaw, userConfigPath } from "./src/config.ts";
import { buildSettingItems } from "./src/settings.ts";
import { applyOverlay, emptyOverlay } from "./src/settings-state.ts";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-"));
const dir = path.join(tmp, "a"); const file = userConfigPath(dir);
fs.mkdirSync(path.dirname(file), { recursive: true });
const options = { from: "fake@qq.com", to: ["reader@example.com"] };
fs.writeFileSync(file, JSON.stringify({ channels: [], providers: [{ id: "email", type: "email", enabled: false, options }] }));
const credentials = createQqCredentials({ status: () => ({ available: true }), get: () => undefined, set() {}, delete() {} }, () => undefined);
let overlay = emptyOverlay();
const declared = () => applyOverlay(loadConfig({ agentDir: dir }).config, overlay).config;
let declaration = structuredClone(declared());
const host = createSettingsHost({ credentials, config: declared, configLoad: () => loadConfig({ agentDir: dir }), agentDir: () => dir, declared: () => declaration,
  log: { log() {}, record() {} }, sessionId: () => "t", isSilenced: () => false, service: () => { throw new Error("no"); },
  reload() { declaration = structuredClone(declared()); }, overlay: () => overlay,
  setOverlay(next) { overlay = next; declaration = structuredClone(declared()); }, userRaw: () => readUserConfigRaw(dir).raw });
const item = (id) => buildSettingItems(declared()).find((entry) => entry.id === id);
console.log("set channels", host.setValue(item("channels"), ["email"]).ok);
console.log("set rules", host.setValue(item("rules.runFailed.channels"), ["email"]).ok);
fs.writeFileSync(file, JSON.stringify({ channels: [], providers: [{ id: "email", type: "email", enabled: true, options }] }));
console.log("close email", JSON.stringify(host.setValue(item("provider:email"), false)));
console.log("overlay", JSON.stringify(overlay));
console.log("current email", declared().providers.find((p) => p.id === "email").enabled);
console.log("follow", JSON.stringify(host.followUserDefault(item("provider:email"))));
console.log("overlay after", JSON.stringify(overlay));
console.log("current email after", declared().providers.find((p) => p.id === "email").enabled);
