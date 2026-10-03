import { describe, expect, it } from "vitest";
import { SORT_KEY_BY_COLUMN, cycleSort, sortEntries } from "../src/renderer/src/state/sort";
import type { SortableEntry } from "../src/renderer/src/state/sort";

function e(
	name: string,
	kind: "folder" | "file",
	modifiedValue: number,
	sizeValue: number,
	kindLabel: string,
	location = "Documents",
): SortableEntry {
	return { name, kind, modifiedValue, sizeValue, kindLabel, location };
}

describe("cycleSort", () => {
	it("starts Name ascending", () => {
		expect(cycleSort(null, "name")).toEqual({ key: "name", dir: 1, flipped: false });
	});

	it("starts Date and Size descending", () => {
		expect(cycleSort(null, "date")).toEqual({ key: "date", dir: -1, flipped: false });
		expect(cycleSort(null, "size")).toEqual({ key: "size", dir: -1, flipped: false });
	});

	it("flips direction on the second click", () => {
		const first = cycleSort(null, "name");
		expect(cycleSort(first, "name")).toEqual({ key: "name", dir: -1, flipped: true });
	});

	it("clears sorting on the third click", () => {
		const second = cycleSort(cycleSort(null, "date"), "date");
		expect(cycleSort(second, "date")).toBeNull();
	});

	it("restarts the cycle when another column is clicked", () => {
		const flipped = cycleSort(cycleSort(null, "name"), "name");
		expect(cycleSort(flipped, "size")).toEqual({ key: "size", dir: -1, flipped: false });
	});
});

describe("SORT_KEY_BY_COLUMN", () => {
	it("maps every sortable column, Name included", () => {
		expect(SORT_KEY_BY_COLUMN.name).toBe("name");
		expect(SORT_KEY_BY_COLUMN.date).toBe("date");
		expect(SORT_KEY_BY_COLUMN.size).toBe("size");
		expect(SORT_KEY_BY_COLUMN.kind).toBe("kind");
	});

	it("leaves the non-sortable columns out", () => {
		expect(SORT_KEY_BY_COLUMN.extension).toBeUndefined();
		expect(SORT_KEY_BY_COLUMN.relativePath).toBeUndefined();
		expect(SORT_KEY_BY_COLUMN.index).toBeUndefined();
	});
});

describe("sortEntries", () => {
	const rows = [
		e("나무.pdf", "file", 20, 200, "PDF Document"),
		e("Zebra", "folder", 10, 0, "Folder"),
		e("가방.xlsx", "file", 30, 100, "Excel Spreadsheet"),
		e("apple", "folder", 40, 0, "Folder"),
	];

	it("keeps the listing order when sorting is cleared", () => {
		expect(sortEntries(rows, null).map((r) => r.name)).toEqual(["나무.pdf", "Zebra", "가방.xlsx", "apple"]);
	});

	it("interleaves folders and files by the active key instead of pinning folders first", () => {
		const mixed = [
			e("zebra.txt", "file", 1, 100, "PDF Document"),
			e("bravo", "folder", 2, 0, "Folder"),
			e("alpha.txt", "file", 3, 200, "PDF Document"),
		];
		// Name ascending: the folder sits between the two files.
		expect(sortEntries(mixed, { key: "name", dir: 1, flipped: false }).map((r) => r.name)).toEqual([
			"alpha.txt",
			"bravo",
			"zebra.txt",
		]);
		// Size descending: the folder (size 0) ranks last, not first.
		expect(sortEntries(mixed, { key: "size", dir: -1, flipped: true }).map((r) => r.name)).toEqual([
			"alpha.txt",
			"zebra.txt",
			"bravo",
		]);
	});

	it("ranks an unparseable stamp or size (NaN) as 0, the minimum", () => {
		const unknown = [
			e("known.txt", "file", 50, 500, "PDF Document"),
			e("unknown.txt", "file", Number.NaN, Number.NaN, "PDF Document"),
		];
		expect(sortEntries(unknown, { key: "size", dir: 1, flipped: false }).map((r) => r.name)).toEqual([
			"unknown.txt",
			"known.txt",
		]);
		expect(sortEntries(unknown, { key: "date", dir: 1, flipped: false }).map((r) => r.name)).toEqual([
			"unknown.txt",
			"known.txt",
		]);
		expect(sortEntries(unknown, { key: "size", dir: -1, flipped: true }).map((r) => r.name)).toEqual([
			"known.txt",
			"unknown.txt",
		]);
	});

	it("compares names with the Korean locale", () => {
		expect(sortEntries(rows, { key: "name", dir: 1, flipped: false }).map((r) => r.name)).toEqual([
			"가방.xlsx",
			"나무.pdf",
			"apple",
			"Zebra",
		]);
	});

	it("sorts dates and sizes numerically", () => {
		expect(sortEntries(rows, { key: "date", dir: -1, flipped: false }).map((r) => r.name)).toEqual([
			"apple",
			"가방.xlsx",
			"나무.pdf",
			"Zebra",
		]);
		expect(sortEntries(rows, { key: "size", dir: 1, flipped: false }).map((r) => r.name)).toEqual([
			"Zebra",
			"apple",
			"가방.xlsx",
			"나무.pdf",
		]);
	});

	it("breaks Kind ties with the name", () => {
		const same = [
			e("b.pdf", "file", 1, 1, "PDF Document"),
			e("a.pdf", "file", 2, 2, "PDF Document"),
			e("c.xlsx", "file", 3, 3, "Excel Spreadsheet"),
		];
		expect(sortEntries(same, { key: "kind", dir: 1, flipped: false }).map((r) => r.name)).toEqual([
			"c.xlsx",
			"a.pdf",
			"b.pdf",
		]);
	});

	it("sorts search results by their location for the Where column", () => {
		const hits = [
			e("a.pdf", "file", 1, 1, "PDF Document", "Downloads"),
			e("b.pdf", "file", 2, 2, "PDF Document", "Desktop"),
		];
		expect(sortEntries(hits, { key: "where", dir: 1, flipped: false }).map((r) => r.location)).toEqual([
			"Desktop",
			"Downloads",
		]);
	});

	it("does not mutate the input", () => {
		const input = [...rows];
		sortEntries(input, { key: "name", dir: 1, flipped: false });
		expect(input.map((r) => r.name)).toEqual(["나무.pdf", "Zebra", "가방.xlsx", "apple"]);
	});
});
