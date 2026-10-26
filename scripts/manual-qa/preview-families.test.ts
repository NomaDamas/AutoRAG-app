// @vitest-environment happy-dom
import { strToU8, zipSync } from "fflate";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PreviewDocument, QuickLookWindowBridge } from "../../src/preview/shared/contract";
import { VIEWER_KINDS, viewerForExtension, type ViewerKind } from "../../src/preview/shared/registry";
import { PreviewBody } from "../../src/preview/ui/body";
import { ChromeProvider, type QuickLookChrome } from "../../src/preview/ui/chrome";

const never = (): Promise<never> => new Promise(() => undefined);
const bridge: QuickLookWindowBridge = {
	platform: "darwin",
	onLoad: () => () => undefined,
	onUnload: () => () => undefined,
	onZoom: () => () => undefined,
	onApp: () => () => undefined,
	onOffice: () => () => undefined,
	onSlides: () => () => undefined,
	ready: () => undefined,
	zoomed: () => undefined,
	request: never,
	details: never,
	sha256: never,
	folderSize: never,
	audioMetadata: never,
	dataPreview: never,
	archivePreview: never,
	share: never,
	copyText: never,
};
const chrome: QuickLookChrome = { bridge, toolbar: null, report: () => undefined, resize: () => undefined, hideTitle: () => undefined, app: null };

const png = Uint8Array.from(
	Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
);

function documentFor(ext: string, bytes: Uint8Array): PreviewDocument {
	return {
		name: `sample.${ext}`,
		path: `/tmp/sample.${ext}`,
		ext,
		size: bytes.byteLength,
		modifiedAt: "2026-09-30T00:00:00.000Z",
		mime: "application/octet-stream",
		truncated: false,
		bytes,
		pages: null,
		office: null,
		thumbnail: null,
		slidesRendering: false,
		native:
			ext === "webloc" ? { kind: "webloc", title: "Example", url: "https://example.com" }
			: ext === "webarchive" ? { kind: "webarchive", html: "<p>Archived</p>" }
			: ext === "rtfd" ? { kind: "rtfd", rtf: bytes, attachments: ["photo.png"] }
			: ext === "iconset" ? { kind: "iconset", icons: [{ name: "icon_16x16.png", bytes }] }
			: ext === "textclipping" ? { kind: "textclipping", text: "Clipped text" }
			: null,
	};
}

const bytesForKind: Readonly<Record<ViewerKind, Uint8Array>> = {
	image: png,
	tiff: new Uint8Array([0x49, 0x49, 0x2a, 0x00]),
	heic: new Uint8Array([0x00, 0x00, 0x00, 0x18]),
	video: new Uint8Array([0x00, 0x00, 0x00, 0x18]),
	audio: new Uint8Array([0x49, 0x44, 0x33, 0x04]),
	pdf: strToU8("%PDF-1.4\n"),
	docx: zipSync({ "[Content_Types].xml": strToU8("<Types/>") }),
	legacyDoc: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]),
	sheet: strToU8("name,qty\napple,2\n"),
	pptx: zipSync({ "ppt/slides/slide1.xml": strToU8("<a:t>Title</a:t>") }),
	legacyPpt: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]),
	markdown: strToU8("# Hello\n"),
	html: strToU8("<p>Hello</p>"),
	text: strToU8("hello preview\n"),
	archive: zipSync({ "notes/a.txt": strToU8("hi") }),
	archiveList: new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
	iwork: png,
	odt: zipSync({ "content.xml": strToU8("<office:document-content/>") }),
	odp: zipSync({ "content.xml": strToU8("<office:document-content/>") }),
	odg: png,
	epub: zipSync({ "OEBPS/ch.xhtml": strToU8("<p>chapter</p>") }),
	hwp: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]),
	font: new Uint8Array([0x00, 0x01, 0x00, 0x00]),
	rtf: strToU8("{\\rtf1 hello}"),
	webloc: strToU8("url"),
	webarchive: strToU8("archive"),
	rtfd: strToU8("{\\rtf1 package}"),
	iconset: png,
	textclipping: strToU8("clipping"),
	data: new Uint8Array([0x53, 0x51, 0x4c]),
	jsonl: strToU8('{"a":1}\n{"a":2}\n'),
	plist: strToU8('<plist version="1.0"><dict/></plist>'),
	mail: strToU8("Subject: hi\r\n\r\nbody"),
	msg: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]),
	contact: strToU8("BEGIN:VCARD\nFN:Kim\nEND:VCARD"),
	calendar: strToU8("BEGIN:VEVENT\nSUMMARY:Lunch\nEND:VEVENT"),
	fallback: new Uint8Array([0, 1, 2, 3, 4]),
	gdrive: strToU8('{"doc_id":"1abc","resource_key":"","email":"me@gmail.com"}'),
};

const extForKind: Readonly<Record<ViewerKind, string>> = {
	image: "png",
	tiff: "tif",
	heic: "heic",
	video: "mp4",
	audio: "mp3",
	pdf: "pdf",
	docx: "docx",
	legacyDoc: "doc",
	sheet: "csv",
	pptx: "pptx",
	legacyPpt: "ppt",
	markdown: "md",
	html: "html",
	text: "txt",
	archive: "zip",
	archiveList: "7z",
	iwork: "numbers",
	odt: "odt",
	odp: "odp",
	odg: "odg",
	epub: "epub",
	hwp: "hwp",
	font: "ttf",
	rtf: "rtf",
	webloc: "webloc",
	webarchive: "webarchive",
	rtfd: "rtfd",
	iconset: "iconset",
	textclipping: "textclipping",
	data: "sqlite",
	jsonl: "jsonl",
	plist: "plist",
	mail: "eml",
	msg: "msg",
	contact: "vcf",
	calendar: "ics",
	gdrive: "gdoc",
	fallback: "bin",
};

describe("preview families", () => {
	it("renders one fixture per family without throwing", () => {
		for (const kind of VIEWER_KINDS) {
			const ext = extForKind[kind];
			expect(viewerForExtension(ext)).toBe(kind);
			const markup = renderToStaticMarkup(createElement(ChromeProvider, { value: chrome }, createElement(PreviewBody, { file: documentFor(ext, bytesForKind[kind]) })));
			expect(markup.length).toBeGreaterThan(0);
		}
	});
});

describe("native package information panel", () => {
	it("does not call a zero-stat directory package an empty file or print a bogus size", () => {
		const file = { ...documentFor("pvt", new Uint8Array([1])), size: 0, package: true };
		const markup = renderToStaticMarkup(createElement(ChromeProvider, { value: chrome }, createElement(PreviewBody, { file })));
		expect(markup).not.toContain("Empty file");
		expect(markup).not.toContain("0 B");
	});
});

describe("Google Drive pointer panel", () => {
	const pointer = strToU8('{"doc_id":"1abc","resource_key":"","email":"me@gmail.com"}');
	const render = (file: PreviewDocument): string =>
		renderToStaticMarkup(createElement(ChromeProvider, { value: chrome }, createElement(PreviewBody, { file })));

	it("shows the thumbnail Drive drew in place of the page glyph", () => {
		const markup = render({ ...documentFor("gdoc", pointer), thumbnail: "autorag-thumb://local/?path=a.gdoc&mtime=1&size=640" });
		expect(markup).toContain('src="autorag-thumb://local/?path=a.gdoc&amp;mtime=1&amp;size=640"');
		expect(markup).toContain("quickLook.gdrive.account");
		expect(markup).not.toContain('viewBox="0 0 176 214"');
	});

	it("keeps the page glyph when Drive has drawn nothing yet", () => {
		const markup = render(documentFor("gsheet", pointer));
		expect(markup).not.toContain("<img");
		expect(markup).toContain('viewBox="0 0 176 214"');
	});

	it("says so when the file is not a Drive pointer", () => {
		expect(render(documentFor("gform", strToU8("not json")))).toContain("quickLook.gdrive.notPointer");
	});
});
