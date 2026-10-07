import { describe, expect, it } from "vitest";
import type { FinderEntry } from "../src/renderer/src/data/entries";
import { needsThumbnail, thumbnailKey } from "../src/renderer/src/state/thumbnails";

function entry(overrides: Partial<FinderEntry> = {}): FinderEntry {
	return {
		name: "a.png",
		path: "/docs/a.png",
		kind: "file",
		ext: "png",
		size: 0,
		mtimeMs: Date.parse("2026-10-01T00:00:00.000Z"),
		birthtimeMs: 0,
		...overrides,
	};
}

describe("needsThumbnail", () => {
	it("is true for a file that has no icon yet", () => {
		expect(needsThumbnail(entry())).toBe(true);
	});

	it("is false once the OS produced an icon", () => {
		expect(needsThumbnail(entry({ iconUrl: "autorag-thumb://local/?path=%2Fdocs%2Fa.png&mtime=1759276800000" }))).toBe(false);
	});

	it("is false for folders", () => {
		expect(needsThumbnail(entry({ kind: "folder" }))).toBe(false);
	});
});

describe("thumbnailKey", () => {
	it("separates the same path at different mtimes", () => {
		expect(thumbnailKey(entry({ mtimeMs: 1 }))).not.toBe(thumbnailKey(entry({ mtimeMs: 2 })));
	});

	it("is stable for the same identity", () => {
		expect(thumbnailKey(entry())).toBe(thumbnailKey(entry()));
	});
});
