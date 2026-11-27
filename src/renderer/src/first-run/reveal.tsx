/**
 * The Ready → Finder hand-off (design: design-mockups/onboarding-intro-desktop-v3-fullscreen.html):
 *
 * 1. The ready copy fades while the Dazzi sunflower glides to the centre and the whole desktop dims into dusk.
 * 2. A breathing field of sunflower yellow, cream and sky blue wells up behind the mark and spreads across the
 *    desktop (drawn here and, behind the window, by the desktop windows of `src/main/reveal-backdrop.ts`), and
 *    "Dazzi" springs in letter by letter.
 * 3. The word and the mark leave, the mark turning as it fades, and the real Finder rises out of the light: the
 *    light parts exactly along the window's outline, which reads as clear glass and then clears.
 * 4. The rest of the light and the dusk lift and the tour takes over.
 */

import { useEffect, useRef, type ReactElement } from "react";
import { APP_NAME } from "../../../shared/app-info";
import { REVEAL_LIGHT_IDLE, type RevealLightFrame, type RevealLightScene } from "../../../shared/reveal-light";
import { WINDOW_DUSK_MAX, computeGlyphStates, computeRevealState, createRevealLightRenderer } from "./reveal-shader";
import { REVEAL_SPEED, REVEAL_T } from "./reveal-timing";

/** The Finder's parts in arrival order: sidebar, toolbar, left pane, right pane + inspector. */
const DESK_ITEMS: readonly string[] = [
	".desk .sidebar",
	".desk .toolbar",
	".desk .workspace-pane:first-of-type",
	".desk .workspace-pane + .workspace-pane, .desk .inspector-column",
];

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
	setStyle(document.querySelector<HTMLElement>(".desk"), {
		"will-change": LAYER,
		opacity: "0",
		transform: `translateY(${REVEAL_T.riseOffset}px) scale(${1 - REVEAL_T.riseScale})`,
		filter: `blur(${REVEAL_T.focusBlur}px)`,
		"transform-origin": "50% 50%",
	});
}

/** Undoes {@link prewarmReveal} when the Finder comes in another way (reduced motion). */
export function cancelPrewarm(): void {
	clearStyle(document.querySelector<HTMLElement>(".desk"));
}

/**
 * Plays the hand-off once. `onTour` fires once the light and the dusk have lifted, `onEnd` once the clock reaches
 * `end` (the same moment: whichever runs first ends the reveal).
 */
export function Reveal({
	playing,
	onTour,
	onEnd,
	onRelease,
}: {
	readonly playing: boolean;
	readonly onTour: () => void;
	readonly onEnd: () => void;
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
		const parts = [".fr-title", ".fr-lead", '[data-action="first-run-start"]', ".fr-status-mark", ".fr-done-mark", ".fr-reveal-sweep > span"].map(
			(selector) => ready?.querySelector<HTMLElement>(selector) ?? null,
		);
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
		const word = part("word");
		const glyphEls = Array.from(layer.querySelectorAll<HTMLElement>('[data-reveal="glyph"]'));
		const shaderCanvas = layer.querySelector<HTMLCanvasElement>('[data-reveal="shader"]');

		const ready = document.querySelector<HTMLElement>(".fr-ready");
		const texts = [
			ready?.querySelector<HTMLElement>(".fr-title"),
			ready?.querySelector<HTMLElement>(".fr-lead"),
			ready?.querySelector<HTMLElement>('[data-action="first-run-start"]'),
		];
		const badge = ready?.querySelector<HTMLElement>(".fr-status-mark") ?? null;
		const logo = ready?.querySelector<HTMLElement>(".fr-done-mark") ?? null;
		const sweep = ready?.querySelector<HTMLElement>(".fr-reveal-sweep > span") ?? null;
		const desk = document.querySelector<HTMLElement>(".desk");

		const box = logo?.getBoundingClientRect();
		const targetX = window.innerWidth / 2;
		const targetY = window.innerHeight / 2;
		const dx = box === undefined ? 0 : targetX - (box.left + box.width / 2);
		const dy = box === undefined ? 0 : targetY - (box.top + box.height / 2);
		setStyle(word, { top: `${targetY + 78}px` });

		const layered = { animation: "none", transition: "none", "will-change": LAYER };
		for (const element of [...texts, badge, logo, sweep, ...glyphEls]) setStyle(element ?? null, layered);
		setStyle(desk, { ...layered, "transform-origin": "50% 50%" });

		// Where this window sits on screen; the light is drawn in screen coordinates so it meets the desktop's.
		const scene: RevealLightScene = {
			originX: window.screenX,
			originY: window.screenY,
			windowX: window.screenX,
			windowY: window.screenY,
			windowWidth: window.innerWidth,
			windowHeight: window.innerHeight,
			unit: window.screen.height || window.innerHeight,
			duskMax: WINDOW_DUSK_MAX,
		};
		const lightRenderer = shaderCanvas !== null ? createRevealLightRenderer(shaderCanvas) : null;
		if (lightRenderer !== null) layer.setAttribute("data-backend", lightRenderer.backend);
		const setBackdrop = window.autorag?.onboarding?.setRevealBackdrop;
		const pushBackdrop = (frame: RevealLightFrame | null): void => {
			setBackdrop?.(frame);
		};

		let items: Styled[][] = [];
		let toured = false;
		let frame = 0;
		const started = performance.now();

		const render = (t: number): void => {
			const s = computeRevealState(t);
			layer.setAttribute("data-phase", s.phase);
			pushBackdrop(s.light);

			// The ready copy and its check badge fade away.
			texts.forEach((element, index) => {
				const p = s.textOut[index] ?? 1;
				setStyle(element ?? null, {
					opacity: String(1 - p),
					filter: p > 0.01 ? `blur(${(6 * p).toFixed(2)}px)` : "none",
					transform: `translateY(${(-8 * p).toFixed(2)}px)`,
				});
			});
			const badgeOut = s.textOut[0] ?? 1;
			setStyle(badge, { opacity: String(1 - badgeOut), transform: `scale(${(1 - 0.35 * badgeOut).toFixed(3)})` });
			setStyle(sweep, { opacity: "0" });

			// The ready screen's background gives way to the dusk.
			setStyle(base, { opacity: String(s.readyBg) });
			setStyle(bgw, { opacity: String(s.readyBg) });

			lightRenderer?.render(scene, s.light);

			// The sunflower stays crisp: it glides to the centre, then fades while it turns.
			setStyle(logo, {
				transform: `translate(${(dx * s.logo.move).toFixed(2)}px, ${(dy * s.logo.move).toFixed(2)}px) rotate(${s.logo.rotate.toFixed(2)}deg)`,
				filter: "none",
				opacity: String(s.logo.opacity),
			});

			// "Dazzi" springs in letter by letter, then fades.
			setStyle(word, {
				opacity: String(s.word.opacity),
				filter: s.word.blur > 0.05 ? `blur(${s.word.blur.toFixed(2)}px)` : "none",
			});
			const glyphs = computeGlyphStates(APP_NAME, t);
			glyphEls.forEach((el, index) => {
				const g = glyphs[index];
				if (g === undefined) return;
				setStyle(el, {
					opacity: String(g.opacity),
					filter: g.blur > 0.05 ? `blur(${g.blur.toFixed(2)}px)` : "none",
					transform: `translateY(${g.y.toFixed(2)}px)`,
				});
			});

			// The Finder rises out of the light, in step with the outline the shader cuts.
			setStyle(desk, {
				opacity: s.finder.visible ? "1" : "0",
				transform: `translateY(${s.finder.y.toFixed(2)}px) scale(${s.finder.scale.toFixed(4)})`,
				filter: s.finder.blur > 0.05 ? `blur(${s.finder.blur.toFixed(2)}px)` : "none",
			});
			if (items.length === 0 && s.finder.visible) {
				items = DESK_ITEMS.map(all);
				for (const group of items) for (const element of group) setStyle(element, { "will-change": LAYER, transition: "none" });
			}
			items.forEach((group, index) => {
				const p = s.finder.itemProgress[index] ?? 1;
				for (const element of group) {
					setStyle(element, {
						opacity: String(0.25 + 0.75 * p),
						transform: `translateY(${(10 * (1 - p)).toFixed(2)}px)`,
					});
				}
			});
			if (!toured && s.tourTriggered) {
				toured = true;
				tourRef.current();
			}
		};

		const tick = (now: number): void => {
			const t = ((now - started) / 1000) * REVEAL_SPEED;
			if (t >= REVEAL_T.end) {
				render(REVEAL_T.end);
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
			pushBackdrop(null);
			lightRenderer?.render(scene, REVEAL_LIGHT_IDLE);
			lightRenderer?.dispose();
			for (const element of [...texts, badge, logo, sweep, ...glyphEls]) clearStyle(element ?? null);
			const finder = [desk, ...items.flat()];
			for (const element of finder) setStyle(element ?? null, { opacity: "1", transform: "none", filter: "none" });
			window.setTimeout(() => {
				releaseRef.current();
				for (const element of finder) clearStyle(element ?? null);
			}, RELEASE_MS);
		};
	}, [playing]);

	const letters = Array.from(APP_NAME);

	return (
		<div ref={root} className="fr-reveal" data-playing={playing ? "true" : undefined} aria-hidden="true">
			<div className="fr-reveal-back">
				<div className="fr-reveal-base" data-reveal="base" />
				<div className="fr-reveal-bgw" data-reveal="bgw" />
				<canvas className="fr-reveal-shader" data-reveal="shader" />
			</div>
			<div className="fr-reveal-front">
				<div className="fr-reveal-word" data-reveal="word">
					{letters.map((char, index) => (
						<span key={index} className="fr-reveal-glyph" data-reveal="glyph">
							{char}
						</span>
					))}
				</div>
			</div>
		</div>
	);
}
