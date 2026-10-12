import { describe, expect, it } from "vitest";
import { archiveFormatOf } from "../src/shared/archive-formats";

describe("archiveFormatOf", () => {
	it("reads single-suffix formats and their stems", () => {
		expect(archiveFormatOf("docs.zip")).toEqual({ format: "zip", stem: "docs" });
		expect(archiveFormatOf("docs.tar")).toEqual({ format: "tar", stem: "docs" });
		expect(archiveFormatOf("docs.tgz")).toEqual({ format: "tgz", stem: "docs" });
		expect(archiveFormatOf("docs.tbz2")).toEqual({ format: "tbz2", stem: "docs" });
		expect(archiveFormatOf("docs.txz")).toEqual({ format: "txz", stem: "docs" });
		expect(archiveFormatOf("docs.7z")).toEqual({ format: "7z", stem: "docs" });
		expect(archiveFormatOf("docs.RAR")).toEqual({ format: "rar", stem: "docs" });
	});

	it("matches multi-dot suffixes longest-first", () => {
		expect(archiveFormatOf("a.tar.gz")).toEqual({ format: "tar.gz", stem: "a" });
		expect(archiveFormatOf("a.tar.bz2")).toEqual({ format: "tar.bz2", stem: "a" });
		expect(archiveFormatOf("a.tar.xz")).toEqual({ format: "tar.xz", stem: "a" });
		expect(archiveFormatOf("notes.txt.gz")).toEqual({ format: "gz", stem: "notes.txt" });
	});

	it("is case-insensitive and keeps the original stem spelling", () => {
		expect(archiveFormatOf("Report.TAR.GZ")).toEqual({ format: "tar.gz", stem: "Report" });
		expect(archiveFormatOf("Archive.ZIP")).toEqual({ format: "zip", stem: "Archive" });
	});

	it("rejects plain files, dotfiles, and unoffered shorthand", () => {
		expect(archiveFormatOf("notes.txt")).toBeNull();
		expect(archiveFormatOf("README")).toBeNull();
		expect(archiveFormatOf("trailing.zip.")).toBeNull();
		expect(archiveFormatOf(".zip")).toBeNull();
		expect(archiveFormatOf(".tar.gz")).toBeNull();
		expect(archiveFormatOf("..zip")).toBeNull();
		expect(archiveFormatOf("docs.bz2")).toBeNull();
		expect(archiveFormatOf("docs.xz")).toBeNull();
	});
});
