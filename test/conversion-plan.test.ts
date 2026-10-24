import { describe, expect, it } from "vitest";
import { planConversion } from "../src/main/conversion-plan";

describe("planConversion", () => {
	it("converts when the new extension is a format the old one can become", () => {
		expect(planConversion("report.hwpx", "report.pdf")).toEqual({ kind: "convert", from: "hwpx", to: "pdf" });
		expect(planConversion("slides.pptx", "slides.pdf")).toEqual({ kind: "convert", from: "pptx", to: "pdf" });
		expect(planConversion("photo.heic", "photo.png")).toEqual({ kind: "convert", from: "heic", to: "png" });
		expect(planConversion("notes.md", "notes.docx")).toEqual({ kind: "convert", from: "md", to: "docx" });
	});

	it("reads the extension case-insensitively and reports it lower-case", () => {
		expect(planConversion("SCAN.PNG", "SCAN.Pdf")).toEqual({ kind: "convert", from: "png", to: "pdf" });
	});

	it("takes the new name's own stem: only the extension decides", () => {
		expect(planConversion("draft.hwpx", "final version.pdf")).toEqual({ kind: "convert", from: "hwpx", to: "pdf" });
	});

	it("keeps a rename that does not change the format a plain rename", () => {
		expect(planConversion("a.pdf", "b.pdf")).toEqual({ kind: "rename" });
		expect(planConversion("a.PDF", "a.pdf")).toEqual({ kind: "rename" });
		expect(planConversion("photo.jpg", "photo.jpeg")).toEqual({ kind: "rename" });
		expect(planConversion("page.htm", "page.html")).toEqual({ kind: "rename" });
		expect(planConversion("raw.cr2", "raw.nef")).toEqual({ kind: "rename" });
	});

	it("keeps a rename a plain rename when either side has no extension", () => {
		expect(planConversion("README", "README.md")).toEqual({ kind: "rename" });
		expect(planConversion("notes.txt", "notes")).toEqual({ kind: "rename" });
		expect(planConversion(".bashrc", ".zshrc")).toEqual({ kind: "rename" });
		expect(planConversion("trailing.", "trailing.pdf")).toEqual({ kind: "rename" });
	});

	it("rejects a target the source has no route to", () => {
		// Audio only converts to audio; a spreadsheet does not become audio.
		expect(planConversion("song.mp3", "song.pdf")).toEqual({ kind: "unsupported", from: "mp3", to: "pdf" });
		expect(planConversion("sheet.xlsx", "sheet.mp3")).toEqual({ kind: "unsupported", from: "xlsx", to: "mp3" });
	});

	it("rejects an extension Filee does not know on either side", () => {
		expect(planConversion("report.hwpx", "report.bak")).toEqual({ kind: "unsupported", from: "hwpx", to: "bak" });
		expect(planConversion("data.zzz", "data.pdf")).toEqual({ kind: "unsupported", from: "zzz", to: "pdf" });
	});

	it("treats Filee's other spellings as the format they name", () => {
		expect(planConversion("photo.jpeg", "photo.webp")).toEqual({ kind: "convert", from: "jpeg", to: "webp" });
		expect(planConversion("photo.png", "photo.jpeg")).toEqual({ kind: "convert", from: "png", to: "jpeg" });
		expect(planConversion("page.htm", "page.pdf")).toEqual({ kind: "convert", from: "htm", to: "pdf" });
	});

	it("looks only at the last extension of a dotted name", () => {
		expect(planConversion("v1.2.final.docx", "v1.2.final.pdf")).toEqual({ kind: "convert", from: "docx", to: "pdf" });
	});
});
