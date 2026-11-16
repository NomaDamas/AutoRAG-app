import { describe, expect, it } from "vitest";
import { litSeeds, mapShape, planTween, SEEDS } from "../src/renderer/src/components/settings/index-map/motion";
import { OUTER_RADIUS, RADIAL_HOLE, type RadialSector } from "../src/renderer/src/components/settings/index-map/radial";
import type { IndexMapNode } from "../src/shared/index-map-contract";

const TAU = Math.PI * 2;

function sector(path: string, start: number, end: number, level: number, step = 50): RadialSector {
	const inner = RADIAL_HOLE + level * step + 1;
	const node = { id: 0, parent: null, kind: "folder", path, name: path, state: "indexed", weight: 1, counts: { indexed: 1, stale: 0, unindexed: 0, unindexable: 0, excluded: 0 } } as unknown as IndexMapNode;
	return { node, start, end, inner, outer: inner + step - 3, level, drawnStart: start, drawnEnd: end, path: "", edge: "" };
}

describe("index map motion", () => {
	it("carries a shape through the shared folder's frame", () => {
		const from = { start: Math.PI / 2, end: Math.PI, inner: RADIAL_HOLE + 51, step: 50 };
		const to = { start: 0, end: TAU, inner: RADIAL_HOLE + 1, step: 100 };
		// The folder itself opens to the whole circle on the first ring.
		expect(mapShape({ start: Math.PI / 2, end: Math.PI, inner: RADIAL_HOLE + 51, outer: RADIAL_HOLE + 98 }, from, to)).toEqual({ start: 0, end: TAU, inner: RADIAL_HOLE + 1, outer: RADIAL_HOLE + 95 });
		// A sibling outside its span closes up at the circle's edge, and the parent ring sinks into the hole.
		const sibling = mapShape({ start: 0, end: Math.PI / 4, inner: RADIAL_HOLE + 1, outer: RADIAL_HOLE + 48 }, from, to);
		expect(sibling.start).toBe(0);
		expect(sibling.end).toBe(0);
		expect(sibling.inner).toBe(RADIAL_HOLE);
		expect(sibling.outer).toBeLessThanOrEqual(RADIAL_HOLE + 1);
		expect(mapShape({ start: 0, end: 1, inner: 290, outer: 400 }, to, to).outer).toBe(OUTER_RADIUS);
	});

	it("moves shared sectors, folds away leaving ones, and grows arriving ones from the old frame", () => {
		const before = [sector("/a", 0, Math.PI, 0), sector("/b", Math.PI, TAU, 0), sector("/a/x", 0, Math.PI, 1)];
		const after = [sector("/a", 0, TAU, 0, 100), sector("/a/x", 0, TAU, 1, 100), sector("/a/x/y", 0, TAU, 2, 100)];
		const plan = planTween(before, after, ["folder\u0000/a"]);
		expect(plan).not.toBeNull();
		const byKey = new Map(plan!.map((tween) => [tween.key.split("\u0000")[1], tween]));
		expect(byKey.get("/a")).toMatchObject({ leaving: false, from: { start: 0, end: Math.PI }, to: { start: 0, end: TAU } });
		expect(byKey.get("/b")?.leaving).toBe(true);
		expect(byKey.get("/b")?.to.start).toBe(TAU);
		// Arriving from beyond the old outer ring: it starts closed at the rim.
		const arriving = byKey.get("/a/x/y")!;
		expect(arriving.leaving).toBe(false);
		expect(arriving.from.outer - arriving.from.inner).toBeLessThan(arriving.to.outer - arriving.to.inner);
	});

	it("does not tween between views with no folder in common", () => {
		expect(planTween([sector("/a", 0, TAU, 0)], [sector("/b", 0, TAU, 0)], ["folder\u0000/a"])).toBeNull();
	});

	it("fills seeds in proportion, never all until everything is read", () => {
		expect(SEEDS.length).toBeGreaterThan(40);
		expect(litSeeds(0, 10)).toBe(0);
		expect(litSeeds(1, 1000)).toBe(1);
		expect(litSeeds(999, 1000)).toBe(SEEDS.length - 1);
		expect(litSeeds(10, 10)).toBe(SEEDS.length);
		expect(litSeeds(5, 0)).toBe(0);
	});
});
