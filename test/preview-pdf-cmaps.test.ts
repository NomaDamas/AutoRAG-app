import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { pdfDocumentSource, pdfSupportUrls } from "../src/preview/ui/pdf-config";

/**
 * Minimal valid PDF 1.4 using an unembedded Type0 CIDFont with Adobe-Korea1
 * ordering and the predefined `UniKS-UTF16-H` CMap (same font/CMap structure as
 * Korean business PDFs generated without embedded glyph subsets, such as
 * estimate/invoice exports). Without `cMapUrl`, pdf.js fails `translateFont`
 * with `Ensure that the cMapUrl API parameter is provided` and drops every
 * glyph on the page.
 */
export function buildUnembeddedKoreanCMapPdf(text: string): Uint8Array {
	const utf16BeHex = Array.from(text)
		.map((ch) => ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase())
		.join("");
	const stream = `BT /F1 24 Tf 72 720 Td <${utf16BeHex}> Tj ET`;
	const objects = [
		"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
		"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
		"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>\nendobj\n",
		"4 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /ArialUnicodeMS-UniKS-UTF16-H /Encoding /UniKS-UTF16-H /DescendantFonts [5 0 R] >>\nendobj\n",
		"5 0 obj\n<< /Type /Font /Subtype /CIDFontType0 /BaseFont /ArialUnicodeMS /CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 0 >> /DW 1000 /FontDescriptor 6 0 R >>\nendobj\n",
		"6 0 obj\n<< /Type /FontDescriptor /FontName /ArialUnicodeMS /Flags 32 /FontBBox [-1011 -330 2260 1078] /ItalicAngle 0 /Ascent 1069 /Descent -271 /CapHeight 1069 /StemV 70 >>\nendobj\n",
		`7 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
	];
	let pdf = "%PDF-1.4\n";
	const offsets: number[] = [0];
	for (const obj of objects) {
		offsets.push(Buffer.byteLength(pdf, "latin1"));
		pdf += obj;
	}
	const xrefOffset = Buffer.byteLength(pdf, "latin1");
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (let i = 1; i < offsets.length; i += 1) {
		pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
	}
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return new Uint8Array(Buffer.from(pdf, "latin1"));
}

describe("pdfSupportUrls and pdfDocumentSource", () => {
	it("resolves trailing-slash resource URLs relative to a file:// renderer document", () => {
		const urls = pdfSupportUrls("file:///Applications/Dazzi.app/Contents/Resources/app/out/renderer/quick-look.html");
		expect(urls.cMapUrl).toBe("file:///Applications/Dazzi.app/Contents/Resources/app/out/renderer/pdfjs/cmaps/");
		expect(urls.standardFontDataUrl).toBe("file:///Applications/Dazzi.app/Contents/Resources/app/out/renderer/pdfjs/standard_fonts/");
		expect(urls.wasmUrl).toBe("file:///Applications/Dazzi.app/Contents/Resources/app/out/renderer/pdfjs/wasm/");
		expect(urls.iccUrl).toBe("file:///Applications/Dazzi.app/Contents/Resources/app/out/renderer/pdfjs/iccs/");
	});

	it("resolves trailing-slash resource URLs relative to an http:// dev or remote document", () => {
		const urls = pdfSupportUrls("http://localhost:5173/quick-look.html");
		expect(urls.cMapUrl).toBe("http://localhost:5173/pdfjs/cmaps/");
		expect(urls.standardFontDataUrl).toBe("http://localhost:5173/pdfjs/standard_fonts/");
		expect(urls.wasmUrl).toBe("http://localhost:5173/pdfjs/wasm/");
		expect(urls.iccUrl).toBe("http://localhost:5173/pdfjs/iccs/");
	});

	it("builds getDocument parameters with cMapPacked, CMap, standard font, wasm, and ICC URLs", () => {
		const source = pdfDocumentSource("autorag-preview://local/?path=%2Ftmp%2Festimate.pdf", "file:///app/out/renderer/quick-look.html");
		expect(source).toEqual({
			url: "autorag-preview://local/?path=%2Ftmp%2Festimate.pdf",
			disableAutoFetch: true,
			cMapUrl: "file:///app/out/renderer/pdfjs/cmaps/",
			cMapPacked: true,
			standardFontDataUrl: "file:///app/out/renderer/pdfjs/standard_fonts/",
			wasmUrl: "file:///app/out/renderer/pdfjs/wasm/",
			iccUrl: "file:///app/out/renderer/pdfjs/iccs/",
		});
	});
});

describe("unembedded Korean CIDFont (UniKS-UTF16-H) extraction via pdfjs-dist", () => {
	const pdfjsRoot = createRequire(import.meta.url).resolve("pdfjs-dist/package.json").replace(/package\.json$/, "");

	it("loses all text when cMapUrl is omitted, and recovers Korean text when cMapUrl and standardFontDataUrl are provided", async () => {
		const bytes = buildUnembeddedKoreanCMapPdf("견적서 1,102,200원");

		// Baseline failure: without cMapUrl, pdf.js cannot decode UniKS-UTF16-H and extracts nothing.
		const brokenTask = getDocument({ data: bytes.slice(), verbosity: 0 });
		try {
			const page = await (await brokenTask.promise).getPage(1);
			const text = (await page.getTextContent()).items
				.map((item) => ("str" in item ? item.str : ""))
				.join("");
			expect(text).toBe("");
		} finally {
			await brokenTask.destroy();
		}

		// Fixed path: with bundled cmaps + standard_fonts, pdf.js decodes every Korean and ASCII character.
		const fixedTask = getDocument({
			data: bytes.slice(),
			verbosity: 0,
			cMapUrl: `${pdfjsRoot}cmaps/`,
			cMapPacked: true,
			standardFontDataUrl: `${pdfjsRoot}standard_fonts/`,
		});
		try {
			const page = await (await fixedTask.promise).getPage(1);
			const text = (await page.getTextContent()).items
				.map((item) => ("str" in item ? item.str : ""))
				.join("");
			expect(text).toBe("견적서 1,102,200원");
		} finally {
			await fixedTask.destroy();
		}
	});
});
