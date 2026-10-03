import { describe, expect, it } from "vitest";
import type { FinderEntry } from "../src/renderer/src/data/entries";
import { needsThumbnail, takeThumbnailBatch, thumbnailKey } from "../src/renderer/src/state/thumbnails";

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

describe("takeThumbnailBatch", () => {
	it("drains the accepted queue, marks it requested, and returns it", () => {
		const queue = new Map([
			["/docs/a.png\u0000t1", entry({ path: "/docs/a.png" })],
			["/docs/b.png\u0000t1", entry({ path: "/docs/b.png" })],
		]);
		const requested = new Set<string>();

		const batch = takeThumbnailBatch(queue, requested, () => true);

		expect(batch.map((item) => item.path)).toEqual(["/docs/a.png", "/docs/b.png"]);
		expect(queue.size).toBe(0);
		expect(requested).toEqual(new Set(["/docs/a.png\u0000t1", "/docs/b.png\u0000t1"]));
	});

	it("drops entries whose location is no longer the current view", () => {
		const queue = new Map([
			["/docs/a.png\u0000t1", entry({ path: "/docs/a.png", location: "/docs" })],
			["/else/b.png\u0000t1", entry({ path: "/else/b.png", location: "/else" })],
		]);
		const requested = new Set<string>();

		const batch = takeThumbnailBatch(queue, requested, (location) => location === "/docs");

		expect(batch.map((item) => item.path)).toEqual(["/docs/a.png"]);
		expect(requested).toEqual(new Set(["/docs/a.png\u0000t1"]));
		expect(queue.size).toBe(0);
	});

	it("returns nothing for an empty queue", () => {
		expect(takeThumbnailBatch(new Map(), new Set(), () => true)).toEqual([]);
	});
});
