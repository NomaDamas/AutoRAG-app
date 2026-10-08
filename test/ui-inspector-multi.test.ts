import { describe, expect, it } from "vitest";
import type { FinderEntry } from "../src/renderer/src/data/entries";
import type { FsFinderMetadata } from "../src/shared/fs-contract";
import { stackCards, summarizeSelection } from "../src/renderer/src/state/inspector-multi";

function finder(overrides: Partial<FsFinderMetadata> = {}): FsFinderMetadata {
	return {
		createdAt: null,
		addedAt: null,
		lastOpenedAt: null,
		tags: [],
		comments: null,
		width: null,
		height: null,
		rating: null,
		application: null,
		...overrides,
	};
}

function entry(overrides: Partial<FinderEntry> = {}): FinderEntry {
	return {
		name: "a.pdf",
		path: "/Users/me/Documents/a.pdf",
		kind: "file",
		ext: "pdf",
		size: 1_468_006,
		mtimeMs: new Date(2026, 8, 30, 12, 0, 0).getTime(),
		birthtimeMs: 0,
		osKind: "PDF document",
		...overrides,
	};
}

describe("summarizeSelection", () => {
	it("titles the panel with the item count", () => {
		const summary = summarizeSelection([entry(), entry({ path: "/b.pdf", name: "b.pdf" })]);
		expect(summary.count).toBe(2);
		expect(summary.title).toBe("2개 항목");
	});

	it("sums file sizes into one total", () => {
		const summary = summarizeSelection([
			entry({ size: 1_000_000 }),
			entry({ path: "/b.pdf", size: 2_000_000 }),
		]);
		expect(summary.totalBytes).toBe(3_000_000);
		expect(summary.sizeLabel).toBe("2.9 MB");
	});

	it("collapses one shared kind into '<kind> N개'", () => {
		const summary = summarizeSelection([entry(), entry({ path: "/b.pdf" })]);
		expect(summary.kindSummary).toBe("PDF document 2개");
	});

	it("joins mixed kinds by descending count", () => {
		const summary = summarizeSelection([
			entry(),
			entry({ path: "/b.pdf" }),
			entry({ path: "/c.jpg", ext: "jpg", osKind: "JPEG image" }),
		]);
		expect(summary.kindSummary).toBe("PDF document 2개, JPEG image 1개");
	});

	it("caps a long kind list with 외 N종", () => {
		const summary = summarizeSelection([
			entry(),
			entry({ path: "/b.jpg", ext: "jpg", osKind: "JPEG image" }),
			entry({ path: "/c.zip", ext: "zip", osKind: "ZIP archive" }),
			entry({ path: "/d.md", ext: "md", osKind: "Markdown" }),
		]);
		expect(summary.kindSummary).toBe("JPEG image 1개, Markdown 1개, 외 2종");
	});

	it("excludes folders from the byte total and drops the size when nothing is measurable", () => {
		const folder = entry({ kind: "folder", ext: "", osKind: "Folder", size: null });
		const mixed = summarizeSelection([folder, entry({ path: "/b.pdf", size: 500_000 })]);
		expect(mixed.totalBytes).toBe(500_000);
		expect(mixed.sizeLabel).toBe("488 KB");
		const foldersOnly = summarizeSelection([folder, { ...folder, path: "/other" }]);
		expect(foldersOnly.sizeLabel).toBeNull();
	});

	it("ranges dates across the selection and collapses a shared day", () => {
		const summary = summarizeSelection([
			entry({
				mtimeMs: new Date(2026, 8, 30, 12).getTime(),
				finder: finder({ createdAt: new Date(2026, 8, 28, 9).toISOString() }),
			}),
			entry({
				path: "/b.pdf",
				mtimeMs: new Date(2026, 9, 3, 21, 16).getTime(),
				finder: finder({ createdAt: new Date(2026, 9, 3, 21, 16).toISOString() }),
			}),
		]);
		expect(summary.modifiedRange).toBe("2026-09-30 – 2026-10-03");
		expect(summary.createdRange).toBe("2026-09-28 – 2026-10-03");

		const sameDay = summarizeSelection([
			entry({ mtimeMs: new Date(2026, 9, 3, 9).getTime() }),
			entry({ path: "/b.pdf", mtimeMs: new Date(2026, 9, 3, 21).getTime() }),
		]);
		expect(sameDay.modifiedRange).toBe("2026-10-03");
	});

	it("ignores unparseable zero stamps and reports null when no stamp survives", () => {
		const summary = summarizeSelection([
			entry({ mtimeMs: 0 }),
			entry({ path: "/b.pdf", mtimeMs: 0 }),
		]);
		expect(summary.modifiedRange).toBeNull();
		expect(summary.createdRange).toBeNull();
	});
});

describe("stackCards", () => {
	it("puts the focused entry in front, then follows visual order", () => {
		const a = entry();
		const b = entry({ path: "/b.pdf", name: "b.pdf" });
		const c = entry({ path: "/c.pdf", name: "c.pdf" });
		const cards = stackCards([a, b, c], "/c.pdf");
		expect(cards.map((card) => card.path)).toEqual(["/c.pdf", "/Users/me/Documents/a.pdf", "/b.pdf"]);
	});

	it("caps the fan at five cards", () => {
		const many = [1, 2, 3, 4, 5, 6, 7].map((n) => entry({ path: `/f${n}.pdf`, name: `f${n}.pdf` }));
		const cards = stackCards(many, null);
		expect(cards).toHaveLength(5);
		expect(cards[0]?.path).toBe("/f1.pdf");
	});

	it("starts from the first entry when the focus is absent from the selection", () => {
		const a = entry();
		const b = entry({ path: "/b.pdf" });
		expect(stackCards([a, b], "/gone.pdf")[0]?.path).toBe(a.path);
		expect(stackCards([a, b], null)[0]?.path).toBe(a.path);
	});

	it("returns no cards for an empty selection", () => {
		expect(stackCards([], null)).toEqual([]);
	});
});
