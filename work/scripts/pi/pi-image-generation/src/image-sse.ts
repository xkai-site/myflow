import { decodeGeneratedImage } from "./image-files.ts";
import type { GeneratedImage, ImageTransportResult } from "./types.ts";

export interface SseLimits { maxEventBytes?: number; maxTotalBytes?: number }
export interface ImageSseOptions extends SseLimits {
 task: "generate" | "edit";
 outputFormat: "png" | "jpeg" | "webp";
 partialImages: number;
 signal?: AbortSignal;
 /** Ephemeral preview only. This adapter never writes files or history. */
 onPartial?: (image: Readonly<GeneratedImage>, index: number) => void | Promise<void>;
}
const MAX_EVENT = 48 * 1024 * 1024;
const MAX_TOTAL = 192 * 1024 * 1024;
function limit(value: number | undefined, maximum: number): number {
 if (value === undefined) return maximum;
 if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("Invalid SSE resource limit");
 return value;
}

/** Isolated SSE framing, independent of the production JSON transport. */
export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal, limits: SseLimits = {}): AsyncGenerator<{ event: string; data: string }> {
 const maxEvent = limit(limits.maxEventBytes, MAX_EVENT), maxTotal = limit(limits.maxTotalBytes, MAX_TOTAL);
 signal?.throwIfAborted();
 const reader = body.getReader();
 const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
 let event = "message", data: string[] = [], eventBytes = 0, total = 0;
 let parts: Buffer[] = [], tail: Buffer | undefined, used = 0, lineBytes = 0, skipLf = false, firstLine = true;
 const append = (fragment: Uint8Array) => {
  lineBytes += fragment.byteLength;
  if (eventBytes + lineBytes > maxEvent) throw new Error("SSE event byte limit exceeded");
  // Fixed buffers keep both time and storage linear even for one-byte chunks.
  for (let offset = 0; offset < fragment.byteLength;) {
   if (!tail || used === tail.length) { tail = Buffer.allocUnsafe(Math.min(16_384, maxEvent, Math.max(256, fragment.byteLength))); parts.push(tail); used = 0; }
   const count = Math.min(tail.length - used, fragment.byteLength - offset);
   tail.set(fragment.subarray(offset, offset + count), used); used += count; offset += count;
  }
 };
 let rejectAbort!: (reason: unknown) => void;
 const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
 const onAbort = () => { rejectAbort(signal!.reason); void reader.cancel().catch(() => undefined); };
 signal?.addEventListener("abort", onAbort, { once: true });
 try {
  while (true) {
   signal?.throwIfAborted();
   const chunk = await Promise.race([reader.read(), aborted]);
   signal?.throwIfAborted();
   if (chunk.done) {
    if (lineBytes) decoder.decode(Buffer.concat(parts, lineBytes)); // reject truncated UTF-8 too
    break; // SSE discards an unterminated last event.
   }
   total += chunk.value.byteLength;
   if (total > maxTotal) throw new Error("SSE cumulative byte limit exceeded");
   const bytes = chunk.value;
   let start = 0;
   for (let i = 0; i < bytes.byteLength; i++) {
    const byte = bytes[i];
    if (skipLf) { skipLf = false; if (byte === 10) { start = i + 1; continue; } }
    if (byte !== 10 && byte !== 13) continue;
    append(bytes.subarray(start, i));
    let line = decoder.decode(Buffer.concat(parts, lineBytes));
    if (firstLine && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    firstLine = false; parts = []; tail = undefined; used = 0;
    // Count CR as two bytes conservatively, including split CRLF delimiters.
    eventBytes += lineBytes + (byte === 13 ? 2 : 1); lineBytes = 0;
    if (eventBytes > maxEvent) throw new Error("SSE event byte limit exceeded");
    skipLf = byte === 13; start = i + 1;
    if (!line) {
     if (data.length) { signal?.throwIfAborted(); yield { event, data: data.join("\n") }; }
     event = "message"; data = []; eventBytes = 0;
    } else if (!line.startsWith(":")) {
     const colon = line.indexOf(":");
     const field = colon < 0 ? line : line.slice(0, colon);
     let value = colon < 0 ? "" : line.slice(colon + 1);
     if (value.startsWith(" ")) value = value.slice(1);
     if (field === "data") {
      if (data.length >= 100_000) throw new Error("SSE event data-line limit exceeded");
      data.push(value);
     } else if (field === "event") event = value;
     // id/retry and unknown fields have no image protocol meaning.
    }
   }
   append(bytes.subarray(start));
  }
 } finally {
  signal?.removeEventListener("abort", onAbort);
  await reader.cancel().catch(() => undefined);
  reader.releaseLock();
 }
}

/** Platform Images SSE protocol, NOT a claim about Codex SSE support.
 * No fetch/auth and no production feature switch. A completed event is mandatory.
 */
export async function readImageSse(response: Response, options: ImageSseOptions): Promise<ImageTransportResult> {
 if (!Number.isSafeInteger(options.partialImages) || options.partialImages < 0 || options.partialImages > 3) throw new Error("partial_images must be an integer from 0 to 3");
 if (!["generate", "edit"].includes(options.task) || !["png", "jpeg", "webp"].includes(options.outputFormat)) throw new Error("SSE supports only raster generation/edit, not SVG or GIF");
 options.signal?.throwIfAborted();
 if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "text/event-stream" || !response.body) throw new Error("Expected a successful Images SSE response");
 const prefix = options.task === "edit" ? "image_edit" : "image_generation";
 const mime = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" }[options.outputFormat];
 let final: GeneratedImage | undefined;
 let previous = -1;
 for await (const envelope of parseSse(response.body, options.signal, options)) {
  options.signal?.throwIfAborted();
  let payload: Record<string, unknown>;
  try {
   const raw = JSON.parse(envelope.data);
   if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
   payload = raw;
  } catch { throw new Error("Malformed Images SSE JSON event"); }
  const type = payload.type;
  if (envelope.event === "error" || type === "error" || payload.error !== undefined) throw new Error("Images SSE server error; no final image saved");
  if (final || (envelope.event !== "message" && envelope.event !== type) || (type !== `${prefix}.partial_image` && type !== `${prefix}.completed`)) throw new Error("Unexpected Images SSE event or ordering");
  if (typeof payload.b64_json !== "string" || (payload.output_format !== undefined && payload.output_format !== options.outputFormat)) throw new Error("Images SSE image payload/format mismatch");
  const decoded = decodeGeneratedImage({ data: payload.b64_json, mimeType: "" });
  if (decoded.mimeType !== mime) throw new Error("Images SSE actual image format mismatch");
  const image = Object.freeze({ data: payload.b64_json, mimeType: decoded.mimeType });
  if (type === `${prefix}.partial_image`) {
   const index = payload.partial_image_index;
   if (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= options.partialImages || Number(index) <= previous) throw new Error("Invalid Images SSE partial_image_index");
   previous = Number(index);
   options.signal?.throwIfAborted();
   await options.onPartial?.(image, previous);
   options.signal?.throwIfAborted();
  } else final = image;
 }
 options.signal?.throwIfAborted();
 if (!final) throw new Error("Images SSE ended without a completed image");
 return { images: [final], texts: [] };
}
