import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeEditedConfig, readVideoConfig } from "../src/config.ts";
import { requireHttpsUrl } from "../src/http.ts";
import type { VideoGenerationConfig } from "../src/types.ts";

test("invalid config JSON never includes source text from files or the editor", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "video-config-test-"));
	const filePath = path.join(directory, "model.json");
	const current: VideoGenerationConfig = { version: 1, providers: [], models: [] };
	const secret = "abcdefgh1234567890"; // Synthetic opaque key, not covered by sk-/Bearer redaction.
	try {
		for (const text of [`{"apiKey":${secret}}`, `[${secret}]`, `"${secret}\n"`]) {
			await writeFile(filePath, text);
			await assert.rejects(() => readVideoConfig(filePath), { message: "Video model config is invalid JSON" });
			assert.throws(() => mergeEditedConfig(text, current), { message: "Edited video config is invalid JSON" });
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("IPv6 private-prefix checks do not reject ordinary public hostnames", () => {
	for (const host of ["fcdn.example", "fd-cdn.example", "fe80-cdn.example", "cdn.example", "8.8.8.8", "[2001:4860:4860::8888]"]) {
		assert.doesNotThrow(() => requireHttpsUrl(`https://${host}/video.mp4`, "Video URL"));
	}
	for (const host of ["localhost", "cdn.localhost", "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "[::1]", "[fc00::1]", "[fd00::1]", "[fe80::1]", "[::ffff:127.0.0.1]"]) {
		assert.throws(() => requireHttpsUrl(`https://${host}/video.mp4`, "Video URL"), /local or private address/);
	}
});
