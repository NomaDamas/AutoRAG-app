/**
 * The index map's land: every node claims ground around itself, the claims of
 * one state add up into a territory, and each cell of the grid goes to the
 * state with the strongest claim there. Where the claims together are weak the
 * cell is sea; along a change of owner a border is drawn; inside a territory
 * the summed claim is its elevation, drawn as terraces with contour lines.
 *
 * Pure: it fills an RGBA buffer the canvas then draws scaled up, so a test can
 * read the map cell by cell.
 */

import { INDEX_MAP_STATES, type IndexMapState } from "../../../../../shared/index-map-contract";

export type Rgb = readonly [number, number, number];

/** Territory colors (the canvas cannot read CSS tokens per pixel). Blue holds, red needs indexing, grey is left out. */
export const TERRITORY_COLORS: Readonly<Record<IndexMapState, Rgb>> = {
	indexed: [64, 132, 255],
	stale: [255, 92, 92],
	unindexed: [232, 58, 76],
	excluded: [148, 156, 172],
	unindexable: [104, 112, 128],
};

/** How opaque each territory is: left-out ground is a translucent neutral country. */
export const TERRITORY_OPACITY: Readonly<Record<IndexMapState, number>> = {
	indexed: 0.92,
	stale: 0.9,
	unindexed: 0.9,
	excluded: 0.42,
	unindexable: 0.3,
};

export interface TerritoryClaim {
	/** Center in grid cells. */
	readonly x: number;
	readonly y: number;
	/** Reach in grid cells. */
	readonly radius: number;
	readonly state: IndexMapState;
}

export interface TerritoryGrid {
	readonly width: number;
	readonly height: number;
	/** RGBA, `width * height * 4`. */
	readonly pixels: Uint8ClampedArray<ArrayBuffer>;
	/** Owner per cell: an index into `INDEX_MAP_STATES`, or -1 for sea. */
	readonly owner: Int8Array;
}

/** Summed claim where the coast runs. A lone node's claim peaks at 1, so it always shows as an island. */
const COAST = 0.32;
/** Claim width of the soft coast edge. */
const COAST_SOFTNESS = 0.1;
/** Summed claim per terrace step. */
const TERRACE = 0.9;

export function paintTerritory(width: number, height: number, claims: readonly TerritoryClaim[]): TerritoryGrid {
	const cells = width * height;
	const stateCount = INDEX_MAP_STATES.length;
	const field = new Float32Array(cells * stateCount);
	const stateIndex = new Map(INDEX_MAP_STATES.map((state, index) => [state, index]));
	for (const claim of claims) {
		const radius = claim.radius;
		if (radius <= 0) continue;
		const offset = stateIndex.get(claim.state) ?? 0;
		const x0 = Math.max(0, Math.floor(claim.x - radius));
		const x1 = Math.min(width - 1, Math.ceil(claim.x + radius));
		const y0 = Math.max(0, Math.floor(claim.y - radius));
		const y1 = Math.min(height - 1, Math.ceil(claim.y + radius));
		const inverse = 1 / (radius * radius);
		for (let y = y0; y <= y1; y += 1) {
			const dy = y + 0.5 - claim.y;
			for (let x = x0; x <= x1; x += 1) {
				const dx = x + 0.5 - claim.x;
				const falloff = 1 - (dx * dx + dy * dy) * inverse;
				// (1 - d²/r²)² : smooth, and exactly zero at the reach, so claims merge into round coasts.
				if (falloff > 0) {
					const slot = (y * width + x) * stateCount + offset;
					field[slot] = (field[slot] ?? 0) + falloff * falloff;
				}
			}
		}
	}

	const owner = new Int8Array(cells).fill(-1);
	const total = new Float32Array(cells);
	for (let cell = 0; cell < cells; cell += 1) {
		let best = -1;
		let bestValue = 0;
		let sum = 0;
		for (let state = 0; state < stateCount; state += 1) {
			const value = field[cell * stateCount + state] ?? 0;
			sum += value;
			if (value > bestValue) {
				bestValue = value;
				best = state;
			}
		}
		total[cell] = sum;
		if (sum >= COAST - COAST_SOFTNESS) owner[cell] = best;
	}

	const pixels = new Uint8ClampedArray(cells * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const cell = y * width + x;
			const own = owner[cell] ?? -1;
			if (own < 0) continue;
			const state = INDEX_MAP_STATES[own] ?? "excluded";
			const sum = total[cell] ?? 0;
			const [r, g, b] = TERRITORY_COLORS[state];
			const coast = Math.min(1, Math.max(0, (sum - (COAST - COAST_SOFTNESS)) / (2 * COAST_SOFTNESS)));
			const right = x + 1 < width ? (owner[cell + 1] ?? -1) : own;
			const below = y + 1 < height ? (owner[cell + width] ?? -1) : own;
			const border = (right >= 0 && right !== own) || (below >= 0 && below !== own);
			// Elevation: higher ground (denser claims) is lighter, in terraces; a contour line closes each terrace.
			const level = Math.min(5, Math.floor(sum / TERRACE));
			const fraction = sum / TERRACE - Math.floor(sum / TERRACE);
			const contour = sum > TERRACE && fraction < 0.08 && level < 5;
			const lift = level * 0.07 + Math.min(0.12, sum * 0.03);
			const shade = border ? -0.42 : contour ? -0.16 : lift;
			const mix = (channel: number): number => (shade >= 0 ? channel + (255 - channel) * shade : channel * (1 + shade));
			const offset = cell * 4;
			pixels[offset] = mix(r);
			pixels[offset + 1] = mix(g);
			pixels[offset + 2] = mix(b);
			pixels[offset + 3] = Math.round(255 * coast * (border ? Math.max(0.75, TERRITORY_OPACITY[state]) : TERRITORY_OPACITY[state]));
		}
	}
	return { width, height, pixels, owner };
}
