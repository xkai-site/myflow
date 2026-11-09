import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { readJsonResponse, requestImageJson } from "../src/http.ts";
import type { ImageRequestDiagnostic } from "../src/diagnostics.ts";

const encode = (text: string) => new TextEncoder().encode(text);

function streamed(chunks: Uint8Array[], headers: HeadersInit = {}, cancel: () => void | Promise<void> = () => {}) {
	let reads = 0;
	const response = new Response(new ReadableStream<Uint8Array>({
		pull(controller) {
			if (reads === chunks.length) controller.close();
			else controller.enqueue(chunks[reads++]);
		},
		cancel,
	}, { highWaterMark: 0 }), { headers });
	response.arrayBuffer = async () => assert.fail("JSON transport must not buffer the entire response via arrayBuffer()");
	return { response, reads: () => reads };
}

test("JSON response accepts the inclusive byte limit and UTF-8 split across chunks", async () => {
	const value = { text: "中文 🐈", count: 2 };
	const bytes = encode(JSON.stringify(value));
	const chunks = [new Uint8Array(), ...Array.from(bytes, byte => Uint8Array.of(byte)), new Uint8Array()];
	const { response } = streamed(chunks, { "content-length": String(bytes.length) });
	assert.deepEqual(await readJsonResponse(response, bytes.length), value);
	assert.equal(response.body!.locked, false);
});

test("JSON response stops at the first oversized chunk regardless of missing, invalid or understated Content-Length", async () => {
	for (const length of [undefined, "invalid", "0", "2", "8"]) {
		let cancelled = 0;
		const headers: HeadersInit = length === undefined ? {} : { "content-length": length };
		const fixture = streamed([encode("{}"), encode(" ".repeat(7)), encode("unread")], headers, () => { cancelled++; });
		await assert.rejects(readJsonResponse(fixture.response, 8), /Provider response is too large/);
		assert.equal(fixture.reads(), 2, "do not read or drain the rest of an oversized response");
		assert.equal(cancelled, 1);
		assert.equal(fixture.response.body!.locked, false);
	}
});

test("JSON response rejects a single oversized chunk and does not wait for cancellation to settle", async () => {
	let cancelled = 0;
	const fixture = streamed([encode(" ".repeat(1024))], {}, () => { cancelled++; return new Promise(() => {}); });
	await assert.rejects(readJsonResponse(fixture.response, 8), /Provider response is too large/);
	assert.equal(fixture.reads(), 1);
	assert.equal(cancelled, 1);
	assert.equal(fixture.response.body!.locked, false);
});

test("oversized declared JSON length cancels before reading, even if cancellation rejects", async () => {
	let cancelled = 0;
	const fixture = streamed([encode("{}")], { "content-length": "9" }, async () => {
		cancelled++;
		throw new Error("cancel failure must not mask the size limit");
	});
	await assert.rejects(readJsonResponse(fixture.response, 8), /Provider response is too large/);
	assert.equal(fixture.reads(), 0);
	assert.equal(cancelled, 1);
	assert.equal(fixture.response.body!.locked, false);
});

test("JSON byte limit counts UTF-8 bytes rather than decoded characters", async () => {
	const text = JSON.stringify({ text: "中文" });
	const fixture = streamed([encode(text)]);
	await assert.rejects(readJsonResponse(fixture.response, text.length), /Provider response is too large/);
});

test("JSON response grows a bounded buffer across many chunks without losing bytes", async () => {
	const value = { text: "x".repeat(200_000) };
	const bytes = encode(JSON.stringify(value));
	const chunks = [];
	for (let offset = 0; offset < bytes.length; offset += 8191) chunks.push(bytes.subarray(offset, offset + 8191));
	const fixture = streamed(chunks);
	assert.deepEqual(await readJsonResponse(fixture.response, bytes.length), value);
	assert.equal(fixture.response.body!.locked, false);
});

test("empty or malformed JSON retains the HTTP-status error and releases the reader", async () => {
	for (const text of ["", "{bad json}"]) {
		const fixture = streamed([encode(text)]);
		await assert.rejects(readJsonResponse(fixture.response, 100), /Provider returned invalid JSON \(HTTP 200\)/);
		assert.equal(fixture.response.body!.locked, false);
	}
	await assert.rejects(readJsonResponse(new Response(null, { status: 204 }), 100), /Provider returned invalid JSON \(HTTP 204\)/);
});

test("JSON body-read failures are preserved and release the reader", async () => {
	const error = new Error("synthetic response disconnect");
	const response = new Response(new ReadableStream({ pull(controller) { controller.error(error); } }, { highWaterMark: 0 }));
	await assert.rejects(readJsonResponse(response, 100), candidate => candidate === error);
	assert.equal(response.body!.locked, false);
});

test("JSON limits reject invalid budgets instead of allowing unbounded reads", async () => {
	for (const limit of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		await assert.rejects(readJsonResponse(new Response("{}"), limit), /Invalid JSON response byte limit/);
	}
});

test("loopback gzip response is limited by decoded bytes, not compressed Content-Length", async () => {
	const payload = encode(JSON.stringify({ text: "x".repeat(4096) }));
	const compressed = gzipSync(payload);
	const limit = 128;
	assert.ok(compressed.length < limit && payload.length > limit);
	let calls = 0;
	const server = createServer((_request, response) => {
		calls++;
		response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": compressed.length });
		response.end(compressed);
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address() as { port: number };
		await assert.rejects(requestImageJson(`http://127.0.0.1:${address.port}`, {}, limit, { operation: "generate" }), /Provider response is too large/);
		assert.equal(calls, 1);
	} finally {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

test("oversized mock JSON produces one response-phase error diagnostic and no retry", async () => {
	let calls = 0, cancelled = 0;
	const records: ImageRequestDiagnostic[] = [];
	const fixture = streamed([encode("{}"), encode(" ".repeat(7)), encode("unread")], {}, () => { cancelled++; });
	await assert.rejects(requestImageJson("https://chatgpt.com/backend-api/codex/images/generations", {}, 8, {
		operation: "generate",
		fetch: async () => { calls++; return fixture.response; },
		onDiagnostic: async record => { records.push(record); return "mock-diagnostic.json"; },
	}), /Provider response is too large/);
	assert.equal(calls, 1);
	assert.equal(cancelled, 1);
	assert.equal(records.length, 1);
	assert.equal(records[0].outcome, "error");
	assert.equal(records[0].phase, "response");
});
