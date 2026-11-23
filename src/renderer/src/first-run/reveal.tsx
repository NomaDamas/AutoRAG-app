/**
 * The Ready → Finder hand-off, modeled after Arc & Dia Browser's onboarding intro
 * anchored on the Dazzi sunflower mark:
 *
 * 1. Ready copy softens away while the Dazzi sunflower glides to center and the stage
 *    dims into obsidian night.
 * 2. A WebGL liquid-glass orb (warm sunlight gold + crystal ice-blue Fresnel rim, matching
 *    Dazzi's glass icon tile) blooms and breathes behind the sunflower.
 * 3. "Dazzi" cascades in letter-by-letter with a 3D spring tilt & blur settle, followed by
 *    a silk specular sweep across the sunflower.
 * 4. An organic noise-warped aperture melts outward from behind the Dazzi mark with a
 *    golden-ice optical dispersion rim, revealing the real Finder pulling into crisp focus
 *    (sidebar, toolbar, left pane, right pane + inspector) before handing off to the tour.
 */

import { useEffect, useRef, type ReactElement } from "react";
import { APP_NAME } from "../../../shared/app-info";
import { computeArcRevealState, computeGlyphStates, createArcShaderRenderer } from "./reveal-shader";
import { REVEAL_SPEED, REVEAL_T, easeOut, progressIn } from "./reveal-timing";

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
 * Plays the Arc/Dia × Dazzi hand-off once. `onTour` fires at `REVEAL_T.dim[0]`;
 * `onEnd` fires once the clock reaches `end`.
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
		const targetY = window.innerHeight / 2 - 16;
		const dx = box === undefined ? 0 : targetX - (box.left + box.width / 2);
		const dy = box === undefined ? 0 : targetY - (box.top + box.height / 2);
		setStyle(word, { top: `${targetY + 86}px` });

		const layered = { animation: "none", transition: "none", "will-change": LAYER };
		for (const element of [...texts, badge, logo, sweep, ...glyphEls]) setStyle(element ?? null, layered);
		setStyle(desk, { ...layered, "transform-origin": "50% 50%" });

		const shaderRenderer = shaderCanvas !== null ? createArcShaderRenderer(shaderCanvas) : null;
		if (shaderRenderer !== null) {
			layer.setAttribute("data-backend", shaderRenderer.backend);
		}

		let items: Styled[][] = [];
		let toured = false;
		let frame = 0;
		const started = performance.now();
		const T = REVEAL_T;

		const render = (t: number): void => {
			const s = computeArcRevealState(t);
			layer.setAttribute("data-phase", s.phase);

			// Ready screen copy dissolves upward with soft focus pull
			texts.forEach((element, index) => {
				const p = progressIn(t, [T.textOut[0] + index * 0.07, T.textOut[1] + index * 0.07], easeOut);
				setStyle(element ?? null, {
					opacity: String(1 - p),
					filter: p > 0.01 ? `blur(${(10 * p).toFixed(2)}px)` : "none",
					transform: `translateY(${(-10 * p).toFixed(2)}px)`,
				});
				if (index === 0) setStyle(badge, { opacity: String(1 - p), transform: `scale(${(1 - 0.35 * p).toFixed(3)})` });
			});

			// Original ready backdrop hands over seamlessly to the WebGL shader canvas
			setStyle(base, { opacity: String(s.readyBgOpacity) });
			setStyle(bgw, { opacity: String(s.readyBgOpacity) });

			// WebGL liquid-glass orb + organic melt mask
			if (shaderRenderer !== null) {
				const dpr = Math.min(2, window.devicePixelRatio || 1);
				shaderRenderer.render(window.innerWidth, window.innerHeight, dpr, s, t);
			}

			// Centered Dazzi sunflower mark with warm optical glow
			const logoFilters: string[] = [];
			if (s.logo.blur > 0.05) logoFilters.push(`blur(${s.logo.blur.toFixed(2)}px)`);
			if (s.logo.halo > 0.05) {
				logoFilters.push(
					`drop-shadow(0 0 ${(20 * s.logo.halo).toFixed(1)}px rgba(255, 224, 148, 0.72)) drop-shadow(0 0 ${(44 * s.logo.halo).toFixed(1)}px rgba(112, 180, 255, 0.38))`,
				);
			}
			setStyle(logo, {
				transform: `translate(${(dx * s.logo.move).toFixed(2)}px, ${(dy * s.logo.move).toFixed(2)}px) scale(${s.logo.scale.toFixed(4)})`,
				filter: logoFilters.length > 0 ? logoFilters.join(" ") : "none",
				opacity: String(s.logo.opacity),
			});

			// Silk specular light sweep masked to the sunflower silhouette
			setStyle(sweep, {
				opacity: s.sweep > 0 && s.sweep < 1 ? "1" : "0",
				transform: `translateX(${(-90 + 230 * s.sweep).toFixed(2)}px) skewX(-18deg)`,
			});

			// Arc/Dia per-letter 3D spring cascade for "Dazzi", lifted softly as the melt opens
			setStyle(word, {
				opacity: String(s.wordLift.opacity),
				filter: s.wordLift.blur > 0.05 ? `blur(${s.wordLift.blur.toFixed(2)}px)` : "none",
				transform: `translateY(${s.wordLift.y.toFixed(2)}px) scale(${s.wordLift.scale.toFixed(4)})`,
			});
			const glyphs = computeGlyphStates(APP_NAME, t);
			glyphEls.forEach((el, index) => {
				const g = glyphs[index];
				if (g === undefined) return;
				setStyle(el, {
					opacity: String(g.opacity),
					filter: g.blur > 0.05 ? `blur(${g.blur.toFixed(2)}px)` : "none",
					transform: `translateY(${g.y.toFixed(2)}px) rotate(${g.rotateZ.toFixed(2)}deg) scale(${g.scale.toFixed(4)})`,
				});
			});

			// Live Finder emerges crisp through the organic melt aperture
			setStyle(desk, {
				opacity: String(s.finder.opacity),
				transform: `scale(${s.finder.scale.toFixed(4)})`,
				filter: s.finder.blur > 0.05 ? `blur(${s.finder.blur.toFixed(2)}px)` : "none",
			});
			if (items.length === 0 && t >= T.fin[0]) {
				items = DESK_ITEMS.map(all);
				for (const group of items) for (const element of group) setStyle(element, { "will-change": LAYER, transition: "none" });
			}
			items.forEach((group, index) => {
				const p = s.finder.itemProgress[index] ?? 1;
				const vis = 0.25 + 0.75 * p;
				for (const element of group) {
					setStyle(element, {
						opacity: String(vis),
						transform: `translateY(${(10 * (1 - p)).toFixed(2)}px)`,
						filter: p < 0.995 ? `blur(${(4.5 * (1 - p)).toFixed(2)}px)` : "none",
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
			shaderRenderer?.dispose();
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
