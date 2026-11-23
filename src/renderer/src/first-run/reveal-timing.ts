/**
 * The Ready → Finder cosmic pop-art reveal's clock and easing helpers.
 *
 * Five-act choreography (total 5.2 s at 1.0× speed, handing off to the tour at 4.65 s):
 * 1. `implosion` (0.00–0.85 s): Gravitational collapse — copy pulls in, sunflower centers & winds up.
 * 2. `impact`    (0.85–1.01 s): Sakuga 2-beat impact frame (pure white → inverted neon ink).
 * 3. `supernova` (1.01–2.10 s): Big Bang shockwaves, warp stars, Takashi/Right Now pop motifs,
 *                               Banksy spray splatters & drips, anime speedlines.
 * 4. `imprint`   (2.10–3.15 s): High-contrast Banksy stencil "DAZZI" slams in with chromatic
 *                               misregistration, halftone cosmos, viewfinder crop marks & light sweep.
 * 5. `portal`    (3.15–4.65 s): Radial cosmic portal rips open into the live Finder; panels punch in.
 */

export type RevealPhase = "implosion" | "impact" | "supernova" | "imprint" | "portal" | "done";

/** Seconds on the reveal clock. */
export const REVEAL_T = {
	textOut: [0.0, 0.62],
	logoMove: [0.06, 0.78],
	implode: [0.22, 0.85],
	impact: [0.85, 1.01],
	shockwave: [0.95, 2.35],
	popBurst: [1.01, 3.35],
	splatter: [1.04, 3.25],
	word: [1.55, 2.1],
	sweep: [2.15, 2.85],
	lift: [3.08, 3.68],
	liftScale: 0.24,
	liftBlur: 10,
	bloom: [2.98, 3.58],
	portal: [3.22, 4.32],
	fin: [3.26, 4.32],
	finScale: 0.08,
	finBlur: 12,
	items: 3.5,
	itemStep: 0.12,
	dim: [4.65, 5.05],
	end: 5.2,
} as const;

/** Real-time playback multiplier. */
export const REVEAL_SPEED = 1.0;

/** Real milliseconds for a moment on the reveal clock. */
export function revealMs(seconds: number): number {
	return (seconds * 1000) / REVEAL_SPEED;
}

/** Named choreography phase for clock time `t` (seconds). */
export function revealPhaseAt(t: number): RevealPhase {
	if (t < REVEAL_T.impact[0]) return "implosion";
	if (t < REVEAL_T.impact[1]) return "impact";
	if (t < REVEAL_T.word[1]) return "supernova";
	if (t < REVEAL_T.portal[0]) return "imprint";
	if (t < REVEAL_T.end) return "portal";
	return "done";
}

/** A cubic-bezier timing function, solved by bisection. */
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

/** Cel-anime pop overshoot: punches past 1.0 and snaps cleanly onto 1.0. */
export const easePop = bezier(0.22, 1.56, 0.48, 1);

/** Explosive Big Bang ease: violent initial launch with a silky cosmic tail. */
export function easeExpoOut(x: number): number {
	const c = Math.max(0, Math.min(1, x));
	return c === 1 ? 1 : 1 - 2 ** (-10 * c);
}

/** Gravitational collapse ease: accelerates smoothly toward singularity. */
export function easeInQuad(x: number): number {
	const c = Math.max(0, Math.min(1, x));
	return c * c;
}

/** Progress of `t` through `[a, b]`, clamped, through `ease` when given. */
export function progressIn(t: number, range: readonly [number, number], ease?: (x: number) => number): number {
	const p = Math.max(0, Math.min(1, (t - range[0]) / (range[1] - range[0])));
	return ease === undefined ? p : ease(p);
}
