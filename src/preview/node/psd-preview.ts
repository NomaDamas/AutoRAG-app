import { type FileHandle, open } from "node:fs/promises";
import type * as agPsd from "ag-psd";
import type { PixelData } from "ag-psd";
import type { EmbeddedThumbnail } from "./odf";
import { encodePng } from "./png-encode";

/** `8BPS`: the signature of both a PSD and a PSB. */
const SIGNATURE = [0x38, 0x42, 0x50, 0x53] as const;
/** Signature, version, six reserved bytes, channels, height, width, depth, colour mode. */
const HEADER_BYTES = 26;
/** A resource 1036 payload: format, width, height, row bytes, two sizes, bits, planes. */
const THUMBNAIL_PREAMBLE_BYTES = 28;
/** Resource 1036 holds the JPEG thumbnail; 1033 holds the same picture as raw BGR, which nothing here can show. */
const THUMBNAIL_RESOURCE = 1036;
/** The `format` field of resource 1036 when the payload is a JPEG. */
const JPEG_FORMAT = 1;
/** The signatures Photoshop and other writers put at the head of an image resource block. */
const RESOURCE_SIGNATURES: Record<string, true> = { "8BIM": true, MeSa: true, AgHg: true, PHUT: true, DCSR: true };
/** Neither a colour table nor an image resource section is ever this big in a real document. */
const SECTION_BYTE_CAP = 16 * 1024 * 1024;
/** A composite this big is not a preview: the caller gets nothing rather than a stalled window. */
export const PSD_COMPOSITE_MAX_IMAGE_DATA_BYTES = 96 * 1024 * 1024;
/** Longest side of the decoded composite. A Quick Look panel shows less than this. */
export const PSD_COMPOSITE_MAX_SIDE = 2048;

export interface PsdReadOptions {
	/** Called with the length of every range read, so a caller can see the layer data was never touched. */
	readonly onRead?: (bytes: number) => void;
}

export interface PsdCompositeOptions extends PsdReadOptions {
	/** Image data past this many bytes is refused unread; defaults to {@link PSD_COMPOSITE_MAX_IMAGE_DATA_BYTES}. */
	readonly maxImageDataBytes?: number;
	/** Longest side of the returned PNG; defaults to {@link PSD_COMPOSITE_MAX_SIDE}. */
	readonly maxSide?: number;
}

/** The document's JPEG thumbnail, with the pixel size its resource records. */
export type PsdThumbnail = EmbeddedThumbnail & { readonly width: number; readonly height: number };

interface ByteRange {
	readonly offset: number;
	readonly length: number;
}

interface PsdSections {
	readonly header: Uint8Array;
	/** Version 2 is a PSB, whose layer-and-mask length is eight bytes instead of four. */
	readonly large: boolean;
	readonly colorModeData: ByteRange;
	readonly resources: ByteRange;
	readonly imageData: ByteRange;
}

type ReadRange = (position: number, length: number) => Promise<Uint8Array | null>;

/** Range reads over one open file: nothing past the file's own size is ever handed back. */
function rangeReader(handle: FileHandle, size: number, onRead?: (bytes: number) => void): ReadRange {
	return async (position, length) => {
		if (length < 0 || position < 0 || position + length > size) return null;
		if (length === 0) return new Uint8Array(0);
		const bytes = new Uint8Array(length);
		const { bytesRead } = await handle.read(bytes, 0, length, position);
		onRead?.(bytesRead);
		return bytesRead === length ? bytes : null;
	};
}

function uint16(bytes: Uint8Array, offset: number): number {
	return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function uint32(bytes: Uint8Array, offset: number): number {
	return (((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)) >>> 0;
}

function latin1(bytes: Uint8Array, offset: number, length: number): string {
	let text = "";
	for (let index = 0; index < length; index += 1) text += String.fromCharCode(bytes[offset + index] ?? 0);
	return text;
}

/** A section's length prefix: four bytes, or eight in a PSB (the only length that grows there). */
async function readSectionLength(read: ReadRange, offset: number, large: boolean): Promise<number | null> {
	const bytes = await read(offset, large ? 8 : 4);
	if (bytes === null) return null;
	// A section needing more than four bytes is far past a preview's reach, and its high
	// word would take the offset arithmetic past Number.MAX_SAFE_INTEGER.
	return large ? (uint32(bytes, 0) === 0 ? uint32(bytes, 4) : null) : uint32(bytes, 0);
}

/** The header and the offsets of the three sections behind it, or null for anything unreadable. */
async function readSections(read: ReadRange, size: number): Promise<PsdSections | null> {
	const header = await read(0, HEADER_BYTES);
	if (header === null || SIGNATURE.some((byte, index) => byte !== header[index])) return null;
	const version = uint16(header, 4);
	if (version !== 1 && version !== 2) return null;
	const large = version === 2;
	let offset = HEADER_BYTES;
	const colorModeLength = await readSectionLength(read, offset, false);
	if (colorModeLength === null) return null;
	const colorModeOffset = offset + 4;
	offset = colorModeOffset + colorModeLength;
	const resourcesLength = await readSectionLength(read, offset, false);
	if (resourcesLength === null) return null;
	const resourcesOffset = offset + 4;
	offset = resourcesOffset + resourcesLength;
	const layerLength = await readSectionLength(read, offset, large);
	if (layerLength === null) return null;
	const imageDataOffset = offset + (large ? 8 : 4) + layerLength;
	if (imageDataOffset > size) return null;
	return {
		header,
		large,
		colorModeData: { offset: colorModeOffset, length: colorModeLength },
		resources: { offset: resourcesOffset, length: resourcesLength },
		imageData: { offset: imageDataOffset, length: size - imageDataOffset },
	};
}

/** Resource 1036's payload is a 28-byte preamble and then the JPEG itself. */
function thumbnailFromPayload(payload: Uint8Array): PsdThumbnail | null {
	if (payload.length < THUMBNAIL_PREAMBLE_BYTES + 2 || uint32(payload, 0) !== JPEG_FORMAT) return null;
	const bytes = payload.subarray(THUMBNAIL_PREAMBLE_BYTES);
	if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	return { bytes, mime: "image/jpeg", width: uint32(payload, 4), height: uint32(payload, 8) };
}

/**
 * Walks the image resource blocks for the JPEG thumbnail. Null when the stream
 * is damaged or carries no JPEG thumbnail; resource 1033 and every other id is
 * stepped over by its length without its payload being read.
 */
function findThumbnail(resources: Uint8Array): PsdThumbnail | null {
	let offset = 0;
	// A block is at least twelve bytes long, so this cannot walk past the section.
	while (offset + 12 <= resources.length) {
		if (RESOURCE_SIGNATURES[latin1(resources, offset, 4)] === undefined) return null;
		const id = uint16(resources, offset + 4);
		const nameLength = resources[offset + 6] ?? 0;
		// A Pascal name, padded so that the header stays even.
		let cursor = offset + 7 + nameLength + ((nameLength + 1) % 2);
		if (cursor + 4 > resources.length) return null;
		const length = uint32(resources, cursor);
		cursor += 4;
		if (cursor + length > resources.length) return null;
		if (id === THUMBNAIL_RESOURCE) {
			const thumbnail = thumbnailFromPayload(resources.subarray(cursor, cursor + length));
			if (thumbnail !== null) return thumbnail;
		}
		offset = cursor + length + (length % 2);
	}
	return null;
}

/**
 * The JPEG thumbnail the document embeds, or null when it carries none, is
 * not a PSD/PSB, or is damaged. Only the header and the image resource section
 * are read: the layer data of a layered document is never touched, however
 * large the document is.
 */
export async function readPsdThumbnail(path: string, options: PsdReadOptions = {}): Promise<PsdThumbnail | null> {
	const handle = await open(path, "r");
	try {
		const { size } = await handle.stat();
		const read = rangeReader(handle, size, options.onRead);
		const sections = await readSections(read, size);
		if (sections === null || sections.resources.length === 0 || sections.resources.length > SECTION_BYTE_CAP) return null;
		const resources = await read(sections.resources.offset, sections.resources.length);
		return resources === null ? null : findThumbnail(resources);
	} finally {
		await handle.close();
	}
}

interface RgbaPicture {
	readonly data: Uint8Array;
	readonly width: number;
	readonly height: number;
}

type AgPsd = typeof agPsd;
type AgPsdFactory = Parameters<AgPsd["initializeCanvas"]>[0];
type AgPsdImageData = NonNullable<Parameters<AgPsd["initializeCanvas"]>[1]>;

/** ag-psd is a megabyte no other preview needs; it loads the first time a composite is decoded. */
let loadedAgPsd: Promise<AgPsd> | null = null;

/**
 * ag-psd allocates every bitmap through a canvas factory, which a main process
 * has none of. The image-data half of that pair is all this reader reaches: a
 * composite arrives as a plain typed array, and no 2D context is ever created
 * (the factory that would make one is left to throw rather than lie).
 */
function loadAgPsd(): Promise<AgPsd> {
	loadedAgPsd ??= import("ag-psd").then((module) => {
		module.initializeCanvas(
			(() => {
				throw new Error("no canvas in the main process");
			}) as unknown as AgPsdFactory,
			((width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) })) as unknown as AgPsdImageData,
		);
		return module;
	});
	return loadedAgPsd;
}

/** The document's header, colour mode data, image resources, and image data, with no layer section. */
function layerlessPsd(sections: PsdSections, colorModeData: Uint8Array, resources: Uint8Array, imageData: Uint8Array): Uint8Array {
	const layerBytes = sections.large ? 8 : 4;
	const bytes = new Uint8Array(HEADER_BYTES + 4 + colorModeData.length + 4 + resources.length + layerBytes + imageData.length);
	const view = new DataView(bytes.buffer);
	let offset = 0;
	bytes.set(sections.header, offset);
	offset += HEADER_BYTES;
	view.setUint32(offset, colorModeData.length);
	offset += 4;
	bytes.set(colorModeData, offset);
	offset += colorModeData.length;
	view.setUint32(offset, resources.length);
	offset += 4;
	bytes.set(resources, offset);
	offset += resources.length + layerBytes; // the empty layer-and-mask section: eight zero bytes in a PSB
	bytes.set(imageData, offset);
	return bytes;
}

/**
 * The decoded bitmap as four 8-bit samples per pixel. ag-psd hands back the
 * sample depth the file stores — bytes for 8-bit, half-words for 16-bit, unit
 * floats for 32-bit — and every colour mode it decodes arrives RGB(A).
 */
function toRgba8(pixel: PixelData | undefined): RgbaPicture | null {
	if (pixel === undefined) return null;
	const { width, height, data } = pixel;
	if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return null;
	const samples = width * height * 4;
	if (data.length !== samples) return null;
	const rgba = new Uint8Array(samples);
	if (data instanceof Uint8ClampedArray || data instanceof Uint8Array) rgba.set(data);
	else if (data instanceof Uint16Array) for (let index = 0; index < samples; index += 1) rgba[index] = Math.round((data[index] ?? 0) / 257);
	else if (data instanceof Float32Array) for (let index = 0; index < samples; index += 1) rgba[index] = Math.round(Math.min(1, Math.max(0, data[index] ?? 0)) * 255);
	else return null;
	return { data: rgba, width, height };
}

/** Every pixel the same colour: the blank sheet a document without 'Maximize Compatibility' stores. */
function isBlank(picture: RgbaPicture): boolean {
	const { data } = picture;
	for (let pixel = 4; pixel < data.length; pixel += 4) {
		for (let sample = 0; sample < 4; sample += 1) {
			if (data[pixel + sample] !== data[sample]) return false;
		}
	}
	return true;
}

/**
 * Shrinks a picture so its longest side is at most `maxSide` by averaging the
 * source rectangle behind each destination pixel. Never enlarges, and the
 * integer bounds make the result identical on every machine.
 */
function downscale(picture: RgbaPicture, maxSide: number): RgbaPicture {
	const longest = Math.max(picture.width, picture.height);
	if (maxSide <= 0 || longest <= maxSide) return picture;
	const width = Math.max(1, Math.floor((picture.width * maxSide) / longest));
	const height = Math.max(1, Math.floor((picture.height * maxSide) / longest));
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		const top = Math.floor((y * picture.height) / height);
		const bottom = Math.max(top + 1, Math.floor(((y + 1) * picture.height) / height));
		for (let x = 0; x < width; x += 1) {
			const left = Math.floor((x * picture.width) / width);
			const right = Math.max(left + 1, Math.floor(((x + 1) * picture.width) / width));
			const sums = [0, 0, 0, 0];
			for (let sourceY = top; sourceY < bottom; sourceY += 1) {
				for (let sourceX = left; sourceX < right; sourceX += 1) {
					const source = (sourceY * picture.width + sourceX) * 4;
					for (let sample = 0; sample < 4; sample += 1) sums[sample] = (sums[sample] ?? 0) + (picture.data[source + sample] ?? 0);
				}
			}
			const count = (bottom - top) * (right - left);
			const target = (y * width + x) * 4;
			for (let sample = 0; sample < 4; sample += 1) data[target + sample] = Math.round((sums[sample] ?? 0) / count);
		}
	}
	return { data, width, height };
}

/**
 * Whether the image-data section holds every sample the header promises.
 * ag-psd decodes what a truncated file does have and only warns about the
 * rest, so completeness has to be judged here: a whole composite is exactly
 * `channels` planes of `width` x `height` samples, or the same rows stored
 * run-length encoded behind their per-row lengths.
 */
function holdsEverySample(header: Uint8Array, large: boolean, imageData: Uint8Array): boolean {
	const channels = uint16(header, 12);
	const height = uint32(header, 14);
	const width = uint32(header, 18);
	const depth = uint16(header, 22);
	if (channels < 1 || width === 0 || height === 0) return false;
	const compression = uint16(imageData, 0);
	// A bitmap stores one byte-aligned row per eight pixels; every other depth is a whole number of bytes per sample.
	const plane = depth === 1 ? Math.ceil(width / 8) * height : (width * height * depth) / 8;
	if (compression === 0) return 2 + channels * plane <= imageData.length;
	if (compression !== 1) return false; // ag-psd decodes neither of the zip-compressed forms
	const rows = channels * height;
	const lengthBytes = large ? 4 : 2;
	const table = 2 + rows * lengthBytes;
	if (table > imageData.length) return false;
	const view = new DataView(imageData.buffer, imageData.byteOffset, imageData.length);
	let runBytes = 0;
	for (let row = 0; row < rows; row += 1) runBytes += large ? view.getUint32(2 + row * 4) : view.getUint16(2 + row * 2);
	return table + runBytes <= imageData.length;
}

async function decodeComposite(sections: PsdSections, colorModeData: Uint8Array, resources: Uint8Array, imageData: Uint8Array): Promise<RgbaPicture | null> {
	try {
		const psd = (await loadAgPsd()).readPsd(layerlessPsd(sections, colorModeData, resources, imageData), {
			skipLayerImageData: true,
			skipThumbnail: true,
			skipLinkedFilesData: true,
			useImageData: true,
		});
		const picture = toRgba8(psd.imageData);
		return picture === null || isBlank(picture) ? null : picture;
	} catch {
		// Whatever ag-psd cannot make of the file is simply not a preview.
		return null;
	}
}

/**
 * The flattened composite as a PNG. Only the header, the colour mode data, the
 * image resources, and the image data are read: the layer-and-mask section is
 * skipped by its length, and the image data is refused unread past
 * `maxImageDataBytes`, so a layered document costs no more than its composite.
 * Null when the file carries no composite this decoder can use — a document
 * saved without 'Maximize Compatibility' stores a blank sheet — so the caller
 * can fall back to the thumbnail resource.
 */
export async function readPsdComposite(path: string, options: PsdCompositeOptions = {}): Promise<EmbeddedThumbnail | null> {
	const maxImageDataBytes = options.maxImageDataBytes ?? PSD_COMPOSITE_MAX_IMAGE_DATA_BYTES;
	const maxSide = options.maxSide ?? PSD_COMPOSITE_MAX_SIDE;
	const handle = await open(path, "r");
	try {
		const { size } = await handle.stat();
		const read = rangeReader(handle, size, options.onRead);
		const sections = await readSections(read, size);
		if (sections === null) return null;
		if (sections.imageData.length <= 2 || sections.imageData.length > maxImageDataBytes) return null;
		if (sections.colorModeData.length > SECTION_BYTE_CAP || sections.resources.length > SECTION_BYTE_CAP) return null;
		const colorModeData = await read(sections.colorModeData.offset, sections.colorModeData.length);
		const resources = await read(sections.resources.offset, sections.resources.length);
		const imageData = await read(sections.imageData.offset, sections.imageData.length);
		if (colorModeData === null || resources === null || imageData === null) return null;
		if (!holdsEverySample(sections.header, sections.large, imageData)) return null;
		const picture = await decodeComposite(sections, colorModeData, resources, imageData);
		if (picture === null) return null;
		const scaled = downscale(picture, maxSide);
		return { bytes: encodePng(scaled.data, scaled.width, scaled.height), mime: "image/png" };
	} finally {
		await handle.close();
	}
}
