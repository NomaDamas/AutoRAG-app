import type { IndexMap, IndexMapCounts, IndexMapNode } from "../../../../../shared/index-map-contract";

export type RadialState = "indexed" | "partial" | "unindexed" | "excluded";

/** Excluded files do not contribute to completion, even before the next refresh removes them. */
export function indexMapTargets(counts: IndexMapCounts): number {
	return counts.indexed + counts.stale + counts.unindexed + counts.unindexable;
}

export function radialState(node: IndexMapNode): RadialState {
	if (node.state === "excluded") return "excluded";
	if (node.kind === "file" || node.kind === "parcel") return node.state === "indexed" ? "indexed" : "unindexed";
	const targets = indexMapTargets(node.counts);
	if (targets === 0) return "excluded";
	if (node.counts.indexed === targets) return "indexed";
	return node.counts.indexed > 0 ? "partial" : "unindexed";
}

export interface RadialSector {
	readonly node: IndexMapNode;
	readonly start: number;
	readonly end: number;
	readonly inner: number;
	readonly outer: number;
	readonly path: string;
}

const TAU = Math.PI * 2;
export const RADIAL_CENTER = 320;
export const RADIAL_HOLE = 87;
const OUTER_RADIUS = 300;

function point(radius: number, angle: number): string {
	return `${RADIAL_CENTER + Math.sin(angle) * radius},${RADIAL_CENTER - Math.cos(angle) * radius}`;
}

/** A full annulus is split into two arcs: one SVG arc cannot describe a complete circle. */
export function sectorPath(start: number, end: number, inner: number, outer: number): string {
	const middle = (start + end) / 2;
	return `M${point(outer, start)} A${outer},${outer} 0 0 1 ${point(outer, middle)} A${outer},${outer} 0 0 1 ${point(outer, end)} L${point(inner, end)} A${inner},${inner} 0 0 0 ${point(inner, middle)} A${inner},${inner} 0 0 0 ${point(inner, start)} Z`;
}

/** Parent-first radial partition. Angles encode file counts, not bytes or completion. */
export function layoutRadial(map: IndexMap, focusId: number | null): RadialSector[] {
	const children = new Map<number | null, IndexMapNode[]>();
	for (const node of map.nodes) {
		const siblings = children.get(node.parent);
		if (siblings === undefined) children.set(node.parent, [node]);
		else siblings.push(node);
	}
	const focus = focusId === null ? undefined : map.nodes.find((node) => node.id === focusId);
	const roots = (focus === undefined ? children.get(null) ?? [] : [focus]).filter((node) => node.weight > 0 || children.has(node.id));
	const weights = new Map<number, number>();
	for (let index = map.nodes.length - 1; index >= 0; index -= 1) {
		const node = map.nodes[index]!;
		const kids = children.get(node.id);
		weights.set(node.id, kids === undefined ? Math.max(1, node.weight) : kids.reduce((sum, child) => sum + (weights.get(child.id) ?? 1), 0));
	}
	const depthOf = (node: IndexMapNode): number => 1 + Math.max(0, ...(children.get(node.id) ?? []).map(depthOf));
	// Deeper descendants remain in the data; drilling into a folder reveals the next nine rings.
	const maxRings = 9;
	const rings = Math.max(1, Math.min(maxRings, Math.max(0, ...roots.map(depthOf))));
	const step = (OUTER_RADIUS - RADIAL_HOLE) / rings;
	const result: RadialSector[] = [];
	const visit = (siblings: readonly IndexMapNode[], start: number, end: number, level: number): void => {
		if (level >= maxRings) return;
		const total = siblings.reduce((sum, node) => sum + (weights.get(node.id) ?? 1), 0);
		let cursor = start;
		for (const node of siblings) {
			const next = cursor + ((end - start) * (weights.get(node.id) ?? 1)) / Math.max(1, total);
			const gap = Math.min(0.007, (next - cursor) * 0.08);
			const inner = RADIAL_HOLE + level * step + 1;
			const outer = inner + step - 3;
			// Files read as fine radial strokes rather than wide blocks, even in a small scope.
			const middle = (cursor + next) / 2;
			const half = node.kind === "file" ? Math.min(0.012, (next - cursor - gap) / 2) : (next - cursor - gap) / 2;
			result.push({ node, start: cursor, end: next, inner, outer, path: sectorPath(middle - half, middle + half, inner, outer) });
			visit(children.get(node.id) ?? [], cursor, next, level + 1);
			cursor = next;
		}
	};
	visit(roots, 0, TAU, 0);
	return result;
}
