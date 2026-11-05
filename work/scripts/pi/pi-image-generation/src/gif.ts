/** Bounded GIF container validation, not a pixel/LZW decoder or an animation player. */
export interface GifMetadata { width: number; height: number; frames: number; delaysMs: number[]; loopCount?: number }
const MAX_BYTES = 32 * 1024 * 1024;
export const GIF_MAX_PIXELS = 16_777_216;
const MAX_TOTAL_PIXELS = 64 * 1024 * 1024;

export function validateAnimatedGif(bytes: Buffer): GifMetadata {
	const invalid = (): never => { throw new Error("Invalid or unsupported animated GIF structure"); };
	if (bytes.length > MAX_BYTES) throw new Error("GIF exceeds the size limit");
	if (bytes.length < 14 || !["GIF87a", "GIF89a"].includes(bytes.toString("latin1", 0, 6))) invalid();
	let offset = 6;
	const take = (length: number): number => {
		if (length < 0 || length > bytes.length - offset) invalid();
		const start = offset; offset += length; return start;
	};
	const byte = () => bytes[take(1)];
	const word = () => bytes.readUInt16LE(take(2));
	const width = word(), height = word(), packed = byte(), background = byte(); byte();
	if (!width || !height || width * height > GIF_MAX_PIXELS) invalid();
	const globalColors = packed & 0x80 ? 1 << ((packed & 7) + 1) : 0;
	if (globalColors) { if (background >= globalColors) invalid(); take(globalColors * 3); }
	const subblocks = (): number => {
		let total = 0;
		for (;;) { const length = byte(); if (!length) return total; take(length); total += length; }
	};
	const result: GifMetadata = { width, height, frames: 0, delaysMs: [] };
	let pendingDelay: number | undefined;
	let transparentIndex: number | undefined;
	let pixels = 0;
	for (;;) {
		const marker = byte();
		if (marker === 0x3b) {
			if (offset !== bytes.length || result.frames < 2 || pendingDelay !== undefined) invalid();
			return result;
		}
		if (marker === 0x21) {
			const label = byte();
			if (label === 0xf9) {
				if (byte() !== 4 || pendingDelay !== undefined) invalid();
				const flags = byte();
				if (flags & 0xe0 || ((flags >> 2) & 7) > 3) invalid();
				pendingDelay = word() * 10;
				const index = byte(); transparentIndex = flags & 1 ? index : undefined;
				if (byte() !== 0) invalid();
			} else if (label === 0xff) {
				if (byte() !== 11) invalid();
				const name = bytes.toString("latin1", take(11), offset);
				if (name === "NETSCAPE2.0" || name === "ANIMEXTS1.0") {
					if (result.loopCount !== undefined || byte() !== 3 || byte() !== 1) invalid();
					result.loopCount = word();
					if (byte() !== 0) invalid();
				} else subblocks();
			} else if (label === 0xfe) subblocks();
			else invalid(); // Plain-text rendering/unknown extensions are outside this static file subset.
			continue;
		}
		if (marker !== 0x2c) invalid();
		const left = word(), top = word(), w = word(), h = word(), flags = byte();
		if (!w || !h || left + w > width || top + h > height || flags & 0x18) invalid();
		pixels += w * h;
		if (++result.frames > 16 || pixels > MAX_TOTAL_PIXELS) invalid();
		const localColors = flags & 0x80 ? 1 << ((flags & 7) + 1) : 0;
		const colors = localColors || globalColors;
		if (!colors || (transparentIndex !== undefined && transparentIndex >= colors)) invalid();
		if (localColors) take(localColors * 3);
		const codeSize = byte();
		if (codeSize < 2 || codeSize > 8 || !subblocks()) invalid();
		result.delaysMs.push(pendingDelay ?? 0);
		pendingDelay = undefined; transparentIndex = undefined;
	}
}
