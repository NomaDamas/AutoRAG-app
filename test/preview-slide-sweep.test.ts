import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlideSweep, type SweepUpdate } from "../src/preview/ui/slide-sweep";

const bytes = (tag: number): Uint8Array => Uint8Array.from([tag]);
const slides = (...indexes: number[]) => indexes.map((index) => ({ index, bytes: bytes(index) }));

describe("slide sweep", () => {
	let applied: SweepUpdate[];
	beforeEach(() => {
		vi.useFakeTimers();
		applied = [];
	});
	afterEach(() => {
		vi.useRealTimers();
	});
	const order = (): number[] => applied.flatMap((update) => update.slides.map((slide) => slide.index));

	it("applies a burst top to bottom over several steps, not all at once", () => {
		const sweep = createSlideSweep((update) => applied.push(update));
		sweep.push({ slides: slides(4, 2, 0, 3, 1), rendering: false });
		expect(order()).toEqual([0]);
		vi.advanceTimersByTime(60 * 10);
		expect(order()).toEqual([0, 1, 2, 3, 4]);
		expect(applied.length).toBe(5);
	});

	it("keeps rendering true until the last slide is applied, then ends it", () => {
		const sweep = createSlideSweep((update) => applied.push(update));
		sweep.push({ slides: slides(0, 1, 2), rendering: false });
		vi.advanceTimersByTime(1000);
		expect(applied.map((update) => update.rendering)).toEqual([true, true, false]);
	});

	it("takes at most 20 steps however large the deck", () => {
		const sweep = createSlideSweep((update) => applied.push(update));
		sweep.push({ slides: slides(...Array.from({ length: 140 }, (_, index) => index)), rendering: false });
		vi.advanceTimersByTime(60 * 100);
		expect(order()).toEqual(Array.from({ length: 140 }, (_, index) => index));
		expect(applied.length).toBeLessThanOrEqual(20);
		expect(applied.at(-1)!.rendering).toBe(false);
	});

	it("paces slides that arrive a few milliseconds apart, as Keynote writes them", () => {
		const sweep = createSlideSweep((update) => applied.push(update));
		sweep.push({ slides: slides(0), rendering: true });
		vi.advanceTimersByTime(2);
		sweep.push({ slides: slides(1), rendering: true });
		vi.advanceTimersByTime(2);
		sweep.push({ slides: slides(2), rendering: true });
		expect(order()).toEqual([0]);
		vi.advanceTimersByTime(60);
		expect(order()).toEqual([0, 1]);
		vi.advanceTimersByTime(60);
		expect(order()).toEqual([0, 1, 2]);
	});

	it("applies slides that stream in slowly as they come, keeping the wait open until the end", () => {
		const sweep = createSlideSweep((update) => applied.push(update));
		sweep.push({ slides: slides(0), rendering: true });
		expect(order()).toEqual([0]);
		vi.advanceTimersByTime(500);
		sweep.push({ slides: slides(1), rendering: true });
		expect(order()).toEqual([0, 1]);
		expect(applied.every((update) => update.rendering)).toBe(true);
		vi.advanceTimersByTime(500);
		sweep.push({ slides: [], rendering: false });
		expect(applied.at(-1)).toEqual({ slides: [], rendering: false });
	});

	it("ends the wait at once when nothing is queued, and drops what is queued on clear", () => {
		const sweep = createSlideSweep((update) => applied.push(update));
		sweep.push({ slides: [], rendering: false });
		expect(applied).toEqual([{ slides: [], rendering: false }]);
		applied.length = 0;
		sweep.push({ slides: slides(0, 1, 2, 3), rendering: true });
		sweep.clear();
		vi.advanceTimersByTime(1000);
		expect(order()).toEqual([0]);
	});
});
