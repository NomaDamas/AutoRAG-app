import { describe, expect, it } from "vitest";
import { FITS, fitPathBar, foldOrder, trailWidth } from "../src/renderer/src/state/path-fit";

// 오류 › 하정 - 개인 › 바탕 화면 › 작업물 › 2025-2학기 › bx공간 (segment button widths)
const SEGMENTS = [50, 80, 70, 60, 90, 70];
const LAYOUT = { segments: SEGMENTS, separator: 12, gap: 1, more: 26 };
const NATURAL = trailWidth(LAYOUT, new Set()); // 420 + 5 separators (60) + 5 gaps = 485
const fit = (available: number) => fitPathBar({ ...LAYOUT, available, lastLabel: 40, minLabel: 32 });

describe("foldOrder", () => {
	it("folds the middle first, then the root, then the parent; the last segment never folds", () => {
		expect(foldOrder(6)).toEqual([1, 2, 3, 0, 4]);
		expect(foldOrder(3)).toEqual([0, 1]);
		expect(foldOrder(2)).toEqual([0]);
		expect(foldOrder(1)).toEqual([]);
		expect(foldOrder(0)).toEqual([]);
	});
});

describe("trailWidth", () => {
	it("puts “…” where the folded run starts, after the separator before it, and drops the separator after it", () => {
		expect(NATURAL).toBe(485);
		// 오류 › … 2025-2학기 › bx공간: root, …(+sep), 2025-2학기 (no sep), bx공간 (+sep), 3 gaps.
		expect(trailWidth(LAYOUT, new Set([1, 2, 3]))).toBe(50 + (26 + 12) + 90 + (70 + 12) + 3);
		// … bx공간 once the root and the parent are folded too.
		expect(trailWidth(LAYOUT, new Set([0, 1, 2, 3, 4]))).toBe(26 + 70 + 1);
	});
});

describe("fitPathBar", () => {
	it("shows every folder when the trail fits", () => {
		expect(fit(NATURAL)).toEqual(FITS);
	});

	it("folds whole folders from the left of the middle, one at a time, as the bar narrows", () => {
		expect(fit(NATURAL - 1).hidden).toEqual([1]);
		expect(fit(trailWidth(LAYOUT, new Set([1, 2]))).hidden).toEqual([1, 2]);
		expect(fit(trailWidth(LAYOUT, new Set([1, 2, 3]))).hidden).toEqual([1, 2, 3]);
	});

	it("keeps the root until the whole middle is folded, then folds it before the parent", () => {
		expect(fit(trailWidth(LAYOUT, new Set([1, 2, 3])) - 1).hidden).toEqual([0, 1, 2, 3]);
		expect(fit(trailWidth(LAYOUT, new Set([0, 1, 2, 3])) - 1).hidden).toEqual([0, 1, 2, 3, 4]);
	});

	it("never clips while folding is enough", () => {
		const result = fit(trailWidth(LAYOUT, new Set([0, 1, 2, 3, 4])));
		expect(result).toEqual({ hidden: [0, 1, 2, 3, 4], lastClip: null, overflow: false });
	});

	it("narrows only the last label once nothing else can fold, and floors it", () => {
		const tight = trailWidth(LAYOUT, new Set([0, 1, 2, 3, 4]));
		expect(fit(tight - 5.5)).toEqual({ hidden: [0, 1, 2, 3, 4], lastClip: 34, overflow: false });
	});

	it("reports overflow when even the narrowest last label does not fit beside “…”", () => {
		const tight = trailWidth(LAYOUT, new Set([0, 1, 2, 3, 4]));
		expect(fit(tight - 20)).toEqual({ hidden: [0, 1, 2, 3, 4], lastClip: 32, overflow: true });
	});

	it("clips a lone segment without folding anything", () => {
		const single = fitPathBar({ segments: [100], separator: 12, gap: 1, more: 26, available: 90, lastLabel: 60, minLabel: 32 });
		expect(single).toEqual({ hidden: [], lastClip: 50, overflow: false });
	});
});
