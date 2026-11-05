import { describe, expect, it } from "vitest";
import { cellAt, dot, layoutGlobe, paintGlobe, stateAt, type GlobeSite } from "../src/renderer/src/components/settings/index-map/globe";
import { emptyIndexMapCounts, type IndexMap, type IndexMapNode, type IndexMapState } from "../src/shared/index-map-contract";

/** A tree from `[parent, kind, state]` rows; folder counts are summed from their files. */
function tree(rows: readonly (readonly [number | null, IndexMapNode["kind"], IndexMapState])[]): IndexMap {
	const counts = rows.map(() => emptyIndexMapCounts());
	const weights = rows.map(() => 0);
	const depth = rows.map(() => 0);
	rows.forEach(([parent], id) => {
		if (parent !== null) depth[id] = (depth[parent] ?? 0) + 1;
	});
	for (let id = rows.length - 1; id >= 0; id -= 1) {
		const [parent, kind, state] = rows[id] ?? [null, "file", "indexed"];
		if (kind === "file") {
			counts[id]![state] += 1;
			weights[id] = 1;
		}
		if (parent !== null) {
			weights[parent]! += weights[id] ?? 0;
			for (const key of Object.keys(counts[id]!) as IndexMapState[]) counts[parent]![key] += counts[id]![key];
		}
	}
	const nodes = rows.map(([parent, kind, state], id) => ({ id, parent, kind, name: `n${id}`, path: `/r/n${id}`, state, weight: weights[id] ?? 0, counts: counts[id]!, depth: depth[id] ?? 0 }));
	const totals = emptyIndexMapCounts();
	for (const node of nodes) if (node.kind === "file") totals[node.state] += 1;
	return { roots: ["/r"], nodes, totals, truncated: false, folded: false };
}

const siteOf = (sites: readonly GlobeSite[], id: number): GlobeSite => {
	const site = sites.find((candidate) => candidate.node.id === id);
	if (site === undefined) throw new Error(`no site ${id}`);
	return site;
};
const angle = (a: GlobeSite, b: GlobeSite): number => Math.acos(Math.min(1, dot(a.at, b.at)));

describe("layoutGlobe", () => {
	it("keeps every child inside its parent's region and gives heavier folders more ground", () => {
		const map = tree([
			[null, "root", "indexed"],
			[0, "folder", "indexed"],
			[1, "file", "indexed"],
			[1, "file", "indexed"],
			[1, "file", "indexed"],
			[1, "file", "indexed"],
			[0, "folder", "unindexed"],
			[6, "file", "unindexed"],
		]);
		const sites = layoutGlobe(map);

		for (const site of sites) expect(Math.hypot(...site.at)).toBeCloseTo(1, 6);
		for (const site of sites) {
			if (site.node.parent === null) continue;
			const parent = siteOf(sites, site.node.parent);
			expect(angle(site, parent) + site.cap).toBeLessThanOrEqual(parent.cap + 1e-9);
		}
		expect(siteOf(sites, 1).cap).toBeGreaterThan(siteOf(sites, 6).cap);
		// Only nodes without drawn children claim ground.
		expect(sites.filter((site) => site.reach > 0).map((site) => site.node.id)).toEqual([2, 3, 4, 5, 7]);
	});

	it("lays out the same planet on every open", () => {
		const map = tree([
			[null, "root", "indexed"],
			[0, "file", "indexed"],
			[0, "file", "stale"],
		]);
		expect(layoutGlobe(map)).toEqual(layoutGlobe(map));
	});
});

describe("paintGlobe", () => {
	const map = tree([
		[null, "root", "indexed"],
		[0, "folder", "indexed"],
		...Array.from({ length: 12 }, () => [1, "file", "indexed"] as const),
		[0, "folder", "unindexed"],
		...Array.from({ length: 6 }, () => [14, "file", "unindexed"] as const),
		[0, "folder", "excluded"],
		...Array.from({ length: 6 }, () => [21, "file", "excluded"] as const),
	]);
	const sites = layoutGlobe(map);
	const texture = paintGlobe(sites);
	const at = (id: number, progress = 1): IndexMapState | null => stateAt(texture, cellAt(texture, siteOf(sites, id).at), progress);

	it("raises indexed and not-yet-indexed ground as land and sinks the left-out region into the sea", () => {
		expect(at(1)).toBe("indexed");
		expect(at(14)).toBe("unindexed");
		expect(at(21)).toBe("excluded");
		// Opposite the scope there is only deep ocean.
		const [x, y, z] = siteOf(sites, 0).at;
		expect(stateAt(texture, cellAt(texture, [-x, -y, -z]), 1)).toBeNull();
	});

	it("draws ground that needs indexing as red before the count reaches it, then blue", () => {
		const fileCell = cellAt(texture, siteOf(sites, 2).at);
		const turn = texture.flipAt[fileCell] ?? 2;

		expect(turn).toBeGreaterThanOrEqual(0);
		expect(turn).toBeLessThan(1);
		expect(stateAt(texture, fileCell, 0)).toBe("unindexed");
		expect(stateAt(texture, fileCell, turn)).toBe("indexed");
		// Ground that is red for real stays red through the whole count.
		expect(at(14, 0)).toBe("unindexed");
		expect(at(14, 1)).toBe("unindexed");
	});

	it("marks a coastline or border where the owner changes", () => {
		const row = Math.floor(texture.height / 2);
		let edges = 0;
		for (let x = 0; x < texture.width; x += 1) {
			const cell = row * texture.width + x;
			const east = row * texture.width + ((x + 1) % texture.width);
			if (texture.owner[cell] !== texture.owner[east]) expect(texture.edge[cell]).toBe(1);
			edges += texture.edge[cell] ?? 0;
		}
		expect(edges).toBeLessThan(texture.width / 4);
	});
});
