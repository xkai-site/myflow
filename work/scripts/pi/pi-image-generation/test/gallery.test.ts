import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { saveImageGallery } from "../src/gallery.ts";
import { saveGeneratedImages } from "../src/image-files.ts";
import type { GeneratedImageEntryData } from "../src/types.ts";

const png = { data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"), mimeType: "image/png" };
async function createEntries(cwd: string, count: number): Promise<GeneratedImageEntryData[]> {
	return (await saveGeneratedImages(cwd, "provider", "model", Array.from({ length: count }, () => png)))
		.map((image) => ({ ...image, provider: "provider", model: "model", prompt: "PRIVATE_PROMPT", createdAt: Date.now() }));
}

test("single and multi-image galleries reference every original, remain unique and use local-only resources", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "image-gallery-"));
	try {
		for (const count of [1, 4]) {
			const entries = await createEntries(cwd, count);
			const first = await saveImageGallery(cwd, entries);
			const html = await readFile(first, "utf8");
			const second = await saveImageGallery(cwd, entries);
			assert.notEqual(first, second);
			assert.equal(await readFile(first, "utf8"), html);
			assert.equal((html.match(/<figure>/g) ?? []).length, count);
			assert.ok(html.includes(`<title>图片预览${count === 1 ? "" : ` · ${count} 张`}</title>`));
			assert.doesNotMatch(html, /PRIVATE_PROMPT|data:image|<script|https?:\/\//);
			for (const entry of entries) {
				assert.ok(html.includes(`src="./${encodeURIComponent(path.basename(entry.path))}"`));
				assert.ok(html.includes(`href="./${encodeURIComponent(path.basename(entry.path))}"`));
				assert.equal((await readFile(entry.path)).toString("base64"), png.data);
			}
		}
		assert.ok((await readdir(path.join(cwd, ".pi", "generated-images"))).every((name) => !name.endsWith(".tmp")));
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("gallery omits technical metadata and safely encodes filenames in copyable file URLs", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "图集 space #%-"));
	try {
		const [entry] = await createEntries(cwd, 1);
		entry.path = path.join(path.dirname(entry.path), "图 & ' #%.png");
		await writeFile(entry.path, Buffer.from(png.data, "base64"));
		entry.provider = '<script>alert("x")</script>';
		entry.model = "model & 'quoted'";
		const gallery = await saveImageGallery(cwd, [entry]);
		const html = await readFile(gallery, "utf8");
		assert.doesNotMatch(html, /alert|quoted|PRIVATE_PROMPT|<script>/);
		assert.match(html, /%26%20&#39;%20%23%25\.png/);
		const caption = html.match(/<figcaption>([\s\S]*?)<\/figcaption>/)![1];
		const visibleCaption = caption.replace(/<[^>]+>/g, "");
		assert.doesNotMatch(visibleCaption, /图 &|provider|model|\.png/);
		assert.match(visibleCaption, /查看原图/);
		assert.doesNotMatch(visibleCaption, /下载/);
		const src = html.match(/<img src="([^"]+)"/)![1].replaceAll("&#39;", "'");
		assert.equal(fileURLToPath(new URL(src, pathToFileURL(gallery))), entry.path);
		assert.equal(fileURLToPath(pathToFileURL(gallery)), gallery);
		assert.match(pathToFileURL(gallery).href, /%20/);
		assert.match(pathToFileURL(gallery).href, /%23/);
		assert.match(pathToFileURL(gallery).href, /%25/);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("image-first layout reserves an unclipped viewport with accessible original links", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "image-gallery-layout-"));
	try {
		for (const count of [1, 4, 51]) {
			const entries = await createEntries(cwd, count);
			const html = await readFile(await saveImageGallery(cwd, entries), "utf8");
			assert.equal(html.includes('class="gallery gallery--single"'), count === 1);
			assert.equal(html.includes('class="gallery gallery--many"'), count > 50);
			assert.equal((html.match(/class="image-number"/g) ?? []).length, count === 1 ? 0 : count);
			assert.doesNotMatch(html, /此页面|不上传|相对位置|<p>|<script|transition:|animation:|maximum-scale|user-scalable/);
			assert.match(html, /color-scheme: dark/);
			assert.match(html, /name="theme-color" content="#111214"/);
			assert.match(html, /object-fit: contain/);
			assert.match(html, /100svh/);
			assert.match(html, /env\(safe-area-inset-bottom/);
			assert.match(html, /a:focus-visible/);
			assert.match(html, /href="#gallery">跳至图片/);
			assert.match(html, /<main id="gallery"[^>]+tabindex="-1"/);
			assert.match(html, /min-height: 44px/);
			assert.match(html, /default-src 'none'/);
			const images = [...html.matchAll(/<img [^>]+>/g)].map(([tag]) => tag);
			assert.equal(images.length, count);
			images.forEach((image, index) => {
				assert.match(image, /width="1600" height="1000"/);
				assert.ok(image.includes(`alt="生成图片 ${index + 1}"`));
				assert.ok(image.includes(`loading="${index === 0 ? "eager" : "lazy"}"`));
				assert.ok(image.includes(`fetchpriority="${index === 0 ? "high" : "auto"}"`));
			});
			assert.doesNotMatch(html, /download=|下载/);
			assert.equal((html.match(/aria-label="查看原图 /g) ?? []).length, count * 2);
			assert.equal((html.match(/target="_blank" rel="noopener noreferrer"/g) ?? []).length, count * 2);
		}
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("rejects empty, missing and outside-directory images without deleting saved images", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "image-gallery-invalid-"));
	try {
		const [entry] = await createEntries(cwd, 1);
		await assert.rejects(saveImageGallery(cwd, []), /empty/);
		await assert.rejects(saveImageGallery(cwd, [{ ...entry, path: path.join(cwd, "outside.png") }]), /current project's/);
		await assert.rejects(saveImageGallery(cwd, [{ ...entry, path: path.join(path.dirname(entry.path), "missing.png") }]), /ENOENT/);
		await assert.rejects(saveImageGallery(cwd, [{ ...entry, path: ".pi/generated-images/relative.png" }]), /current project's/);
		assert.equal((await readFile(entry.path)).toString("base64"), png.data);
		assert.equal((await readdir(path.dirname(entry.path))).length, 1);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("rejects a linked output directory", async (t) => {
	const cwd = await mkdtemp(path.join(tmpdir(), "image-gallery-link-"));
	const target = await mkdtemp(path.join(tmpdir(), "image-gallery-target-"));
	try {
		const [entry] = await createEntries(target, 1);
		try { await symlink(path.join(target, ".pi"), path.join(cwd, ".pi"), process.platform === "win32" ? "junction" : "dir"); }
		catch (error) {
			if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return t.skip("Symlinks unavailable");
			throw error;
		}
		await assert.rejects(saveImageGallery(cwd, [{ ...entry, path: path.join(cwd, ".pi", "generated-images", path.basename(entry.path)) }]), /symbolic link/);
		assert.equal((await readdir(path.dirname(entry.path))).length, 1);
	} finally {
		await rm(cwd, { recursive: true, force: true });
		await rm(target, { recursive: true, force: true });
	}
});
