import { open } from "node:fs/promises";
import { endianness } from "node:os";
import path from "node:path";
import { decodeGeneratedImage, validateInputImages } from "./image-files.ts";
import type { ImageModelConfig } from "./model-config.ts";
import type { InputImage } from "./types.ts";

export const MARKUP_MAX_PIXELS = 16_777_216;
export const MARKUP_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MARKUP_MAX_DATA_URL_LENGTH = 20_971_520;
export const MARKUP_MAX_JSON_BYTES = Math.floor((MARKUP_MAX_DATA_URL_LENGTH - "data:image/png;base64,".length) / 4) * 3;
// Identity-bound immutable evidence for the synchronous request builder. A caller
// cannot forge a validation boolean or mutate the bytes after pixel validation.
const prepared = new WeakMap<InputImage, readonly InputImage[]>();

export async function loadMarkupImage(cwd: string, filePath: string, signal?: AbortSignal): Promise<InputImage> {
 signal?.throwIfAborted();
 const file = await open(path.resolve(cwd, filePath), "r");
 try {
  const stats = await file.stat();
  if (!stats.isFile() || stats.size > MARKUP_MAX_JSON_BYTES) throw new Error("Markup PNG exceeds the file/data URL size limit or is not a file");
  // Bound reads even if the file grows after stat; do not allocate its reported size.
  const bytes = Buffer.alloc(MARKUP_MAX_JSON_BYTES + 1);
  let count = 0;
  while (count < bytes.length) {
   signal?.throwIfAborted();
   const read = await file.read(bytes, count, bytes.length - count, null);
   if (!read.bytesRead) break;
   count += read.bytesRead;
  }
  if (count > MARKUP_MAX_JSON_BYTES) throw new Error("Markup PNG exceeds the data URL size limit");
  return { data: bytes.subarray(0, count).toString("base64"), mimeType: "image/png" };
 } finally { await file.close(); }
}

export function assertPreparedMarkup(images: readonly InputImage[], markup: InputImage): void {
 if (prepared.get(markup) !== images) throw new Error("Markup must pass pixel/orientation validation before request construction");
}

// TODO: 当前 Codex Markup 编辑链路/服务端响应实测固定为 1254×1254（不同 size 均如此），非客户端传参或缩放问题；待核实服务端尺寸限制。
/** Real bounded pixel decoding, not a header/alpha-channel test. Returns a separate
 * oriented PNG overlay and oriented first image; never composites the two. */
export async function prepareMarkupEdit(model: ImageModelConfig, images: readonly InputImage[], markup: InputImage, signal?: AbortSignal): Promise<{ images: readonly InputImage[]; markup: InputImage }> {
 signal?.throwIfAborted();
 if (!model.nativeCapabilities?.markup?.enabled || !images.length || !model.tasks.includes("edit")) throw new Error("Markup is not enabled for editing by this model");
 validateInputImages(images, model.inputImages);
 if (prepared.get(markup) === images) return { images, markup };
 const decoded = decodeGeneratedImage(markup);
 if (decoded.mimeType !== "image/png" || markup.mimeType !== "image/png") throw new Error("Markup must be a real PNG");
 if (decoded.bytes.length > MARKUP_MAX_FILE_BYTES || `data:image/png;base64,${markup.data}`.length > MARKUP_MAX_DATA_URL_LENGTH) throw new Error("Markup PNG exceeds the file/data URL size limit");
 const source = decodeGeneratedImage(images[0]);
 // Native codecs are loaded only for an explicitly enabled markup operation.
 const { default: sharp } = await import("sharp");
 const decodeOptions = { limitInputPixels: MARKUP_MAX_PIXELS, failOn: "warning" as const, pages: 1 };
 // Disallow multi-page/animated inputs rather than silently choosing one frame.
 let overlay16 = false, original16 = false;
 for (const [index, bytes] of [source.bytes, decoded.bytes].entries()) {
  if (bytes.subarray(1, 4).toString("ascii") === "PNG") {
   for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw new Error("Invalid markup/input PNG chunk");
    if (bytes.toString("ascii", offset + 4, offset + 8) === "acTL") throw new Error("Animated PNG is not supported for markup");
    offset += length + 12;
   }
  }
  signal?.throwIfAborted();
  const metadata = await sharp(bytes, decodeOptions).metadata();
  if (index === 0) original16 = metadata.bitsPerSample === 16;
  else overlay16 = metadata.bitsPerSample === 16;
  if ((metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height || metadata.width * metadata.height > MARKUP_MAX_PIXELS) throw new Error("Markup and first image must each be single images within the pixel limit");
 }
 signal?.throwIfAborted();
 const overlay = await sharp(decoded.bytes, decodeOptions).rotate().toColourspace(overlay16 ? "rgb16" : "srgb").ensureAlpha().raw({ depth: overlay16 ? "ushort" : "uchar" }).toBuffer({ resolveWithObject: true });
 signal?.throwIfAborted();
 let transparent = false;
 if (overlay16) {
  for (let i = 6; i < overlay.data.length; i += 8) {
   const alpha = endianness() === "LE" ? overlay.data.readUInt16LE(i) : overlay.data.readUInt16BE(i);
   if (alpha < 65535) { transparent = true; break; }
  }
 } else for (let i = 3; i < overlay.data.length; i += 4) if (overlay.data[i] < 255) { transparent = true; break; }
 if (!transparent) throw new Error("Markup PNG must contain actual transparent pixels, not just an alpha channel");
 const original = await sharp(source.bytes, decodeOptions).rotate().toColourspace(original16 ? "rgb16" : "srgb").png().toBuffer({ resolveWithObject: true });
 signal?.throwIfAborted();
 if (original.info.width !== overlay.info.width || original.info.height !== overlay.info.height) throw new Error("Markup dimensions must match the first image after EXIF orientation");
 // Preserve 16-bit alpha: 65534/65535 is genuinely transparent and must not round to opaque.
 const pixels = overlay16 ? new Uint16Array(overlay.data.buffer, overlay.data.byteOffset, overlay.data.byteLength / 2) : overlay.data;
 const png = await sharp(pixels, { raw: { width: overlay.info.width, height: overlay.info.height, channels: 4 }, limitInputPixels: MARKUP_MAX_PIXELS }).toColourspace(overlay16 ? "rgb16" : "srgb").png().toBuffer();
 signal?.throwIfAborted();
 const normalizedMarkup = Object.freeze({ data: png.toString("base64"), mimeType: "image/png" });
 if (png.length > MARKUP_MAX_FILE_BYTES || normalizedMarkup.data.length + "data:image/png;base64,".length > MARKUP_MAX_DATA_URL_LENGTH) throw new Error("Oriented markup exceeds the file/data URL size limit");
 const normalizedImages = Object.freeze([Object.freeze({ data: original.data.toString("base64"), mimeType: "image/png" }), ...images.slice(1).map(image => Object.freeze({ ...image }))]);
 validateInputImages(normalizedImages, model.inputImages);
 prepared.set(normalizedMarkup, normalizedImages);
 return { images: normalizedImages, markup: normalizedMarkup };
}
