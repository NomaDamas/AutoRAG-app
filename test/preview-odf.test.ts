// @vitest-environment happy-dom
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createIconProvider } from "../src/main/file-icon";
import { readOdfThumbnail } from "../src/preview/node/odf";
import { renderOdpSlide, renderOdt, type OdfDom, type OdfDomElement } from "../src/preview/shared/odf-render";
import type { OdfDocument, ParseOdf } from "../src/preview/shared/odf-xml";
import { buildOdpDeck } from "../src/preview/shared/odp-model";
import { buildOdtDocument, odtPictures } from "../src/preview/shared/odt-model";
import { byteNeed, viewerForExtension } from "../src/preview/shared/registry";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const NS =
	'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"';

const g = globalThis as unknown as { DOMParser: new () => { parseFromString(text: string, type: string): { getElementsByTagName(name: string): { readonly length: number } } }; document: OdfDom };
const parse: ParseOdf = (text) => {
	const parsed = new g.DOMParser().parseFromString(text, "application/xml");
	return parsed.getElementsByTagName("parsererror").length > 0 ? null : (parsed as unknown as OdfDocument);
};

function odt(body: string, styles = ""): Uint8Array {
	return zipSync({
		"content.xml": strToU8(`<?xml version="1.0"?><office:document-content ${NS}><office:automatic-styles>${styles}</office:automatic-styles><office:body><office:text>${body}</office:text></office:body></office:document-content>`),
	});
}

function odp(pages: string, styles = "", layout = ""): Uint8Array {
	return zipSync({
		"styles.xml": strToU8(
			`<?xml version="1.0"?><office:document-styles ${NS}><office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="15.75cm"/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="Default" style:page-layout-name="pm1">${layout}</style:master-page></office:master-styles></office:document-styles>`,
		),
		"content.xml": strToU8(`<?xml version="1.0"?><office:document-content ${NS}><office:automatic-styles>${styles}</office:automatic-styles><office:body><office:presentation>${pages}</office:presentation></office:body></office:document-content>`),
	});
}

function html(node: OdfDomElement): string {
	return (node as unknown as { outerHTML: string }).outerHTML;
}

describe("OpenDocument registry", () => {
	it("routes odt/odp/odg to their viewers, keeps ods on the sheet, and potx on the PowerPoint viewer", () => {
		expect(viewerForExtension("odt")).toBe("odt");
		expect(viewerForExtension("odp")).toBe("odp");
		expect(viewerForExtension("odg")).toBe("odg");
		expect(viewerForExtension("ods")).toBe("sheet");
		expect(viewerForExtension("potx")).toBe("pptx");
		expect(byteNeed("odt")).toBe("whole");
		expect(byteNeed("odp")).toBe("whole");
		expect(byteNeed("odg")).toBe("extract");
	});
});

describe("readOdfThumbnail", () => {
	async function pack(name: string, files: Parameters<typeof zipSync>[0]): Promise<{ dir: string; path: string }> {
		const dir = await mkdtemp(join(tmpdir(), "autorag-odf-"));
		const path = join(dir, name);
		await writeFile(path, zipSync(files));
		return { dir, path };
	}

	it("returns the embedded first-page PNG", async () => {
		const { dir, path } = await pack("a.odt", { "content.xml": strToU8("x"), "Thumbnails/thumbnail.png": PNG });
		try {
			expect(await readOdfThumbnail(path)).toEqual(PNG);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("is null without a thumbnail, with a non-PNG entry, or for a non-ZIP", async () => {
		const none = await pack("b.odg", { "content.xml": strToU8("x") });
		const bad = await pack("c.odp", { "Thumbnails/thumbnail.png": strToU8("not a png") });
		const plain = await pack("d.odt", {});
		await writeFile(plain.path, "hello");
		try {
			expect(await readOdfThumbnail(none.path)).toBeNull();
			expect(await readOdfThumbnail(bad.path)).toBeNull();
			expect(await readOdfThumbnail(plain.path)).toBeNull();
		} finally {
			for (const entry of [none, bad, plain]) await rm(entry.dir, { recursive: true, force: true });
		}
	});

	it("gives odt/ods/odp/odg tile thumbnails from the package on a platform with no Quick Look", async () => {
		const { dir, path } = await pack("tile.ods", { "Thumbnails/thumbnail.png": PNG });
		try {
			const provider = createIconProvider({ platform: "linux", systemIcon: async () => null, warn: () => undefined });
			const mtimeMs = 1;
			const icons = await provider.icons([{ path, ext: "ods", mtimeMs }]);
			expect(icons.has(path)).toBe(true);
			expect(provider.read(path, mtimeMs)).toEqual(PNG);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("buildOdtDocument", () => {
	it("models headings, styled runs, lists, tables, and pictures and renders them inertly", () => {
		const styles =
			'<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold" fo:color="#ff0000"/></style:style>' +
			'<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/></style:style>';
		const body =
			'<text:h text:outline-level="2">제목 <text:span text:style-name="T1">굵게</text:span></text:h>' +
			'<text:p text:style-name="P1">가운데<text:line-break/>둘째<text:s text:c="2"/>끝</text:p>' +
			'<text:list><text:list-item><text:p>하나</text:p></text:list-item></text:list>' +
			'<table:table><table:table-row><table:table-cell table:number-columns-spanned="2"><text:p>셀</text:p></table:table-cell></table:table-row></table:table>' +
			'<text:p><draw:frame svg:width="2cm" svg:height="1cm"><draw:image xlink:href="Pictures/a.png"/></draw:frame></text:p>' +
			'<text:p><draw:frame><draw:image xlink:href="https://evil.test/x.png"/></draw:frame></text:p>' +
			'<text:p>&lt;img src=x onerror=alert(1)&gt;</text:p>';
		const model = buildOdtDocument(odt(body, styles), parse);
		expect(model).not.toBeNull();
		expect(odtPictures(model!)).toEqual(["Pictures/a.png"]);
		const page = renderOdt(g.document, model!.blocks, (entry) => (entry === "Pictures/a.png" ? "blob:a" : null));
		const out = html(page);
		expect(out).toContain("<h2");
		expect(out).toContain("font-weight:700");
		expect(out).toContain("color:#ff0000");
		expect(out).toContain("text-align:center");
		expect(out).toContain("<li>");
		expect(out).toContain('colspan="2"');
		expect(out).toContain('src="blob:a"');
		expect(out).not.toContain("evil.test");
		expect(out).not.toContain("<img src=\"x\"");
		expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(out).toContain("<span>  </span>");
	});

	it("rejects a package with no text body and non-ZIP bytes", () => {
		expect(buildOdtDocument(odp("<draw:page/>"), parse)).toBeNull();
		expect(buildOdtDocument(strToU8("nope"), parse)).toBeNull();
	});

	it("rejects traversal and absolute picture references", () => {
		const model = buildOdtDocument(odt('<text:p><draw:frame><draw:image xlink:href="../../etc/passwd.png"/></draw:frame><draw:frame><draw:image xlink:href="/abs.png"/></draw:frame></text:p>'), parse);
		expect(odtPictures(model!)).toEqual([]);
	});
});

describe("buildOdpDeck", () => {
	const frame = (x: string, text: string) => `<draw:frame svg:x="${x}" svg:y="1cm" svg:width="10cm" svg:height="3cm"><draw:text-box><text:p>${text}</text:p></draw:text-box></draw:frame>`;

	it("reads page size, slide order, backgrounds, text boxes, pictures, and shapes", () => {
		const styles = '<style:style style:name="dp1" style:family="drawing-page"><style:drawing-page-properties draw:fill="solid" draw:fill-color="#112233"/></style:style>' +
			'<style:style style:name="gr1" style:family="graphic"><style:graphic-properties draw:fill="solid" draw:fill-color="#00ff00" draw:stroke="none"/></style:style>';
		const pages =
			`<draw:page draw:master-page-name="Default" draw:style-name="dp1">${frame("2cm", "첫 슬라이드")}<draw:frame svg:x="0cm" svg:y="0cm" svg:width="4cm" svg:height="4cm"><draw:image xlink:href="Pictures/p.png"/></draw:frame></draw:page>` +
			`<draw:page draw:master-page-name="Default"><draw:custom-shape draw:style-name="gr1" svg:x="1cm" svg:y="1cm" svg:width="3cm" svg:height="3cm"/>${frame("2cm", "둘째")}</draw:page>`;
		const deck = buildOdpDeck(odp(pages, styles), parse);
		expect(deck).not.toBeNull();
		expect(deck!.width).toBeCloseTo((28 * 96) / 2.54, 1);
		expect(deck!.height).toBeCloseTo((15.75 * 96) / 2.54, 1);
		expect(deck!.slides).toHaveLength(2);
		expect(deck!.slides[0]!.background).toBe("#112233");
		expect(deck!.slides[0]!.media).toEqual(["Pictures/p.png"]);
		const first = html(renderOdpSlide(g.document, deck!, 0, () => "blob:p"));
		expect(first).toContain("첫 슬라이드");
		expect(first).toContain("background:#112233");
		expect(first).toContain('src="blob:p"');
		const second = html(renderOdpSlide(g.document, deck!, 1, () => null));
		expect(second).toContain("background:#00ff00");
		expect(second).toContain("둘째");
		expect(second).not.toContain("<img");
	});

	it("draws master-page shapes on every slide and skips placeholders", () => {
		const layout = frame("1cm", "머리글") + '<draw:frame presentation:placeholder="true" svg:x="0cm" svg:y="0cm" svg:width="1cm" svg:height="1cm"><draw:text-box><text:p>끌어놓기</text:p></draw:text-box></draw:frame>';
		const deck = buildOdpDeck(odp(`<draw:page draw:master-page-name="Default">${frame("2cm", "본문")}</draw:page>`, "", layout), parse);
		const out = html(renderOdpSlide(g.document, deck!, 0, () => null));
		expect(out).toContain("머리글");
		expect(out).toContain("본문");
		expect(out).not.toContain("끌어놓기");
	});

	it("drops a style value that is not a plain #rrggbb colour", () => {
		const styles = '<style:style style:name="dp1" style:family="drawing-page"><style:drawing-page-properties draw:fill="solid" draw:fill-color="red;background:url(x)"/></style:style>';
		const deck = buildOdpDeck(odp('<draw:page draw:style-name="dp1" draw:master-page-name="Default"/>', styles), parse);
		expect(deck!.slides[0]!.background).toBeNull();
	});

	it("is null for a presentation with no pages", () => {
		expect(buildOdpDeck(odp(""), parse)).toBeNull();
	});
});
