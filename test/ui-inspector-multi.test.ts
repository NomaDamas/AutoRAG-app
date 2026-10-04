import { describe, expect, it } from "vitest";
import type { FinderEntry } from "../src/renderer/src/data/entries";
import { stackCards, summarizeSelection } from "../src/renderer/src/state/inspector-multi";

function entry(overrides: Partial<FinderEntry> = {}): FinderEntry {
	return {
		name: "a.pdf",
		path: "/Users/me/Documents/a.pdf",
		kind: "file",
		fileKind: "pdf",
		iconUrl: null,
		dateLabel: "Sep 30, 12:00",
		sizeLabel: "1.4 MB",
		kindLabel: "PDF document",
		location: "/Users/me/Documents",
		modifiedValue: new Date(2026, 8, 30, 12, 0, 0).getTime(),
		sizeValue: 1_468_006,
		createdValue: new Date(2026, 8, 30, 9, 0, 0).getTime(),
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
			entry({ sizeValue: 1_000_000 }),
			entry({ path: "/b.pdf", sizeValue: 2_000_000 }),
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
			entry({ path: "/c.jpg", fileKind: "png", kindLabel: "JPEG image" }),
		]);
		expect(summary.kindSummary).toBe("PDF document 2개, JPEG image 1개");
	});

	it("caps a long kind list with 외 N종", () => {
		const summary = summarizeSelection([
			entry(),
			entry({ path: "/b.jpg", fileKind: "png", kindLabel: "JPEG image" }),
			entry({ path: "/c.zip", fileKind: "zip", kindLabel: "ZIP archive" }),
			entry({ path: "/d.md", fileKind: "md", kindLabel: "Markdown" }),
		]);
		expect(summary.kindSummary).toBe("JPEG image 1개, Markdown 1개, 외 2종");
	});

	it("excludes folders from the byte total and drops the size when nothing is measurable", () => {
		const folder = entry({ kind: "folder", fileKind: "folder", kindLabel: "Folder", sizeValue: 0 });
		const mixed = summarizeSelection([folder, entry({ path: "/b.pdf", sizeValue: 500_000 })]);
		expect(mixed.totalBytes).toBe(500_000);
		expect(mixed.sizeLabel).toBe("488 KB");
		const foldersOnly = summarizeSelection([folder, { ...folder, path: "/other" }]);
		expect(foldersOnly.sizeLabel).toBeNull();
	});

	it("ranges dates across the selection and collapses a shared day", () => {
		const summary = summarizeSelection([
			entry({
				modifiedValue: new Date(2026, 8, 30, 12).getTime(),
				createdValue: new Date(2026, 8, 28, 9).getTime(),
			}),
			entry({
				path: "/b.pdf",
				modifiedValue: new Date(2026, 9, 3, 21, 16).getTime(),
				createdValue: new Date(2026, 9, 3, 21, 16).getTime(),
			}),
		]);
		expect(summary.modifiedRange).toBe("2026-09-30 – 2026-10-03");
		expect(summary.createdRange).toBe("2026-09-28 – 2026-10-03");

		const sameDay = summarizeSelection([
			entry({ modifiedValue: new Date(2026, 9, 3, 9).getTime() }),
			entry({ path: "/b.pdf", modifiedValue: new Date(2026, 9, 3, 21).getTime() }),
		]);
		expect(sameDay.modifiedRange).toBe("2026-10-03");
	});

	it("ignores unparseable zero stamps and reports null when no stamp survives", () => {
		const summary = summarizeSelection([
			entry({ modifiedValue: 0, createdValue: undefined }),
			entry({ path: "/b.pdf", modifiedValue: 0, createdValue: undefined }),
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

	it("caps the fan at three cards", () => {
		const many = [1, 2, 3, 4, 5].map((n) => entry({ path: `/f${n}.pdf`, name: `f${n}.pdf` }));
		expect(stackCards(many, null)).toHaveLength(3);
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
