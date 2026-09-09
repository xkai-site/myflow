import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectErrorCauses, createDiagnosticWriter, diagnosticHint, type ImageRequestDiagnostic } from "../src/diagnostics.ts";
import { sanitizeDiagnosticText } from "../src/errors.ts";
import { downloadImage, requestImageJson } from "../src/http.ts";
import { generateAliWanImages } from "../src/ali-wan-images.ts";
import { generateOpenAICodexImages } from "../src/openai-codex-images.ts";

const endpoint = "https://chatgpt.com/backend-api/codex/images/generations";
const networkError = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error(`${code}: connection failed`), { code, syscall: "connect" }) });
const wan = { apiKey: "opaque-test-key", baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com", prompt: "PRIVATE_PROMPT", model: "wan-test", size: "2K", images: [] };

test("network failures retain bounded cause/AggregateError chains, code, stage and recovery hints without retrying", async () => {
	for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED", "SELF_SIGNED_CERT_IN_CHAIN"]) {
		let calls = 0;
		const records: ImageRequestDiagnostic[] = [];
		await assert.rejects(requestImageJson(endpoint, { method: "POST", redirect: "error" }, 1024, {
			operation: "generate", model: "image-test",
			fetch: async () => { calls++; throw networkError(code); },
			onDiagnostic: async (record) => { records.push(record); return ".pi/image-generation-logs/test.json"; },
		}), (error: Error) => {
			assert.ok(error.message.includes(code));
			assert.match(error.message, /生成请求失败.*chatgpt.com/);
			assert.match(error.message, /未收到 HTTP 响应/);
			assert.match(error.message, /\.pi\/image-generation-logs\/test.json/);
			assert.ok(error.message.length < 800);
			return true;
		});
		assert.equal(calls, 1);
		assert.equal(records.length, 1);
		assert.equal(records[0].phase, "connect");
		assert.equal(records[0].model, "image-test");
		assert.equal(records[0].status, undefined);
		assert.equal(records[0].causes[1].syscall, "connect");
		assert.ok(records[0].elapsedMs >= 0);
	}
	const aggregate = new AggregateError([networkError("ENETUNREACH"), networkError("ETIMEDOUT")], "Both address families failed");
	const root = new TypeError("fetch failed", { cause: aggregate });
	Object.assign(aggregate, { cause: root }); // Cycle, not an infinite walk.
	const causes = collectErrorCauses(root);
	assert.deepEqual(causes.filter((cause) => cause.code).map((cause) => cause.code), ["ENETUNREACH", "ETIMEDOUT"]);
	assert.ok(collectErrorCauses(new AggregateError(Array.from({ length: 100 }, () => networkError("EAI_AGAIN")), "many")).length <= 12);
	assert.match(diagnosticHint(collectErrorCauses(new Error("unexpected redirect"))), /重定向/);
	assert.match(diagnosticHint(collectErrorCauses(networkError("UND_ERR_SOCKET"))), /模型\/请求兼容性/);
});

test("HTTP errors preserve status and header/payload request IDs, including HTML instead of JSON", async () => {
	for (const status of [401, 403, 429, 502]) {
		for (const html of [false, true]) {
			let record: ImageRequestDiagnostic | undefined;
			await assert.rejects(requestImageJson(endpoint, { method: "POST" }, 4096, {
				operation: "edit",
				fetch: async () => html
					? new Response("<html>PRIVATE_GATEWAY_BODY</html>", { status, headers: { "x-request-id": "gateway-123" } })
					: Response.json({ message: "Service refused", request_id: "provider-456" }, { status }),
				onDiagnostic: async (value) => { record = value; return "test.json"; },
			}), (error: Error) => error.message.includes(`HTTP ${status}`) && error.message.includes("编辑请求失败"));
			assert.equal(record!.status, status);
			assert.equal(record!.phase, "response");
			assert.equal(record!.requestId, html ? "gateway-123" : "provider-456");
			assert.doesNotMatch(JSON.stringify(record), /PRIVATE_GATEWAY_BODY/);
		}
	}
});

test("body-read failures remain distinguishable from connection failures", async () => {
	let record: ImageRequestDiagnostic | undefined;
	await assert.rejects(requestImageJson(endpoint, {}, 4096, {
		operation: "generate",
		fetch: async () => new Response(new ReadableStream({ start(controller) { controller.error(networkError("UND_ERR_SOCKET")); } }), { headers: { "x-request-id": "body-123" } }),
		onDiagnostic: async (value) => { record = value; return "test.json"; },
	}), /UND_ERR_SOCKET/);
	assert.equal(record!.phase, "response");
	assert.equal(record!.status, 200);
	assert.equal(record!.requestId, "body-123");
});

test("both adapters and the CDN download carry safe diagnostics without forwarding credentials to CDN", async () => {
	const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "PRIVATE_ACCOUNT" } })).toString("base64url")}.signature`;
	const records: ImageRequestDiagnostic[] = [];
	const onDiagnostic = async (record: ImageRequestDiagnostic) => { records.push(record); return "test.json"; };
	await assert.rejects(generateOpenAICodexImages({ ...wan, apiKey: token, baseUrl: "https://chatgpt.com/backend-api/codex", fetch: async () => { throw networkError("ECONNRESET"); }, onDiagnostic }), /ECONNRESET/);
	assert.equal(records[0].operation, "generate");
	let calls = 0;
	await assert.rejects(generateAliWanImages({ ...wan, headers: { "x-private": "PRIVATE_HEADER" }, onDiagnostic, fetch: async (_url, options) => {
		calls++;
		assert.equal(options?.redirect, "error");
		if (options?.method === "POST") return Response.json({ output: { choices: [{ message: { content: [{ image: "https://cdn.example.test/private/file.png?signature=SIGNED_SECRET" }] } }] } });
		assert.equal(options?.headers, undefined);
		throw new TypeError("fetch failed", { cause: Object.assign(new Error("https://proxyuser:proxypass@cdn.example.test/private/file.png?signature=SIGNED_SECRET PRIVATE_HEADER"), { code: "ECONNREFUSED" }) });
	} }), /图片下载失败.*cdn.example.test/);
	assert.equal(calls, 2); // One generation, one download; no automatic generation retry.
	assert.equal(records[1].outcome, "success");
	assert.equal(records[2].operation, "download");
	assert.equal(records[2].model, wan.model);
	assert.doesNotMatch(JSON.stringify(records), /SIGNED_SECRET|proxypass|proxyuser|PRIVATE_HEADER|PRIVATE_ACCOUNT|PRIVATE_PROMPT|private\/file/);
});

test("redaction covers cause fields, reflected prompts, credentials, encoded secrets and terminal controls before truncation", async () => {
	const secret = "opaque/key+with=chars";
	const prompt = 'PRIVATE "prompt"\nwith newline';
	const header = "HEADER_SECRET_".repeat(100);
	let record: ImageRequestDiagnostic | undefined;
	await assert.rejects(requestImageJson(endpoint, { headers: { "x-private": header } }, 10000, {
		operation: "generate", secrets: [secret, prompt],
		fetch: async () => Response.json({ message: `${secret} ${encodeURIComponent(secret)} ${JSON.stringify(prompt).slice(1, -1)} ${header}\x1b[31m!`, request_id: secret }, { status: 401 }),
		onDiagnostic: async (value) => { record = value; return "test.json"; },
	}), (error: Error) => {
		assert.doesNotMatch(error.message, /opaque|PRIVATE|HEADER_SECRET|\x1b/);
		return true;
	});
	assert.doesNotMatch(JSON.stringify(record), /opaque|PRIVATE|HEADER_SECRET|\\u001b/);
	assert.match(JSON.stringify(record), /redacted/);
	assert.equal(sanitizeDiagnosticText("https://user:pass@proxy.test/?key=secret cookie=secret"), "[url-redacted] [credential-redacted]");
	const details = collectErrorCauses({ name: secret, message: secret, code: secret, syscall: secret, stack: "PRIVATE_STACK", request: { headers: { secret } } }, [secret]);
	assert.doesNotMatch(JSON.stringify(details), /opaque|PRIVATE_STACK|headers/);
});

test("explicit cancellation is not logged, but deadline expiration is actionable and logged", async () => {
	let writes = 0;
	let calls = 0;
	const aborted = new AbortController();
	aborted.abort(new Error("PRIVATE_CANCEL_REASON"));
	await assert.rejects(requestImageJson(endpoint, { signal: aborted.signal }, 1000, {
		operation: "generate", fetch: async () => { calls++; throw networkError("ECONNRESET"); },
		onDiagnostic: async () => { writes++; return "test.json"; },
	}), (error: Error) => error.name === "AbortError" && !error.message.includes("PRIVATE"));
	assert.equal(calls, 0);
	assert.equal(writes, 0);
	const deadline = new AbortController();
	deadline.abort(new DOMException("Deadline exceeded", "TimeoutError"));
	await assert.rejects(requestImageJson(endpoint, { signal: deadline.signal }, 1000, {
		operation: "generate", onDiagnostic: async () => { writes++; return "test.json"; },
	}), /请求超时/);
	assert.equal(writes, 1);
});

test("log failures cannot mask network errors or successful requests", async () => {
	await assert.rejects(requestImageJson(endpoint, {}, 1024, {
		operation: "generate", fetch: async () => { throw networkError("ENOTFOUND"); },
		onDiagnostic: async () => { throw new Error("PRIVATE_WRITE_FAILURE"); },
	}), (error: Error) => error.message.includes("ENOTFOUND") && error.message.includes("日志写入失败") && !error.message.includes("PRIVATE"));
	assert.deepEqual(await requestImageJson(endpoint, {}, 1024, {
		operation: "generate", fetch: async () => Response.json({ ok: true }),
		onDiagnostic: async (record) => { assert.equal(record.outcome, "success"); throw new Error("PRIVATE_WRITE_FAILURE"); },
	}), { ok: true });
	await assert.rejects(downloadImage("http://cdn.test/image.png", { maxBytes: 10 }), /non-HTTPS/);
});

test("diagnostic files are unique, atomic, private and reject unsafe directories", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "image-diagnostics-"));
	try {
		const writer = createDiagnosticWriter(cwd);
		const record: ImageRequestDiagnostic = { version: 1, id: "test", timestamp: new Date().toISOString(), operation: "generate", phase: "connect", host: "chatgpt.com", method: "POST", elapsedMs: 3, causes: collectErrorCauses(networkError("ENOTFOUND")), hint: "Check DNS" };
		const first = await writer(record);
		const second = await writer(record);
		assert.notEqual(first, second);
		assert.ok(!path.isAbsolute(first));
		const parsed = JSON.parse(await readFile(path.join(cwd, first), "utf8"));
		assert.equal(parsed.causes[1].code, "ENOTFOUND");
		assert.equal(parsed.runtime.node, process.version);
		assert.equal((await readdir(path.dirname(path.join(cwd, first)))).length, 2);
		if (process.platform !== "win32") assert.equal((await stat(path.join(cwd, first))).mode & 0o777, 0o600);
		const blocked = path.join(cwd, "blocked");
		await mkdir(blocked);
		await writeFile(path.join(blocked, ".pi"), "not a directory");
		await assert.rejects(createDiagnosticWriter(blocked)(record), /Unsafe/);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("diagnostic writes refuse linked .pi and log directories", async (t) => {
	const cwd = await mkdtemp(path.join(tmpdir(), "image-diagnostics-link-"));
	const target = await mkdtemp(path.join(tmpdir(), "image-diagnostics-target-"));
	try {
		for (const nested of [false, true]) {
			const root = path.join(cwd, nested ? "nested" : "root");
			await mkdir(nested ? path.join(root, ".pi") : root, { recursive: true });
			const link = nested ? path.join(root, ".pi", "image-generation-logs") : path.join(root, ".pi");
			try { await symlink(target, link, process.platform === "win32" ? "junction" : "dir"); }
			catch (error) {
				if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return t.skip("Symlinks unavailable");
				throw error;
			}
			await assert.rejects(createDiagnosticWriter(root)({} as ImageRequestDiagnostic), /Unsafe/);
		}
		assert.deepEqual(await readdir(target), []);
	} finally {
		await rm(cwd, { recursive: true, force: true });
		await rm(target, { recursive: true, force: true });
	}
});
