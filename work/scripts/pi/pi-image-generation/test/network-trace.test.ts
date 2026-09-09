import assert from "node:assert/strict";
import { test } from "node:test";
import { channel } from "node:diagnostics_channel";
import { createServer } from "node:http";
import { createNetworkTrace } from "../src/network-trace.ts";
import { requestImageJson } from "../src/http.ts";
import type { ImageRequestDiagnostic } from "../src/diagnostics.ts";

test("parallel observers isolate request identities, retain no payload, and detach", async () => {
 const a = createNetworkTrace(performance.now());
 const b = createNetworkTrace(performance.now());
 const ra = { secret: "PRIVATE" }, rb = {};
 await Promise.all([
  a.run(async () => { channel("undici:request:create").publish({ request: ra }); }),
  b.run(async () => { channel("undici:request:create").publish({ request: rb }); }),
 ]);
 channel("undici:request:bodySent").publish({ request: ra });
 channel("undici:request:error").publish({ request: rb, error: "PRIVATE" });
 assert.ok(a.trace.events.some(x => x.stage === "request-body-sent"));
 assert.ok(!b.trace.events.some(x => x.stage === "request-body-sent"));
 assert.ok(!a.trace.events.some(x => x.stage === "wire-request-error"));
 a.stop(); b.stop();
 const before = JSON.stringify(a.trace);
 channel("undici:request:bodySent").publish({ request: ra });
 assert.equal(JSON.stringify(a.trace), before);
 assert.doesNotMatch(before + JSON.stringify(b.trace), /PRIVATE/);
});

test("real local HTTP records sent body, headers, completion and sanitized success IDs", async () => {
 const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
   res.setHeader("x-codex-imagegen-request-id", "safe-id");
   res.end('{"ok":true}');
  });
 });
 await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
 const address = server.address() as { port: number };
 let record: ImageRequestDiagnostic | undefined;
 try {
  await requestImageJson(`http://127.0.0.1:${address.port}/PRIVATE?token=PRIVATE`, { method: "POST", body: "PRIVATE", headers: { authorization: "PRIVATE" } }, 1024, {
   operation: "generate", onDiagnostic: async r => { record = r; return "local.json"; },
  });
  assert.equal(record?.outcome, "success");
  assert.equal(record?.imagegenRequestId, "safe-id");
  assert.equal(record?.network?.observation, "undici");
  for (const stage of ["request-body-sent", "wire-response-headers", "response-consumed"]) assert.ok(record?.network?.events.some(x => x.stage === stage), stage);
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE|authorization/);
 } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
