import { describe, expect, it } from "vitest";
import { groupedLayout } from "../src/renderer/src/state/grouping";
import { combineMarquee, marqueeHits, marqueeRect } from "../src/renderer/src/state/marquee";

// Three 100px tracks with 10px gaps (width 320), 124px rows on a 132px stride.
const GEOMETRY = { columns: 3, rowHeight: 124, columnGap: 10, width: 320 };
const STRIDE = { columns: 3, rowStride: 132, rowGap: 8, headerStride: 40 };

describe("marqueeHits", () => {
	it("selects exactly the tiles a rectangle touches, never the empty cells of a short last row", () => {
		// Given 5 tiles in rows of 3 (the second row has 2 tiles)
		const layout = groupedLayout([{ label: null, rows: 5 }], STRIDE);

		// A box over the middle column of both rows
		expect(marqueeHits(layout, GEOMETRY, marqueeRect({ x: 150, y: 10 }, { x: 160, y: 200 }))).toEqual([1, 4]);
		// A box reaching into the empty third cell of row 2 picks no phantom tile
		expect(marqueeHits(layout, GEOMETRY, marqueeRect({ x: 230, y: 140 }, { x: 300, y: 200 }))).toEqual([]);
		// A box sitting only in the gap between two tracks touches nothing
		expect(marqueeHits(layout, GEOMETRY, marqueeRect({ x: 101, y: 10 }, { x: 109, y: 50 }))).toEqual([]);
		// A box sitting only in the gap between rows touches nothing
		expect(marqueeHits(layout, GEOMETRY, marqueeRect({ x: 0, y: 125 }, { x: 320, y: 131 }))).toEqual([]);
	});

	it("skips group headers and indexes rows across sections in view order", () => {
		// Given two labeled sections of 2 and 3 tiles
		const layout = groupedLayout(
			[
				{ label: "A", rows: 2 },
				{ label: "B", rows: 3 },
			],
			STRIDE,
		);
		// Header A [0,40), A row [40,164), header B [164,204), B row [204,328)

		// A box over only header B selects nothing
		expect(marqueeHits(layout, GEOMETRY, marqueeRect({ x: 0, y: 170 }, { x: 320, y: 200 }))).toEqual([]);
		// A box over everything returns all five flattened indices
		expect(marqueeHits(layout, GEOMETRY, marqueeRect({ x: 0, y: 0 }, { x: 320, y: 400 }))).toEqual([0, 1, 2, 3, 4]);
	});
});

describe("combineMarquee", () => {
	const ordered = ["a", "b", "c", "d"];

	it("replaces, adds (⇧), or toggles (⌘) against the selection the drag started from", () => {
		expect(combineMarquee(ordered, ["a"], ["c", "b"], "replace")).toEqual(["c", "b"]);
		expect(combineMarquee(ordered, ["d", "a"], ["b"], "add")).toEqual(["a", "b", "d"]);
		expect(combineMarquee(ordered, ["a", "b"], ["b", "c"], "toggle")).toEqual(["a", "c"]);
	});
});
