import { describe, expect, it } from "vitest";
import {
	EMPTY_SELECTION,
	ROW_HEIGHT,
	applyRowClick,
	moveInGrid,
	moveSelection,
	SCROLL_LEAD,
	scrollTopToReveal,
	selectionCount,
} from "../src/renderer/src/state/selection";

const order = ["a", "b", "c", "d", "e"];
const plain = { meta: false, shift: false };

describe("applyRowClick", () => {
	it("selects a single row", () => {
		const next = applyRowClick(EMPTY_SELECTION, "c", order, plain);
		expect(next).toEqual({ keys: ["c"], anchor: "c", focus: "c" });
	});

	it("replaces a multi-selection on a plain click", () => {
		const multi = { keys: ["a", "b"], anchor: "a", focus: "b" };
		expect(applyRowClick(multi, "d", order, plain).keys).toEqual(["d"]);
	});

	it("adds and removes with the command key", () => {
		const one = applyRowClick(EMPTY_SELECTION, "a", order, plain);
		const two = applyRowClick(one, "c", order, { meta: true, shift: false });
		expect(two.keys).toEqual(["a", "c"]);
		expect(two.focus).toBe("c");
		const back = applyRowClick(two, "a", order, { meta: true, shift: false });
		expect(back.keys).toEqual(["c"]);
		expect(back.focus).toBe("c");
	});

	it("selects a range with shift, in both directions", () => {
		const anchored = applyRowClick(EMPTY_SELECTION, "b", order, plain);
		expect(applyRowClick(anchored, "d", order, { meta: false, shift: true }).keys).toEqual(["b", "c", "d"]);
		const fromEnd = applyRowClick(EMPTY_SELECTION, "d", order, plain);
		expect(applyRowClick(fromEnd, "b", order, { meta: false, shift: true }).keys).toEqual(["b", "c", "d"]);
	});

	it("keeps the anchor across repeated shift clicks", () => {
		const anchored = applyRowClick(EMPTY_SELECTION, "b", order, plain);
		const wide = applyRowClick(anchored, "e", order, { meta: false, shift: true });
		expect(applyRowClick(wide, "c", order, { meta: false, shift: true }).keys).toEqual(["b", "c"]);
	});

	it("falls back to a single row when shift has no anchor", () => {
		expect(applyRowClick(EMPTY_SELECTION, "c", order, { meta: false, shift: true }).keys).toEqual(["c"]);
	});
});

describe("moveSelection", () => {
	it("moves down and up by one row", () => {
		const at = applyRowClick(EMPTY_SELECTION, "b", order, plain);
		expect(moveSelection(order, at, 1).focus).toBe("c");
		expect(moveSelection(order, at, -1).focus).toBe("a");
	});

	it("clamps at both ends", () => {
		const first = applyRowClick(EMPTY_SELECTION, "a", order, plain);
		expect(moveSelection(order, first, -1).focus).toBe("a");
		const last = applyRowClick(EMPTY_SELECTION, "e", order, plain);
		expect(moveSelection(order, last, 1).focus).toBe("e");
	});

	it("starts at the first row when nothing is selected", () => {
		expect(moveSelection(order, EMPTY_SELECTION, 1).focus).toBe("a");
	});

	it("collapses a multi-selection to one row", () => {
		const multi = { keys: ["a", "b", "c"], anchor: "a", focus: "c" };
		expect(moveSelection(order, multi, 1).keys).toEqual(["d"]);
	});

	it("keeps the selection on an empty list", () => {
		expect(moveSelection([], EMPTY_SELECTION, 1)).toEqual(EMPTY_SELECTION);
	});
});

describe("moveInGrid", () => {
	// 7 tiles in rows of 3:  a b c / d e f / g
	const tiles = ["a", "b", "c", "d", "e", "f", "g"];
	const at = (key: string) => ({ keys: [key], anchor: key, focus: key });

	it("moves one tile sideways and clamps at the ends", () => {
		expect(moveInGrid(tiles, at("b"), { dx: 1, dy: 0 }, 3).focus).toBe("c");
		expect(moveInGrid(tiles, at("c"), { dx: 1, dy: 0 }, 3).focus).toBe("d");
		expect(moveInGrid(tiles, at("a"), { dx: -1, dy: 0 }, 3).focus).toBe("a");
		expect(moveInGrid(tiles, at("g"), { dx: 1, dy: 0 }, 3).focus).toBe("g");
	});

	it("moves a whole row up and down", () => {
		expect(moveInGrid(tiles, at("b"), { dx: 0, dy: 1 }, 3).focus).toBe("e");
		expect(moveInGrid(tiles, at("e"), { dx: 0, dy: -1 }, 3).focus).toBe("b");
	});

	it("stays put when there is no row above", () => {
		expect(moveInGrid(tiles, at("b"), { dx: 0, dy: -1 }, 3).focus).toBe("b");
	});

	it("drops into a short last row at its last tile, and stays on the last row", () => {
		expect(moveInGrid(tiles, at("f"), { dx: 0, dy: 1 }, 3).focus).toBe("g");
		expect(moveInGrid(tiles, at("g"), { dx: 0, dy: 1 }, 3).focus).toBe("g");
	});

	it("starts at the first tile when nothing is focused", () => {
		expect(moveInGrid(tiles, EMPTY_SELECTION, { dx: 0, dy: 1 }, 3).focus).toBe("a");
	});

	it("keeps the selection on an empty grid", () => {
		expect(moveInGrid([], EMPTY_SELECTION, { dx: 1, dy: 0 }, 3)).toEqual(EMPTY_SELECTION);
	});
});

describe("scrollTopToReveal", () => {
	// 480px viewport over 100 rows of ROW_HEIGHT: scrollTop 0..(2400 - 480).
	const viewport = 480;
	const maxScrollTop = 100 * ROW_HEIGHT - viewport;
	const at = (index: number): { top: number; height: number } => ({ top: index * ROW_HEIGHT, height: ROW_HEIGHT });
	const reveal = (index: number, scrollTop: number, intent: "step" | "reveal" = "step"): number =>
		scrollTopToReveal({ ...at(index), scrollTop, viewport, maxScrollTop, intent });

	it("uses the real row height", () => {
		expect(ROW_HEIGHT).toBe(24);
	});

	it("leaves the scroll alone while the row is fully visible, anywhere in the viewport", () => {
		// Rows 10..29 fill the viewport at scrollTop 240.
		for (let index = 10; index < 30; index += 1) {
			expect(reveal(index, 240)).toBe(240);
			expect(reveal(index, 240, "reveal")).toBe(240);
		}
	});

	it("scrolls down by exactly the overflow: the row's bottom lands on the viewport's bottom edge", () => {
		// Row 30 starts at the bottom edge (240 + 480 = 720), so one row of overflow.
		expect(reveal(30, 240)).toBe(240 + ROW_HEIGHT);
		// A row cut off by 10px scrolls 10px.
		expect(scrollTopToReveal({ top: 706, height: ROW_HEIGHT, scrollTop: 240, viewport, maxScrollTop, intent: "step" })).toBe(250);
		const next = reveal(30, 240);
		expect(30 * ROW_HEIGHT + ROW_HEIGHT - next).toBe(viewport);
	});

	it("scrolls up by exactly the overflow: the row's top lands on the viewport's top edge", () => {
		expect(reveal(9, 240)).toBe(9 * ROW_HEIGHT);
		expect(scrollTopToReveal({ top: 230, height: ROW_HEIGHT, scrollTop: 240, viewport, maxScrollTop, intent: "step" })).toBe(230);
	});

	it("keeps a held arrow key one row per press: no jump, no lead", () => {
		let scrollTop = 0;
		const seen: number[] = [];
		for (let index = 0; index < 60; index += 1) {
			scrollTop = reveal(index, scrollTop);
			seen.push(scrollTop);
		}
		// Rows 0..19 are on screen at 0: no scroll until the 21st row.
		expect(seen.slice(0, 20).every((value) => value === 0)).toBe(true);
		expect(seen[20]).toBe(ROW_HEIGHT);
		expect(seen[21]).toBe(2 * ROW_HEIGHT);
		expect(seen[59]).toBe(40 * ROW_HEIGHT);
	});

	it("never scrolls past the top or the settled end", () => {
		expect(reveal(0, 0)).toBe(0);
		expect(reveal(0, 30)).toBe(0);
		expect(reveal(99, maxScrollTop - 24)).toBe(maxScrollTop);
		expect(reveal(99, maxScrollTop)).toBe(maxScrollTop);
	});

	it("counts a viewport that stands past the settled end as standing at the end (a folder is closing)", () => {
		// The list is still taller than it will be; row 80 is on screen once it has settled to maxScrollTop.
		expect(reveal(80, maxScrollTop + 300)).toBe(maxScrollTop + 300);
		// ...and a row above that settled viewport scrolls from the settled end, not from where the scroller stands now.
		expect(reveal(70, maxScrollTop + 300)).toBe(70 * ROW_HEIGHT);
	});

	it("scrolls only a row that is partly visible to its nearest edge, even for a reveal", () => {
		expect(reveal(30, 240 + 10, "reveal")).toBe(240 + ROW_HEIGHT);
		expect(scrollTopToReveal({ top: 706, height: ROW_HEIGHT, scrollTop: 240, viewport, maxScrollTop, intent: "reveal" })).toBe(250);
		expect(scrollTopToReveal({ top: 230, height: ROW_HEIGHT, scrollTop: 240, viewport, maxScrollTop, intent: "reveal" })).toBe(230);
	});

	it("keeps context above a row revealed from outside the viewport, down to the first row and up to the end", () => {
		expect(reveal(50, 0, "reveal")).toBe(50 * ROW_HEIGHT - SCROLL_LEAD);
		expect(reveal(5, 1000, "reveal")).toBe(Math.max(0, 5 * ROW_HEIGHT - SCROLL_LEAD));
		expect(reveal(1, 1000, "reveal")).toBe(0);
		expect(reveal(99, 0, "reveal")).toBe(maxScrollTop);
		// The same far row, reached one step at a time, is not given the context.
		expect(reveal(50, 0, "step")).toBe(50 * ROW_HEIGHT + ROW_HEIGHT - viewport);
	});

	it("does nothing without a measured viewport", () => {
		expect(scrollTopToReveal({ ...at(50), scrollTop: 77, viewport: 0, maxScrollTop: 0, intent: "step" })).toBe(77);
	});

	it("aligns the top of a row taller than the viewport", () => {
		expect(scrollTopToReveal({ top: 100, height: 60, scrollTop: 0, viewport: 40, maxScrollTop: 500, intent: "step" })).toBe(100);
	});
});

describe("selectionCount", () => {
	it("counts the selected keys", () => {
		expect(selectionCount(EMPTY_SELECTION)).toBe(0);
		expect(selectionCount({ keys: ["a", "b"], anchor: "a", focus: "b" })).toBe(2);
	});
});
