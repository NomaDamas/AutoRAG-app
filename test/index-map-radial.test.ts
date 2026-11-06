import { describe, expect, it } from "vitest";
import { buildIndexMap, type ScanDir, type ScanFile } from "../src/main/index-map";
import { emptyIndexMapCounts, type IndexMapState } from "../src/shared/index-map-contract";
import { indexMapTargets, layoutRadial, radialState } from "../src/renderer/src/components/settings/index-map/radial";

const file = (path: string, state: IndexMapState): ScanFile => ({ path, name: path.split("/").at(-1)!, state });
const folder = (path: string, files: ScanFile[], dirs: ScanDir[] = []): ScanDir => ({ path, name: path.split("/").at(-1)!, files, dirs, sealed: null });

describe("radial indexing map", () => {
	it("keeps descendants outside and within the angular span of their own parent", () => {
		const map = buildIndexMap({ roots: [folder("/r", [], [folder("/r/a", [file("/r/a/1.txt", "indexed"), file("/r/a/2.txt", "stale")]), folder("/r/b", [file("/r/b/3.txt", "unindexed")])])], truncated: false });
		const sectors = layoutRadial(map, null);
		const byId = new Map(sectors.map((sector) => [sector.node.id, sector]));
		for (const sector of sectors) {
			if (sector.node.parent === null) continue;
			const parent = byId.get(sector.node.parent)!;
			expect(sector.inner).toBeGreaterThan(parent.outer);
			expect(sector.start).toBeGreaterThanOrEqual(parent.start - 1e-10);
			expect(sector.end).toBeLessThanOrEqual(parent.end + 1e-10);
		}
		const a = sectors.find((sector) => sector.node.path === "/r/a")!;
		const b = sectors.find((sector) => sector.node.path === "/r/b")!;
		expect(a.end - a.start).toBeCloseTo(2 * (b.end - b.start));
	});

	it("drills only the selected subtree and preserves its counts, not its siblings'", () => {
		const map = buildIndexMap({ roots: [folder("/r", [], [folder("/r/a", [file("/r/a/1.txt", "indexed"), file("/r/a/2.txt", "unindexed")]), folder("/r/b", [file("/r/b/3.txt", "indexed")])])], truncated: false });
		const a = map.nodes.find((node) => node.path === "/r/a")!;
		const sectors = layoutRadial(map, a.id);
		expect(sectors.map((sector) => sector.node.path)).toEqual(["/r/a", "/r/a/1.txt", "/r/a/2.txt"]);
		expect(sectors[0]!.end - sectors[0]!.start).toBeCloseTo(Math.PI * 2);
		expect(indexMapTargets(a.counts)).toBe(2);
		expect(a.counts.indexed).toBe(1);
	});

	it("keeps failed and changed supported files unfinished, ignores exclusions in completion", () => {
		const map = buildIndexMap({ roots: [folder("/r", [], [folder("/r/full", [file("/r/full/1.txt", "indexed"), file("/r/full/private.txt", "excluded")]), folder("/r/mixed", [file("/r/mixed/1.txt", "indexed"), file("/r/mixed/2.txt", "unindexable")]), folder("/r/new", [file("/r/new/1.txt", "stale")]), { ...folder("/r/off", []), sealed: emptyIndexMapCounts() }])], truncated: false });
		const state = (path: string) => radialState(map.nodes.find((node) => node.path === path)!);
		expect(state("/r/full")).toBe("indexed");
		expect(state("/r/mixed")).toBe("partial");
		expect(state("/r/new")).toBe("unindexed");
		expect(state("/r/off")).toBe("excluded");
		expect(state("/r/mixed/2.txt")).toBe("unindexed");
		expect(indexMapTargets(map.totals)).toBe(4);
	});

	it("draws no fake excluded territory for an empty supported scope", () => {
		const map = buildIndexMap({ roots: [folder("/r", [])], truncated: false });
		expect(layoutRadial(map, null)).toEqual([]);
		expect(indexMapTargets(map.totals)).toBe(0);
	});

	it("reveals deep descendants by drilling without mixing other roots into the view", () => {
		const chain = (depth: number, path: string): ScanDir => folder(path, depth === 0 ? [file(`${path}/leaf.txt`, "indexed")] : [], depth === 0 ? [] : [chain(depth - 1, `${path}/next`)]);
		const map = buildIndexMap({ roots: [chain(12, "/a"), folder("/b", [file("/b/pending.txt", "unindexed")])], truncated: false });
		const overview = layoutRadial(map, null);
		expect(overview.some((sector) => sector.node.name === "leaf.txt")).toBe(false);
		const deep = map.nodes.find((node) => node.path === "/a/next/next/next/next/next")!;
		const focused = layoutRadial(map, deep.id);
		expect(focused.some((sector) => sector.node.name === "leaf.txt")).toBe(true);
		expect(focused.some((sector) => sector.node.path.startsWith("/b"))).toBe(false);
		expect(focused.every((sector) => sector.outer <= 300)).toBe(true);
	});
});
