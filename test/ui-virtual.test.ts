import { describe, expect, it } from "vitest";
import {
	type WindowInput,
	columnsForWidth,
	gridColumnCount,
	gridWindow,
	linearWindow,
} from "../src/renderer/src/state/virtual";

const base: WindowInput = { count: 100, offset: 0, viewport: 320, stride: 32, overscan: 2 };

describe("linearWindow", () => {
	it("renders the rows intersecting the viewport plus overscan", () => {
		// 320px viewport / 32px rows = 10 visible rows at offset 0.
		expect(linearWindow(base)).toEqual({ start: 0, end: 12 });
	});

	it("shifts with the scroll offset", () => {
		// offset 320 => first visible row 10, last 19, overscan 2.
		expect(linearWindow({ ...base, offset: 320 })).toEqual({ start: 8, end: 22 });
	});

	it("clamps both edges to the item count", () => {
		expect(linearWindow({ ...base, offset: -50 })).toEqual({ start: 0, end: 12 });
		expect(linearWindow({ ...base, count: 12, offset: 320 })).toEqual({ start: 8, end: 12 });
		// Scrolled past the end: nothing is visible.
		expect(linearWindow({ ...base, offset: 10_000 })).toEqual({ start: 100, end: 100 });
	});

	it("returns an empty window when there is nothing to render", () => {
		expect(linearWindow({ ...base, count: 0 })).toEqual({ start: 0, end: 0 });
		expect(linearWindow({ ...base, count: -5 })).toEqual({ start: 0, end: 0 });
		expect(linearWindow({ ...base, stride: 0 })).toEqual({ start: 0, end: 0 });
	});

	it("keeps the natural window when the include index is already rendered", () => {
		expect(linearWindow({ ...base, include: 5 })).toEqual({ start: 0, end: 12 });
	});

	it("moves the window to cover an include index scrolled off-screen", () => {
		// Forward jump: window moves rather than stretching across the gap.
		expect(linearWindow({ ...base, include: 90 })).toEqual({ start: 88, end: 93 });
		// Backward jump.
		expect(linearWindow({ ...base, offset: 320, include: 0 })).toEqual({ start: 0, end: 3 });
	});

	it("ignores an include index outside the item count", () => {
		expect(linearWindow({ ...base, include: 100 })).toEqual({ start: 0, end: 12 });
		expect(linearWindow({ ...base, include: -1 })).toEqual({ start: 0, end: 12 });
	});
});

describe("gridWindow", () => {
	// 34 tiles in rows of 5: rows 0..5 full, row 6 holds 4 tiles.
	const tiles = { count: 34, offset: 0, viewport: 272, stride: 136, overscan: 1, columns: 5 };

	it("returns a row-aligned item window", () => {
		// 272px viewport / 136px rows = 2 visible rows, overscan 1 => rows 0..2.
		const window = gridWindow(tiles);
		expect(window).toEqual({ start: 0, end: 15, startRow: 0, endRow: 3 });
		expect(window.start % tiles.columns).toBe(0);
		expect(window.end % tiles.columns).toBe(0);
	});

	it("keeps the first rendered row full width", () => {
		const window = gridWindow({ ...tiles, offset: 136 });
		expect(window.startRow).toBe(0);
		expect(window.start).toBe(0);
	});

	it("clamps the end to the tile count on the short last row", () => {
		const window = gridWindow({ ...tiles, offset: 6 * 136 });
		expect(window.startRow).toBe(5);
		expect(window.endRow).toBe(7);
		expect(window.end).toBe(34);
	});

	it("moves the window to the include tile's row", () => {
		expect(gridWindow({ ...tiles, include: 32 })).toEqual({ start: 25, end: 34, startRow: 5, endRow: 7 });
		expect(gridWindow({ ...tiles, offset: 6 * 136, include: 0 })).toEqual({ start: 0, end: 10, startRow: 0, endRow: 2 });
	});

	it("backs the window off the short last row so the column count stays measurable", () => {
		// Natural window would start on the partial last row (row 6, 4 tiles).
		expect(gridWindow({ ...tiles, offset: 6 * 136, overscan: 0 })).toEqual({
			start: 25,
			end: 34,
			startRow: 5,
			endRow: 7,
		});
	});

	it("treats a non-positive column count as one column", () => {
		expect(gridWindow({ ...tiles, columns: 0, count: 3 })).toEqual({ start: 0, end: 3, startRow: 0, endRow: 3 });
	});

	it("returns an empty window for an empty grid", () => {
		expect(gridWindow({ ...tiles, count: 0 })).toEqual({ start: 0, end: 0, startRow: 0, endRow: 0 });
	});
});

describe("gridColumnCount", () => {
	it("counts the resolved pixel tracks", () => {
		expect(gridColumnCount("112px 112px 112px")).toBe(3);
		expect(gridColumnCount("  116.5px   116.5px  ")).toBe(2);
	});

	it("reports 0 for missing or unresolved values so callers can fall back", () => {
		expect(gridColumnCount("")).toBe(0);
		expect(gridColumnCount("none")).toBe(0);
		expect(gridColumnCount("repeat(auto-fill, minmax(112px, 1fr))")).toBe(0);
		expect(gridColumnCount(null)).toBe(0);
		expect(gridColumnCount(undefined)).toBe(0);
	});
});

describe("columnsForWidth", () => {
	it("fits as many minimum tracks plus gaps as the width allows", () => {
		expect(columnsForWidth(112 * 3, 112, 0)).toBe(3);
		// 3 tracks need 112*3 + 4*2 = 344px; 340px only fits 2.
		expect(columnsForWidth(340, 112, 4)).toBe(2);
		expect(columnsForWidth(344, 112, 4)).toBe(3);
	});

	it("always leaves at least one column", () => {
		expect(columnsForWidth(10, 112, 4)).toBe(1);
		expect(columnsForWidth(-100, 112, 4)).toBe(1);
		expect(columnsForWidth(500, 0, 4)).toBe(1);
	});
});
