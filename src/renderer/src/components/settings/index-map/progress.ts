import type { IndexMap, IndexMapCounts, IndexMapNode } from "../../../../../shared/index-map-contract";
import { nodeKey } from "./radial";

/**
 * Where a running index is working, read off the map itself.
 *
 * The run's progress snapshot counts files per stage but does not say which ones, so the places come from what the
 * map already knows: two reads of it, one after the other, and the nodes whose files moved forward in between. Nothing
 * here is estimated or animated by time: a place is named only when a file in it really changed state.
 */
export interface MapProgress {
	/** The innermost nodes (by `nodeKey`) that moved: the files, or the folder when its files are folded away. */
	readonly here: ReadonlySet<string>;
	/** Every node with a moved one at or below it: the places above `here`, up to the search root. */
	readonly inside: ReadonlySet<string>;
}

export const NO_PROGRESS: MapProgress = { here: new Set(), inside: new Set() };

/**
 * A file moves forward in two steps: read into the mirror (`stale` until MinSync stages it), then staged (`indexed`). A
 * node moved when either count rose. Leaving something out lowers `unindexed` and raises `excluded`, which is neither.
 */
function moved(before: IndexMapCounts, after: IndexMapCounts): boolean {
	return after.indexed > before.indexed || after.stale > before.stale;
}

const sameRoots = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((root, index) => root === b[index]);

/**
 * What moved between two reads of the same scope. A different set of search folders is a different map, not the
 * index moving, and a node with no counterpart before (a file that just appeared) has nothing to compare with: its
 * folder, which was there, carries the change instead.
 */
export function mapProgress(previous: IndexMap, next: IndexMap): MapProgress {
	if (!sameRoots(previous.roots, next.roots)) return NO_PROGRESS;
	const before = new Map<string, IndexMapCounts>();
	for (const node of previous.nodes) before.set(nodeKey(node), node.counts);

	const movedNodes: IndexMapNode[] = [];
	for (const node of next.nodes) {
		const was = before.get(nodeKey(node));
		if (was !== undefined && moved(was, node.counts)) movedNodes.push(node);
	}
	if (movedNodes.length === 0) return NO_PROGRESS;

	// A moved node whose own subtree holds another moved node is not where it happened, only where it is.
	const parentOf = (node: IndexMapNode): IndexMapNode | undefined => (node.parent === null ? undefined : next.nodes[node.parent]);
	const above = new Set<number>();
	for (const node of movedNodes) {
		for (let parent = parentOf(node); parent !== undefined; parent = parentOf(parent)) above.add(parent.id);
	}
	const here = new Set<string>();
	const inside = new Set<string>();
	for (const node of movedNodes) {
		if (above.has(node.id)) continue;
		here.add(nodeKey(node));
		inside.add(nodeKey(node));
		for (let parent = parentOf(node); parent !== undefined; parent = parentOf(parent)) inside.add(nodeKey(parent));
	}
	return { here, inside };
}
