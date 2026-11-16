import { nodeKey, OUTER_RADIUS, RADIAL_CENTER, RADIAL_HOLE, radialState, type RadialSector, type RadialState } from "./radial";

/**
 * The index map's motion: going into a folder and back out tweens every sector from where it was to where it lands
 * (the folder opens to the full circle, the rings around it slide in or out), and the seed head in the hole turns by
 * the golden angle. Everything here is geometry; the panel drives it and skips it under reduced motion.
 */

const TAU = Math.PI * 2;

/** The golden angle in degrees: the seed head turns by it on each zoom, the way a sunflower lays its seeds. */
export const GOLDEN_ANGLE_DEG = 137.5;
export const ZOOM_MS = 650;

export interface SectorShape {
	readonly start: number;
	readonly end: number;
	readonly inner: number;
	readonly outer: number;
}

/** Where one layout puts a node: its share of the circle and its ring, with the ring's width. */
interface Frame {
	readonly start: number;
	readonly end: number;
	readonly inner: number;
	readonly step: number;
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

function frameOf(sector: RadialSector): Frame {
	// Rings are `step` apart and drawn 3 narrower (radial.ts), so the drawn width plus that gap is the step.
	return { start: sector.start, end: sector.end, inner: sector.inner, step: sector.outer - sector.inner + 3 };
}

export function drawnShape(sector: RadialSector): SectorShape {
	return { start: sector.drawnStart, end: sector.drawnEnd, inner: sector.inner, outer: sector.outer };
}

/**
 * A shape drawn in one layout, carried into another by the node both layouts share: angles stretch with that node's
 * share of the circle, rings shift with its ring. Whatever falls outside closes up at the circle's edges, the hole, or
 * the outer rim, which is how the sectors that leave fold away and the ones that arrive grow in.
 */
export function mapShape(shape: SectorShape, from: Frame, to: Frame): SectorShape {
	const span = from.end - from.start || Number.EPSILON;
	const angle = (value: number): number => clamp(to.start + ((value - from.start) / span) * (to.end - to.start), 0, TAU);
	const radius = (value: number): number => clamp(to.inner + ((value - from.inner) / from.step) * to.step, RADIAL_HOLE, OUTER_RADIUS);
	return { start: angle(shape.start), end: angle(shape.end), inner: radius(shape.inner), outer: radius(shape.outer) };
}

export interface SectorTween {
	readonly key: string;
	readonly from: SectorShape;
	readonly to: SectorShape;
	/** Drawn only during the tween: the node is not in the new layout. */
	readonly leaving: boolean;
	readonly state: RadialState;
}

/**
 * How each sector moves from one layout to the next. `anchors` are node keys, nearest first, that may sit in both
 * layouts (the folder entered, or the folder left, then its parents); the first one that does sets the frame. With
 * none in common there is nothing to carry over, and the caller just swaps the layouts.
 */
export function planTween(before: readonly RadialSector[], after: readonly RadialSector[], anchors: readonly string[]): SectorTween[] | null {
	const old = new Map(before.map((sector) => [nodeKey(sector.node), sector]));
	const next = new Map(after.map((sector) => [nodeKey(sector.node), sector]));
	const anchor = anchors.find((key) => old.has(key) && next.has(key));
	if (anchor === undefined) return null;
	const fromFrame = frameOf(old.get(anchor)!);
	const toFrame = frameOf(next.get(anchor)!);
	const tweens: SectorTween[] = [];
	for (const [key, sector] of next) {
		const was = old.get(key);
		const to = drawnShape(sector);
		tweens.push({ key, to, from: was === undefined ? mapShape(to, toFrame, fromFrame) : drawnShape(was), leaving: false, state: radialState(sector.node) });
	}
	for (const [key, sector] of old) {
		if (next.has(key)) continue;
		const from = drawnShape(sector);
		tweens.push({ key, from, to: mapShape(from, fromFrame, toFrame), leaving: true, state: radialState(sector.node) });
	}
	return tweens;
}

export function lerpShape(a: SectorShape, b: SectorShape, t: number): SectorShape {
	const mix = (x: number, y: number): number => x + (y - x) * t;
	return { start: mix(a.start, b.start), end: mix(a.end, b.end), inner: mix(a.inner, b.inner), outer: mix(a.outer, b.outer) };
}

export function easeInOutCubic(t: number): number {
	return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export interface Seed {
	readonly x: number;
	readonly y: number;
}

/** Seeds sit in a band inside the hole, clear of the readout: from this radius out to just inside the first ring. */
const SEED_INNER = 64;
const SEED_OUTER = RADIAL_HOLE - 3;
const SEED_SPACING = 7.4;
export const SEED_RADIUS = 3.1;

/** The seed head: Vogel's sunflower model (seed n at the golden angle n times, radius ∝ √n), innermost first. */
export const SEEDS: readonly Seed[] = (() => {
	const golden = Math.PI * (3 - Math.sqrt(5));
	const seeds: Seed[] = [];
	for (let n = Math.ceil((SEED_INNER / SEED_SPACING) ** 2); SEED_SPACING * Math.sqrt(n) <= SEED_OUTER; n += 1) {
		const radius = SEED_SPACING * Math.sqrt(n);
		seeds.push({ x: RADIAL_CENTER + Math.cos(n * golden) * radius, y: RADIAL_CENTER + Math.sin(n * golden) * radius });
	}
	return seeds;
})();

/** How many seeds are filled: never all before every file is read, and at least one once any is. */
export function litSeeds(indexed: number, targets: number, total: number = SEEDS.length): number {
	if (targets <= 0 || indexed <= 0) return 0;
	if (indexed >= targets) return total;
	return Math.min(total - 1, Math.max(1, Math.round((indexed / targets) * total)));
}

/** Motion only where the platform can say the user has not asked for less of it. */
export function motionAllowed(): boolean {
	// Read through globalThis: this module is also type-checked with the tests, outside the DOM library.
	const media = (globalThis as { readonly matchMedia?: (query: string) => { readonly matches: boolean } }).matchMedia;
	return typeof media === "function" && !media.call(globalThis, "(prefers-reduced-motion: reduce)").matches;
}
