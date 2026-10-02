import { CSSSpringEasing } from "spring-easing";

/**
 * The zoom curve, as an Apple spring rather than a hand-tuned bezier.
 *
 * Apple parameterises springs by `response` (its perceptual duration) and
 * `dampingFraction` (`SwiftUI.spring(response:dampingFraction:)`, UIKit's
 * `interpolatingSpring(mass:stiffness:damping:velocity:)`). `spring-easing`
 * turns those physics into a CSS `linear()` easing, so the compositor plays the
 * same curve macOS Quick Look does: quick off the icon, smooth landing, no
 * visible bounce.
 */
const MASS = 1;
/** Just under critical damping: settles cleanly without a visible overshoot. */
const DAMPING_FRACTION = 0.9;
/** Apple's `response` for opening and closing, in seconds. */
const RESPONSE_IN = 0.18;
const RESPONSE_OUT = 0.15;

function springEasing(response: number): string {
	const stiffness = (2 * Math.PI / response) ** 2;
	const damping = DAMPING_FRACTION * 2 * Math.sqrt(MASS * stiffness);
	const [easing] = CSSSpringEasing({
		easing: `spring(${MASS}, ${stiffness.toFixed(2)}, ${damping.toFixed(2)}, 0)`,
		numPoints: 40,
		decimal: 4,
		quality: 0.85,
	});
	return `linear(${easing})`;
}

export interface ZoomMotion {
	/** Milliseconds the curve spans, tail included. */
	readonly duration: number;
	readonly easing: string;
}

export const ZOOM_IN: ZoomMotion = { duration: RESPONSE_IN * 1000, easing: springEasing(RESPONSE_IN) };
export const ZOOM_OUT: ZoomMotion = { duration: RESPONSE_OUT * 1000, easing: springEasing(RESPONSE_OUT) };
