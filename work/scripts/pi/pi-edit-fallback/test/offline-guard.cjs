// Preloaded into every Node process in the clean-room run (including npm and CLI children).
const { appendFileSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const deny = (api) => () => {
  appendFileSync(process.env.PI_OFFLINE_ATTEMPTS, `${api}\n`);
  throw new Error(`Offline verification forbids network: ${api}`);
};
globalThis.fetch = deny("fetch");
require("node:net").Socket.prototype.connect = deny("net.Socket.connect");
require("node:tls").connect = deny("tls.connect");
for (const protocol of ["http", "https"]) {
  const module = require(`node:${protocol}`);
  module.request = deny(`${protocol}.request`);
  module.get = deny(`${protocol}.get`);
}
for (const module of [require("node:dns"), require("node:dns/promises")]) {
  for (const key of Object.keys(module)) {
    if (key === "lookup" || key.startsWith("resolve") || key === "reverse") module[key] = deny(`dns.${key}`);
  }
}
require("node:dgram").createSocket = deny("dgram.createSocket");
syncBuiltinESMExports();
