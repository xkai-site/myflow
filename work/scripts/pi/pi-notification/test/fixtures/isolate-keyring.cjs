/** Test-only preloader: no process in this regression may read/write the real OS vault. */
const path = require("node:path");
const Module = require("node:module");
const id = require.resolve("@napi-rs/keyring", { paths: [path.resolve(__dirname, "../..")] });
const fake = new Module(id);
fake.filename = id;
fake.loaded = true;
fake.exports = { Entry: class {
  getPassword() { return null; }
  setPassword() { throw new Error("Real credential vault disabled in tests"); }
  deletePassword() { throw new Error("Real credential vault disabled in tests"); }
} };
require.cache[id] = fake;
delete process.env.PI_NOTIFY_QQ_SMTP_AUTH_CODE;
const preload = path.resolve(__filename).replace(/\\/g, "/");
if (!(process.env.NODE_OPTIONS || "").includes(preload)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ""} --require ${JSON.stringify(preload)}`.trim();
}
