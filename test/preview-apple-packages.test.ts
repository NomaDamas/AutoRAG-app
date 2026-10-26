import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readNativePreview, textFromResourceFork } from "../src/preview/node/apple";
import { isNativeThumbnailExtension } from "../src/main/file-icon";
import { viewerForExtension } from "../src/preview/shared/registry";
import { isPreviewDocument } from "../src/preview/shared/contract";

const HOSTILE_ARCHIVE = Buffer.from(
	"YnBsaXN0MDDSAQIDCl8QD1dlYk1haW5SZXNvdXJjZV8QD1dlYlN1YnJlc291cmNlc9MEBQYHCAleV2ViUmVzb3VyY2VVUkxfEBNXZWJSZXNvdXJjZU1JTUVUeXBlXxAPV2ViUmVzb3VyY2VEYXRhXxAfaHR0cHM6Ly9ldmlsLmV4YW1wbGUvaW5kZXguaHRtbFl0ZXh0L2h0bWxPEQEyPGh0bWw+PGhlYWQ+PHNjcmlwdD5mZXRjaCgiaHR0cHM6Ly9ldmlsLmV4YW1wbGUvYmVhY29uIik8L3NjcmlwdD48bGluayByZWw9InN0eWxlc2hlZXQiIGhyZWY9Imh0dHBzOi8vZXZpbC5leGFtcGxlL3N0eWxlLmNzcyI+PC9oZWFkPjxib2R5IG9ubG9hZD0iZmV0Y2goJ2h0dHBzOi8vZXZpbC5leGFtcGxlL29ubG9hZCcpIj48aW1nIHNyYz0iaHR0cHM6Ly9ldmlsLmV4YW1wbGUvcGl4ZWwucG5nIj48aW1nIHNyYz0iaHR0cHM6Ly9yZW1vdGUuZXhhbXBsZS90cmFja2VyLnBuZyI+PHA+U2FmZSBhcmNoaXZlPC9wPjwvYm9keT48L2h0bWw+ogsP0wQFBgwNDl8QHmh0dHBzOi8vZXZpbC5leGFtcGxlL3BpeGVsLnBuZ1lpbWFnZS9wbmdPEEaJUE5HDQoaCgAAAA1JSERSAAAAAQAAAAEIBgAAAB8VxIkAAAANSURBVHjaY/zPwFAPAASFAYCEqYwhAAAAAElFTkSuQmCC0wQFBhAREl8QHmh0dHBzOi8vZXZpbC5leGFtcGxlL3N0eWxlLmNzc1h0ZXh0L2Nzc08QFWJvZHl7YmFja2dyb3VuZDojZmZmfQAIAA0AHwAxADgARwBdAG8AkQCbAdEB1AHbAfwCBgJPAlYCdwKAAAAAAAAAAgEAAAAAAAAAEwAAAAAAAAAAAAAAAAAAApg=",
	"base64",
);
const XML_LINK = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>URL</key><string>https://example.com/docs?q=1&amp;x=2</string></dict></plist>`;

describe("macOS-native preview registry", () => {
	it.each([
		["webloc", "webloc"],
		["inetloc", "webloc"],
		["webarchive", "webarchive"],
		["rtfd", "rtfd"],
		["iconset", "iconset"],
		["textclipping", "textclipping"],
	] as const)("claims .%s as %s", (ext, kind) => {
		expect(viewerForExtension(ext)).toBe(kind);
	});

	it.each(["pvt", "lpdf", "prefpane", "pict", "pct", "pic", "pictclipping"])("uses the OS thumbnailer for .%s", (ext) => {
		expect(isNativeThumbnailExtension(ext)).toBe(true);
	});
});

describe("native preview IPC contract", () => {
	const document = {
		name: "Example.webloc", path: "/tmp/Example.webloc", ext: "webloc", size: 10,
		modifiedAt: "2026-01-01T00:00:00.000Z", mime: "application/octet-stream", truncated: false,
		bytes: null, pages: null, office: null, thumbnail: null, slidesRendering: false,
		native: { kind: "webloc", title: "Example", url: "https://example.com" },
	};

	it("accepts structured native content and rejects malformed payloads", () => {
		expect(isPreviewDocument(document)).toBe(true);
		expect(isPreviewDocument({ ...document, package: true })).toBe(true);
		expect(isPreviewDocument({ ...document, package: "yes" })).toBe(false);
		expect(isPreviewDocument({ ...document, native: { kind: "webloc", title: "Example" } })).toBe(false);
		expect(isPreviewDocument({ ...document, native: { kind: "iconset", icons: [{ name: "x.png", bytes: "not bytes" }] } })).toBe(false);
	});
});

describe("native document readers", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "autorag-native-preview-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("reads an XML internet location without navigating to it", async () => {
		const path = join(root, "Example.webloc");
		await writeFile(path, XML_LINK);

		expect(await readNativePreview(path)).toEqual({ kind: "webloc", title: "Example", url: "https://example.com/docs?q=1&x=2" });
	});

	it("sanitizes a hostile binary webarchive and inlines only archived resources", async () => {
		const path = join(root, "Hostile.webarchive");
		await writeFile(path, HOSTILE_ARCHIVE);

		const preview = await readNativePreview(path);
		expect(preview.kind).toBe("webarchive");
		if (preview.kind !== "webarchive") throw new Error("wrong preview kind");
		expect(preview.html).toContain("Safe archive");
		expect(preview.html).toContain("Content-Security-Policy");
		expect(preview.html).toContain("default-src 'none'");
		expect(preview.html).toContain("data:image/png;base64,");
		expect(preview.html).toContain("<style>body{background:#fff}</style>");
		expect(preview.html).not.toContain("<script");
		expect(preview.html).not.toContain("onload");
		expect(preview.html).not.toContain("remote.example");
	});

	it("drops excess duplicate resources instead of expanding an archive beyond the preview cap", async () => {
		const path = join(root, "Repeated.webarchive");
		const html = `<html><body>${'<img src="https://evil.example/pixel.png">'.repeat(40)}</body></html>`;
		const xml = `<?xml version="1.0"?><plist><dict><key>WebMainResource</key><dict><key>WebResourceURL</key><string>https://evil.example/index.html</string><key>WebResourceMIMEType</key><string>text/html</string><key>WebResourceData</key><data>${Buffer.from(html).toString("base64")}</data></dict><key>WebSubresources</key><array><dict><key>WebResourceURL</key><string>https://evil.example/pixel.png</string><key>WebResourceMIMEType</key><string>image/png</string><key>WebResourceData</key><data>${Buffer.alloc(1024 * 1024, 65).toString("base64")}</data></dict></array></dict></plist>`;
		await writeFile(path, xml);

		const preview = await readNativePreview(path);
		if (preview.kind !== "webarchive") throw new Error("wrong preview kind");
		expect(Buffer.byteLength(preview.html)).toBeLessThanOrEqual(32 * 1024 * 1024);
		expect((preview.html.match(/data:image\/png;base64/g) ?? []).length).toBeLessThan(40);
	});

	it("reuses TXT.rtf and lists, but does not render, RTFD attachments", async () => {
		const path = join(root, "Notes.rtfd");
		await mkdir(path);
		await writeFile(join(path, "TXT.rtf"), "{\\rtf1 Hello package}");
		await writeFile(join(path, "photo.png"), new Uint8Array([1, 2, 3]));

		expect(await readNativePreview(path)).toMatchObject({ kind: "rtfd", attachments: ["photo.png"] });
		const preview = await readNativePreview(path);
		if (preview.kind !== "rtfd") throw new Error("wrong preview kind");
		expect(new TextDecoder().decode(preview.rtf)).toBe("{\\rtf1 Hello package}");
	});

	it("reads an iconset as sorted PNG images instead of a folder listing", async () => {
		const path = join(root, "App.iconset");
		await mkdir(path);
		await writeFile(join(path, "icon_32x32.png"), new Uint8Array([3, 2]));
		await writeFile(join(path, "icon_16x16.png"), new Uint8Array([1, 2]));
		await writeFile(join(path, "README.txt"), "ignore");

		const preview = await readNativePreview(path);
		expect(preview.kind).toBe("iconset");
		if (preview.kind !== "iconset") throw new Error("wrong preview kind");
		expect(preview.icons.map((icon) => icon.name)).toEqual(["icon_16x16.png", "icon_32x32.png"]);
	});

	it("reads textclipping plists and plain UTF-8 clippings", async () => {
		const plist = join(root, "Clip.textclipping");
		await writeFile(plist, `<?xml version="1.0"?><plist><dict><key>public.utf8-plain-text</key><string>Clipped text</string></dict></plist>`);
		const plain = join(root, "Plain.textclipping");
		await writeFile(plain, "Plain clipped text");

		expect(await readNativePreview(plist)).toEqual({ kind: "textclipping", text: "Clipped text" });
		expect(await readNativePreview(plain)).toEqual({ kind: "textclipping", text: "Plain clipped text" });
	});

	it("extracts TEXT resources from a classic clipping resource fork", () => {
		const dataOffset = 256;
		const mapOffset = 272;
		const bytes = new Uint8Array(512);
		const view = new DataView(bytes.buffer);
		view.setUint32(0, dataOffset);
		view.setUint32(4, mapOffset);
		view.setUint32(8, 12);
		view.setUint32(12, 64);
		view.setUint32(dataOffset, 7);
		new TextEncoder().encodeInto("Classic", bytes.subarray(dataOffset + 4));
		view.setUint16(mapOffset + 22, 0);
		view.setUint16(mapOffset + 24, 28);
		view.setUint16(mapOffset + 26, 56);
		const types = mapOffset + 28;
		view.setUint16(types, 0);
		new TextEncoder().encodeInto("TEXT", bytes.subarray(types + 2));
		view.setUint16(types + 6, 0);
		view.setUint16(types + 8, 10);
		const ref = types + 10;
		view.setUint16(ref, 256);
		view.setUint16(ref + 2, 0xffff);
		view.setUint8(ref + 7, 0);
		view.setUint16(ref + 8, 0);

		expect(textFromResourceFork(bytes)).toBe("Classic");
	});
});
