import { describe, expect, it } from "vitest";
import { buildIndexMap, type ScanDir, type ScanFile } from "../src/main/index-map";
import { emptyIndexMapCounts, type IndexMapNode, type IndexMapState } from "../src/shared/index-map-contract";
import { nodeKey } from "../src/renderer/src/components/settings/index-map/radial";

const file = (path: string, state: IndexMapState): ScanFile => ({ path, name: path.split("/").at(-1)!, state });
const folder = (path: string, files: ScanFile[], dirs: ScanDir[] = []): ScanDir => ({ path, name: path.split("/").at(-1)!, files, dirs, sealed: null });

/** Every sibling group must have distinct keys: React drops or duplicates children that share one. */
function duplicateSiblingKeys(nodes: readonly IndexMapNode[]): string[] {
	const seen = new Map<string, number>();
	for (const node of nodes) {
		const group = `${node.parent}|${nodeKey(node)}`;
		seen.set(group, (seen.get(group) ?? 0) + 1);
	}
	return [...seen].filter(([, count]) => count > 1).map(([group]) => group);
}

describe("nodeKey", () => {
	it("gives every node of a folded map its own key, parcels included", () => {
		// 300 files in four states under one folder, folded into one parcel per state at this budget.
		const files = Array.from({ length: 300 }, (_, index) => file(`/r/big/f${index}.md`, (["indexed", "stale", "unindexed", "unindexable"] as const)[index % 4]!));
		const map = buildIndexMap({ roots: [folder("/r", [], [folder("/r/big", files)])], truncated: false }, 40);

		const parcels = map.nodes.filter((node) => node.kind === "parcel");
		expect(parcels.length).toBeGreaterThanOrEqual(4);
		// All the parcels share their folder's path: only their state tells them apart.
		expect(new Set(parcels.map((node) => node.path)).size).toBe(1);
		expect(duplicateSiblingKeys(map.nodes)).toEqual([]);
		expect(new Set(map.nodes.map(nodeKey)).size).toBe(map.nodes.length);
	});

	it("keeps a file's key when its state changes, so the item under the pointer stays the same one", () => {
		const before = buildIndexMap({ roots: [folder("/r", [file("/r/a.md", "unindexed")])], truncated: false }).nodes.find((node) => node.kind === "file")!;
		const after = buildIndexMap({ roots: [folder("/r", [file("/r/a.md", "indexed")])], truncated: false }).nodes.find((node) => node.kind === "file")!;
		expect(before.state).not.toBe(after.state);
		expect(nodeKey(before)).toBe(nodeKey(after));
	});

	it("keeps a folder's key when its completion changes", () => {
		const make = (state: IndexMapState): IndexMapNode =>
			buildIndexMap({ roots: [folder("/r", [], [folder("/r/d", [file("/r/d/a.md", state)])])], truncated: false }).nodes.find((node) => node.path === "/r/d")!;
		expect(nodeKey(make("unindexed"))).toBe(nodeKey(make("indexed")));
	});

	it("does not confuse a folder with a file or parcel of the same path", () => {
		const base = { id: 0, parent: null, name: "x", path: "/r/x", state: "indexed" as const, weight: 1, counts: emptyIndexMapCounts(), depth: 1 };
		const keys = (["folder", "file", "parcel", "root"] as const).map((kind) => nodeKey({ ...base, kind }));
		expect(new Set(keys).size).toBe(4);
	});
});
