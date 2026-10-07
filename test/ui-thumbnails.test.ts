import { describe, expect, it } from "vitest";
import type { FinderEntry } from "../src/renderer/src/data/entries";
import { needsThumbnail, thumbnailKey } from "../src/renderer/src/state/thumbnails";

function entry(overrides: Partial<FinderEntry> = {}): FinderEntry {
	return {
		name: "a.png",
		path: "/docs/a.png",
		kind: "file",
		fileKind: "png",
		iconUrl: null,
		modifiedAt: "2026-10-01T00:00:00.000Z",
		dateLabel: "",
		sizeLabel: "",
		modifiedValue: 0,
		sizeValue: 0,
		kindLabel: "",
		location: "/docs",
		...overrides,
	};
}

describe("needsThumbnail", () => {
	it("is true for a file that has no icon yet", () => {
		expect(needsThumbnail(entry())).toBe(true);
	});

	it("is false once the OS produced an icon", () => {
		expect(needsThumbnail(entry({ iconUrl: "autorag-thumb://local/?path=%2Fdocs%2Fa.png&mtime=x" }))).toBe(false);
	});

	it("is false for folders and entries without a modification stamp", () => {
		expect(needsThumbnail(entry({ kind: "folder" }))).toBe(false);
		const { modifiedAt: _dropped, ...withoutMtime } = entry();
		expect(needsThumbnail(withoutMtime)).toBe(false);
	});
});

describe("thumbnailKey", () => {
	it("separates the same path at different mtimes", () => {
		expect(thumbnailKey(entry({ modifiedAt: "t1" }))).not.toBe(thumbnailKey(entry({ modifiedAt: "t2" })));
	});

	it("is stable for the same identity", () => {
		expect(thumbnailKey(entry())).toBe(thumbnailKey(entry()));
	});
});
