/**
 * The index map's planet. Every search root is a continent on a globe; its
 * folders and files are laid out as nested regions of that continent, each
 * taking ground in proportion to the files it stands for. What the index is
 * meant to hold (indexed, stale, unindexed) is land: blue where it is indexed,
 * red where it still needs indexing. What is left out (excluded, unreadable)
 * is sea: shallow water over a region the scope dropped, deep ocean elsewhere.
 *
 * The texture is equirectangular (longitude across, latitude down) so the
 * globe renderer only samples it. Every indexed cell also carries the moment
 * it turns blue in the opening count (`flipAt`, 0..1): before that it shows
 * red, so the blue spreads across the red like returns coming in.
 *
 * Pure: no DOM, so a test can read the planet cell by cell.
 */

import { INDEX_MAP_STATES, type IndexMap, type IndexMapNode, type IndexMapState } from "../../../../../shared/index-map-contract";

export type Rgb = readonly [number, number, number];
export type Vec3 = readonly [number, number, number];

/** Land and sea colors (the canvas cannot read CSS tokens per pixel). */
export const GLOBE_COLORS: Readonly<Record<IndexMapState, Rgb>> = {
	indexed: [52, 124, 255],
	stale: [255, 116, 82],
	unindexed: [232, 56, 70],
	excluded: [58, 92, 140],
	unindexable: [38, 66, 108],
};

/** Deep ocean, where nothing in the scope lies. */
export const OCEAN: Rgb = [9, 26, 58];

/** States that are land; the rest of the scope is sea. */
export function isLand(state: IndexMapState): boolean {
	return state === "indexed" || state === "stale" || state === "unindexed";
}

/** Share of the globe's surface the roots split between them. */
const LAND_SHARE = 0.42;
/** A leaf's claim reaches a little past its own region, so neighbors merge into one coast. */
const LEAF_REACH = 1.4;
/** Smallest claim, in radians (about 1.3°), so a lone file still shows as an island. */
const MIN_REACH = 0.022;
/** Summed claim where the coast runs. */
const COAST = 0.32;

export interface GlobeSite {
	readonly node: IndexMapNode;
	/** Unit vector of the region's center. */
	readonly at: Vec3;
	/** Angular radius of the region the node holds, in radians. */
	readonly cap: number;
	/** True for a node with no drawn children: only leaves claim ground. */
	readonly leaf: boolean;
	/** Angular reach of a leaf's claim; 0 for an inner node. */
	readonly reach: number;
	/** When an indexed leaf turns blue in the opening count, 0..1; 1 for every other site. */
	readonly order: number;
}

/** Deterministic 0..1 noise, so the planet is the same on every open. */
export function hash(seed: number): number {
	const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
	return value - Math.floor(value);
}

function normalize([x, y, z]: Vec3): Vec3 {
	const length = Math.hypot(x, y, z) || 1;
	return [x / length, y / length, z / length];
}

function cross([ax, ay, az]: Vec3, [bx, by, bz]: Vec3): Vec3 {
	return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

export function dot(a: Vec3, b: Vec3): number {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** The point `distance` radians away from `center`, heading `azimuth` radians around it. */
function offset(center: Vec3, distance: number, azimuth: number): Vec3 {
	const up: Vec3 = Math.abs(center[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
	const east = normalize(cross(up, center));
	const north = cross(center, east);
	const along = Math.sin(distance);
	const heading: Vec3 = [
		east[0] * Math.cos(azimuth) + north[0] * Math.sin(azimuth),
		east[1] * Math.cos(azimuth) + north[1] * Math.sin(azimuth),
		east[2] * Math.cos(azimuth) + north[2] * Math.sin(azimuth),
	];
	const across = Math.cos(distance);
	return normalize([center[0] * across + heading[0] * along, center[1] * across + heading[1] * along, center[2] * across + heading[2] * along]);
}

/** Angular radius of a cap covering `share` of the sphere. */
function capFor(share: number): number {
	return Math.acos(Math.max(-1, 1 - 2 * Math.min(1, share)));
}

function size(node: IndexMapNode): number {
	return Math.max(1, node.weight);
}

/**
 * Places every node on the globe. Roots spread over the sphere; each node's
 * children sit inside its region on a sunflower spiral, heaviest at the
 * center, each with ground proportional to its file count.
 */
export function layoutGlobe(map: IndexMap): GlobeSite[] {
	const children = new Map<number, IndexMapNode[]>();
	const roots: IndexMapNode[] = [];
	for (const node of map.nodes) {
		if (node.parent === null) roots.push(node);
		else children.set(node.parent, [...(children.get(node.parent) ?? []), node]);
	}
	const placed = new Map<number, { at: Vec3; cap: number; root: number; fromRoot: number }>();
	const total = roots.reduce((sum, root) => sum + size(root), 0);
	roots.forEach((root, index) => {
		// One root faces the viewer; more spread on a Fibonacci sphere, tilted a little north.
		const y = roots.length === 1 ? 0.25 : 1 - ((index + 0.5) / roots.length) * 2;
		const ring = Math.sqrt(Math.max(0, 1 - y * y));
		const theta = index * 2.399963;
		const at = normalize([ring * Math.sin(theta), y * 0.8, ring * Math.cos(theta)]);
		placed.set(root.id, { at, cap: capFor((LAND_SHARE * size(root)) / Math.max(1, total)), root: root.id, fromRoot: 0 });
	});
	for (const node of map.nodes) {
		const parent = placed.get(node.id);
		const kids = children.get(node.id);
		if (parent === undefined || kids === undefined) continue;
		const sorted = [...kids].sort((a, b) => size(b) - size(a) || a.id - b.id);
		const sum = sorted.reduce((acc, kid) => acc + size(kid), 0);
		let before = 0;
		sorted.forEach((kid, index) => {
			const share = size(kid) / sum;
			const cap = parent.cap * Math.sqrt(share) * 0.92;
			// Rings by cumulative weight, kept far enough in that the child's own region stays inside the parent's.
			const distance = (parent.cap - cap) * Math.sqrt((before + size(kid) / 2) / sum);
			before += size(kid);
			const azimuth = index * 2.399963 + hash(kid.id) * 0.5;
			const at = sorted.length === 1 ? parent.at : offset(parent.at, distance, azimuth);
			placed.set(kid.id, { at, cap, root: parent.root, fromRoot: Math.acos(Math.min(1, dot(at, placed.get(parent.root)?.at ?? at))) });
		});
	}
	const sites: GlobeSite[] = [];
	const rootCap = new Map(roots.map((root) => [root.id, placed.get(root.id)?.cap ?? 1]));
	for (const node of map.nodes) {
		const place = placed.get(node.id);
		if (place === undefined) continue;
		const leaf = !children.has(node.id);
		// The count reaches each root's center first and rolls outward, with a little jitter so the front is ragged.
		const order = leaf && node.state === "indexed" ? Math.min(0.999, (place.fromRoot / (rootCap.get(place.root) ?? 1)) * 0.82 + hash(node.id * 5 + 1) * 0.16) : 1;
		sites.push({ node, at: place.at, cap: place.cap, leaf, reach: leaf ? Math.max(MIN_REACH, place.cap * LEAF_REACH) : 0, order });
	}
	return sites;
}

export interface GlobeTexture {
	readonly width: number;
	readonly height: number;
	/** Per cell: an index into `INDEX_MAP_STATES` for land or shallow water, or -1 for deep ocean. */
	readonly owner: Int8Array;
	/** Per cell: the summed claim, 0 at sea; the land's elevation. */
	readonly elevation: Float32Array;
	/** Per cell: when an indexed cell turns blue in the opening count, 0..1; 2 for every other cell. */
	readonly flipAt: Float32Array;
	/** Per cell: 1 where the owner changes to the east or south (a border or a coastline). */
	readonly edge: Uint8Array;
}

/** The planet's surface: each cell goes to the land state with the strongest claim, else to the shallows of a left-out region, else to the ocean. */
export function paintGlobe(sites: readonly GlobeSite[], width = 1440, height = 720): GlobeTexture {
	const cells = width * height;
	const stateCount = INDEX_MAP_STATES.length;
	const field = new Float32Array(cells * stateCount);
	const bestIndexed = new Float32Array(cells);
	const flipAt = new Float32Array(cells).fill(2);
	const stateIndex = new Map(INDEX_MAP_STATES.map((state, index) => [state, index]));
	// Cell centers as unit vectors, row by row.
	const rowLat = Float64Array.from({ length: height }, (_, y) => Math.PI / 2 - ((y + 0.5) / height) * Math.PI);
	for (const site of sites) {
		if (!site.leaf || site.reach <= 0) continue;
		const slot = stateIndex.get(site.node.state) ?? 0;
		const indexed = site.node.state === "indexed";
		const [sx, sy, sz] = site.at;
		const lat = Math.asin(Math.max(-1, Math.min(1, sy)));
		const lon = Math.atan2(sx, sz);
		const reach = site.reach;
		const chordReach = 2 - 2 * Math.cos(reach);
		const y0 = Math.max(0, Math.floor(((Math.PI / 2 - (lat + reach)) / Math.PI) * height));
		const y1 = Math.min(height - 1, Math.ceil(((Math.PI / 2 - (lat - reach)) / Math.PI) * height));
		for (let y = y0; y <= y1; y += 1) {
			const cellLat = rowLat[y] ?? 0;
			const cosLat = Math.cos(cellLat);
			const sinLat = Math.sin(cellLat);
			// Longitude span of the claim on this row; near a pole it wraps the whole row.
			const span = cosLat < 1e-6 || Math.abs(cellLat) + reach >= Math.PI / 2 ? Math.PI : Math.min(Math.PI, reach / cosLat);
			const x0 = Math.floor(((lon - span + Math.PI) / (2 * Math.PI)) * width);
			const x1 = Math.ceil(((lon + span + Math.PI) / (2 * Math.PI)) * width);
			for (let raw = x0; raw <= Math.min(x1, x0 + width - 1); raw += 1) {
				const x = ((raw % width) + width) % width;
				const cellLon = ((x + 0.5) / width) * 2 * Math.PI - Math.PI;
				const cx = cosLat * Math.sin(cellLon);
				const cz = cosLat * Math.cos(cellLon);
				const chord = (cx - sx) ** 2 + (sinLat - sy) ** 2 + (cz - sz) ** 2;
				const falloff = 1 - chord / chordReach;
				if (falloff <= 0) continue;
				const claim = falloff * falloff;
				const cell = y * width + x;
				field[cell * stateCount + slot] = (field[cell * stateCount + slot] ?? 0) + claim;
				if (indexed && claim > (bestIndexed[cell] ?? 0)) {
					bestIndexed[cell] = claim;
					flipAt[cell] = site.order;
				}
			}
		}
	}
	const owner = new Int8Array(cells).fill(-1);
	const elevation = new Float32Array(cells);
	for (let cell = 0; cell < cells; cell += 1) {
		let land = -1;
		let landValue = 0;
		let landSum = 0;
		let water = -1;
		let waterValue = 0;
		for (let state = 0; state < stateCount; state += 1) {
			const value = field[cell * stateCount + state] ?? 0;
			if (isLand(INDEX_MAP_STATES[state] ?? "excluded")) {
				landSum += value;
				if (value > landValue) {
					landValue = value;
					land = state;
				}
			} else if (value > waterValue) {
				waterValue = value;
				water = state;
			}
		}
		// Land wins a contested cell: the scope's own ground is drawn over the water it was cut from.
		if (landSum >= COAST) {
			owner[cell] = land;
			elevation[cell] = landSum;
		} else if (waterValue >= COAST) owner[cell] = water;
		if (owner[cell] !== stateIndex.get("indexed")) flipAt[cell] = 2;
	}
	const edge = new Uint8Array(cells);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const cell = y * width + x;
			const own = owner[cell] ?? -1;
			const east = owner[y * width + ((x + 1) % width)] ?? -1;
			const south = y + 1 < height ? (owner[cell + width] ?? -1) : own;
			if (east !== own || south !== own) edge[cell] = 1;
		}
	}
	return { width, height, owner, elevation, flipAt, edge };
}

/** The texture cell under a unit vector. */
export function cellAt(texture: GlobeTexture, [x, y, z]: Vec3): number {
	const lat = Math.asin(Math.max(-1, Math.min(1, y)));
	const lon = Math.atan2(x, z);
	const column = Math.min(texture.width - 1, Math.floor(((lon + Math.PI) / (2 * Math.PI)) * texture.width));
	const row = Math.min(texture.height - 1, Math.floor(((Math.PI / 2 - lat) / Math.PI) * texture.height));
	return row * texture.width + column;
}

/** What a cell shows at `progress` (0..1) of the opening count: an indexed cell still red before its turn, else its own state. Null is deep ocean. */
export function stateAt(texture: GlobeTexture, cell: number, progress: number): IndexMapState | null {
	const own = texture.owner[cell] ?? -1;
	if (own < 0) return null;
	const state = INDEX_MAP_STATES[own] ?? "excluded";
	if (state === "indexed" && progress < (texture.flipAt[cell] ?? 2)) return "unindexed";
	return state;
}
