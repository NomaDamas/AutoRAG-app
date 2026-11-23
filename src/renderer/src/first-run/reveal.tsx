/**
 * The Ready → Finder cosmic pop-art hand-off:
 * Gravitational implosion → 2-beat sakuga impact frame → Big Bang supernova with
 * NewJeans "Right Now" cel-anime pop motifs & Banksy stencil splatters/drips →
 * high-contrast chromatic stencil "DAZZI" imprint & sweep → starburst cosmic portal
 * ripping open into the live Finder.
 *
 * Drives dual 2D canvases (back cosmos + front art burst), the ready panel's sunflower
 * mark, the Finder (`.desk`), and clears every inline style once the hand-off settles.
 */

import { useEffect, useRef, type ReactElement } from "react";
import { APP_NAME } from "../../../shared/app-info";
import { computeRevealState, createRevealScene, drawRevealCanvas } from "./reveal-scene";
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

function syncCanvasSize(canvas: HTMLCanvasElement | null): { width: number; height: number; ctx: CanvasRenderingContext2D | null } {
	if (canvas === null) return { width: 0, height: 0, ctx: null };
	const width = Math.max(1, window.innerWidth);
	const height = Math.max(1, window.innerHeight);
	const dpr = Math.min(2, window.devicePixelRatio || 1);
	const targetW = Math.round(width * dpr);
	const targetH = Math.round(height * dpr);
	if (canvas.width !== targetW || canvas.height !== targetH) {
		canvas.width = targetW;
		canvas.height = targetH;
	}
	const ctx = canvas.getContext("2d");
	if (ctx !== null) {
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}
	return { width, height, ctx };
}

/**
 * Plays the hand-off once. `onTour` fires at the portal hand-off (`REVEAL_T.dim[0]`);
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
		const glow = part("glow");
		const word = part("word");
		const wordCyan = part("word-cyan");
		const wordPink = part("word-pink");
		const bloom = part("bloom");
		const backCanvas = layer.querySelector<HTMLCanvasElement>('[data-reveal="canvas-back"]');
		const frontCanvas = layer.querySelector<HTMLCanvasElement>('[data-reveal="canvas-front"]');
		const camera = part("camera");

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
		for (const element of [...texts, badge, logo, sweep]) setStyle(element ?? null, layered);
		setStyle(desk, { ...layered, "transform-origin": "50% 50%" });

		const scene = createRevealScene();
		let items: Styled[][] = [];
		let toured = false;
		let frame = 0;
		const started = performance.now();
		const T = REVEAL_T;

		const render = (t: number): void => {
			const s = computeRevealState(t);
			layer.setAttribute("data-phase", s.phase);

			// Ready screen copy gets pulled upward & blurs away into the singularity
			texts.forEach((element, index) => {
				const p = progressIn(t, [T.textOut[0] + index * 0.07, T.textOut[1] + index * 0.07], easeOut);
				setStyle(element ?? null, {
					opacity: String(1 - p),
					filter: `blur(${12 * p}px)`,
					transform: `translateY(${-18 * p}px) scale(${1 - 0.08 * p})`,
				});
				if (index === 0) setStyle(badge, { opacity: String(1 - p), transform: `scale(${1 - 0.5 * p})` });
			});

			// Original ready backdrop smoothly yields to the cosmic canvas
			setStyle(base, { opacity: String(s.cosmos.bgFade * s.cosmos.opacity) });
			setStyle(bgw, { opacity: String(s.cosmos.bgFade * s.cosmos.opacity) });

			// Camera shake on the front/back art stage
			const shakeTransform =
				s.cameraShake.x === 0 && s.cameraShake.y === 0 && s.cameraShake.rot === 0
					? "none"
					: `translate3d(${s.cameraShake.x.toFixed(2)}px, ${s.cameraShake.y.toFixed(2)}px, 0) rotate(${s.cameraShake.rot.toFixed(2)}deg)`;
			setStyle(camera, { transform: shakeTransform });

			// Central solar aura behind the sunflower
			setStyle(glow, {
				opacity: String(s.logo.glow),
				transform: `scale(${0.72 + 0.58 * s.logo.scale})`,
			});

			// Sunflower hero mark: winds up, blasts with pop overshoot, glows with neon solar halo
			const logoFilterParts: string[] = [];
			if (s.logo.blur > 0.05) logoFilterParts.push(`blur(${s.logo.blur.toFixed(2)}px)`);
			if (s.impactBeat === "flash-white") logoFilterParts.push("brightness(4) contrast(2)");
			else if (s.impactBeat === "flash-invert") logoFilterParts.push("invert(1) saturate(3) contrast(2)");
			else if (s.logo.glow > 0.1) {
				logoFilterParts.push(
					`drop-shadow(0 0 ${(22 * s.logo.glow).toFixed(1)}px rgba(255, 214, 10, 0.85)) drop-shadow(0 0 ${(44 * s.logo.glow).toFixed(1)}px rgba(255, 46, 147, 0.55))`,
				);
			}
			setStyle(logo, {
				transform: `translate(${(dx * s.logo.move + s.cameraShake.x * 0.65).toFixed(2)}px, ${(dy * s.logo.move + s.cameraShake.y * 0.65).toFixed(2)}px) rotate(${s.logo.rotate.toFixed(2)}deg) scale(${s.logo.scale.toFixed(4)})`,
				filter: logoFilterParts.length > 0 ? logoFilterParts.join(" ") : "none",
				opacity: String(s.logo.opacity),
			});

			// Stencil wordmark with Banksy chromatic cyan/magenta misregistration plates
			setStyle(word, {
				opacity: String(s.word.opacity),
				filter: s.word.blur > 0.05 ? `blur(${s.word.blur.toFixed(2)}px)` : "none",
				transform: `translateY(${s.word.y.toFixed(2)}px) scale(${s.word.scale.toFixed(4)})`,
			});
			const split = s.word.chromaSplit;
			setStyle(wordCyan, {
				transform: `translate(${(-split).toFixed(2)}px, ${(-split * 0.28).toFixed(2)}px)`,
				opacity: String(Math.min(1, s.word.opacity * (split > 0.5 ? 0.92 : 0.45))),
			});
			setStyle(wordPink, {
				transform: `translate(${split.toFixed(2)}px, ${(split * 0.28).toFixed(2)}px)`,
				opacity: String(Math.min(1, s.word.opacity * (split > 0.5 ? 0.92 : 0.45))),
			});

			// Light sweep over sunflower + supernova bloom handoff
			setStyle(sweep, {
				opacity: s.sweep > 0 && s.sweep < 1 ? "1" : "0",
				transform: `translateX(${(-90 + 230 * s.sweep).toFixed(2)}px) skewX(-18deg)`,
			});
			setStyle(bloom, {
				opacity: String(s.bloom.opacity),
				transform: `scale(${s.bloom.scale.toFixed(4)})`,
			});

			// Draw back cosmos (with portal cutout) and front art burst
			const back = syncCanvasSize(backCanvas);
			if (back.ctx !== null) drawRevealCanvas(back.ctx, back.width, back.height, scene, s, t, "back");
			const front = syncCanvasSize(frontCanvas);
			if (front.ctx !== null) drawRevealCanvas(front.ctx, front.width, front.height, scene, s, t, "front");

			// Pull the real Finder into crisp focus through the opening portal
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
				for (const element of group) {
					setStyle(element, {
						opacity: String(p),
						transform: `translateY(${(14 * (1 - p)).toFixed(2)}px)`,
						filter: p < 0.995 ? `blur(${(6 * (1 - p)).toFixed(2)}px)` : "none",
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
			for (const element of [...texts, badge, logo, sweep]) clearStyle(element ?? null);
			const finder = [desk, ...items.flat()];
			for (const element of finder) setStyle(element ?? null, { opacity: "1", transform: "none", filter: "none" });
			window.setTimeout(() => {
				releaseRef.current();
				for (const element of finder) clearStyle(element ?? null);
			}, RELEASE_MS);
		};
	}, [playing]);

	const brandLabel = APP_NAME.toUpperCase();

	return (
		<div ref={root} className="fr-reveal" data-playing={playing ? "true" : undefined} aria-hidden="true">
			<div className="fr-reveal-camera" data-reveal="camera">
				<div className="fr-reveal-back">
					<div className="fr-reveal-base" data-reveal="base" />
					<div className="fr-reveal-bgw" data-reveal="bgw" />
					<canvas className="fr-reveal-canvas" data-reveal="canvas-back" />
					<div className="fr-reveal-glow" data-reveal="glow" />
				</div>
				<div className="fr-reveal-front">
					<canvas className="fr-reveal-canvas" data-reveal="canvas-front" />
					<div className="fr-reveal-word" data-reveal="word">
						<span className="fr-reveal-word-plate fr-reveal-word-plate--cyan" data-reveal="word-cyan">
							{brandLabel}
						</span>
						<span className="fr-reveal-word-plate fr-reveal-word-plate--pink" data-reveal="word-pink">
							{brandLabel}
						</span>
						<span className="fr-reveal-word-core">{brandLabel}</span>
					</div>
					<div className="fr-reveal-bloom" data-reveal="bloom" />
				</div>
			</div>
		</div>
	);
}
