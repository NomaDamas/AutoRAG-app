/**
 * Binary property lists (`bplist00`) rendered as the XML `plutil -convert xml1`
 * writes, so Quick Look shows readable text for the files macOS apps store
 * preferences and metadata in. Every offset and length is bounds-checked, and
 * output and nesting are capped, because the input is an arbitrary file.
 */

const HEADER = "bplist00";
const TRAILER = 32;
const MAX_DEPTH = 64;
const MAX_OUTPUT = 4 * 1024 * 1024;
/** Seconds between the Unix epoch and the Core Foundation epoch (2001-01-01). */
const APPLE_EPOCH = 978_307_200;
const BASE64_LINE = 68;

export function isBinaryPlist(bytes: Uint8Array): boolean {
	if (bytes.length < HEADER.length) return false;
	for (let index = 0; index < HEADER.length; index += 1) if (bytes[index] !== HEADER.charCodeAt(index)) return false;
	return true;
}

class Fail extends Error {}

function fail(): never {
	throw new Fail("Invalid binary property list");
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function base64(bytes: Uint8Array): string {
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	return btoa(binary);
}

function unsigned(view: DataView, offset: number, size: number): number {
	if (size < 1 || size > 8 || offset < 0 || offset + size > view.byteLength) fail();
	let value = 0n;
	for (let index = 0; index < size; index += 1) value = (value << 8n) | BigInt(view.getUint8(offset + index));
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail();
	return Number(value);
}

function isoDate(seconds: number): string {
	const date = new Date((APPLE_EPOCH + Math.floor(seconds)) * 1000);
	if (Number.isNaN(date.getTime())) fail();
	return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function realText(value: number): string {
	if (Number.isNaN(value)) return "nan";
	if (value === Infinity) return "+infinity";
	if (value === -Infinity) return "-infinity";
	return String(value);
}

class Writer {
	readonly view: DataView;
	readonly bytes: Uint8Array;
	readonly offsetSize: number;
	readonly refSize: number;
	readonly count: number;
	readonly tableOffset: number;
	readonly stack = new Set<number>();
	out = "";

	constructor(bytes: Uint8Array) {
		this.bytes = bytes;
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		if (!isBinaryPlist(bytes) || bytes.length < HEADER.length + TRAILER + 1) fail();
		const trailer = bytes.length - TRAILER;
		this.offsetSize = this.view.getUint8(trailer + 6);
		this.refSize = this.view.getUint8(trailer + 7);
		this.count = unsigned(this.view, trailer + 8, 8);
		this.tableOffset = unsigned(this.view, trailer + 24, 8);
		if (this.offsetSize < 1 || this.offsetSize > 8 || this.refSize < 1 || this.refSize > 8) fail();
		if (this.count < 1 || this.tableOffset < HEADER.length || this.tableOffset + this.count * this.offsetSize > trailer) fail();
	}

	top(): number {
		return unsigned(this.view, this.bytes.length - TRAILER + 16, 8);
	}

	objectOffset(index: number): number {
		if (index >= this.count) fail();
		const offset = unsigned(this.view, this.tableOffset + index * this.offsetSize, this.offsetSize);
		if (offset < HEADER.length || offset >= this.tableOffset) fail();
		return offset;
	}

	/** The element count of a sized object and where its payload starts. */
	length(offset: number, marker: number): { readonly count: number; readonly start: number } {
		const nibble = marker & 0x0f;
		if (nibble !== 0x0f) return { count: nibble, start: offset + 1 };
		const intMarker = this.view.getUint8(offset + 1);
		if (intMarker >> 4 !== 1) fail();
		const size = 1 << (intMarker & 0x0f);
		return { count: unsigned(this.view, offset + 2, size), start: offset + 2 + size };
	}

	emit(text: string): void {
		this.out += text;
		if (this.out.length > MAX_OUTPUT) throw new Fail("Binary property list is too large to show");
	}

	write(index: number, depth: number): void {
		if (depth > MAX_DEPTH) fail();
		const pad = "\t".repeat(depth);
		const offset = this.objectOffset(index);
		const marker = this.view.getUint8(offset);
		const kind = marker >> 4;
		switch (kind) {
			case 0x0:
				if (marker === 0x08) return this.emit(`${pad}<false/>\n`);
				if (marker === 0x09) return this.emit(`${pad}<true/>\n`);
				return fail();
			case 0x1: {
				const size = 1 << (marker & 0x0f);
				if (size > 16 || offset + 1 + size > this.tableOffset) fail();
				let value = 0n;
				for (let at = 0; at < size; at += 1) value = (value << 8n) | BigInt(this.view.getUint8(offset + 1 + at));
				if (size >= 8) value = BigInt.asIntN(size * 8, value);
				return this.emit(`${pad}<integer>${value}</integer>\n`);
			}
			case 0x2: {
				const size = 1 << (marker & 0x0f);
				if (offset + 1 + size > this.tableOffset) fail();
				if (size === 4) return this.emit(`${pad}<real>${realText(this.view.getFloat32(offset + 1))}</real>\n`);
				if (size === 8) return this.emit(`${pad}<real>${realText(this.view.getFloat64(offset + 1))}</real>\n`);
				return fail();
			}
			case 0x3:
				if (marker !== 0x33 || offset + 9 > this.tableOffset) fail();
				return this.emit(`${pad}<date>${isoDate(this.view.getFloat64(offset + 1))}</date>\n`);
			case 0x4: {
				const { count, start } = this.length(offset, marker);
				if (start + count > this.tableOffset) fail();
				const encoded = base64(this.bytes.subarray(start, start + count));
				if (encoded === "") return this.emit(`${pad}<data>\n${pad}</data>\n`);
				const lines: string[] = [];
				for (let at = 0; at < encoded.length; at += BASE64_LINE) lines.push(`${pad}${encoded.slice(at, at + BASE64_LINE)}\n`);
				return this.emit(`${pad}<data>\n${lines.join("")}${pad}</data>\n`);
			}
			case 0x5: {
				const { count, start } = this.length(offset, marker);
				if (start + count > this.tableOffset) fail();
				return this.emit(`${pad}<string>${escapeXml(new TextDecoder("latin1").decode(this.bytes.subarray(start, start + count)))}</string>\n`);
			}
			case 0x6: {
				const { count, start } = this.length(offset, marker);
				if (start + count * 2 > this.tableOffset) fail();
				return this.emit(`${pad}<string>${escapeXml(new TextDecoder("utf-16be").decode(this.bytes.subarray(start, start + count * 2)))}</string>\n`);
			}
			case 0x8: {
				const size = (marker & 0x0f) + 1;
				const uid = unsigned(this.view, offset + 1, size);
				return this.emit(`${pad}<dict>\n${pad}\t<key>CF$UID</key>\n${pad}\t<integer>${uid}</integer>\n${pad}</dict>\n`);
			}
			case 0xa:
			case 0xc:
				return this.container(index, offset, marker, depth, false);
			case 0xd:
				return this.container(index, offset, marker, depth, true);
			default:
				return fail();
		}
	}

	container(index: number, offset: number, marker: number, depth: number, dict: boolean): void {
		const pad = "\t".repeat(depth);
		const { count, start } = this.length(offset, marker);
		const refs = dict ? count * 2 : count;
		if (start + refs * this.refSize > this.tableOffset) fail();
		const tag = dict ? "dict" : "array";
		if (count === 0) return this.emit(`${pad}<${tag}/>\n`);
		if (this.stack.has(index)) fail();
		this.stack.add(index);
		this.emit(`${pad}<${tag}>\n`);
		if (dict) {
			const entries: { readonly key: string; readonly value: number }[] = [];
			for (let at = 0; at < count; at += 1) {
				const keyIndex = unsigned(this.view, start + at * this.refSize, this.refSize);
				const value = unsigned(this.view, start + (count + at) * this.refSize, this.refSize);
				entries.push({ key: this.keyText(keyIndex), value });
			}
			entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
			for (const entry of entries) {
				this.emit(`${pad}\t<key>${escapeXml(entry.key)}</key>\n`);
				this.write(entry.value, depth + 1);
			}
		} else {
			for (let at = 0; at < count; at += 1) this.write(unsigned(this.view, start + at * this.refSize, this.refSize), depth + 1);
		}
		this.emit(`${pad}</${tag}>\n`);
		this.stack.delete(index);
	}

	keyText(index: number): string {
		const offset = this.objectOffset(index);
		const marker = this.view.getUint8(offset);
		const { count, start } = this.length(offset, marker);
		if (marker >> 4 === 0x5 && start + count <= this.tableOffset) return new TextDecoder("latin1").decode(this.bytes.subarray(start, start + count));
		if (marker >> 4 === 0x6 && start + count * 2 <= this.tableOffset) return new TextDecoder("utf-16be").decode(this.bytes.subarray(start, start + count * 2));
		return fail();
	}
}

/** Converts a binary plist to XML text. Throws an `Error` for anything malformed or too large. */
export function bplistToXml(bytes: Uint8Array): string {
	const writer = new Writer(bytes);
	writer.out =
		'<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n';
	try {
		writer.write(writer.top(), 0);
	} catch (error) {
		if (error instanceof RangeError) fail();
		throw error;
	}
	return `${writer.out}</plist>\n`;
}
