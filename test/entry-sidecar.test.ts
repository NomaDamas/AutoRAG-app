import { describe, expect, it, vi } from "vitest";
import type { FsFinderMetadata } from "../src/shared/fs-contract";
import type { IndexStatus } from "../src/shared/index-contract";
import type { FinderEntry } from "../src/renderer/src/data/entries";
import { createEntrySidecar } from "../src/renderer/src/data/entry-sidecar";
import {
	createdMsOf,
	dimensionsAreaOf,
	dimensionsTextOf,
	kindLabelOf,
	tagsTextOf,
} from "../src/renderer/src/state/entry-values";

const STAMP = Date.parse("2026-09-30T00:00:00.000Z");

function entry(path: string, mtimeMs: number = STAMP): FinderEntry {
	return {
		name: path.split("/").pop() ?? path,
		path,
		kind: "file",
		ext: "md",
		size: 1,
		mtimeMs,
		birthtimeMs: 0,
	};
}

function finder(over: Partial<FsFinderMetadata>): FsFinderMetadata {
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
		...over,
	};
}

function status(path: string, kind: IndexStatus["kind"]): IndexStatus {
	return { path, kind, excluded: kind === "excluded", toggleable: true, detail: "" };
}

describe("entry sidecar", () => {
	it("resolves an entry to itself until enrichment lands, then to one stable merged row", () => {
		const sidecar = createEntrySidecar();
		const row = entry("/d/a.md");
		expect(sidecar.resolve(row)).toBe(row);

		sidecar.applyEnrichment([{ path: "/d/a.md", mtimeMs: STAMP, osKind: "Markdown Document", iconUrl: "thumb://a" }]);
		const resolved = sidecar.resolve(row);
		expect(resolved).toMatchObject({ osKind: "Markdown Document", iconUrl: "thumb://a" });
		expect(kindLabelOf(resolved)).toBe("Markdown Document");
		// The raw row stays bare: enrichment lives beside it, not in it.
		expect(row.iconUrl).toBeUndefined();
		expect(row.osKind).toBeUndefined();
		expect(sidecar.resolve(row)).toBe(resolved);
		// Resolving the resolved row again is the same row, not a copy of it.
		expect(sidecar.resolve(resolved)).toBe(resolved);
	});

	it("never applies enrichment from another file version", () => {
		const sidecar = createEntrySidecar();
		const row = entry("/d/a.md", Date.parse("2026-10-01T00:00:00.000Z"));
		sidecar.applyEnrichment([{ path: "/d/a.md", mtimeMs: STAMP, osKind: "Old", iconUrl: "thumb://old" }]);
		sidecar.applyMetadata([{ path: "/d/a.md", mtimeMs: STAMP, finder: finder({ tags: ["Old"] }) }]);
		expect(sidecar.resolve(row)).toBe(row);
	});

	it("keeps an icon the viewport loaded when a capped background pass returns none", () => {
		const sidecar = createEntrySidecar();
		const row = entry("/d/a.jpg");
		sidecar.applyEnrichment([{ path: "/d/a.jpg", mtimeMs: STAMP, osKind: null, iconUrl: "thumb://viewport" }]);
		sidecar.applyEnrichment([{ path: "/d/a.jpg", mtimeMs: STAMP, osKind: "JPEG image", iconUrl: null }]);
		const resolved = sidecar.resolve(row);
		expect(resolved).toMatchObject({ iconUrl: "thumb://viewport", osKind: "JPEG image" });
		expect(kindLabelOf(resolved)).toBe("JPEG image");
	});

	it("lands icons and Finder metadata in either order without one erasing the other", () => {
		const icon = { path: "/d/a.jpg", mtimeMs: STAMP, osKind: "JPEG image", iconUrl: "thumb://a" };
		const metadata = { path: "/d/a.jpg", mtimeMs: STAMP, finder: finder({ tags: ["Red"], width: 4, height: 3 }) };
		const iconFirst = createEntrySidecar();
		iconFirst.applyEnrichment([icon]);
		iconFirst.applyMetadata([metadata]);
		const metadataFirst = createEntrySidecar();
		metadataFirst.applyMetadata([metadata]);
		metadataFirst.applyEnrichment([icon]);
		for (const sidecar of [iconFirst, metadataFirst]) {
			const resolved = sidecar.resolve(entry("/d/a.jpg"));
			expect(resolved).toMatchObject({ iconUrl: "thumb://a", osKind: "JPEG image" });
			expect(kindLabelOf(resolved)).toBe("JPEG image");
			expect(tagsTextOf(resolved)).toBe("Red");
			expect(dimensionsTextOf(resolved)).toBe("4 × 3");
			expect(dimensionsAreaOf(resolved)).toBe(12);
		}
	});

	it("an older metadata response never replaces a newer file version's", () => {
		const sidecar = createEntrySidecar();
		const newer = Date.parse("2026-10-01T00:00:00.000Z");
		sidecar.applyMetadata([{ path: "/d/a.md", mtimeMs: newer, finder: finder({ tags: ["New"] }) }]);
		sidecar.applyMetadata([{ path: "/d/a.md", mtimeMs: STAMP, finder: finder({ tags: ["Old"] }) }]);
		expect(tagsTextOf(sidecar.resolve(entry("/d/a.md", newer)))).toBe("New");
	});

	it("uses Finder's creation date for a row, falling back to the filesystem birth time", () => {
		const sidecar = createEntrySidecar();
		const spotlight = Date.parse("2026-01-02T03:04:05.000Z");
		const birth = Date.parse("2025-05-06T07:08:09.000Z");
		sidecar.applyMetadata([{ path: "/d/a.md", mtimeMs: STAMP, finder: finder({ createdAt: "2026-01-02T03:04:05.000Z" }) }]);
		const withSpotlight = { ...sidecar.resolve(entry("/d/a.md")), birthtimeMs: birth };
		expect(createdMsOf(withSpotlight)).toBe(spotlight);
		// No Finder creation date: the row's own birth time is the fallback.
		expect(createdMsOf({ ...entry("/d/a.md"), birthtimeMs: birth })).toBe(birth);
		expect(createdMsOf(entry("/d/a.md"))).toBeUndefined();
	});

	it("notifies only the rows whose data changed, and nothing for a repeat", () => {
		const sidecar = createEntrySidecar();
		const a = vi.fn();
		const b = vi.fn();
		const all = vi.fn();
		sidecar.subscribe("/d/a.md", a);
		sidecar.subscribe("/d/b.md", b);
		sidecar.subscribeAll(all);
		const patch = { path: "/d/a.md", mtimeMs: STAMP, osKind: "Markdown Document", iconUrl: "thumb://a" };
		sidecar.applyEnrichment([patch]);
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).not.toHaveBeenCalled();
		expect(all).toHaveBeenCalledTimes(1);

		const version = sidecar.version();
		sidecar.applyEnrichment([patch]);
		const tags = { path: "/d/a.md", mtimeMs: STAMP, finder: finder({ tags: ["Red"] }) };
		sidecar.applyMetadata([tags]);
		sidecar.applyMetadata([tags]);
		expect(a).toHaveBeenCalledTimes(2);
		expect(all).toHaveBeenCalledTimes(2);
		expect(sidecar.version()).toBe(version + 1);
	});

	it("one batch notifies the pipeline once however many rows it touches", () => {
		const sidecar = createEntrySidecar();
		const all = vi.fn();
		sidecar.subscribeAll(all);
		sidecar.applyEnrichment(
			Array.from({ length: 50 }, (_, index) => ({ path: `/d/${index}.md`, mtimeMs: STAMP, osKind: "Doc", iconUrl: null })),
		);
		expect(all).toHaveBeenCalledTimes(1);
	});

	it("tracks index status per path; an unchanged status keeps its object and stays silent", () => {
		const sidecar = createEntrySidecar();
		const listener = vi.fn();
		sidecar.subscribe("/d/a.md", listener);
		expect(sidecar.indexStatus("/d/a.md")).toBeNull();
		sidecar.setIndexStatuses([status("/d/a.md", "included")]);
		const first = sidecar.indexStatus("/d/a.md");
		expect(first?.kind).toBe("included");
		expect(listener).toHaveBeenCalledTimes(1);
		const revision = sidecar.revision("/d/a.md");

		sidecar.setIndexStatuses([status("/d/a.md", "included")]);
		expect(sidecar.indexStatus("/d/a.md")).toBe(first);
		expect(listener).toHaveBeenCalledTimes(1);

		sidecar.setIndexStatuses([status("/d/a.md", "excluded")]);
		expect(sidecar.indexStatus("/d/a.md")?.excluded).toBe(true);
		expect(sidecar.revision("/d/a.md")).toBeGreaterThan(revision);
		// Index state is not row data: the resolved row keeps its identity.
		const row = entry("/d/a.md");
		expect(sidecar.resolve(row)).toBe(row);
	});

	it("drops the oldest records past its capacity", () => {
		const sidecar = createEntrySidecar({ capacity: 2 });
		for (const name of ["a", "b", "c"]) {
			sidecar.applyEnrichment([{ path: `/d/${name}.md`, mtimeMs: STAMP, osKind: name, iconUrl: null }]);
		}
		expect(sidecar.hasKind(entry("/d/a.md"))).toBe(false);
		expect(sidecar.hasKind(entry("/d/b.md"))).toBe(true);
		expect(kindLabelOf(sidecar.resolve(entry("/d/c.md")))).toBe("c");
	});
});
