import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GeneratedImage, InputImage, SavedImage } from "./types.ts";
import type { ImageLimits } from "./model-config.ts";
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const ALLOWED_INPUT_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/bmp"]);

export interface DecodedImage {
	bytes: Buffer;
	mimeType: string;
	extension: "png" | "jpg" | "webp" | "bmp";
}

export function parseReferenceImagePaths(input: string): string[] {
	return input
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
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

export async function loadInputImages(
	cwd: string,
	filePaths: readonly string[],
	limits: ImageLimits,
): Promise<InputImage[]> {
	if (filePaths.length > limits.maximum) throw new Error(`Model accepts at most ${limits.maximum} reference images`);
	const images: InputImage[] = [];
	for (const [index, filePath] of filePaths.entries()) {
		const absolutePath = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(cwd, filePath);
		let fileStats: Awaited<ReturnType<typeof stat>>;
		try {
			fileStats = await stat(absolutePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				throw new Error(`Reference image ${index + 1} does not exist: ${filePath}`);
			}
			throw error;
		}
		if (!fileStats.isFile()) throw new Error(`Reference image ${index + 1} is not a file: ${filePath}`);
		const maxBytes = limits.maxBytes;
		if (fileStats.size > maxBytes) {
			throw new Error(`Reference image ${index + 1} exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB limit`);
		}
		const bytes = await readFile(absolutePath);
		const detected = detectImage(bytes);
		if (!detected) throw new Error(`Reference image ${index + 1} has an unsupported file signature`);
		images.push({ data: bytes.toString("base64"), mimeType: detected.mimeType });
	}
	validateInputImages(images, limits);
	return images;
}

export function validateInputImages(images: readonly InputImage[], limits: ImageLimits): void {
	if (images.length > limits.maximum) throw new Error(`Model accepts at most ${limits.maximum} reference images`);
	const maxBytes = limits.maxBytes;
	for (const [index, image] of images.entries()) {
		if (!ALLOWED_INPUT_MIME.has(normalizeMimeType(image.mimeType)) || !limits.mimeTypes.includes(normalizeMimeType(image.mimeType))) {
			throw new Error(`Reference image ${index + 1} has unsupported MIME type: ${image.mimeType}`);
		}
		const decoded = decodeImage(image.data, maxBytes);
		if (normalizeMimeType(image.mimeType) !== decoded.mimeType) {
			throw new Error(`Reference image ${index + 1} MIME type does not match its file signature`);
		}
	}
}

export function decodeGeneratedImage(image: GeneratedImage): DecodedImage {
	const decoded = decodeImage(image.data, MAX_OUTPUT_BYTES);
	const declaredMime = normalizeMimeType(image.mimeType);
	if (declaredMime && declaredMime !== decoded.mimeType) {
		throw new Error("Generated image MIME type does not match its file signature");
	}
	return decoded;
}

export function detectImage(bytes: Uint8Array): Omit<DecodedImage, "bytes"> | undefined {
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return { mimeType: "image/png", extension: "png" };
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return { mimeType: "image/jpeg", extension: "jpg" };
	}
	if (
		bytes.length >= 12 &&
		ascii(bytes, 0, 4) === "RIFF" &&
		ascii(bytes, 8, 12) === "WEBP"
	) {
		return { mimeType: "image/webp", extension: "webp" };
	}
	if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
		return { mimeType: "image/bmp", extension: "bmp" };
	}
	return undefined;
}

export async function saveGeneratedImages(
	cwd: string,
	provider: string,
	model: string,
	images: readonly GeneratedImage[],
	signal?: AbortSignal,
): Promise<SavedImage[]> {
	if (images.length === 0) throw new Error("Provider returned no images");
	const outputDirectory = path.resolve(cwd, ".pi", "generated-images");
	await ensureSafeOutputDirectory(cwd, outputDirectory);
	const saved: SavedImage[] = [];

	try {
		for (const image of images) {
			signal?.throwIfAborted();
			const decoded = decodeGeneratedImage(image);
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			const suffix = randomUUID().slice(0, 8);
			const filename = `${timestamp}-${safeSlug(provider)}-${safeSlug(model)}-${suffix}.${decoded.extension}`;
			const finalPath = path.join(outputDirectory, filename);
			const temporaryPath = path.join(outputDirectory, `.${filename}.${randomUUID()}.tmp`);
			try {
				await writeFile(temporaryPath, decoded.bytes, { flag: "wx" });
				signal?.throwIfAborted();
				await rename(temporaryPath, finalPath);
			} catch (error) {
				await rm(temporaryPath, { force: true }).catch(() => undefined);
				throw error;
			}
			saved.push({ path: finalPath, mimeType: decoded.mimeType, bytes: decoded.bytes.length });
		}
		return saved;
	} catch (error) {
		for (const file of saved) await rm(file.path, { force: true }).catch(() => undefined);
		throw error;
	}
}

export async function readGeneratedImage(filePath: string, mimeType: string): Promise<GeneratedImage> {
	const bytes = await readFile(filePath);
	if (bytes.length > MAX_OUTPUT_BYTES) throw new Error("Generated image is too large to render");
	const detected = detectImage(bytes);
	if (!detected || detected.mimeType !== normalizeMimeType(mimeType)) {
		throw new Error("Stored image format is invalid");
	}
	return { data: bytes.toString("base64"), mimeType: detected.mimeType };
}

export function isGeneratedImagePath(filePath: string): boolean {
	const normalized = path.normalize(filePath);
	return path.basename(path.dirname(normalized)).toLowerCase() === "generated-images" &&
		path.basename(path.dirname(path.dirname(normalized))).toLowerCase() === ".pi";
}

function decodeImage(data: string, maxBytes: number): DecodedImage {
	if (data.length > Math.ceil(maxBytes / 3) * 4) throw new Error("Image payload exceeds the size limit");
	if (!isCanonicalBase64(data)) throw new Error("Image payload is not valid base64");
	const bytes = Buffer.from(data, "base64");
	if (bytes.length === 0) throw new Error("Image payload is empty");
	if (bytes.length > maxBytes) throw new Error(`Image exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB limit`);
	const detected = detectImage(bytes);
	if (!detected) throw new Error("Image payload has an unsupported file signature");
	return { bytes, ...detected };
}

function isCanonicalBase64(data: string): boolean {
	if (data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return false;
	const paddingIndex = data.indexOf("=");
	return paddingIndex === -1 || paddingIndex >= data.length - 2;
}

function normalizeMimeType(mimeType: string): string {
	const normalized = mimeType.split(";", 1)[0].trim().toLowerCase();
	return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
	return String.fromCharCode(...bytes.slice(start, end));
}

function safeSlug(value: string): string {
	const slug = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return slug || "image";
}

export async function ensureSafeOutputDirectory(cwd: string, outputDirectory: string): Promise<void> {
	const projectRoot = path.resolve(cwd);
	const relative = path.relative(projectRoot, outputDirectory);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error("Image output directory escapes the current project");
	}
	const configDirectory = path.join(projectRoot, ".pi");
	for (const candidate of [configDirectory, outputDirectory]) {
		try {
			const stats = await lstat(candidate);
			if (stats.isSymbolicLink()) throw new Error(`Refusing to write through symbolic link: ${candidate}`);
			if (!stats.isDirectory()) throw new Error(`Image output path is not a directory: ${candidate}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	await mkdir(outputDirectory, { recursive: true });
}
