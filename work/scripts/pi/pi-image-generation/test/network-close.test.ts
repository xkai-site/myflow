import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { requestImageJson } from "../src/http.ts";
import type { ImageRequestDiagnostic } from "../src/diagnostics.ts";

test("local peer close after upload distinguishes waiting for headers from unsent request", async () => {
 let calls = 0;
 const server = createServer((req) => {
  calls++; req.resume(); req.on("end", () => setTimeout(() => req.socket.destroy(), 30));
 });
 await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
 let record: ImageRequestDiagnostic | undefined;
 try {
  await assert.rejects(requestImageJson(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { method: "POST", body: "secret" }, 1024, {
   operation: "generate", onDiagnostic: async r => { record = r; return "test.json"; },
  }), /UND_ERR_SOCKET/);
  assert.equal(calls, 1);
  assert.equal(record?.outcome, "error");
  assert.equal(record?.status, undefined);
  assert.ok(record?.network?.events.some(x => x.stage === "request-body-sent"));
  assert.ok(!record?.network?.events.some(x => x.stage === "wire-response-headers"));
  assert.ok(record?.network?.events.some(x => x.stage === "wire-request-error"));
 } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
