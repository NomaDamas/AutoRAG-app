import { strToU8, zipSync } from "fflate";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PreviewDocument } from "../../src/preview/shared/contract";
import { VIEWER_KINDS, viewerForExtension, type ViewerKind } from "../../src/preview/shared/registry";
import { PreviewBody } from "../../src/preview/ui/body";

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
	sheet: strToU8("name,qty\napple,2\n"),
	pptx: zipSync({ "ppt/slides/slide1.xml": strToU8("<a:t>Title</a:t>") }),
	markdown: strToU8("# Hello\n"),
	html: strToU8("<p>Hello</p>"),
	text: strToU8("hello preview\n"),
	archive: zipSync({ "notes/a.txt": strToU8("hi") }),
	epub: zipSync({ "OEBPS/ch.xhtml": strToU8("<p>chapter</p>") }),
	hwpx: zipSync({ "Contents/section0.xml": strToU8("<hp:t>안녕</hp:t>") }),
	font: new Uint8Array([0x00, 0x01, 0x00, 0x00]),
	rtf: strToU8("{\\rtf1 hello}"),
	fallback: new Uint8Array([0, 1, 2, 3, 4]),
};

const extForKind: Readonly<Record<ViewerKind, string>> = {
	image: "png",
	tiff: "tif",
	heic: "heic",
	video: "mp4",
	audio: "mp3",
	pdf: "pdf",
	docx: "docx",
	sheet: "csv",
	pptx: "pptx",
	markdown: "md",
	html: "html",
	text: "txt",
	archive: "zip",
	epub: "epub",
	hwpx: "hwpx",
	font: "ttf",
	rtf: "rtf",
	fallback: "bin",
};

describe("preview families", () => {
	it("renders one fixture per family without throwing", () => {
		for (const kind of VIEWER_KINDS) {
			const ext = extForKind[kind];
			expect(viewerForExtension(ext)).toBe(kind);
			const markup = renderToStaticMarkup(createElement(PreviewBody, { file: documentFor(ext, bytesForKind[kind]) }));
			expect(markup.length).toBeGreaterThan(0);
		}
	});
});
