import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import * as XLSX from "xlsx";
import { newFileContents } from "../src/main/file-templates";
import { NEW_FILE_FORMATS, newFileFormat } from "../src/shared/new-file-contract";

/** Every part of an OOXML package, decoded as UTF-8 text. */
function ooxmlParts(bytes: Uint8Array): Record<string, string> {
	const entries = unzipSync(bytes);
	return Object.fromEntries(Object.entries(entries).map(([name, data]) => [name, strFromU8(data)]));
}

describe("new-file format catalog", () => {
	it("lists the document formats the New submenu offers, each with a unique extension", () => {
		const ids = NEW_FILE_FORMATS.map((format) => format.id);
		const extensions = NEW_FILE_FORMATS.map((format) => format.extension);
		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(extensions).size).toBe(extensions.length);
		expect(extensions).toEqual(expect.arrayContaining(["txt", "md", "rtf", "docx", "xlsx", "pptx"]));
	});

	it("resolves a format by id, extension included", () => {
		expect(newFileFormat("word")).toMatchObject({ extension: "docx" });
		expect(newFileFormat("powerpoint").extension).toBe("pptx");
	});
});

describe("newFileContents", () => {
	it("writes a plain-text document empty, and markdown empty too", () => {
		expect(newFileContents("text").length).toBe(0);
		expect(newFileContents("markdown").length).toBe(0);
	});

	it("writes an RTF document that opens in a rich-text editor", () => {
		const rtf = strFromU8(newFileContents("rtf"));
		expect(rtf.startsWith("{\\rtf1")).toBe(true);
		expect(rtf.trim().endsWith("}")).toBe(true);
	});

	it("writes a Word document as an OOXML package", () => {
		const parts = ooxmlParts(newFileContents("word"));
		expect(Object.keys(parts)).toEqual(
			expect.arrayContaining(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]),
		);
		expect(parts["[Content_Types].xml"]).toContain("wordprocessingml.document.main+xml");
		expect(parts["word/document.xml"]).toContain("<w:document");
	});

	it("writes an Excel workbook that SheetJS can parse", () => {
		const bytes = newFileContents("excel");
		const parts = ooxmlParts(bytes);
		expect(Object.keys(parts)).toEqual(
			expect.arrayContaining([
				"[Content_Types].xml",
				"_rels/.rels",
				"xl/workbook.xml",
				"xl/worksheets/sheet1.xml",
			]),
		);
		const workbook = XLSX.read(bytes, { type: "array" });
		expect(workbook.SheetNames.length).toBe(1);
	});

	it("writes a PowerPoint deck as an OOXML package with a master, layout, slide, and theme", () => {
		const parts = ooxmlParts(newFileContents("powerpoint"));
		expect(Object.keys(parts)).toEqual(
			expect.arrayContaining([
				"[Content_Types].xml",
				"_rels/.rels",
				"ppt/presentation.xml",
				"ppt/slideMasters/slideMaster1.xml",
				"ppt/slideLayouts/slideLayout1.xml",
				"ppt/slides/slide1.xml",
				"ppt/theme/theme1.xml",
			]),
		);
		expect(parts["ppt/presentation.xml"]).toContain("<p:presentation");
	});
});
