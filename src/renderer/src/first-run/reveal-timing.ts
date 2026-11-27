/**
 * The Ready → Finder reveal's clock and easing curves
 * (design: design-mockups/onboarding-intro-desktop-v3-fullscreen.html).
 *
 * 5.6 s at 1.0× speed, in four acts:
 * 1. `dusk`  (0.00–1.15 s): the ready copy fades, the Dazzi sunflower glides to the centre and the whole desktop
 *                           dims into dusk.
 * 2. `light` (1.15–3.60 s): a breathing field of sunflower yellow, cream and sky blue wells up behind the mark and
 *                           spreads until it covers the desktop; "Dazzi" springs in letter by letter beneath it.
 * 3. `rise`  (3.60–5.00 s): the word and the mark leave (the mark turns 10° as it fades), and the Finder window rises
 *                           out of the light, which parts exactly along its outline; the window reads as clear glass,
 *                           then clears.
 * 4. `clear` (5.00–5.60 s): the rest of the light and the dusk lift off the desktop; the tour takes over.
 */

export type RevealPhase = "dusk" | "light" | "rise" | "clear" | "done";

/** Seconds on the reveal clock. */
export const REVEAL_T = {
	/** The ready copy and the check badge fade. */
	textOut: [0.05, 0.5],
	/** The sunflower glides to the window's centre. */
	logoMove: [0.1, 0.8],
	/** The desktop dims. */
	dusk: [0, 1.15],
	/** The light wells up behind the mark. */
	lightIn: [1.15, 1.8],
	/** It spreads from the mark until it covers the desktop. */
	spread: [1.15, 3.2],
	/** The warm glow right behind the mark. */
	glowIn: [1.15, 1.95],
	/** Then reaches full strength. */
	lightFull: [3.2, 3.6],
	/** "Dazzi", one letter after another. */
	word: 1.95,
	letterStep: 0.02,
	/** The word fades. */
	wordOut: [3.6, 4.1],
	/** The warm glow fades with the mark. */
	glowOut: [3.55, 4.05],
	/** The mark fades, turning 10°. */
	markOut: [3.7, 4.3],
	markTurn: 10,
	/** The window's outline opens in the light. */
	open: 3.68,
	/** The window rises: 22 px low at 95.5 %, settling in place. */
	rise: [3.7, 5.0],
	riseOffset: 22,
	riseScale: 0.045,
	/** The window comes into focus. */
	focus: [3.7, 5.1],
	focusBlur: 10,
	/** The window's parts arrive one after another. */
	items: [3.9, 4.8],
	itemStep: 0.1,
	/** The rest of the light leaves. */
	lightOut: [4.75, 5.5],
	/** The dusk lifts. */
	duskOut: [4.5, 5.5],
	end: 5.6,
} as const;

/** Real-time playback speed multiplier. */
export const REVEAL_SPEED = 1.0;

/** Real milliseconds for a moment on the reveal clock. */
export function revealMs(seconds: number): number {
	return (seconds * 1000) / REVEAL_SPEED;
}

/** Named choreography phase for clock time `t` (seconds). */
export function revealPhaseAt(t: number): RevealPhase {
	if (t < REVEAL_T.dusk[1]) return "dusk";
	if (t < REVEAL_T.open) return "light";
	if (t < REVEAL_T.rise[1]) return "rise";
	if (t < REVEAL_T.end) return "clear";
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

/** Progress of `t` through `[a, b]`, clamped, through `ease` when given. */
export function progressIn(t: number, range: readonly [number, number], ease?: (x: number) => number): number {
	const p = Math.max(0, Math.min(1, (t - range[0]) / (range[1] - range[0])));
	return ease === undefined ? p : ease(p);
}

/**
 * A damped spring from 0 to 1 after `elapsed` seconds, in the duration/bounce terms SwiftUI and Motion use:
 * `duration` is the perceptual settle time and `bounce` (0..1) how far it overshoots.
 */
export function spring(elapsed: number, duration = 0.6, bounce = 0.26): number {
	if (elapsed <= 0) return 0;
	const omega = (2 * Math.PI) / duration;
	const zeta = 1 - bounce;
	const damped = omega * Math.sqrt(1 - zeta * zeta);
	const decay = Math.exp(-zeta * omega * elapsed);
	return 1 - decay * (Math.cos(damped * elapsed) + ((zeta * omega) / damped) * Math.sin(damped * elapsed));
}
