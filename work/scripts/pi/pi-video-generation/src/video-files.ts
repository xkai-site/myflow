import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { requireHttpsUrl } from "./http.ts";
import type { InputImage, SavedVideo, VideoModelConfig } from "./types.ts";

export interface DetectedImage {
	mimeType: "image/jpeg" | "image/png" | "image/webp";
	width: number;
	height: number;
}

export function parseImagePaths(input: string): string[] {
	return input
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const withoutAt = line.startsWith("@") ? line.slice(1).trim() : line;
			if (
				withoutAt.length >= 2 &&
				((withoutAt.startsWith('"') && withoutAt.endsWith('"')) ||
					(withoutAt.startsWith("'") && withoutAt.endsWith("'")))
			) {
				return withoutAt.slice(1, -1);
			}
			return withoutAt;
		});
}

export async function loadInputImages(cwd: string, filePaths: readonly string[], model: VideoModelConfig): Promise<InputImage[]> {
	const limits = model.inputImages;
	if (filePaths.length < limits.minimum || filePaths.length > limits.maximum) {
		throw new Error(`${model.id} requires ${limits.minimum} to ${limits.maximum} input image(s)`);
	}
	const images: InputImage[] = [];
	for (const [index, filePath] of filePaths.entries()) {
		const absolutePath = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(cwd, filePath);
		const bytes = await readBoundedInputFile(absolutePath, limits.maxBytes, index, filePath);
		const detected = detectImage(bytes);
		if (!detected) throw new Error(`Input image ${index + 1} has an unsupported or invalid file signature`);
		if (!limits.mimeTypes.includes(detected.mimeType)) {
			throw new Error(`Input image ${index + 1} has unsupported MIME type ${detected.mimeType}`);
		}
		validateDimensions(detected, model, index);
		images.push({
			path: absolutePath,
			data: bytes.toString("base64"),
			mimeType: detected.mimeType,
			bytes: bytes.length,
			width: detected.width,
			height: detected.height,
		});
	}
	return images;
}

export function detectImage(bytes: Uint8Array): DetectedImage | undefined {
	if (
		bytes.length >= 24 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		ascii(bytes, 12, 16) === "IHDR"
	) {
		const width = readUint32BE(bytes, 16);
		const height = readUint32BE(bytes, 20);
		return width > 0 && height > 0 ? { mimeType: "image/png", width, height } : undefined;
	}
	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return detectJpeg(bytes);
	if (bytes.length >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
		return detectWebp(bytes);
	}
	return undefined;
}

export async function downloadAndSaveVideo(
	url: string,
	options: {
		cwd: string;
		provider: string;
		model: string;
		maxBytes: number;
		signal?: AbortSignal;
		fetch?: typeof globalThis.fetch;
	},
): Promise<SavedVideo> {
	const response = await fetchVideoWithSafeRedirects(url, options);
	if (!response.ok) throw new Error(`Generated video download failed: HTTP ${response.status}`);
	if (!response.body) throw new Error("Generated video download has no response body");
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
		throw new Error("Generated video exceeds the configured size limit");
	}
	const contentType = normalizeMimeType(response.headers.get("content-type") ?? "");
	if (contentType && contentType !== "video/mp4" && contentType !== "application/octet-stream") {
		throw new Error(`Generated video has unexpected MIME type ${contentType}`);
	}

	const outputDirectory = path.resolve(options.cwd, ".pi", "generated-videos");
	await ensureSafeOutputDirectory(options.cwd, outputDirectory);
	const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
	const filename = `${timestamp}-${safeSlug(options.provider)}-${safeSlug(options.model)}-${randomUUID().slice(0, 8)}.mp4`;
	const finalPath = path.join(outputDirectory, filename);
	const temporaryPath = path.join(outputDirectory, `.${filename}.${randomUUID()}.tmp`);
	const file = await open(temporaryPath, "wx", 0o600);
	let total = 0;
	let signature = Buffer.alloc(0);
	try {
		const reader = response.body.getReader();
		while (true) {
			options.signal?.throwIfAborted();
			const chunk = await reader.read();
			if (chunk.done) break;
			total += chunk.value.length;
			if (total > options.maxBytes) throw new Error("Generated video exceeds the configured size limit");
			if (signature.length < 32) {
				signature = Buffer.concat([signature, Buffer.from(chunk.value)]).subarray(0, 32);
			}
			await file.write(chunk.value);
		}
		if (total === 0) throw new Error("Generated video download is empty");
		if (!detectMp4(signature)) throw new Error("Generated video is not an MP4 file");
		await file.sync();
		await file.close();
		await rename(temporaryPath, finalPath);
		return { path: finalPath, mimeType: "video/mp4", bytes: total };
	} catch (error) {
		await file.close().catch(() => undefined);
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function fetchVideoWithSafeRedirects(
	url: string,
	options: { signal?: AbortSignal; fetch?: typeof globalThis.fetch },
): Promise<Response> {
	let current = requireHttpsUrl(url, "Generated video URL");
	const fetchImplementation = options.fetch ?? globalThis.fetch;
	for (let redirects = 0; redirects <= 5; redirects++) {
		const response = await fetchImplementation(current, { signal: options.signal, redirect: "manual" });
		if (![301, 302, 303, 307, 308].includes(response.status)) return response;
		if (redirects === 5) throw new Error("Generated video download exceeded 5 redirects");
		const location = response.headers.get("location");
		if (!location) throw new Error("Generated video redirect is missing Location");
		current = requireHttpsUrl(new URL(location, current).toString(), "Generated video redirect URL");
	}
	throw new Error("Generated video download exceeded 5 redirects");
}

export function detectMp4(bytes: Uint8Array): boolean {
	if (bytes.length < 12 || ascii(bytes, 4, 8) !== "ftyp") return false;
	const boxSize = readUint32BE(bytes, 0);
	return boxSize >= 8;
}

export function isGeneratedVideoPath(filePath: string): boolean {
	const normalized = path.normalize(filePath);
	return (
		path.basename(path.dirname(normalized)).toLowerCase() === "generated-videos" &&
		path.basename(path.dirname(path.dirname(normalized))).toLowerCase() === ".pi" &&
		path.extname(normalized).toLowerCase() === ".mp4"
	);
}

export async function ensureSafeOutputDirectory(cwd: string, outputDirectory: string): Promise<void> {
	const projectRoot = path.resolve(cwd);
	const relative = path.relative(projectRoot, outputDirectory);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error("Video output directory escapes the current project");
	}
	const configDirectory = path.join(projectRoot, ".pi");
	for (const candidate of [configDirectory, outputDirectory]) {
		try {
			const stats = await lstat(candidate);
			if (stats.isSymbolicLink()) throw new Error(`Refusing to write through symbolic link: ${candidate}`);
			if (!stats.isDirectory()) throw new Error(`Video output path is not a directory: ${candidate}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
}

async function readBoundedInputFile(
	absolutePath: string,
	maxBytes: number,
	index: number,
	displayPath: string,
): Promise<Buffer> {
	let file: Awaited<ReturnType<typeof open>>;
	try {
		file = await open(absolutePath, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`Input image ${index + 1} does not exist: ${displayPath}`);
		}
		throw error;
	}
	try {
		const fileStats = await file.stat();
		if (!fileStats.isFile()) throw new Error(`Input image ${index + 1} is not a file: ${displayPath}`);
		if (fileStats.size > maxBytes) {
			throw new Error(`Input image ${index + 1} exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB`);
		}
		const chunks: Buffer[] = [];
		let total = 0;
		while (true) {
			const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total + 1));
			const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
			if (bytesRead === 0) break;
			total += bytesRead;
			if (total > maxBytes) {
				throw new Error(`Input image ${index + 1} exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB`);
			}
			chunks.push(chunk.subarray(0, bytesRead));
		}
		return Buffer.concat(chunks, total);
	} finally {
		await file.close();
	}
}

function validateDimensions(image: DetectedImage, model: VideoModelConfig, index: number): void {
	const limits = model.inputImages;
	if (limits.minWidth !== undefined && image.width < limits.minWidth) {
		throw new Error(`Input image ${index + 1} width must be at least ${limits.minWidth}px`);
	}
	if (limits.minHeight !== undefined && image.height < limits.minHeight) {
		throw new Error(`Input image ${index + 1} height must be at least ${limits.minHeight}px`);
	}
	if (limits.minShortSide !== undefined && Math.min(image.width, image.height) < limits.minShortSide) {
		throw new Error(`Input image ${index + 1} short side must be at least ${limits.minShortSide}px`);
	}
	const ratio = image.width / image.height;
	if (limits.minAspectRatio !== undefined && ratio < limits.minAspectRatio) {
		throw new Error(`Input image ${index + 1} aspect ratio is below ${limits.minAspectRatio}`);
	}
	if (limits.maxAspectRatio !== undefined && ratio > limits.maxAspectRatio) {
		throw new Error(`Input image ${index + 1} aspect ratio exceeds ${limits.maxAspectRatio}`);
	}
}

function detectJpeg(bytes: Uint8Array): DetectedImage | undefined {
	let offset = 2;
	while (offset + 9 < bytes.length) {
		if (bytes[offset] !== 0xff) return undefined;
		const marker = bytes[offset + 1];
		offset += 2;
		if (marker === 0xd8 || marker === 0xd9) continue;
		if (offset + 2 > bytes.length) return undefined;
		const length = readUint16BE(bytes, offset);
		if (length < 2 || offset + length > bytes.length) return undefined;
		if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
			if (length < 7) return undefined;
			const height = readUint16BE(bytes, offset + 3);
			const width = readUint16BE(bytes, offset + 5);
			return width > 0 && height > 0 ? { mimeType: "image/jpeg", width, height } : undefined;
		}
		offset += length;
	}
	return undefined;
}

function detectWebp(bytes: Uint8Array): DetectedImage | undefined {
	const type = ascii(bytes, 12, 16);
	if (type === "VP8X" && bytes.length >= 30) {
		return {
			mimeType: "image/webp",
			width: 1 + readUint24LE(bytes, 24),
			height: 1 + readUint24LE(bytes, 27),
		};
	}
	if (type === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
		const bits = readUint32LE(bytes, 21);
		return {
			mimeType: "image/webp",
			width: (bits & 0x3fff) + 1,
			height: ((bits >>> 14) & 0x3fff) + 1,
		};
	}
	if (type === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
		return {
			mimeType: "image/webp",
			width: readUint16LE(bytes, 26) & 0x3fff,
			height: readUint16LE(bytes, 28) & 0x3fff,
		};
	}
	return undefined;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
	return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
	return (((bytes[offset] ?? 0) * 0x1000000) + ((bytes[offset + 1] ?? 0) << 16) + ((bytes[offset + 2] ?? 0) << 8) + (bytes[offset + 3] ?? 0)) >>> 0;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
	return (((bytes[offset + 3] ?? 0) * 0x1000000) + ((bytes[offset + 2] ?? 0) << 16) + ((bytes[offset + 1] ?? 0) << 8) + (bytes[offset] ?? 0)) >>> 0;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
	return String.fromCharCode(...bytes.slice(start, end));
}

function normalizeMimeType(value: string): string {
	return value.split(";", 1)[0].trim().toLowerCase();
}

function safeSlug(value: string): string {
	const slug = value.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
	return slug || "video";
}
