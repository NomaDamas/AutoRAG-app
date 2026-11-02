import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { NativePreview, PreviewDocument } from "../shared/contract";
import { mimeForExtension } from "../shared/registry";
import { parsePlist, type PlistValue } from "../shared/plist-value";
import { standaloneOfficeHtml, type OfficeAttachment } from "./office-render";
import { PREVIEW_BYTE_CAP, readHead, TEXT_BYTE_CAP } from "./read-file";

const ICON_LIMIT = 32;
const ICON_BYTES = 4 * 1024 * 1024;

function dictionary(value: PlistValue): Readonly<Record<string, PlistValue>> {
	if (typeof value !== "object" || value === null || value instanceof Date || value instanceof Uint8Array || Array.isArray(value)) {
		throw new Error("Expected a property list dictionary");
	}
	return value as Readonly<Record<string, PlistValue>>;
}

function stringField(value: Readonly<Record<string, PlistValue>>, key: string): string {
	const field = value[key];
	if (typeof field !== "string") throw new Error(`Missing property list string ${key}`);
	return field;
}

function dataField(value: Readonly<Record<string, PlistValue>>, key: string): Uint8Array {
	const field = value[key];
	if (!(field instanceof Uint8Array)) throw new Error(`Missing property list data ${key}`);
	return field;
}

async function readWhole(path: string, cap = PREVIEW_BYTE_CAP): Promise<Uint8Array> {
	const info = await stat(path);
	if (!info.isFile() || info.size > cap) throw new Error("Native preview is too large to read");
	return readFile(path);
}

async function readWebloc(path: string): Promise<NativePreview> {
	const plist = dictionary(parsePlist(await readWhole(path)));
	const url = plist.URL ?? plist.url;
	if (typeof url !== "string" || url.length === 0) throw new Error("Internet location has no URL");
	// Validate the pointer without opening it. Relative and malformed locations
	// stay on the information panel rather than becoming navigation targets.
	new URL(url);
	return { kind: "webloc", title: basename(path, extname(path)), url };
}

interface ArchiveResource {
	readonly url: string;
	readonly mime: string;
	readonly data: Uint8Array;
}

function archiveResource(value: PlistValue): ArchiveResource {
	const resource = dictionary(value);
	return {
		url: stringField(resource, "WebResourceURL"),
		mime: typeof resource.WebResourceMIMEType === "string" ? resource.WebResourceMIMEType : "application/octet-stream",
		data: dataField(resource, "WebResourceData"),
	};
}

function archiveText(resource: ArchiveResource, encoding: string): string {
	try {
		return new TextDecoder(encoding).decode(resource.data);
	} catch {
		return new TextDecoder("utf-8").decode(resource.data);
	}
}

function absoluteResourceUrl(name: string, base: string): string {
	try {
		return new URL(name, base).href;
	} catch {
		return name;
	}
}

async function readWebarchive(path: string): Promise<NativePreview> {
	const archive = dictionary(parsePlist(await readWhole(path)));
	const mainValue = archive.WebMainResource;
	if (mainValue === undefined) throw new Error("Web archive has no main resource");
	const mainRecord = dictionary(mainValue);
	const main = archiveResource(mainValue);
	const encoding = typeof mainRecord.WebResourceTextEncodingName === "string" ? mainRecord.WebResourceTextEncodingName : "utf-8";
	const resources = new Map<string, ArchiveResource>();
	let inlinedBytes = 0;
	const reserveInline = (resource: ArchiveResource): boolean => {
		const cost = Math.ceil(resource.data.byteLength / 3) * 4 + resource.mime.length + 16;
		if (inlinedBytes + cost > PREVIEW_BYTE_CAP) return false;
		inlinedBytes += cost;
		return true;
	};
	const subresources = archive.WebSubresources ?? [];
	if (!Array.isArray(subresources)) throw new Error("Web archive resources are malformed");
	for (const value of subresources) {
		const resource = archiveResource(value);
		resources.set(resource.url, resource);
	}
	const resolve = (name: string): OfficeAttachment | null => {
		const resource = resources.get(name) ?? resources.get(absoluteResourceUrl(name, main.url));
		if (resource === undefined) return null;
		if (resource.mime === "text/css") {
			const css = archiveText(resource, "utf-8").replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (_match, _quote: string, target: string) => {
				const image = resources.get(target) ?? resources.get(absoluteResourceUrl(target, main.url));
				if (image === undefined || !image.mime.startsWith("image/") || !reserveInline(image)) return "url()";
				return `url("data:${image.mime};base64,${Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).toString("base64")}")`;
			});
			return { kind: "css", text: css };
		}
		return resource.mime.startsWith("image/") && reserveInline(resource) ? { kind: "data", mime: resource.mime, bytes: resource.data } : null;
	};
	const html = standaloneOfficeHtml(archiveText(main, encoding), resolve);
	if (Buffer.byteLength(html) > PREVIEW_BYTE_CAP) throw new Error("Web archive preview is too large");
	return { kind: "webarchive", html };
}

async function readRtfd(path: string): Promise<NativePreview> {
	const entries = await readdir(path, { withFileTypes: true });
	const body = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === "txt.rtf");
	if (body === undefined) throw new Error("RTFD package has no TXT.rtf");
	const rtfPath = join(path, body.name);
	const info = await stat(rtfPath);
	const rtf = await readHead(rtfPath, Math.min(info.size, TEXT_BYTE_CAP));
	const attachments = entries
		.filter((entry) => entry.name !== body.name && !entry.name.startsWith("."))
		.map((entry) => entry.name)
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
	return { kind: "rtfd", rtf, attachments };
}

async function readIconset(path: string): Promise<NativePreview> {
	const entries = await readdir(path, { withFileTypes: true });
	const names = entries
		.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
		.map((entry) => entry.name)
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
		.slice(0, ICON_LIMIT);
	const icons: { readonly name: string; readonly bytes: Uint8Array }[] = [];
	for (const name of names) {
		const bytes = await readWhole(join(path, name), ICON_BYTES);
		icons.push({ name, bytes });
	}
	return { kind: "iconset", icons };
}

function firstText(value: PlistValue): string | null {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		for (const item of value) {
			const text = firstText(item);
			if (text !== null) return text;
		}
		return null;
	}
	if (typeof value !== "object" || value === null || value instanceof Date || value instanceof Uint8Array) return null;
	for (const item of Object.values(value)) {
		const text = firstText(item);
		if (text !== null) return text;
	}
	return null;
}

/** Extracts the first TEXT/utf8/utxt resource from a classic Mac resource fork. */
export function textFromResourceFork(bytes: Uint8Array): string | null {
	if (bytes.length < 16) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const dataOffset = view.getUint32(0);
	const mapOffset = view.getUint32(4);
	const dataLength = view.getUint32(8);
	const mapLength = view.getUint32(12);
	if (dataOffset < 16 || mapOffset < 16 || dataOffset + dataLength > bytes.length || mapOffset + mapLength > bytes.length || mapLength < 30) return null;
	const types = mapOffset + view.getUint16(mapOffset + 24);
	if (types + 2 > mapOffset + mapLength) return null;
	const typeCount = view.getUint16(types) + 1;
	for (let index = 0; index < typeCount; index += 1) {
		const entry = types + 2 + index * 8;
		if (entry + 8 > mapOffset + mapLength) return null;
		const type = String.fromCharCode(...bytes.subarray(entry, entry + 4));
		if (type !== "TEXT" && type !== "utf8" && type !== "utxt") continue;
		const count = view.getUint16(entry + 4) + 1;
		const refs = types + view.getUint16(entry + 6);
		if (count < 1 || refs + 12 > mapOffset + mapLength) return null;
		const relative = (view.getUint8(refs + 5) << 16) | view.getUint16(refs + 6);
		const at = dataOffset + relative;
		if (at + 4 > dataOffset + dataLength) return null;
		const length = view.getUint32(at);
		if (length > TEXT_BYTE_CAP || at + 4 + length > dataOffset + dataLength) return null;
		const text = bytes.subarray(at + 4, at + 4 + length);
		return new TextDecoder(type === "utxt" ? "utf-16be" : type === "utf8" ? "utf-8" : "macintosh").decode(text);
	}
	return null;
}

async function readTextClipping(path: string): Promise<NativePreview> {
	const bytes = await readWhole(path, TEXT_BYTE_CAP);
	if (bytes.length > 0) {
		try {
			const text = firstText(parsePlist(bytes));
			if (text !== null) return { kind: "textclipping", text };
		} catch {
			// Plain-text clippings are not property lists.
		}
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			if (!text.includes("\0")) return { kind: "textclipping", text };
		} catch {
			// A resource-fork clipping can carry arbitrary bytes in its data fork.
		}
	}
	if (process.platform === "darwin") {
		const resource = await readFile(`${path}/..namedfork/rsrc`).catch(() => null);
		const text = resource === null ? null : textFromResourceFork(resource);
		if (text !== null) return { kind: "textclipping", text };
	}
	throw new Error("Text clipping has no readable text");
}

export async function readNativePreview(path: string): Promise<NativePreview> {
	switch (extname(path).slice(1).toLowerCase()) {
		case "webloc":
		case "inetloc":
			return readWebloc(path);
		case "webarchive":
			return readWebarchive(path);
		case "rtfd":
			return readRtfd(path);
		case "iconset":
			return readIconset(path);
		case "textclipping":
			return readTextClipping(path);
		default:
			throw new Error("Not a decodable native preview");
	}
}

/** Metadata plus best-effort native content; malformed documents degrade to the info panel. */
export async function readNativeDocument(path: string, warn: (message: string) => void = (message) => console.warn(message)): Promise<PreviewDocument> {
	const info = await stat(path);
	const ext = extname(path).slice(1).toLowerCase();
	let native: NativePreview | null = null;
	if (["webloc", "inetloc", "webarchive", "rtfd", "iconset", "textclipping"].includes(ext)) {
		try {
			native = await readNativePreview(path);
		} catch (error) {
			warn(`quick-look: native preview for ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return {
		name: basename(path),
		path,
		ext,
		size: info.size,
		modifiedAt: info.mtime.toISOString(),
		mime: mimeForExtension(ext),
		truncated: false,
		bytes: null,
		pages: null,
		office: null,
		thumbnail: null,
		native,
		package: info.isDirectory(),
		slidesRendering: false,
	};
}
