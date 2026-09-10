import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const sdk = process.argv[2] ?? pathToFileURL(require.resolve("@earendil-works/pi-coding-agent")).href;
const hostRequire = createRequire(sdk);
const { createJiti } = hostRequire("jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, alias: {
	"@earendil-works/pi-coding-agent": fileURLToPath(sdk),
	"@earendil-works/pi-tui": fileURLToPath(new URL("../node_modules/@earendil-works/pi-tui/dist/index.js", sdk)),
} });
const dir = await mkdtemp(path.join(tmpdir(), "video-preview-"));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail("Unexpected network request");
try {
	const { default: extension, publishOutcome } = await jiti.import("../extensions/index.ts");
	const { formatVideoLink } = await jiti.import("../src/preview-link.ts");
	const { getCapabilities, setCapabilities, Text, visibleWidth, stripTerminalSequences, getOsc8LinkAtColumn } = await jiti.import("@earendil-works/pi-tui");
	const originalCapabilities = getCapabilities();
	try {
		const outputDir = path.join(dir, ".pi", "generated-videos");
		await mkdir(outputDir, { recursive: true });
		const videoPath = path.join(outputDir, "视频 space # %.mp4");
		const bytes = Buffer.from("synthetic MP4 fixture; rendering must not read/decode this");
		await writeFile(videoPath, bytes);
		const filesBefore = await readdir(outputDir);
		const data = { provider: "test", model: "test-model", task: "t2v", taskId: "test-task", parameters: {}, path: videoPath, mimeType: "video/mp4", bytes: bytes.length, createdAt: 1 };
		const url = pathToFileURL(videoPath).href;
		const entries = [], notices = [];
		let renderer, handler;
		const pi = {
			registerEntryRenderer(type, fn) { assert.equal(type, "pi-video-generation"); renderer = fn; },
			registerCommand(name, command) { assert.equal(name, "video"); handler = command.handler; },
			on() {},
			appendEntry(type, entry) { entries.push({ type, data: structuredClone(entry) }); },
		};
		const theme = { fg: (color, text) => color === "mdLink" ? `\x1b[94m${text}\x1b[39m` : text, underline: text => `\x1b[4m${text}\x1b[24m` };
		const ctx = { cwd: dir, mode: "rpc", isIdle: () => true, ui: { notify: text => notices.push(text) } };
		extension(pi);
		await handler("--help", ctx);
		assert.match(notices.at(-1), /video/);
		for (const hyperlinks of [true, false]) {
			setCapabilities({ images: null, trueColor: true, hyperlinks });
			publishOutcome(pi, { ...ctx, mode: "tui" }, { entry: data });
			assert.deepEqual(entries.at(-1).data, data);
			assert.equal(notices.at(-1), `Saved video: ${videoPath}`);
			const lines = renderer(entries.at(-1), {}, theme).render(1000);
			const visible = [...lines, notices.at(-1)].map(stripTerminalSequences).join("\n");
			assert.equal(visible.split(url).length - 1, 1);
			assert.match(visible, /Open original video/);
			const linkLine = lines.find(line => stripTerminalSequences(line).startsWith("file:///"));
			assert.equal(getOsc8LinkAtColumn(linkLine, 0), hyperlinks ? url : undefined);
			assert.ok(linkLine.includes("\x1b[4m"));
			publishOutcome(pi, ctx, { entry: data });
			assert.equal(notices.at(-1).split(url).length - 1, 1);
			assert.doesNotMatch(notices.at(-1), /\x1b/);
			assert.doesNotMatch(JSON.stringify(entries), /\\u001b/);
		}
		// Fresh extension and JSON-roundtripped old metadata need no migration or extra files.
		const oldRenderer = renderer;
		extension(pi);
		assert.notEqual(renderer, oldRenderer);
		for (const filePath of [videoPath, path.join(outputDir, "missing.mp4")]) {
			const historical = JSON.parse(JSON.stringify({ data: { ...data, path: filePath } }));
			assert.ok(renderer(historical, {}, theme).render(1000).join("\n").includes(pathToFileURL(filePath).href));
		}
		for (const invalid of [undefined, null, 42, ".pi/generated-videos/relative.mp4", path.join(dir, "outside.mp4"), path.join(outputDir, "not-video.html")]) {
			const text = renderer({ data: { ...data, path: invalid } }, {}, theme).render(1000).join("\n");
			assert.match(text, /invalid path/);
			assert.doesNotMatch(text, /file:\/\//);
		}
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const specialPath = path.join(outputDir, '原片 # % "\x1b.mp4');
		const specialUrl = pathToFileURL(specialPath).href;
		assert.equal(fileURLToPath(specialUrl), specialPath);
		assert.match(specialUrl, /%1B/i);
		const formatted = formatVideoLink(specialPath, theme);
		assert.equal(formatVideoLink(specialPath), specialUrl);
		assert.equal(stripTerminalSequences(formatted), specialUrl);
		assert.equal(getOsc8LinkAtColumn(formatted + " AFTER", specialUrl.length), undefined);
		for (const width of [24, 60]) {
			const lines = new Text(formatted, 0, 0).render(width);
			assert.ok(lines.length > 1);
			assert.equal(lines.map(line => stripTerminalSequences(line).trimEnd()).join(""), specialUrl);
			for (const line of lines) {
				assert.ok(visibleWidth(line) <= width);
				for (let col = 0; col < stripTerminalSequences(line).trimEnd().length; col++) assert.equal(getOsc8LinkAtColumn(line, col), specialUrl);
				assert.equal(getOsc8LinkAtColumn(line + " AFTER", width), undefined);
			}
		}
		const changingTheme = { ...theme };
		const component = renderer({ data }, {}, changingTheme);
		component.render(1000);
		changingTheme.fg = (color, text) => color === "mdLink" ? `\x1b[96m${text}\x1b[39m` : text;
		component.invalidate();
		assert.ok(component.render(1000).join("\n").includes("\x1b[96m"));
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		component.invalidate();
		assert.doesNotMatch(component.render(1000).join("\n"), /\x1b\]8;/);
		assert.deepEqual(await readdir(outputDir), filesBefore);
		assert.deepEqual(await readFile(videoPath), bytes);
		console.log("Video output checks passed: persistent TUI link, RPC fallback, historical entries, invalid paths, OSC 8 targets/wrapping, theme/capability refresh, no file writes or network.");
	} finally { setCapabilities(originalCapabilities); }
} finally {
	globalThis.fetch = originalFetch;
	await rm(dir, { recursive: true, force: true });
}
