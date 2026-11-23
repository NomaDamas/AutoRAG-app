import { describe, expect, it } from "vitest";
import { REVEAL_SPEED, REVEAL_T, bezier, easeOut, progressIn, revealMs } from "../src/renderer/src/first-run/reveal-timing";

describe("Ready → Finder reveal timing", () => {
	it("uses the mockup's clock: 5.8 s played at 1.2× is about 4.8 s", () => {
		expect(REVEAL_SPEED).toBe(1.2);
		expect(REVEAL_T.end).toBe(5.8);
		expect(Math.round(revealMs(REVEAL_T.end))).toBe(4833);
		expect(Math.round(revealMs(REVEAL_T.dim[0]))).toBe(3917);
	});

	it("keeps the mockup's order: the imprint ends where the sweep begins, the Finder is in before the dim", () => {
		expect(REVEAL_T.word[1]).toBe(REVEAL_T.sweep[0]);
		expect(REVEAL_T.fin[1]).toBeLessThan(REVEAL_T.dim[0]);
		expect(REVEAL_T.items + 3 * REVEAL_T.itemStep + 0.9).toBeLessThan(REVEAL_T.dim[0]);
	});

	it("clamps progress to its range and eases it", () => {
		expect(progressIn(0, [0.5, 1.5])).toBe(0);
		expect(progressIn(1, [0.5, 1.5])).toBe(0.5);
		expect(progressIn(9, [0.5, 1.5])).toBe(1);
		expect(progressIn(1, [0.5, 1.5], easeOut)).toBeGreaterThan(0.5);
	});

	it("solves a cubic-bezier from 0 to 1", () => {
		const linear = bezier(0, 0, 1, 1);
		expect(linear(0)).toBeCloseTo(0, 5);
		expect(linear(1)).toBeCloseTo(1, 5);
		expect(linear(0.5)).toBeCloseTo(0.5, 3);
	});
});
