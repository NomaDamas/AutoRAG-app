import { describe, expect, it } from "vitest";
import { entryFromFs } from "../src/renderer/src/data/entries";
import type { FsEntry } from "../src/shared/fs-contract";

function fsEntry(over: Partial<FsEntry>): FsEntry {
	return {
		name: "a.mp4",
		path: "/docs/a.mp4",
		kind: "file",
		ext: "mp4",
		size: 10,
		modifiedAt: new Date(0).toISOString(),
		isSymlink: false,
		osKind: null,
		iconUrl: null,
		...over,
	};
}

describe("entryFromFs kind label", () => {
	it("prefers the OS-detected kind over the extension map", () => {
		// Given a file whose extension the map would label "Markdown"
		const entry = fsEntry({ ext: "mp4", osKind: "MPEG-4 movie" });

		// When the row is built
		// Then the Kind cell shows the OS kind
		expect(entryFromFs(entry).kindLabel).toBe("MPEG-4 movie");
	});

	it("falls back to the extension map when the OS reported no kind", () => {
		expect(entryFromFs(fsEntry({ name: "a.pdf", ext: "pdf", osKind: null })).kindLabel).toBe("PDF Document");
	});

	it("labels folders Folder", () => {
		expect(entryFromFs(fsEntry({ name: "Docs", ext: "", kind: "folder", osKind: null })).kindLabel).toBe("Folder");
	});

	it("keeps the file tile family from the extension map", () => {
		expect(entryFromFs(fsEntry({ ext: "xlsx", osKind: "Excel spreadsheet" })).fileKind).toBe("xlsx");
	});

	it("maps a macOS app bundle to the app tile and the OS's Application label", () => {
		// Given a .app row whose bundle Quick Look has not answered for yet
		const entry = fsEntry({ name: "Hello.app", path: "/Applications/Hello.app", ext: "app", size: null, osKind: null });

		// When the row is built
		const row = entryFromFs(entry);

		// Then it renders the app tile with the Application label and no folder size
		expect(row.kind).toBe("file");
		expect(row.fileKind).toBe("app");
		expect(row.kindLabel).toBe("Application");
		expect(row.sizeLabel).toBe("—");
	});

	it("carries the OS tile icon through to the row", () => {
		// Given a file the OS produced an icon for
		const icon = "autorag-thumb://local/?path=%2Fdocs%2Fa.mp4&mtime=2026-09-29T00%3A00%3A00.000Z";

		// When the row is built
		// Then the tile receives it
		expect(entryFromFs(fsEntry({ iconUrl: icon })).iconUrl).toBe(icon);
		expect(entryFromFs(fsEntry({ iconUrl: null })).iconUrl).toBeNull();
	});
});
