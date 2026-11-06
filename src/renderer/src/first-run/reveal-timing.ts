/**
 * The Ready → Finder reveal's clock: the `T` object and `SPEED` of
 * `design-mockups/finish-reveal/v5v7-hybrid.html`, and its easing helpers.
 * `reveal.tsx` plays it.
 */

/** Seconds on the mockup's clock. */
export const REVEAL_T = {
	textOut: [0.1, 1.0],
	logoMove: [0.2, 1.2],
	dark5: [0.5, 1.8],
	dark5Max: 0.66,
	glow5: [0.6, 1.8],
	word: [1.3, 2.1],
	darkOut: [3.1, 4.1],
	auraOut: [2.9, 3.9],
	sweep: [2.1, 2.9],
	lift: [2.7, 3.8],
	liftScale: 0.1,
	liftBlur: 12,
	bloom: [2.7, 3.7],
	fin: [2.8, 4.1],
	finScale: 0.06,
	finBlur: 10,
	items: 3.4,
	itemStep: 0.12,
	dim: [4.7, 5.4],
	coach: [5.0, 5.6],
	end: 5.8,
} as const;

/** The mockup plays its clock 1.2× faster than real time (5.8 s ≈ 4.8 s). */
export const REVEAL_SPEED = 1.2;

/** Real milliseconds for a moment on the mockup's clock. */
export function revealMs(seconds: number): number {
	return (seconds * 1000) / REVEAL_SPEED;
}

/** A cubic-bezier timing function, solved by bisection like the mockup's `bez`. */
export function bezier(a: number, b: number, c: number, d: number): (x: number) => number {
	return (x: number): number => {
		let lo = 0;
		let hi = 1;
		let t = x;
		for (let i = 0; i < 24; i += 1) {
			t = (lo + hi) / 2;
			const at = 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * c + t * t * t;
			if (at < x) lo = t;
			else hi = t;
		}
		return 3 * (1 - t) * (1 - t) * t * b + 3 * (1 - t) * t * t * d + t * t * t;
	};
}

export const easeOut = bezier(0.16, 1, 0.3, 1);
export const easeInOut = bezier(0.45, 0, 0.2, 1);
export const easeLift = bezier(0.4, 0, 0.2, 1);

/** Progress of `t` through `[a, b]`, clamped, through `ease` when given (the mockup's `pr`). */
export function progressIn(t: number, range: readonly [number, number], ease?: (x: number) => number): number {
	const p = Math.max(0, Math.min(1, (t - range[0]) / (range[1] - range[0])));
	return ease === undefined ? p : ease(p);
}
