import { describe, expect, it } from "vitest";
import type { FinderEntry } from "../src/renderer/src/data/entries";
import {
	GROUP_OPTIONS,
	type GroupSection,
	groupEntries,
	groupedLayout,
	groupedRowTop,
	groupedWindow,
	groupLabel,
	groupRows,
	parseGroupKey,
} from "../src/renderer/src/state/grouping";
import type { SortableEntry } from "../src/renderer/src/state/sort";
import type { StackRow } from "../src/renderer/src/state/version-family";

function e(
	name: string,
	kind: "folder" | "file",
	modifiedValue: number,
	sizeValue: number,
	kindLabel: string,
	extra: Partial<SortableEntry> = {},
): SortableEntry {
	return {
		name,
		kind,
		modifiedValue,
		sizeValue,
		kindLabel,
		location: "Documents",
		...extra,
	};
}

/** Local-noon stamp on a September 2026 calendar day. */
const stamp = (day: number, hour = 12): number =>
	new Date(2026, 8, day, hour).getTime();
/** Fixed "now" (Sep 15, 2026 noon) for the relative date buckets. */
const NOW = new Date(2026, 8, 15, 12).getTime();
/** An August 2026 local-noon stamp, past the Previous 30 Days window. */
const august = (day: number): number => new Date(2026, 7, day, 10).getTime();

function fe(entry: SortableEntry): FinderEntry {
	return {
		name: entry.name,
		path: `Documents/${entry.name}`,
		kind: entry.kind,
		fileKind: entry.kind === "folder" ? "folder" : "md",
		iconUrl: null,
		dateLabel: "Sep 1, 12:00",
		sizeLabel: "1 KB",
		kindLabel: entry.kindLabel,
		location: "Documents",
		modifiedValue: entry.modifiedValue,
		sizeValue: entry.sizeValue,
	};
}

function labels<T>(sections: readonly GroupSection<T>[]): (string | null)[] {
	return sections.map((section) => section.label);
}

describe("parseGroupKey", () => {
	it("round-trips every group option", () => {
		for (const option of GROUP_OPTIONS) {
			expect(parseGroupKey(option.key)).toBe(option.key);
		}
	});

	it("falls back to none for unknown or missing values", () => {
		expect(parseGroupKey(null)).toBe("none");
		expect(parseGroupKey("bogus")).toBe("none");
	});
});

describe("groupLabel", () => {
	it("labels every option", () => {
		expect(groupLabel("none")).toBe("None");
		expect(groupLabel("kind")).toBe("Kind");
		expect(groupLabel("date")).toBe("Date Modified");
	});
});

describe("groupEntries", () => {
	it("returns one headerless section for none, keeping the order", () => {
		const rows = [
			e("b.txt", "file", 1, 10, "Markdown"),
			e("a.txt", "file", 2, 20, "Markdown"),
		];
		const sections = groupEntries(rows, "none");
		expect(sections).toEqual([{ label: null, rows }]);
	});

	it("splits by kind label and orders the sections", () => {
		const rows = [
			e("z.pdf", "file", 1, 1, "PDF Document"),
			e("a.xlsx", "file", 2, 2, "Excel Spreadsheet"),
			e("m.pdf", "file", 3, 3, "PDF Document"),
		];
		const sections = groupEntries(rows, "kind");
		expect(labels(sections)).toEqual(["Excel Spreadsheet", "PDF Document"]);
		expect(sections[1]?.rows.map((row) => row.name)).toEqual([
			"z.pdf",
			"m.pdf",
		]);
	});

	it("groups folders under Folder and files by uppercase extension", () => {
		const rows = [
			e("photo.jpeg", "file", 1, 1, "PNG Image"),
			e("notes", "folder", 2, 0, "Folder"),
			e("readme.md", "file", 3, 3, "Markdown"),
			e("plain", "file", 4, 4, "Markdown"),
		];
		expect(labels(groupEntries(rows, "extension"))).toEqual([
			"Folder",
			"JPEG",
			"MD",
			"No Extension",
		]);
	});

	it("groups names by their first character, uppercased", () => {
		const rows = [
			e("bravo", "folder", 1, 0, "Folder"),
			e("apple", "folder", 2, 0, "Folder"),
			e("가방", "folder", 3, 0, "Folder"),
		];
		// The app's Korean collator ranks Hangul before Latin, like sortEntries.
		expect(labels(groupEntries(rows, "name"))).toEqual(["가", "A", "B"]);
	});

	it("groups dates into Finder buckets, newest first, unknown last", () => {
		const rows = [
			e("month.txt", "file", august(6), 1, "Markdown"),
			e("today.txt", "file", stamp(15, 9), 1, "Markdown"),
			e("yesterday.txt", "file", stamp(14), 1, "Markdown"),
			e("week.txt", "file", stamp(10), 1, "Markdown"),
			e("thirty.txt", "file", stamp(6), 1, "Markdown"),
			e("unknown.txt", "file", 0, 1, "Markdown"),
		];
		expect(labels(groupEntries(rows, "date", NOW))).toEqual([
			"Today",
			"Yesterday",
			"Previous 7 Days",
			"Previous 30 Days",
			"August 2026",
			"Unknown Date",
		]);
	});

	it("keeps unknown dedicated date metadata in an unknown bucket", () => {
		const rows = [
			e("b.txt", "file", stamp(14), 1, "Markdown"),
			e("a.txt", "file", stamp(13), 1, "Markdown"),
		];
		expect(labels(groupEntries(rows, "dateCreated", NOW))).toEqual(["Unknown Date"]);
		expect(labels(groupEntries(rows, "dateAdded", NOW))).toEqual(["Unknown Date"]);
		expect(labels(groupEntries(rows, "dateLastOpened", NOW))).toEqual(["Unknown Date"]);
	});

	it("prefers the dedicated date values when present", () => {
		const rows = [
			e("created-later.txt", "file", stamp(10), 1, "Markdown", {
				createdValue: stamp(15, 9),
			}),
			e("created-earlier.txt", "file", stamp(10), 1, "Markdown", {
				createdValue: stamp(14),
			}),
		];
		expect(labels(groupEntries(rows, "dateCreated", NOW))).toEqual([
			"Today",
			"Yesterday",
		]);
	});

	it("buckets sizes in Finder order, zero first", () => {
		const rows = [
			e("big.bin", "file", 1, 5 * 1024 * 1024 * 1024, "Archive"),
			e("tiny.txt", "file", 2, 512, "Markdown"),
			e("folder", "folder", 3, 0, "Folder"),
			e("mid.doc", "file", 4, 40 * 1024, "Word Document"),
			e("k.txt", "file", 5, 40 * 1024 * 1024, "Markdown"),
		];
		expect(labels(groupEntries(rows, "size"))).toEqual([
			"Zero KB",
			"Under 1 KB",
			"1 KB – 1 MB",
			"1 MB – 1 GB",
			"Over 1 GB",
		]);
	});

	it("keeps unknown application metadata in an explicit bucket", () => {
		const rows = [e("plain.txt", "file", 1, 1, "Markdown")];
		expect(labels(groupEntries(rows, "application"))).toEqual(["No Application"]);
	});

	it("groups tags, comments, and dimensions with explicit empty buckets", () => {
		const rows = [
			e("tagged.txt", "file", 1, 1, "Markdown", { tagsLabel: "urgent" }),
			e("plain.txt", "file", 2, 2, "Markdown"),
		];
		expect(labels(groupEntries(rows, "tags"))).toEqual(["No Tags", "urgent"]);
		expect(labels(groupEntries(rows, "comments"))).toEqual(["No Comments"]);
		expect(labels(groupEntries(rows, "dimensions"))).toEqual(["No Dimensions"]);
	});

	it("groups ratings numerically with unrated first", () => {
		const rows = [
			e("best.txt", "file", 1, 1, "Markdown", { ratingValue: 5 }),
			e("meh.txt", "file", 2, 2, "Markdown", { ratingValue: 2 }),
			e("unrated.txt", "file", 3, 3, "Markdown"),
		];
		expect(labels(groupEntries(rows, "rating"))).toEqual([
			"No Rating",
			"2 Stars",
			"5 Stars",
		]);
	});
});

describe("groupRows", () => {
	it("keeps version-stack children inside their head's section", () => {
		const rows: StackRow[] = [
			{
				entry: fe(e("head.pdf", "file", 1, 1, "PDF Document")),
				stackCount: 1,
				stackOpen: true,
				child: false,
				relation: null,
			},
			{
				entry: fe(e("member.xlsx", "file", 2, 2, "Excel Spreadsheet")),
				stackCount: 0,
				stackOpen: false,
				child: true,
				relation: "near",
			},
			{
				entry: fe(e("solo.xlsx", "file", 3, 3, "Excel Spreadsheet")),
				stackCount: 0,
				stackOpen: false,
				child: false,
				relation: null,
			},
		];
		const sections = groupRows(rows, "kind");
		expect(labels(sections)).toEqual(["Excel Spreadsheet", "PDF Document"]);
		expect(sections[1]?.rows.map((row) => row.entry.name)).toEqual([
			"head.pdf",
			"member.xlsx",
		]);
	});

	it("returns a single headerless section when grouping is off", () => {
		const rows: StackRow[] = [
			{
				entry: fe(e("a.txt", "file", 1, 1, "Markdown")),
				stackCount: 0,
				stackOpen: false,
				child: false,
				relation: null,
			},
		];
		expect(groupRows(rows, "none")).toEqual([{ label: null, rows }]);
	});
});

describe("groupedLayout", () => {
	const header = 40;
	const row = 32;

	it("lays out headerless sections as plain uniform rows", () => {
		const layout = groupedLayout([{ label: null, rows: 3 }], {
			columns: 1,
			rowStride: row,
			headerStride: header,
		});
		expect(layout.items).toEqual([
			{ kind: "rows", section: 0, start: 0, count: 1 },
			{ kind: "rows", section: 0, start: 1, count: 1 },
			{ kind: "rows", section: 0, start: 2, count: 1 },
		]);
		expect(layout.offsets).toEqual([0, 32, 64, 96]);
		expect(layout.rowBases).toEqual([0, 1, 2]);
		expect(layout.total).toBe(96);
	});

	it("inserts a header item before each labelled section", () => {
		const layout = groupedLayout(
			[
				{ label: "A", rows: 2 },
				{ label: "B", rows: 1 },
			],
			{ columns: 1, rowStride: row, headerStride: header },
		);
		expect(
			layout.items.map(
				(item) => `${item.kind}:${item.section}:${item.start}:${item.count}`,
			),
		).toEqual([
			"header:0:0:0",
			"rows:0:0:1",
			"rows:0:1:1",
			"header:1:0:0",
			"rows:1:0:1",
		]);
		expect(layout.offsets).toEqual([0, 40, 72, 104, 144, 176]);
		expect(layout.rowBases).toEqual([0, 0, 1, 2, 2]);
		expect(layout.total).toBe(176);
	});

	it("packs grid items into tile rows of the measured column count", () => {
		const layout = groupedLayout([{ label: "A", rows: 5 }], {
			columns: 3,
			rowStride: 124,
			headerStride: header,
		});
		expect(layout.items).toEqual([
			{ kind: "header", section: 0, start: 0, count: 0 },
			{ kind: "rows", section: 0, start: 0, count: 3 },
			{ kind: "rows", section: 0, start: 3, count: 2 },
		]);
		expect(layout.offsets).toEqual([0, 40, 164, 288]);
	});

	it("handles an empty section list", () => {
		const layout = groupedLayout([], {
			columns: 1,
			rowStride: row,
			headerStride: header,
		});
		expect(layout.items).toEqual([]);
		expect(layout.offsets).toEqual([0]);
		expect(layout.total).toBe(0);
	});
});

describe("groupedWindow", () => {
	// Items: headerA@0, row0@40, row1@72, row2@104, headerB@136, row3@168; total 200.
	const layout = groupedLayout(
		[
			{ label: "A", rows: 3 },
			{ label: "B", rows: 1 },
		],
		{ columns: 1, rowStride: 32, headerStride: 40 },
	);

	it("returns the items intersecting the viewport plus overscan", () => {
		expect(
			groupedWindow(layout, { offset: 0, viewport: 96, overscan: 0 }),
		).toEqual({ start: 0, end: 3 });
		expect(
			groupedWindow(layout, { offset: 144, viewport: 40, overscan: 0 }),
		).toEqual({ start: 4, end: 6 });
	});

	it("clamps beyond the content", () => {
		expect(
			groupedWindow(layout, { offset: 1000, viewport: 96, overscan: 0 }),
		).toEqual({ start: 3, end: 6 });
	});

	it("moves the window to include a keyboard target outside it", () => {
		expect(
			groupedWindow(layout, {
				offset: 0,
				viewport: 40,
				overscan: 0,
				includeRow: 3,
			}),
		).toEqual({ start: 5, end: 6 });
	});

	it("ignores an include row that is already in the window", () => {
		expect(
			groupedWindow(layout, {
				offset: 0,
				viewport: 96,
				overscan: 0,
				includeRow: 1,
			}),
		).toEqual({ start: 0, end: 3 });
	});

	it("treats an out-of-range include row as absent", () => {
		expect(
			groupedWindow(layout, {
				offset: 0,
				viewport: 96,
				overscan: 0,
				includeRow: 99,
			}),
		).toEqual({ start: 0, end: 3 });
	});
});

describe("groupedRowTop", () => {
	const sections: readonly GroupSection<unknown>[] = [
		{ label: "A", rows: [{}, {}, {}] },
		{ label: null, rows: [{}, {}] },
		{ label: "B", rows: [{}] },
	];

	it("computes the content-space top of a flattened row index", () => {
		// Section 0: header 40 + rows 0..2 at 40/64/88.
		expect(groupedRowTop(sections, 0)).toBe(40);
		expect(groupedRowTop(sections, 2)).toBe(88);
		// Section 1 has no header: rows continue at 112/136.
		expect(groupedRowTop(sections, 3)).toBe(112);
		expect(groupedRowTop(sections, 4)).toBe(136);
		// Section 2: header after 160, row at 200.
		expect(groupedRowTop(sections, 5)).toBe(200);

	});

	it("clamps an out-of-range index", () => {
		expect(groupedRowTop(sections, 99)).toBe(224);
		expect(groupedRowTop(sections, -1)).toBe(0);
	});
});

describe("groupedLayout grid trailing gap", () => {
	// Tile-row geometry: 124px row + 8px gap; the reference grid template every
	// section's block shares (`.icon-grid`, `gap-8`).
	const tile = { columns: 3, rowStride: 132, rowGap: 8, headerStride: 40 };

	it("drops the trailing gap of a grid block but keeps it between rows", () => {
		const layout = groupedLayout([{ label: "A", rows: 7 }], tile);
		// Header 40; tile rows at 40/172/304; the last row is 124 tall, not 132.
		expect(layout.offsets).toEqual([0, 40, 172, 304, 428]);
		expect(layout.total).toBe(428);
	});

	it("stops the trailing gap from accumulating across many sections", () => {
		const sections = Array.from({ length: 40 }, (_, index) => ({ label: `G${index}`, rows: 5 }));
		const layout = groupedLayout(sections, tile);
		// 40 headers + 80 tile rows (ceil(5/3)=2 each); one dropped gap per block.
		expect(layout.total).toBe(40 * 40 + 80 * 132 - 40 * 8);
		// The bottom window renders the last block, not a blank tail.
		const window = groupedWindow(layout, { offset: layout.total - 100, viewport: 100, overscan: 0 });
		expect(window.end).toBe(layout.items.length);
		expect(layout.offsets[layout.offsets.length - 1]).toBe(layout.total);
	});

	it("keeps the headerless (grouping off) grid on the pre-group baseline", () => {
		const layout = groupedLayout([{ label: null, rows: 4 }], tile);
		// No header: two tile rows, each advancing the full stride (the
		// baseline reference), and no section header block.
		expect(layout.offsets).toEqual([0, 132, 264]);
		expect(layout.total).toBe(264);
	});

	it("leaves the list geometry unchanged without a row gap", () => {
		const layout = groupedLayout(
			[
				{ label: "A", rows: 2 },
				{ label: "B", rows: 1 },
			],
			{ columns: 1, rowStride: 32, headerStride: 40 },
		);
		expect(layout.offsets).toEqual([0, 40, 72, 104, 144, 176]);
		expect(layout.total).toBe(176);
	});
});
