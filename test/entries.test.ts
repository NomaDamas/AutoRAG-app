import { describe, expect, it } from "vitest";
import { entryFromFs } from "../src/renderer/src/data/entries";
import { fileKindOf, kindLabelOf } from "../src/renderer/src/state/entry-values";
import type { FsEntry } from "../src/shared/fs-contract";

const STAMP = Date.parse("2026-09-30T00:00:00.000Z");

function fsEntry(over: Partial<FsEntry>): FsEntry {
	return {
		name: "a.mp4",
		path: "/docs/a.mp4",
		kind: "file",
		ext: "mp4",
		size: 10,
		mtimeMs: STAMP,
		flags: 0,
		...over,
	};
}

describe("entryFromFs", () => {
	it("maps the filesystem's raw fields onto a row", () => {
		const row = entryFromFs(
			fsEntry({
				name: "a.md",
				path: "/docs/a.md",
				ext: "md",
				size: 42,
				mtimeMs: STAMP,
				birthtimeMs: Date.parse("2026-09-01T00:00:00.000Z"),
			}),
		);
		expect(row).toMatchObject({
			name: "a.md",
			path: "/docs/a.md",
			kind: "file",
			ext: "md",
			size: 42,
			mtimeMs: STAMP,
			birthtimeMs: Date.parse("2026-09-01T00:00:00.000Z"),
		});
	});

	it("defaults birthtimeMs to 0 when the filesystem exposes none", () => {
		expect(entryFromFs(fsEntry({})).birthtimeMs).toBe(0);
	});
});

describe("kindLabelOf", () => {
	it("prefers the OS-detected kind over the extension map", () => {
		// Given a file whose extension the map would label "Markdown"
		const row = { ...entryFromFs(fsEntry({ ext: "mp4" })), osKind: "MPEG-4 movie" };

		// Then the Kind cell shows the OS kind
		expect(kindLabelOf(row)).toBe("MPEG-4 movie");
	});

	it("falls back to the extension map when the OS reported no kind", () => {
		expect(kindLabelOf(entryFromFs(fsEntry({ name: "a.pdf", ext: "pdf" })))).toBe("PDF Document");
	});

	it("labels folders Folder", () => {
		expect(kindLabelOf(entryFromFs(fsEntry({ name: "Docs", ext: "", kind: "folder", size: null })))).toBe("Folder");
	});

	it("keeps the file tile family from the extension map", () => {
		expect(fileKindOf(entryFromFs(fsEntry({ ext: "xlsx" })))).toBe("xlsx");
	});
});
