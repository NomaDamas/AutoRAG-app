/**
 * Deterministic procedural art engine for the Ready → Finder cosmic pop-art reveal.
 *
 * Blends three visual languages on dual HTML5 2D canvases (back cosmos + front art burst)
 * synchronized with DOM typography and the live Finder behind a radial portal cutout:
 * - Cosmic genesis: gravitational singularity, warp-field star trails, magenta/cyan/gold nebula,
 *   concentric relativistic shockwaves, and a starburst portal rip.
 * - Banksy street stencil: aerosol spray mist, paint splatters with gravity drips, stark B&W ink
 *   flashes, halftone comic-dot grid, and registration crop marks.
 * - NewJeans "Right Now" × Takashi Murakami / cel-anime: 2-beat sakuga impact frames, crisp
 *   thick-inked pop stickers (smiling pastel flowers, Y2K 4-point sparkles, pixel hearts, electric
 *   bolts, candy rings), radial manga speedlines, and chromatic misregistration.
 */

import {
	REVEAL_T,
	easeExpoOut,
	easeInOut,
	easeInQuad,
	easeLift,
	easeOut,
	easePop,
	progressIn,
	revealPhaseAt,
	type RevealPhase,
} from "./reveal-timing";

export type ImpactBeat = "none" | "flash-white" | "flash-invert";

export type PopMotifKind = "flower" | "sparkle" | "ring" | "bolt" | "heart";

export interface StarSpec {
	readonly angle: number;
	readonly radius: number;
	readonly speed: number;
	readonly size: number;
	readonly color: string;
	readonly twinklePhase: number;
	readonly depth: number;
}

export interface SpeedLineSpec {
	readonly angle: number;
	readonly innerRatio: number;
	readonly width: number;
	readonly lengthRatio: number;
	readonly color: string;
	readonly phase: number;
}

export interface SplatterSpec {
	readonly angle: number;
	readonly distRatio: number;
	readonly radius: number;
	readonly color: string;
	readonly dripLength: number;
	readonly dripWidth: number;
	readonly delay: number;
	readonly satellites: readonly { readonly dx: number; readonly dy: number; readonly r: number }[];
}

export interface PopMotifSpec {
	readonly kind: PopMotifKind;
	readonly angle: number;
	readonly launchRatio: number;
	readonly size: number;
	readonly primary: string;
	readonly secondary: string;
	readonly spinStart: number;
	readonly spinVel: number;
	readonly delay: number;
	readonly layer: "back" | "front";
}

export interface ShockRingSpec {
	readonly delay: number;
	readonly duration: number;
	readonly color: string;
	readonly strokeWidth: number;
	readonly dashed: boolean;
	readonly maxRatio: number;
}

export interface RevealScene {
	readonly stars: readonly StarSpec[];
	readonly speedLines: readonly SpeedLineSpec[];
	readonly splatters: readonly SplatterSpec[];
	readonly popMotifs: readonly PopMotifSpec[];
	readonly shockRings: readonly ShockRingSpec[];
}

export interface RevealFrameState {
	readonly phase: RevealPhase;
	readonly impactBeat: ImpactBeat;
	readonly cameraShake: { readonly x: number; readonly y: number; readonly rot: number };
	readonly logo: {
		readonly move: number;
		readonly scale: number;
		readonly rotate: number;
		readonly blur: number;
		readonly opacity: number;
		readonly glow: number;
	};
	readonly word: {
		readonly opacity: number;
		readonly scale: number;
		readonly y: number;
		readonly blur: number;
		readonly chromaSplit: number;
	};
	readonly sweep: number;
	readonly bloom: { readonly opacity: number; readonly scale: number };
	readonly cosmos: {
		readonly opacity: number;
		readonly bgFade: number;
		readonly nebulaAlpha: number;
		readonly halftoneAlpha: number;
		readonly cropMarksAlpha: number;
		readonly portalOpen: number;
	};
	readonly finder: {
		readonly opacity: number;
		readonly scale: number;
		readonly blur: number;
		readonly itemProgress: readonly [number, number, number, number];
	};
	readonly tourTriggered: boolean;
}

const COSMIC_PALETTE = {
	voidDeep: "#07060f",
	voidIndigo: "#120a2a",
	sunGold: "#FFD60A",
	solarOrange: "#FF7A00",
	hotPink: "#FF2E93",
	neonCyan: "#00F0FF",
	acidLime: "#C8FF00",
	electricViolet: "#8B5CF6",
	chalkWhite: "#FAF8F2",
	stencilInk: "#09090D",
} as const;

const STAR_COLORS = [
	COSMIC_PALETTE.chalkWhite,
	"#FFF3C4",
	COSMIC_PALETTE.neonCyan,
	COSMIC_PALETTE.hotPink,
	COSMIC_PALETTE.sunGold,
	"#B8B5FF",
] as const;

const SPLATTER_COLORS = [
	COSMIC_PALETTE.hotPink,
	COSMIC_PALETTE.neonCyan,
	COSMIC_PALETTE.sunGold,
	COSMIC_PALETTE.acidLime,
	COSMIC_PALETTE.chalkWhite,
	COSMIC_PALETTE.electricViolet,
] as const;

const POP_PAIRS: readonly (readonly [string, string])[] = [
	[COSMIC_PALETTE.hotPink, COSMIC_PALETTE.sunGold],
	[COSMIC_PALETTE.neonCyan, COSMIC_PALETTE.chalkWhite],
	[COSMIC_PALETTE.sunGold, COSMIC_PALETTE.hotPink],
	[COSMIC_PALETTE.acidLime, COSMIC_PALETTE.electricViolet],
	["#FF9AD5", COSMIC_PALETTE.neonCyan],
	[COSMIC_PALETTE.electricViolet, COSMIC_PALETTE.acidLime],
	[COSMIC_PALETTE.solarOrange, COSMIC_PALETTE.chalkWhite],
];

const MOTIF_KINDS: readonly PopMotifKind[] = ["flower", "sparkle", "ring", "bolt", "heart"];

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

/** Seeded Mulberry32 PRNG for deterministic, reproducible art frames. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Builds all deterministic procedural elements for one reveal playback. */
export function createRevealScene(seed = 20260722): RevealScene {
	const rand = mulberry32(seed);

	const stars: StarSpec[] = [];
	for (let i = 0; i < 210; i += 1) {
		stars.push({
			angle: rand() * Math.PI * 2,
			radius: 0.04 + Math.sqrt(rand()) * 0.96,
			speed: 0.45 + rand() * 1.45,
			size: 0.8 + rand() * 2.5,
			color: STAR_COLORS[Math.floor(rand() * STAR_COLORS.length)]!,
			twinklePhase: rand() * Math.PI * 2,
			depth: 0.35 + rand() * 0.95,
		});
	}

	const speedLines: SpeedLineSpec[] = [];
	const lineCount = 68;
	for (let i = 0; i < lineCount; i += 1) {
		const jitter = (rand() - 0.5) * ((Math.PI * 2) / lineCount) * 0.72;
		speedLines.push({
			angle: (i / lineCount) * Math.PI * 2 + jitter,
			innerRatio: 0.16 + rand() * 0.28,
			width: 1.2 + rand() * 3.8,
			lengthRatio: 0.45 + rand() * 0.65,
			color: i % 7 === 0 ? COSMIC_PALETTE.neonCyan : i % 11 === 0 ? COSMIC_PALETTE.hotPink : i % 5 === 0 ? COSMIC_PALETTE.sunGold : COSMIC_PALETTE.chalkWhite,
			phase: rand() * Math.PI * 2,
		});
	}

	const splatters: SplatterSpec[] = [];
	for (let i = 0; i < 46; i += 1) {
		const satCount = 2 + Math.floor(rand() * 4);
		const satellites: { readonly dx: number; readonly dy: number; readonly r: number }[] = [];
		const baseR = 4 + rand() * 17;
		for (let s = 0; s < satCount; s += 1) {
			const sa = rand() * Math.PI * 2;
			const sd = baseR * (1.2 + rand() * 1.9);
			satellites.push({
				dx: Math.cos(sa) * sd,
				dy: Math.sin(sa) * sd,
				r: Math.max(1.4, baseR * (0.14 + rand() * 0.28)),
			});
		}
		const hasDrip = i % 3 === 0;
		splatters.push({
			angle: (i / 46) * Math.PI * 2 + (rand() - 0.5) * 0.26,
			distRatio: 0.22 + rand() * 0.66,
			radius: baseR,
			color: SPLATTER_COLORS[i % SPLATTER_COLORS.length]!,
			dripLength: hasDrip ? 28 + rand() * 96 : 0,
			dripWidth: hasDrip ? 2.2 + rand() * 3.4 : 0,
			delay: rand() * 0.28,
			satellites,
		});
	}

	const popMotifs: PopMotifSpec[] = [];
	const motifCount = 38;
	for (let i = 0; i < motifCount; i += 1) {
		const pair = POP_PAIRS[i % POP_PAIRS.length]!;
		const kind = MOTIF_KINDS[i % MOTIF_KINDS.length]!;
		const heroRing = i < 12;
		popMotifs.push({
			kind,
			angle: (i / motifCount) * Math.PI * 2 + (rand() - 0.5) * 0.24,
			launchRatio: heroRing ? 0.28 + rand() * 0.28 : 0.48 + rand() * 0.44,
			size:
				kind === "flower"
					? (heroRing ? 28 : 22) + rand() * 18
					: kind === "sparkle"
						? 18 + rand() * 18
						: 16 + rand() * 16,
			primary: pair[0],
			secondary: pair[1],
			spinStart: (rand() - 0.5) * 1.4,
			spinVel: (rand() > 0.5 ? 1 : -1) * (1.2 + rand() * 3.0),
			delay: rand() * 0.2,
			layer: i % 4 === 0 ? "back" : "front",
		});
	}

	const shockRings: ShockRingSpec[] = [
		{ delay: 0.0, duration: 1.05, color: COSMIC_PALETTE.chalkWhite, strokeWidth: 9, dashed: false, maxRatio: 1.28 },
		{ delay: 0.06, duration: 1.18, color: COSMIC_PALETTE.neonCyan, strokeWidth: 5, dashed: false, maxRatio: 1.24 },
		{ delay: 0.13, duration: 1.25, color: COSMIC_PALETTE.hotPink, strokeWidth: 4.5, dashed: true, maxRatio: 1.18 },
		{ delay: 0.21, duration: 1.32, color: COSMIC_PALETTE.sunGold, strokeWidth: 3.5, dashed: false, maxRatio: 1.12 },
		{ delay: 0.3, duration: 1.35, color: COSMIC_PALETTE.acidLime, strokeWidth: 2.5, dashed: true, maxRatio: 1.04 },
	];

	return { stars, speedLines, splatters, popMotifs, shockRings };
}

/** Pure frame-state solver for clock time `rawT` (seconds). */
export function computeRevealState(rawT: number): RevealFrameState {
	const t = Math.max(0, rawT);
	const T = REVEAL_T;
	const phase = revealPhaseAt(t);

	// Impact beats: split the impact window into pure-white sakuga flash + inverted neon flash
	const impactMid = (T.impact[0] + T.impact[1]) / 2;
	let impactBeat: ImpactBeat = "none";
	if (t >= T.impact[0] && t < impactMid) impactBeat = "flash-white";
	else if (t >= impactMid && t < T.impact[1]) impactBeat = "flash-invert";

	// Camera shake: subtle gravitational tremor before detonation + violent damped impulse right after
	let shakeX = 0;
	let shakeY = 0;
	let shakeRot = 0;
	if (t >= T.implode[0] && t < T.impact[0]) {
		const tremor = progressIn(t, [0.42, T.impact[0]], easeInQuad);
		shakeX = Math.sin(t * 78) * 3.2 * tremor;
		shakeY = Math.cos(t * 91) * 2.6 * tremor;
		shakeRot = Math.sin(t * 64) * 0.45 * tremor;
	} else if (t >= T.impact[0] && t < T.impact[1] + 0.78) {
		const post = Math.max(0, t - T.impact[1]);
		const env = Math.exp(-post * 4.2) * (1 - progressIn(t, [T.impact[1] + 0.45, T.impact[1] + 0.78], easeOut));
		shakeX = Math.sin(t * 95) * 14 * env;
		shakeY = Math.cos(t * 113) * 11 * env;
		shakeRot = Math.sin(t * 73) * 1.7 * env;
	} else if (t >= T.word[0] && t < T.word[0] + 0.32) {
		// Micro slam shake when the Banksy DAZZI stencil stamps down
		const slamDecay = 1 - progressIn(t, [T.word[0], T.word[0] + 0.32], easeOut);
		shakeX = Math.sin(t * 88) * 5 * slamDecay * slamDecay;
		shakeY = Math.cos(t * 102) * 4 * slamDecay * slamDecay;
	}

	// Finder reveal & portal
	const portalOpen = progressIn(t, T.portal, easeExpoOut);
	const finderOpacity = progressIn(t, [T.fin[0], T.fin[0] + 0.52], easeInOut);
	const finderFocus = progressIn(t, T.fin, easeOut);
	const behind = 1 - progressIn(t, [T.portal[0] + 0.35, T.dim[0] - 0.15], easeInOut);

	const itemProgress: [number, number, number, number] = [0, 1, 2, 3].map((index) =>
		progressIn(t, [T.items + index * T.itemStep, T.items + index * T.itemStep + 0.65], easeOut),
	) as [number, number, number, number];

	// Logo choreography: center move -> gravitational windup compress -> Big Bang cel-anime pop -> heroic hover -> portal lift
	const move = progressIn(t, T.logoMove, easeOut);
	const windup = progressIn(t, T.implode, easeInQuad);
	const postBang = progressIn(t, [T.impact[1], T.impact[1] + 0.62], easePop);
	const lift = progressIn(t, T.lift, easeLift);

	let logoScale = 1;
	let logoRotate = 0;
	if (t < T.impact[0]) {
		// Coils inward like a star about to go supernova
		logoScale = 1 - 0.24 * windup;
		logoRotate = -14 * windup;
	} else if (t < T.impact[1]) {
		logoScale = 0.72;
		logoRotate = -16;
	} else {
		// Pops past 1.28x then settles around 1.12x before lifting into the bloom
		const heroicBase = 0.72 + 0.52 * postBang;
		const heroSettle = progressIn(t, [T.impact[1] + 0.55, T.word[1] + 0.35], easeInOut);
		const hoverScale = heroicBase - 0.12 * heroSettle;
		logoScale = hoverScale + T.liftScale * lift;
		logoRotate = -16 * (1 - postBang) + Math.sin(Math.max(0, t - T.impact[1]) * 3.8) * 2.2 * (1 - lift);
	}
	const logoOpacity = clamp01((1 - lift) * behind);
	const logoBlur = T.liftBlur * lift;
	const logoGlow = clamp01(
		(t < T.impact[0] ? windup * 0.65 : 1) * (1 - lift) * behind,
	);

	// Banksy stencil wordmark ("DAZZI"): slams in with RGB chromatic offset, settles crisp, exits with lift
	const wordSlam = progressIn(t, T.word, easePop);
	const wordOpacity = clamp01(progressIn(t, [T.word[0], T.word[0] + 0.24], easeOut) * (1 - lift) * behind);
	const wordScale = (1.36 - 0.36 * wordSlam) * (1 + 0.16 * lift);
	const wordY = 26 * (1 - Math.min(1.15, wordSlam));
	const wordBlur = Math.max(0, 7 * (1 - progressIn(t, [T.word[0], T.word[0] + 0.26], easeOut)) + 10 * lift);
	const chromaDecay = 1 - progressIn(t, [T.word[0] + 0.06, T.word[1] + 0.3], easeOut);
	const wordChromaSplit = Math.max(0, 14 * chromaDecay + 2.4 * wordOpacity);

	// Light sweep across the sunflower & tight supernova flash before the starburst portal tear
	const sweep = progressIn(t, T.sweep, easeInOut);
	const bloomIn = progressIn(t, [T.bloom[0], T.bloom[0] + 0.22], easeOut);
	const bloomOut = 1 - progressIn(t, [T.bloom[0] + 0.18, T.bloom[1]], easeInOut);
	const bloomOpacity = clamp01(bloomIn * bloomOut * 0.78);
	const bloomScale = 0.55 + 0.8 * progressIn(t, T.bloom, easeExpoOut);
	// Cosmos backdrop envelope
	const bgFade = clamp01(1 - progressIn(t, [0.12, 0.78], easeInOut));
	const nebulaAlpha = clamp01(progressIn(t, [0.2, 1.1], easeOut) * (1 - progressIn(t, [T.portal[0] + 0.4, T.dim[0]], easeInOut)));
	const halftoneAlpha = clamp01(progressIn(t, [T.impact[1], T.impact[1] + 0.35], easeOut) * 0.72 * (1 - progressIn(t, [T.portal[0] + 0.15, T.portal[1]], easeInOut)));
	const cropMarksAlpha = clamp01(progressIn(t, [T.word[0] - 0.1, T.word[0] + 0.25], easeOut) * (1 - progressIn(t, [T.portal[0], T.portal[0] + 0.45], easeInOut)));
	const cosmosOpacity = clamp01(1 - progressIn(t, [T.portal[1] - 0.18, T.dim[0]], easeOut));

	return {
		phase,
		impactBeat,
		cameraShake: { x: shakeX, y: shakeY, rot: shakeRot },
		logo: {
			move,
			scale: logoScale,
			rotate: logoRotate,
			blur: logoBlur,
			opacity: logoOpacity,
			glow: logoGlow,
		},
		word: {
			opacity: wordOpacity,
			scale: wordScale,
			y: wordY,
			blur: wordBlur,
			chromaSplit: wordChromaSplit,
		},
		sweep,
		bloom: { opacity: bloomOpacity, scale: bloomScale },
		cosmos: {
			opacity: cosmosOpacity,
			bgFade,
			nebulaAlpha,
			halftoneAlpha,
			cropMarksAlpha,
			portalOpen,
		},
		finder: {
			opacity: finderOpacity,
			scale: 1 + T.finScale * (1 - finderFocus),
			blur: T.finBlur * (1 - finderFocus),
			itemProgress,
		},
		tourTriggered: t >= T.dim[0],
	};
}

// ------------------------------------------------------------------ drawing helpers

function drawPopFlower(ctx: CanvasRenderingContext2D, size: number, primary: string, secondary: string): void {
	const petals = 8;
	const petalR = size * 0.36;
	const orbit = size * 0.44;

	ctx.lineWidth = Math.max(2, size * 0.1);
	ctx.strokeStyle = COSMIC_PALETTE.stencilInk;
	ctx.lineJoin = "round";

	for (let i = 0; i < petals; i += 1) {
		const a = (i / petals) * Math.PI * 2;
		const px = Math.cos(a) * orbit;
		const py = Math.sin(a) * orbit;
		ctx.beginPath();
		ctx.arc(px, py, petalR, 0, Math.PI * 2);
		ctx.fillStyle = i % 2 === 0 ? primary : secondary;
		ctx.fill();
		ctx.stroke();
	}

	// Smiling Murakami / Right Now pop core
	ctx.beginPath();
	ctx.arc(0, 0, size * 0.38, 0, Math.PI * 2);
	ctx.fillStyle = COSMIC_PALETTE.sunGold;
	ctx.fill();
	ctx.stroke();

	// Eyes + happy grin
	ctx.fillStyle = COSMIC_PALETTE.stencilInk;
	ctx.beginPath();
	ctx.arc(-size * 0.12, -size * 0.06, size * 0.055, 0, Math.PI * 2);
	ctx.arc(size * 0.12, -size * 0.06, size * 0.055, 0, Math.PI * 2);
	ctx.fill();

	ctx.beginPath();
	ctx.arc(0, size * 0.03, size * 0.14, 0.15 * Math.PI, 0.85 * Math.PI);
	ctx.lineWidth = Math.max(1.5, size * 0.07);
	ctx.stroke();
}

function drawSparkle(ctx: CanvasRenderingContext2D, size: number, primary: string, secondary: string): void {
	const outer = size;
	const inner = size * 0.24;
	ctx.beginPath();
	for (let i = 0; i < 8; i += 1) {
		const r = i % 2 === 0 ? outer : inner;
		const a = (i / 8) * Math.PI * 2;
		const x = Math.cos(a) * r;
		const y = Math.sin(a) * r;
		if (i === 0) ctx.moveTo(x, y);
		else ctx.lineTo(x, y);
	}
	ctx.closePath();
	ctx.fillStyle = primary;
	ctx.fill();
	ctx.lineWidth = Math.max(1.8, size * 0.1);
	ctx.strokeStyle = COSMIC_PALETTE.stencilInk;
	ctx.stroke();

	ctx.beginPath();
	ctx.arc(0, 0, size * 0.16, 0, Math.PI * 2);
	ctx.fillStyle = secondary;
	ctx.fill();
}

function drawPopRing(ctx: CanvasRenderingContext2D, size: number, primary: string, secondary: string): void {
	ctx.beginPath();
	ctx.arc(0, 0, size * 0.72, 0, Math.PI * 2);
	ctx.lineWidth = Math.max(3, size * 0.22);
	ctx.strokeStyle = COSMIC_PALETTE.stencilInk;
	ctx.stroke();

	ctx.beginPath();
	ctx.arc(0, 0, size * 0.72, 0, Math.PI * 2);
	ctx.lineWidth = Math.max(1.8, size * 0.12);
	ctx.strokeStyle = primary;
	ctx.stroke();

	ctx.beginPath();
	ctx.arc(size * 0.24, -size * 0.24, size * 0.16, 0, Math.PI * 2);
	ctx.fillStyle = secondary;
	ctx.fill();
}

function drawBolt(ctx: CanvasRenderingContext2D, size: number, primary: string, secondary: string): void {
	ctx.beginPath();
	ctx.moveTo(-size * 0.15, -size * 0.85);
	ctx.lineTo(size * 0.45, -size * 0.85);
	ctx.lineTo(size * 0.05, -size * 0.1);
	ctx.lineTo(size * 0.55, -size * 0.1);
	ctx.lineTo(-size * 0.35, size * 0.9);
	ctx.lineTo(-size * 0.08, size * 0.14);
	ctx.lineTo(-size * 0.52, size * 0.14);
	ctx.closePath();
	ctx.fillStyle = primary;
	ctx.fill();
	ctx.lineWidth = Math.max(1.8, size * 0.1);
	ctx.strokeStyle = COSMIC_PALETTE.stencilInk;
	ctx.stroke();

	ctx.beginPath();
	ctx.moveTo(0, -size * 0.52);
	ctx.lineTo(-size * 0.12, size * 0.28);
	ctx.lineWidth = Math.max(1.2, size * 0.06);
	ctx.strokeStyle = secondary;
	ctx.stroke();
}

function drawHeart(ctx: CanvasRenderingContext2D, size: number, primary: string, secondary: string): void {
	const s = size * 0.75;
	ctx.beginPath();
	ctx.moveTo(0, s * 0.65);
	ctx.bezierCurveTo(-s * 1.1, s * 0.05, -s * 0.9, -s * 0.9, 0, -s * 0.3);
	ctx.bezierCurveTo(s * 0.9, -s * 0.9, s * 1.1, s * 0.05, 0, s * 0.65);
	ctx.closePath();
	ctx.fillStyle = primary;
	ctx.fill();
	ctx.lineWidth = Math.max(2, size * 0.1);
	ctx.strokeStyle = COSMIC_PALETTE.stencilInk;
	ctx.stroke();

	ctx.beginPath();
	ctx.arc(-s * 0.28, -s * 0.24, s * 0.15, 0, Math.PI * 2);
	ctx.fillStyle = secondary;
	ctx.fill();
}

function drawPopMotif(ctx: CanvasRenderingContext2D, motif: PopMotifSpec, size: number): void {
	switch (motif.kind) {
		case "flower":
			drawPopFlower(ctx, size, motif.primary, motif.secondary);
			return;
		case "sparkle":
			drawSparkle(ctx, size, motif.primary, motif.secondary);
			return;
		case "ring":
			drawPopRing(ctx, size, motif.primary, motif.secondary);
			return;
		case "bolt":
			drawBolt(ctx, size, motif.primary, motif.secondary);
			return;
		case "heart":
			drawHeart(ctx, size, motif.primary, motif.secondary);
			return;
	}
}

function drawBanksyCropMarks(ctx: CanvasRenderingContext2D, width: number, height: number, alpha: number, t: number): void {
	if (alpha <= 0.01) return;
	const pad = Math.min(width, height) * 0.055;
	const arm = 26;
	ctx.save();
	ctx.globalAlpha = alpha * 0.82;
	ctx.strokeStyle = COSMIC_PALETTE.chalkWhite;
	ctx.lineWidth = 2;

	const corners: readonly (readonly [number, number, number, number])[] = [
		[pad, pad, 1, 1],
		[width - pad, pad, -1, 1],
		[pad, height - pad, 1, -1],
		[width - pad, height - pad, -1, -1],
	];
	for (const [cx, cy, sx, sy] of corners) {
		ctx.beginPath();
		ctx.moveTo(cx, cy + sy * arm);
		ctx.lineTo(cx, cy);
		ctx.lineTo(cx + sx * arm, cy);
		ctx.stroke();
	}

	// Subtle Banksy spray-stencil registration crosshairs along top & bottom edges
	const midX = width / 2;
	const pulse = 0.65 + 0.35 * Math.sin(t * 14);
	ctx.globalAlpha = alpha * 0.55 * pulse;
	ctx.strokeStyle = COSMIC_PALETTE.neonCyan;
	ctx.lineWidth = 1.5;
	for (const y of [pad + 6, height - pad - 6]) {
		ctx.beginPath();
		ctx.moveTo(midX - 18, y);
		ctx.lineTo(midX + 18, y);
		ctx.moveTo(midX, y - 6);
		ctx.lineTo(midX, y + 6);
		ctx.stroke();
	}

	// Corner spray-can paint tags (neon magenta + acid lime accent slashes)
	ctx.globalAlpha = alpha * 0.9;
	ctx.fillStyle = COSMIC_PALETTE.hotPink;
	ctx.fillRect(pad + 34, pad - 2, 18, 4);
	ctx.fillStyle = COSMIC_PALETTE.acidLime;
	ctx.fillRect(pad + 56, pad - 2, 8, 4);
	ctx.fillStyle = COSMIC_PALETTE.neonCyan;
	ctx.fillRect(width - pad - 56, height - pad - 2, 22, 4);

	ctx.restore();
}

function drawHalftoneBackdrop(ctx: CanvasRenderingContext2D, width: number, height: number, cx: number, cy: number, maxR: number, alpha: number): void {
	if (alpha <= 0.01) return;
	const step = 30;
	ctx.save();
	ctx.fillStyle = COSMIC_PALETTE.hotPink;
	for (let y = step * 0.5; y < height; y += step) {
		for (let x = step * 0.5; x < width; x += step) {
			const dist = Math.hypot(x - cx, y - cy) / maxR;
			if (dist < 0.34) continue;
			const dotR = Math.min(4.6, Math.max(0.9, (dist - 0.3) * 6.2));
			ctx.globalAlpha = alpha * Math.min(0.45, (dist - 0.3) * 0.52);
			ctx.beginPath();
			ctx.arc(x, y, dotR, 0, Math.PI * 2);
			ctx.fill();
		}
	}
	ctx.restore();
}

function drawStarburstPolygon(ctx: CanvasRenderingContext2D, cx: number, cy: number, innerR: number, outerR: number, spikes: number, rotation: number): void {
	ctx.beginPath();
	const total = spikes * 2;
	for (let i = 0; i < total; i += 1) {
		const r = i % 2 === 0 ? outerR : innerR;
		const a = rotation + (i / total) * Math.PI * 2;
		const x = cx + Math.cos(a) * r;
		const y = cy + Math.sin(a) * r;
		if (i === 0) ctx.moveTo(x, y);
		else ctx.lineTo(x, y);
	}
	ctx.closePath();
}

/**
 * Renders either the `"back"` layer (deep space, nebula, halftone, warp stars, portal cutout)
 * or the `"front"` layer (sakuga impact flash, shockwaves, Banksy spray splatters, Right Now pop motifs,
 * anime speedlines, viewfinder crop marks) for the current frame.
 */
export function drawRevealCanvas(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	scene: RevealScene,
	state: RevealFrameState,
	rawT: number,
	layer: "back" | "front",
): void {
	const t = Math.max(0, rawT);
	const T = REVEAL_T;
	ctx.clearRect(0, 0, width, height);
	if (width <= 0 || height <= 0 || state.cosmos.opacity <= 0.002) return;

	const cx = width / 2;
	const cy = height / 2 - 16;
	const maxR = Math.hypot(width, height) * 0.62;

	if (layer === "back") {
		ctx.save();
		ctx.globalAlpha = state.cosmos.opacity;

		// 1. Deep cosmic void coming in as the ready stage fades out
		const voidAlpha = clamp01(1 - state.cosmos.bgFade * 0.92);
		if (voidAlpha > 0.01) {
			const spaceGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR * 1.1);
			spaceGrad.addColorStop(0, COSMIC_PALETTE.voidIndigo);
			spaceGrad.addColorStop(0.55, COSMIC_PALETTE.voidDeep);
			spaceGrad.addColorStop(1, "#030308");
			ctx.globalAlpha = state.cosmos.opacity * voidAlpha;
			ctx.fillStyle = spaceGrad;
			ctx.fillRect(0, 0, width, height);
		}

		// 2. Cosmic genesis nebula clouds (hot magenta + electric cyan + solar gold)
		if (state.cosmos.nebulaAlpha > 0.01) {
			const swirl = t * 0.45;
			const clouds: readonly (readonly [number, number, number, string])[] = [
				[cx + Math.cos(swirl) * width * 0.18, cy + Math.sin(swirl) * height * 0.14, maxR * 0.65, "rgba(255, 46, 147, 0.38)"],
				[cx - Math.cos(swirl * 0.8) * width * 0.22, cy - Math.sin(swirl * 0.8) * height * 0.16, maxR * 0.7, "rgba(0, 240, 255, 0.34)"],
				[cx + Math.sin(swirl * 0.6) * width * 0.1, cy + Math.cos(swirl * 0.6) * height * 0.1, maxR * 0.48, "rgba(255, 214, 10, 0.32)"],
				[cx, cy, maxR * 0.44, "rgba(139, 92, 246, 0.42)"],
			];
			ctx.save();
			ctx.globalCompositeOperation = "screen";
			for (const [nx, ny, nr, color] of clouds) {
				const ng = ctx.createRadialGradient(nx, ny, 0, nx, ny, nr);
				ng.addColorStop(0, color);
				ng.addColorStop(1, "rgba(0, 0, 0, 0)");
				ctx.globalAlpha = state.cosmos.opacity * state.cosmos.nebulaAlpha;
				ctx.fillStyle = ng;
				ctx.fillRect(0, 0, width, height);
			}
			ctx.restore();
		}

		// 3. Pop-art comic halftone dot field framing the cosmos
		drawHalftoneBackdrop(ctx, width, height, cx, cy, maxR, state.cosmos.halftoneAlpha * state.cosmos.opacity);

		// 4. Implosion gravity well OR Big Bang warp starfield
		const implodeP = progressIn(t, T.implode, easeInQuad);
		const bangAge = Math.max(0, t - T.impact[0]);
		const starAlpha = clamp01(progressIn(t, [0.18, 0.72], easeOut) * state.cosmos.opacity);
		if (starAlpha > 0.01) {
			ctx.save();
			ctx.lineCap = "round";
			for (const star of scene.stars) {
				let rRatio: number;
				let tailLen: number;
				if (t < T.impact[0]) {
					// Sucked inward into the singularity
					rRatio = Math.max(0.02, star.radius * (1 - implodeP * 0.78));
					tailLen = 18 * implodeP * star.speed;
				} else {
					// Blasted outward in relativistic warp streaks
					const burst = easeExpoOut(clamp01(bangAge / 1.45));
					rRatio = (0.04 + star.radius * 0.25 + burst * star.speed * 0.92) % 1.25;
					tailLen = (48 * Math.exp(-bangAge * 1.4) + 7) * star.speed;
				}
				const dist = rRatio * maxR;
				const sx = cx + Math.cos(star.angle) * dist;
				const sy = cy + Math.sin(star.angle) * dist;
				const tx = cx + Math.cos(star.angle) * Math.max(0, dist - tailLen);
				const ty = cy + Math.sin(star.angle) * Math.max(0, dist - tailLen);
				const twinkle = 0.6 + 0.4 * Math.sin(t * 9 + star.twinklePhase);

				ctx.globalAlpha = starAlpha * twinkle * star.depth;
				ctx.strokeStyle = star.color;
				ctx.lineWidth = star.size;
				ctx.beginPath();
				ctx.moveTo(tx, ty);
				ctx.lineTo(sx, sy);
				ctx.stroke();

				if (star.size > 2.2) {
					ctx.fillStyle = COSMIC_PALETTE.chalkWhite;
					ctx.beginPath();
					ctx.arc(sx, sy, star.size * 0.65, 0, Math.PI * 2);
					ctx.fill();
				}
			}
			ctx.restore();
		}

		// 5. Back-layer swirling cosmic starburst behind the sunflower (counter-rotating dual cel-comic rays)
		if (t >= T.impact[1]) {
			const burstIn = progressIn(t, [T.impact[1], T.impact[1] + 0.42], easePop);
			const burstOut = 1 - progressIn(t, [T.portal[0], T.portal[1] - 0.1], easeInOut);
			const starR = maxR * 0.38 * burstIn;
			if (burstOut > 0.01 && starR > 2) {
				ctx.save();
				ctx.globalAlpha = 0.26 * burstOut * state.cosmos.opacity;
				drawStarburstPolygon(ctx, cx, cy, starR * 0.54, starR * 1.12, 16, -t * 0.22 + 0.18);
				ctx.fillStyle = COSMIC_PALETTE.hotPink;
				ctx.fill();
				ctx.lineWidth = 2.5;
				ctx.strokeStyle = COSMIC_PALETTE.neonCyan;
				ctx.stroke();

				ctx.globalAlpha = 0.34 * burstOut * state.cosmos.opacity;
				drawStarburstPolygon(ctx, cx, cy, starR * 0.44, starR, 16, t * 0.34);
				ctx.fillStyle = COSMIC_PALETTE.sunGold;
				ctx.fill();
				ctx.lineWidth = 3;
				ctx.strokeStyle = COSMIC_PALETTE.stencilInk;
				ctx.stroke();
				ctx.restore();
			}
		}

		// 6. Back-layer Right Now pop motifs orbiting in deep space
		if (t >= T.popBurst[0]) {
			const fadeOut = 1 - progressIn(t, [T.portal[0] + 0.1, T.portal[1]], easeInOut);
			for (const motif of scene.popMotifs) {
				if (motif.layer !== "back") continue;
				const age = t - (T.popBurst[0] + motif.delay);
				if (age <= 0 || fadeOut <= 0.01) continue;
				const fly = easeExpoOut(clamp01(age / 1.15));
				const popScale = easePop(clamp01(age / 0.32));
				const dist = (0.14 + motif.launchRatio * 0.85 * fly) * maxR;
				const mx = cx + Math.cos(motif.angle + age * 0.12) * dist;
				const my = cy + Math.sin(motif.angle + age * 0.12) * dist;
				ctx.save();
				ctx.globalAlpha = clamp01(fadeOut * 0.82 * state.cosmos.opacity);
				ctx.translate(mx, my);
				ctx.rotate(motif.spinStart + motif.spinVel * age);
				ctx.scale(popScale, popScale);
				drawPopMotif(ctx, motif, motif.size * 0.86);
				ctx.restore();
			}
		}

		// 7. Cosmic portal rip: destination-out starburst mask revealing the live Finder underneath!
		if (state.cosmos.portalOpen > 0.005) {
			const p = state.cosmos.portalOpen;
			const portalR = p * maxR * 1.42;
			ctx.save();
			ctx.globalCompositeOperation = "destination-out";
			ctx.fillStyle = "#000";
			drawStarburstPolygon(ctx, cx, cy, portalR * (0.76 + 0.24 * p), portalR, 14, p * 0.65);
			ctx.fill();
			ctx.restore();

			// Glowing dual-ink comic portal rim around the tear
			const rimAlpha = clamp01((1 - p) * 1.55);
			if (rimAlpha > 0.01) {
				ctx.save();
				ctx.globalAlpha = rimAlpha;
				drawStarburstPolygon(ctx, cx, cy, portalR * (0.76 + 0.24 * p), portalR, 14, p * 0.65);
				ctx.strokeStyle = COSMIC_PALETTE.hotPink;
				ctx.lineWidth = 16 * (1 - p * 0.55);
				ctx.stroke();
				ctx.strokeStyle = COSMIC_PALETTE.neonCyan;
				ctx.lineWidth = 8 * (1 - p * 0.55);
				ctx.stroke();
				ctx.strokeStyle = COSMIC_PALETTE.chalkWhite;
				ctx.lineWidth = 3;
				ctx.stroke();
				ctx.restore();
			}
		}
		ctx.restore();
		return;
	}

	// ------------------------------------------------------------------ FRONT LAYER
	ctx.save();
	ctx.globalAlpha = state.cosmos.opacity;

	// 1. Gravitational singularity core pulsing before detonation
	if (t < T.impact[0]) {
		const impl = progressIn(t, T.implode, easeInQuad);
		if (impl > 0.01) {
			// Converging ink arcs
			ctx.save();
			ctx.translate(cx, cy);
			ctx.rotate(impl * 3.4);
			for (let i = 0; i < 3; i += 1) {
				const ringR = (1 - impl * 0.72) * (160 + i * 75);
				ctx.beginPath();
				ctx.arc(0, 0, Math.max(8, ringR), i * 1.9, i * 1.9 + Math.PI * 1.15);
				ctx.strokeStyle = i === 0 ? COSMIC_PALETTE.sunGold : i === 1 ? COSMIC_PALETTE.neonCyan : COSMIC_PALETTE.hotPink;
				ctx.lineWidth = 2.5 + impl * 3;
				ctx.globalAlpha = impl * 0.85;
				ctx.stroke();
			}
			ctx.restore();

			// White-hot pinch core
			const coreR = 14 + impl * 32;
			const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.2);
			cg.addColorStop(0, "rgba(255, 255, 255, 0.95)");
			cg.addColorStop(0.4, "rgba(255, 214, 10, 0.55)");
			cg.addColorStop(1, "rgba(255, 46, 147, 0)");
			ctx.fillStyle = cg;
			ctx.globalAlpha = impl;
			ctx.beginPath();
			ctx.arc(cx, cy, coreR * 2.2, 0, Math.PI * 2);
			ctx.fill();
		}
	}

	// 2. Sakuga 2-beat impact frame (0.85–1.01 s): iconic anime frame-by-frame flash
	if (state.impactBeat !== "none") {
		const inverted = state.impactBeat === "flash-invert";
		ctx.save();
		ctx.fillStyle = inverted ? COSMIC_PALETTE.stencilInk : COSMIC_PALETTE.chalkWhite;
		ctx.globalAlpha = 0.96;
		ctx.fillRect(0, 0, width, height);

		// Razor black/neon comic burst rays on the impact frame
		ctx.strokeStyle = inverted ? COSMIC_PALETTE.neonCyan : COSMIC_PALETTE.stencilInk;
		ctx.lineCap = "butt";
		for (let i = 0; i < scene.speedLines.length; i += 1) {
			const line = scene.speedLines[i]!;
			const r0 = maxR * (inverted ? 0.08 : 0.14);
			const r1 = maxR * 1.25;
			ctx.lineWidth = line.width * (inverted ? 2.4 : 2.0);
			ctx.beginPath();
			ctx.moveTo(cx + Math.cos(line.angle) * r0, cy + Math.sin(line.angle) * r0);
			ctx.lineTo(cx + Math.cos(line.angle) * r1, cy + Math.sin(line.angle) * r1);
			ctx.stroke();
		}

		// Central jagged comic flash starburst
		drawStarburstPolygon(ctx, cx, cy, 78, 220, 12, inverted ? 0.25 : 0);
		ctx.fillStyle = inverted ? COSMIC_PALETTE.hotPink : COSMIC_PALETTE.sunGold;
		ctx.fill();
		ctx.lineWidth = 4;
		ctx.strokeStyle = inverted ? COSMIC_PALETTE.chalkWhite : COSMIC_PALETTE.stencilInk;
		ctx.stroke();
		ctx.restore();
		ctx.restore();
		return;
	}

	// 3. Relativistic Big Bang shockwave rings
	if (t >= T.shockwave[0]) {
		for (const ring of scene.shockRings) {
			const p = progressIn(t, [T.shockwave[0] + ring.delay, T.shockwave[0] + ring.delay + ring.duration], easeExpoOut);
			if (p <= 0 || p >= 1) continue;
			const r = p * maxR * ring.maxRatio;
			ctx.save();
			ctx.globalAlpha = (1 - p) * (1 - p * 0.4) * 0.92;
			ctx.strokeStyle = ring.color;
			ctx.lineWidth = Math.max(1, ring.strokeWidth * (1 - p * 0.72));
			if (ring.dashed) ctx.setLineDash([18, 12]);
			ctx.beginPath();
			ctx.arc(cx, cy, r, 0, Math.PI * 2);
			ctx.stroke();
			ctx.restore();
		}
	}

	// 4. Radial manga/anime speedlines pulsing from the edges during supernova & imprint
	if (t >= T.impact[1] && t < T.portal[1]) {
		const speedEnv =
			progressIn(t, [T.impact[1], T.impact[1] + 0.14], easeOut) *
			(1 - progressIn(t, [T.portal[0] - 0.1, T.portal[0] + 0.55], easeInOut));
		if (speedEnv > 0.01) {
			ctx.save();
			ctx.lineCap = "round";
			for (const line of scene.speedLines) {
				const pulse = 0.55 + 0.45 * Math.sin(t * 22 + line.phase);
				const r0 = maxR * (line.innerRatio + 0.28 * (1 - speedEnv) + 0.06 * pulse);
				const r1 = maxR * (line.innerRatio + line.lengthRatio + 0.42);
				ctx.globalAlpha = speedEnv * 0.52 * pulse;
				ctx.strokeStyle = line.color;
				ctx.lineWidth = line.width;
				ctx.beginPath();
				ctx.moveTo(cx + Math.cos(line.angle) * r0, cy + Math.sin(line.angle) * r0);
				ctx.lineTo(cx + Math.cos(line.angle) * r1, cy + Math.sin(line.angle) * r1);
				ctx.stroke();
			}
			ctx.restore();
		}
	}

	// 5. Banksy aerosol spray splatters + gravity paint drips
	if (t >= T.splatter[0]) {
		const splatFade = 1 - progressIn(t, [T.portal[0], T.portal[0] + 0.65], easeInOut);
		if (splatFade > 0.01) {
			ctx.save();
			for (const sp of scene.splatters) {
				const age = t - (T.splatter[0] + sp.delay);
				if (age <= 0) continue;
				const pop = easeExpoOut(clamp01(age / 0.22));
				const px = cx + Math.cos(sp.angle) * (sp.distRatio * maxR * (0.65 + 0.35 * pop));
				const py = cy + Math.sin(sp.angle) * (sp.distRatio * maxR * (0.65 + 0.35 * pop));
				const r = sp.radius * pop;

				ctx.globalAlpha = 0.88 * splatFade;
				ctx.fillStyle = sp.color;
				ctx.beginPath();
				ctx.arc(px, py, r, 0, Math.PI * 2);
				ctx.fill();

				// Micro aerosol satellites
				for (const sat of sp.satellites) {
					ctx.beginPath();
					ctx.arc(px + sat.dx * pop, py + sat.dy * pop, sat.r * pop, 0, Math.PI * 2);
					ctx.fill();
				}

				// Gravity paint drip slowly running down the stencil wall
				if (sp.dripLength > 0) {
					const dripP = easeOut(clamp01((age - 0.08) / 1.45));
					const dl = sp.dripLength * dripP;
					if (dl > 1) {
						ctx.strokeStyle = sp.color;
						ctx.lineWidth = sp.dripWidth;
						ctx.lineCap = "round";
						ctx.beginPath();
						ctx.moveTo(px, py + r * 0.5);
						ctx.lineTo(px, py + r * 0.5 + dl);
						ctx.stroke();

						ctx.beginPath();
						ctx.arc(px, py + r * 0.5 + dl, sp.dripWidth * 0.72, 0, Math.PI * 2);
						ctx.fill();
					}
				}
			}
			ctx.restore();
		}
	}

	// 6. Front-layer NewJeans "Right Now" × cel-anime pop motifs bursting outward
	if (t >= T.popBurst[0]) {
		const motifFade = 1 - progressIn(t, [T.portal[0] + 0.05, T.portal[1] - 0.15], easeInOut);
		if (motifFade > 0.01) {
			for (const motif of scene.popMotifs) {
				if (motif.layer !== "front") continue;
				const age = t - (T.popBurst[0] + motif.delay);
				if (age <= 0) continue;
				const fly = easeExpoOut(clamp01(age / 1.05));
				const popScale = easePop(clamp01(age / 0.34));
				const bob = Math.sin(age * 5.2 + motif.angle) * 7;
				const dist = (0.16 + motif.launchRatio * 0.86 * fly) * maxR;
				const mx = cx + Math.cos(motif.angle) * dist;
				const my = cy + Math.sin(motif.angle) * dist + bob;

				ctx.save();
				ctx.globalAlpha = clamp01(motifFade * 0.96);
				ctx.translate(mx, my);
				ctx.rotate(motif.spinStart + motif.spinVel * age);
				ctx.scale(popScale, popScale);
				drawPopMotif(ctx, motif, motif.size);
				ctx.restore();
			}
		}
	}

	// 7. Street-art viewfinder crop marks & registration tags
	drawBanksyCropMarks(ctx, width, height, state.cosmos.cropMarksAlpha, t);

	ctx.restore();
}
