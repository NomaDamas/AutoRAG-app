/**
 * Arc / Dia-inspired Ready → Finder reveal clock and easing curves.
 *
 * Four restrained optical acts (4.7 s total at 1.0× speed, handing off to the tour at 4.25 s):
 * 1. `gather` (0.00–1.05 s): Copy dissolves, stage darkens smoothly into obsidian night, the
 *                            Dazzi sunflower glides to center, and a luminous glass orb ignites behind it.
 * 2. `orb`    (1.05–2.35 s): Volumetric liquid-glass orb breathes around the Dazzi logo with subtle
 *                            prismatic caustics; "Dazzi" cascades in letter-by-letter with 3D spring tilt
 *                            and blur settle (Arc/Dia staggered text); silk light sweeps the sunflower.
 * 3. `melt`   (2.35–4.25 s): Organic simplex-warped aperture melts open from behind the Dazzi mark with
 *                            a warm golden-ice Fresnel rim, revealing the real Finder pulling into focus
 *                            (sidebar, toolbar, left pane, right pane + inspector staggered cleanly).
 * 4. `settle` (4.25–4.70 s): Hand-off to the tour's first coach mark; shader layer is completely gone.
 */

export type RevealPhase = "gather" | "orb" | "melt" | "settle" | "done";

/** Seconds on the reveal clock. */
export const REVEAL_T = {
	textOut: [0.0, 0.58],
	logoMove: [0.06, 0.92],
	darken: [0.1, 0.96],
	orbIn: [0.42, 1.38],
	word: [1.12, 1.98],
	sweep: [1.68, 2.38],
	lift: [2.36, 3.16],
	liftScale: 0.12,
	liftBlur: 11,
	melt: [2.35, 3.85],
	fin: [2.4, 3.72],
	finScale: 0.05,
	finBlur: 8,
	items: 2.65,
	itemStep: 0.1,
	dim: [4.25, 4.55],
	end: 4.7,
} as const;

/** Real-time playback speed multiplier. */
export const REVEAL_SPEED = 1.0;

/** Real milliseconds for a moment on the reveal clock. */
export function revealMs(seconds: number): number {
	return (seconds * 1000) / REVEAL_SPEED;
}

/** Named choreography phase for clock time `t` (seconds). */
export function revealPhaseAt(t: number): RevealPhase {
	if (t < 1.05) return "gather";
	if (t < REVEAL_T.melt[0]) return "orb";
	if (t < REVEAL_T.dim[0]) return "melt";
	if (t < REVEAL_T.end) return "settle";
	return "done";
}

/** A cubic-bezier timing function with exact 0 and 1 endpoints. */
export function bezier(a: number, b: number, c: number, d: number): (x: number) => number {
	return (x: number): number => {
		if (x <= 0) return 0;
		if (x >= 1) return 1;
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

/** Gentle Arc/Dia spring curve (subtle overshoot, silky settle — never cartoon bounce). */
export const easeSpring = bezier(0.22, 1.18, 0.36, 1);

/** Progress of `t` through `[a, b]`, clamped, through `ease` when given. */
export function progressIn(t: number, range: readonly [number, number], ease?: (x: number) => number): number {
	const p = Math.max(0, Math.min(1, (t - range[0]) / (range[1] - range[0])));
	return ease === undefined ? p : ease(p);
}

/** Per-letter staggered progress (Arc/Dia AnimateText cascade). */
export function glyphProgress(t: number, index: number, start: number, stagger: number, duration: number): number {
	const t0 = start + index * stagger;
	return progressIn(t, [t0, t0 + duration], easeSpring);
}
