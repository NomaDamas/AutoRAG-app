import { describe, expect, it, vi } from "vitest";
import type { FsFinderMetadata } from "../src/shared/fs-contract";
import type { IndexStatus } from "../src/shared/index-contract";
import type { FinderEntry } from "../src/renderer/src/data/entries";
import { createEntrySidecar } from "../src/renderer/src/data/entry-sidecar";

const STAMP = "2026-09-30T00:00:00.000Z";

function entry(path: string, modifiedAt: string = STAMP): FinderEntry {
	return {
		name: path.split("/").pop() ?? path,
		path,
		kind: "file",
		fileKind: "md",
		iconUrl: null,
		modifiedAt,
		dateLabel: "Sep 30, 00:00",
		sizeLabel: "1 B",
		kindLabel: "Markdown",
		location: path.slice(0, path.lastIndexOf("/")),
		modifiedValue: 0,
		sizeValue: 1,
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

		sidecar.applyEnrichment([{ path: "/d/a.md", modifiedAt: STAMP, osKind: "Markdown Document", iconUrl: "thumb://a" }]);
		const resolved = sidecar.resolve(row);
		expect(resolved).toMatchObject({ kindLabel: "Markdown Document", iconUrl: "thumb://a" });
		expect(row.iconUrl).toBeNull();
		expect(sidecar.resolve(row)).toBe(resolved);
		// Resolving the resolved row again is the same row, not a copy of it.
		expect(sidecar.resolve(resolved)).toBe(resolved);
	});

	it("never applies enrichment from another file version", () => {
		const sidecar = createEntrySidecar();
		const row = entry("/d/a.md", "2026-10-01T00:00:00.000Z");
		sidecar.applyEnrichment([{ path: "/d/a.md", modifiedAt: STAMP, osKind: "Old", iconUrl: "thumb://old" }]);
		sidecar.applyMetadata([{ path: "/d/a.md", modifiedAt: STAMP, finder: finder({ tags: ["Old"] }) }]);
		expect(sidecar.resolve(row)).toBe(row);
	});

	it("keeps an icon the viewport loaded when a capped background pass returns none", () => {
		const sidecar = createEntrySidecar();
		const row = entry("/d/a.jpg");
		sidecar.applyEnrichment([{ path: "/d/a.jpg", modifiedAt: STAMP, osKind: null, iconUrl: "thumb://viewport" }]);
		sidecar.applyEnrichment([{ path: "/d/a.jpg", modifiedAt: STAMP, osKind: "JPEG image", iconUrl: null }]);
		expect(sidecar.resolve(row)).toMatchObject({ iconUrl: "thumb://viewport", kindLabel: "JPEG image" });
	});

	it("lands icons and Finder metadata in either order without one erasing the other", () => {
		const icon = { path: "/d/a.jpg", modifiedAt: STAMP, osKind: "JPEG image", iconUrl: "thumb://a" };
		const metadata = { path: "/d/a.jpg", modifiedAt: STAMP, finder: finder({ tags: ["Red"], width: 4, height: 3 }) };
		const iconFirst = createEntrySidecar();
		iconFirst.applyEnrichment([icon]);
		iconFirst.applyMetadata([metadata]);
		const metadataFirst = createEntrySidecar();
		metadataFirst.applyMetadata([metadata]);
		metadataFirst.applyEnrichment([icon]);
		for (const sidecar of [iconFirst, metadataFirst]) {
			expect(sidecar.resolve(entry("/d/a.jpg"))).toMatchObject({
				iconUrl: "thumb://a",
				kindLabel: "JPEG image",
				tagsLabel: "Red",
				dimensionsLabel: "4 × 3",
				dimensionsValue: 12,
			});
		}
	});

	it("an older metadata response never replaces a newer file version's", () => {
		const sidecar = createEntrySidecar();
		const newer = "2026-10-01T00:00:00.000Z";
		sidecar.applyMetadata([{ path: "/d/a.md", modifiedAt: newer, finder: finder({ tags: ["New"] }) }]);
		sidecar.applyMetadata([{ path: "/d/a.md", modifiedAt: STAMP, finder: finder({ tags: ["Old"] }) }]);
		expect(sidecar.resolve(entry("/d/a.md", newer)).tagsLabel).toBe("New");
	});

	it("notifies only the rows whose data changed, and nothing for a repeat", () => {
		const sidecar = createEntrySidecar();
		const a = vi.fn();
		const b = vi.fn();
		const all = vi.fn();
		sidecar.subscribe("/d/a.md", a);
		sidecar.subscribe("/d/b.md", b);
		sidecar.subscribeAll(all);
		const patch = { path: "/d/a.md", modifiedAt: STAMP, osKind: "Markdown Document", iconUrl: "thumb://a" };
		sidecar.applyEnrichment([patch]);
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).not.toHaveBeenCalled();
		expect(all).toHaveBeenCalledTimes(1);

		const version = sidecar.version();
		sidecar.applyEnrichment([patch]);
		const tags = { path: "/d/a.md", modifiedAt: STAMP, finder: finder({ tags: ["Red"] }) };
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
			Array.from({ length: 50 }, (_, index) => ({ path: `/d/${index}.md`, modifiedAt: STAMP, osKind: "Doc", iconUrl: null })),
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
			sidecar.applyEnrichment([{ path: `/d/${name}.md`, modifiedAt: STAMP, osKind: name, iconUrl: null }]);
		}
		expect(sidecar.hasKind(entry("/d/a.md"))).toBe(false);
		expect(sidecar.hasKind(entry("/d/b.md"))).toBe(true);
		expect(sidecar.resolve(entry("/d/c.md")).kindLabel).toBe("c");
	});
});
