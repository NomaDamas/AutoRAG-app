/**
 * The Ready → Finder hand-off (design mockup `design-mockups/finish-reveal/v5v7-hybrid.html`):
 * the ready copy blurs away, the sunflower settles in the middle while the stage
 * dims to dusk with a warm glow, "Dazzi" is imprinted under it, a light sweeps the
 * sunflower, the sunflower and the word lift away in a bloom, and the real Finder
 * pulls into focus behind it, its parts arriving one after another. The tour's
 * first coach bubble takes over from there (the mockup's dim and coach mark).
 *
 * Every timing, scale and blur value is the mockup's `T`, played at its `SPEED`.
 * The layer drives the ready screen, the Finder (`.desk`) and its own backdrop
 * layers directly, one frame at a time, and clears every inline style it set.
 */

import { useEffect, useRef, type ReactElement } from "react";
import { APP_NAME } from "../../../shared/app-info";
import { REVEAL_SPEED, REVEAL_T, easeInOut, easeLift, easeOut, progressIn } from "./reveal-timing";

/** The Finder's parts in the order the mockup brings them in: sidebar, toolbar, left pane, right pane + inspector. */
const DESK_ITEMS: readonly string[] = [".desk .sidebar", ".desk .toolbar", ".desk .workspace-pane:first-of-type", ".desk .workspace-pane + .workspace-pane, .desk .inspector-column"];

type Styled = HTMLElement & { readonly style: CSSStyleDeclaration };

function all(selector: string): Styled[] {
	return Array.from(document.querySelectorAll<HTMLElement>(selector));
}

function setStyle(element: Styled | null | undefined, values: Readonly<Record<string, string>>): void {
	if (element === null || element === undefined) return;
	for (const [key, value] of Object.entries(values)) element.style.setProperty(key, value);
}

const DRIVEN = ["opacity", "filter", "transform", "transform-origin", "animation", "transition", "will-change"];

function clearStyle(element: Styled | null | undefined): void {
	if (element === null || element === undefined) return;
	for (const key of DRIVEN) element.style.removeProperty(key);
}

const LAYER = "opacity, transform, filter";
/** How long after the hand-off the Finder keeps its own compositing layers, so dropping them never lands on a moving frame. */
const RELEASE_MS = 1500;

/**
 * Gives the hidden Finder its compositing layer while the ready screen is up, so the
 * reveal's first frame does not pay for rasterizing the whole window.
 */
export function prewarmReveal(): void {
	// The reveal's first frame for the Finder: hidden, blurred and scaled up. Setting the blur here, while it
	// is out of sight anyway, keeps its one-off setup off the clicked frame.
	setStyle(document.querySelector<HTMLElement>(".desk"), {
		"will-change": LAYER,
		opacity: "0",
		transform: `scale(${1 + REVEAL_T.finScale})`,
		filter: `blur(${REVEAL_T.finBlur}px)`,
		"transform-origin": "50% 50%",
	});
}

/** Undoes {@link prewarmReveal} when the Finder comes in another way (reduced motion). */
export function cancelPrewarm(): void {
	clearStyle(document.querySelector<HTMLElement>(".desk"));
}

/**
 * Plays the hand-off once. `onTour` fires at the mockup's dim (the tour's first
 * bubble comes in there); `onEnd` fires once the clock reaches `end`.
 */
export function Reveal({
	playing,
	onTour,
	onEnd,
	onRelease,
}: {
	/**
	 * False while the ready screen is up: the layers are mounted (and drawn once) at the clock's first
	 * frame, which looks exactly like the ready screen, so the click only starts the clock.
	 */
	readonly playing: boolean;
	readonly onTour: () => void;
	readonly onEnd: () => void;
	/** After the hand-off, once nothing moves: the caller drops the Finder's first-run mode; the layer then clears its own styles. */
	readonly onRelease: () => void;
}): ReactElement {
	const root = useRef<HTMLDivElement>(null);
	const tourRef = useRef(onTour);
	tourRef.current = onTour;
	const endRef = useRef(onEnd);
	endRef.current = onEnd;
	const releaseRef = useRef(onRelease);
	releaseRef.current = onRelease;

	// While the ready screen waits, the parts the clock will move already sit on their own layers.
	useEffect(() => {
		if (playing) return;
		const ready = document.querySelector<HTMLElement>(".fr-ready");
		const parts = [".fr-title", ".fr-lead", '[data-action="first-run-start"]', ".fr-status-mark", ".fr-done-mark", ".fr-reveal-sweep > span"].map((selector) => ready?.querySelector<HTMLElement>(selector) ?? null);
		for (const element of parts) setStyle(element, { "will-change": LAYER });
		return () => {
			for (const element of parts) element?.style.removeProperty("will-change");
		};
	}, [playing]);

	useEffect(() => {
		const layer = root.current;
		if (layer === null || !playing) return;
		const part = (name: string): Styled | null => layer.querySelector<HTMLElement>(`[data-reveal="${name}"]`);
		const base = part("base");
		const bgw = part("bgw");
		const dark = part("dark");
		const glow = part("glow");
		const word = part("word");
		const bloom = part("bloom");

		const ready = document.querySelector<HTMLElement>(".fr-ready");
		const texts = [ready?.querySelector<HTMLElement>(".fr-title"), ready?.querySelector<HTMLElement>(".fr-lead"), ready?.querySelector<HTMLElement>('[data-action="first-run-start"]')];
		const badge = ready?.querySelector<HTMLElement>(".fr-status-mark") ?? null;
		const logo = ready?.querySelector<HTMLElement>(".fr-done-mark") ?? null;
		const sweep = ready?.querySelector<HTMLElement>(".fr-reveal-sweep > span") ?? null;
		const desk = document.querySelector<HTMLElement>(".desk");

		// Where the sunflower settles: the stage's middle, 16 px up, as in the mockup.
		const box = logo?.getBoundingClientRect();
		const targetX = window.innerWidth / 2;
		const targetY = window.innerHeight / 2 - 16;
		const dx = box === undefined ? 0 : targetX - (box.left + box.width / 2);
		const dy = box === undefined ? 0 : targetY - (box.top + box.height / 2);
		setStyle(word, { top: `${targetY + 74}px` });
		// Each driven element gets its own compositing layer, so a blur or fade never repaints the whole window.
		const layered = { animation: "none", transition: "none", "will-change": LAYER };
		for (const element of [...texts, badge, logo, sweep]) setStyle(element ?? null, layered);
		setStyle(desk, { ...layered, "transform-origin": "50% 50%" });

		let items: Styled[][] = [];
		let toured = false;
		let frame = 0;
		const started = performance.now();
		const T = REVEAL_T;

		const render = (t: number): void => {
			texts.forEach((element, index) => {
				const p = progressIn(t, [T.textOut[0] + index * 0.08, T.textOut[1] + index * 0.08], easeOut);
				setStyle(element ?? null, { opacity: String(1 - p), filter: `blur(${10 * p}px)`, transform: `translateY(${-10 * p}px)` });
				if (index === 0) setStyle(badge, { opacity: String(1 - p) });
			});
			const fo = progressIn(t, [T.fin[0], T.fin[0] + 0.8], easeInOut);
			const behind = 1 - fo;
			const d5 = progressIn(t, T.dark5, easeInOut);
			const darkOut = 1 - progressIn(t, T.darkOut, easeInOut);
			setStyle(base, { opacity: String(behind) });
			setStyle(bgw, { opacity: String((1 - d5) * behind) });
			setStyle(dark, { opacity: String(T.dark5Max * d5 * darkOut * behind) });
			const g5 = progressIn(t, T.glow5, easeInOut);
			setStyle(glow, { opacity: String(g5 * (1 - progressIn(t, T.auraOut, easeInOut)) * behind), transform: `scale(${0.85 + 0.3 * g5})` });

			const lift = progressIn(t, T.lift, easeLift);
			const kept = 1 - lift;
			const move = progressIn(t, T.logoMove, easeOut);
			setStyle(logo, {
				transform: `translate(${dx * move}px, ${dy * move}px) scale(${1 + T.liftScale * lift})`,
				filter: `blur(${T.liftBlur * lift}px)`,
				opacity: String(kept * behind),
			});
			const wordIn = progressIn(t, T.word, easeOut);
			setStyle(word, {
				opacity: String(wordIn * kept * behind),
				filter: `blur(${10 * (1 - wordIn) + (T.liftBlur - 2) * lift}px)`,
				transform: `translateY(${10 * (1 - wordIn)}px) scale(${1 + T.liftScale * lift})`,
			});
			const sw = progressIn(t, T.sweep, easeInOut);
			setStyle(sweep, { opacity: sw > 0 && sw < 1 ? "1" : "0", transform: `translateX(${-90 + 230 * sw}px) skewX(-18deg)` });
			const bp = progressIn(t, T.bloom, easeOut);
			setStyle(bloom, {
				opacity: String(bp * (1 - progressIn(t, [T.bloom[0] + 0.5, T.bloom[1] + 0.4], easeInOut)) * 0.85 * behind),
				transform: `scale(${0.75 + 0.45 * bp})`,
			});

			const fp = progressIn(t, T.fin, easeOut);
			setStyle(desk, { opacity: String(fo), transform: `scale(${1 + T.finScale * (1 - fp)})`, filter: `blur(${T.finBlur * (1 - fp)}px)` });
			if (items.length === 0 && t >= T.fin[0]) {
				items = DESK_ITEMS.map(all);
				for (const group of items) for (const element of group) setStyle(element, { "will-change": LAYER, transition: "none" });
			}
			items.forEach((group, index) => {
				const p = progressIn(t, [T.items + index * T.itemStep, T.items + index * T.itemStep + 0.9], easeOut);
				for (const element of group) setStyle(element, { opacity: String(p), transform: `translateY(${12 * (1 - p)}px)`, filter: `blur(${6 * (1 - p)}px)` });
			});

			if (!toured && t >= T.dim[0]) {
				toured = true;
				tourRef.current();
			}
		};

		const tick = (now: number): void => {
			const t = ((now - started) / 1000) * REVEAL_SPEED;
			if (t >= T.end) {
				render(T.end);
				endRef.current();
				return;
			}
			render(t);
			frame = window.requestAnimationFrame(tick);
		};
		render(0);
		frame = window.requestAnimationFrame(tick);
		return () => {
			window.cancelAnimationFrame(frame);
			for (const element of [...texts, badge, logo, sweep]) clearStyle(element ?? null);
			// The Finder holds its final frame (it is still under the first-run cover rule) until nothing moves;
			// then the cover rule goes and the inline styles with it, in one style pass.
			const finder = [desk, ...items.flat()];
			for (const element of finder) setStyle(element ?? null, { opacity: "1", transform: "none", filter: "none" });
			window.setTimeout(() => {
				releaseRef.current();
				for (const element of finder) clearStyle(element ?? null);
			}, RELEASE_MS);
		};
	}, [playing]);

	return (
		<div ref={root} className="fr-reveal" data-playing={playing ? "true" : undefined} aria-hidden="true">
			<div className="fr-reveal-back">
				<div className="fr-reveal-base" data-reveal="base" />
				<div className="fr-reveal-bgw" data-reveal="bgw" />
				<div className="fr-reveal-dark" data-reveal="dark" />
				<div className="fr-reveal-glow" data-reveal="glow" />
			</div>
			<div className="fr-reveal-front">
				<div className="fr-reveal-word" data-reveal="word">
					{APP_NAME}
				</div>
				<div className="fr-reveal-bloom" data-reveal="bloom" />
			</div>
		</div>
	);
}
