import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { TreeRow } from "../state/folder-tree";
import {
	cubicBezier,
	DEFAULT_DISCLOSURE_EASE,
	DEFAULT_DISCLOSURE_MS,
	detectDisclosureChange,
	motionDuration,
	opennessAt,
	parseCubicBezier,
	parseDuration,
	sameShape,
	startDisclosure,
	type DisclosureMotion,
	type ScrollRange,
} from "../state/disclosure-motion";
import type { GroupSection } from "../state/grouping";

/** The custom property the animation drives; `styles/base.css` turns it into the slide. */
export const OPENNESS_PROPERTY = "--slide-q";

/** `prefers-reduced-motion: reduce` is read when a motion would start, so the OS setting applies live. */
function reducedMotion(): boolean {
	return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface MotionState {
	readonly rows: readonly TreeRow[];
	readonly motion: DisclosureMotion | null;
	readonly seq: number;
}

/** Duration and easing come from the `--dur-disclosure` / `--ease-disclosure` tokens, so tokens.css stays the one place to tune them. */
function readTokens(element: HTMLElement): { readonly duration: number; readonly ease: (time: number) => number } {
	const style = getComputedStyle(element);
	const duration = parseDuration(style.getPropertyValue("--dur-disclosure")) ?? DEFAULT_DISCLOSURE_MS;
	const bezier = parseCubicBezier(style.getPropertyValue("--ease-disclosure")) ?? DEFAULT_DISCLOSURE_EASE;
	return { duration, ease: cubicBezier(...bezier) };
}

/**
 * Turns a folder opening or closing in place into a running motion (seungwonme/AutoRAG-app#19).
 *
 * The motion is derived from the rows, not from the click: when the new rows
 * differ from the last ones by exactly one folder's block, a motion starts in
 * the same render, so the first painted frame is already the first frame of the
 * slide. A folder that is still listing therefore animates once, when its rows
 * arrive; a refresh, a sort, or a navigation changes the rows some other way
 * and never animates. A change that is not a disclosure while a motion runs
 * ends it at once, and a disclosure of another folder replaces it.
 *
 * The frames are not React state: a rAF loop writes `--slide-q` (0 closed .. 1
 * open) on `target`, and the CSS moves the rows from it, so the 13 frames of a
 * motion cost no renders and never hold up an event. Reduced motion starts no
 * motion at all.
 */
export function useDisclosureMotion(input: {
	readonly rows: readonly TreeRow[];
	readonly sections: readonly GroupSection<TreeRow>[];
	readonly scroll: ScrollRange;
	readonly overscan: number;
	readonly target: RefObject<HTMLElement | null>;
}): DisclosureMotion | null {
	const { rows, sections, scroll, overscan, target } = input;
	const [state, setState] = useState<MotionState>({ rows, motion: null, seq: 0 });
	/** How far open the running motion is; a reversal starts from here. */
	const openness = useRef(1);

	if (state.rows !== rows) {
		// Adjusting state while rendering (React's "derive from props" pattern): the commit already carries the motion.
		let motion: DisclosureMotion | null = null;
		let seq = state.seq;
		const change = detectDisclosureChange(state.rows, rows);
		if (change !== null && !reducedMotion()) {
			motion = startDisclosure({
				change,
				sections,
				scroll,
				overscan,
				id: seq + 1,
				current: state.motion,
				currentOpenness: openness.current,
			});
			if (motion !== null) seq += 1;
		} else if (change === null && state.motion !== null && sameShape(state.rows, rows)) {
			motion = state.motion;
		}
		setState({ rows, motion, seq });
	}

	const motion = state.motion;
	useLayoutEffect(() => {
		if (motion === null) return;
		const element = target.current;
		const end = (): void => setState((current) => (current.motion === motion ? { ...current, motion: null } : current));
		if (element === null) {
			// Nothing to draw on: the rows are the settled ones.
			end();
			return;
		}
		const { duration: base, ease } = readTokens(element);
		const duration = motionDuration(base, motion.from, motion.to);
		const started = performance.now();
		let frame: number | null = null;
		let settled = false;

		const paint = (value: number): void => {
			openness.current = value;
			element.style.setProperty(OPENNESS_PROPERTY, String(Math.round(value * 10_000) / 10_000));
		};
		const settle = (): void => {
			if (settled) return;
			settled = true;
			if (frame !== null) cancelAnimationFrame(frame);
			window.clearTimeout(backstop);
			// The end value stays on until React drops the motion; the cleanup below clears it in that
			// same commit. Cleared here, a frame painted before that commit would draw a closing block
			// at the CSS fallback openness of 1, fully open (seungwonme/AutoRAG-app#25).
			paint(motion.to);
			end();
		};
		const tick = (): void => {
			frame = null;
			const elapsed = performance.now() - started;
			if (elapsed >= duration) {
				settle();
				return;
			}
			paint(opennessAt(motion, elapsed, duration, ease));
			frame = requestAnimationFrame(tick);
		};

		// Before the first paint: the rows start where the list was.
		paint(motion.from);
		frame = requestAnimationFrame(tick);
		// A window nobody sees gets no animation frames; the rows must still settle.
		const backstop = window.setTimeout(settle, duration + 250);
		return () => {
			settled = true;
			if (frame !== null) cancelAnimationFrame(frame);
			window.clearTimeout(backstop);
			element.style.removeProperty(OPENNESS_PROPERTY);
		};
	}, [motion, target]);

	return motion;
}
