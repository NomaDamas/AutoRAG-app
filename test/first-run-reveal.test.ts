import { describe, expect, it, vi } from "vitest";
import {
	REVEAL_SPEED,
	REVEAL_T,
	bezier,
	easeExpoOut,
	easeInQuad,
	easeOut,
	easePop,
	progressIn,
	revealMs,
	revealPhaseAt,
} from "../src/renderer/src/first-run/reveal-timing";
import { computeRevealState, createRevealScene, drawRevealCanvas } from "../src/renderer/src/first-run/reveal-scene";

describe("Cosmic × Banksy × Pop-Anime Ready → Finder reveal timing", () => {
	it("plays in a tight ~5 s cinematic arc well under the tour timeout", () => {
		const totalMs = revealMs(REVEAL_T.end);
		const tourMs = revealMs(REVEAL_T.dim[0]);
		expect(REVEAL_SPEED).toBeGreaterThan(0);
		expect(totalMs).toBeGreaterThanOrEqual(4500);
		expect(totalMs).toBeLessThanOrEqual(5800);
		expect(tourMs).toBeGreaterThanOrEqual(4000);
		expect(tourMs).toBeLessThan(totalMs);
	});

	it("orders every dramatic beat: implosion → impact → supernova → stencil imprint → portal → Finder settle before dim", () => {
		expect(REVEAL_T.impact[0]).toBeGreaterThan(REVEAL_T.textOut[0]);
		expect(REVEAL_T.impact[1]).toBeGreaterThan(REVEAL_T.impact[0]);
		expect(REVEAL_T.shockwave[0]).toBeGreaterThanOrEqual(REVEAL_T.impact[0]);
		expect(REVEAL_T.word[0]).toBeGreaterThan(REVEAL_T.impact[1]);
		expect(REVEAL_T.sweep[0]).toBeGreaterThanOrEqual(REVEAL_T.word[0]);
		expect(REVEAL_T.portal[0]).toBeGreaterThan(REVEAL_T.word[1]);
		expect(REVEAL_T.fin[1]).toBeLessThanOrEqual(REVEAL_T.dim[0]);
		expect(REVEAL_T.items + 3 * REVEAL_T.itemStep + 0.65).toBeLessThanOrEqual(REVEAL_T.dim[0]);
	});

	it("walks every choreography phase in sequence", () => {
		expect(revealPhaseAt(0)).toBe("implosion");
		expect(revealPhaseAt((REVEAL_T.impact[0] + REVEAL_T.impact[1]) / 2)).toBe("impact");
		expect(revealPhaseAt(REVEAL_T.impact[1] + 0.25)).toBe("supernova");
		expect(revealPhaseAt(REVEAL_T.word[1] + 0.1)).toBe("imprint");
		expect(revealPhaseAt(REVEAL_T.portal[0] + 0.35)).toBe("portal");
		expect(revealPhaseAt(REVEAL_T.end)).toBe("done");
	});

	it("clamps progress and provides anime pop overshoot & Big Bang expo easings", () => {
		expect(progressIn(0, [0.5, 1.5])).toBe(0);
		expect(progressIn(1, [0.5, 1.5])).toBe(0.5);
		expect(progressIn(9, [0.5, 1.5])).toBe(1);
		expect(progressIn(1, [0.5, 1.5], easeOut)).toBeGreaterThan(0.5);

		// Cel-anime overshoot: goes above 1.0 mid-curve and lands on 1.0
		expect(easePop(0)).toBeCloseTo(0, 5);
		expect(easePop(1)).toBeCloseTo(1, 5);
		expect(Math.max(easePop(0.45), easePop(0.55), easePop(0.65))).toBeGreaterThan(1.05);

		// Explosive Big Bang curve: fast initial burst
		expect(easeExpoOut(0)).toBeCloseTo(0, 5);
		expect(easeExpoOut(0.3)).toBeGreaterThan(0.85);
		expect(easeExpoOut(1)).toBeCloseTo(1, 5);

		// Gravitational collapse curve: accelerates inward
		expect(easeInQuad(0.25)).toBeCloseTo(0.0625, 5);
		expect(easeInQuad(1)).toBe(1);
	});

	it("solves a cubic-bezier from 0 to 1", () => {
		const linear = bezier(0, 0, 1, 1);
		expect(linear(0)).toBeCloseTo(0, 5);
		expect(linear(1)).toBeCloseTo(1, 5);
		expect(linear(0.5)).toBeCloseTo(0.5, 3);
	});
});

describe("Cosmic × Banksy × Pop-Anime frame state choreography", () => {
	it("starts on the exact idle ready-screen pose at t = 0", () => {
		const s = computeRevealState(0);
		expect(s.phase).toBe("implosion");
		expect(s.impactBeat).toBe("none");
		expect(s.cameraShake).toEqual({ x: 0, y: 0, rot: 0 });
		expect(s.logo.move).toBe(0);
		expect(s.logo.scale).toBeCloseTo(1, 4);
		expect(s.logo.opacity).toBe(1);
		expect(s.logo.blur).toBe(0);
		expect(s.word.opacity).toBe(0);
		expect(s.finder.opacity).toBe(0);
		expect(s.finder.blur).toBeCloseTo(REVEAL_T.finBlur, 4);
		expect(s.finder.scale).toBeCloseTo(1 + REVEAL_T.finScale, 4);
		expect(s.tourTriggered).toBe(false);
	});

	it("winds the sunflower up during implosion, triggers a 2-beat sakuga impact frame, then pops with overshoot", () => {
		const windup = computeRevealState(REVEAL_T.impact[0] - 0.08);
		expect(windup.logo.scale).toBeLessThan(0.95);
		expect(windup.logo.rotate).toBeLessThan(-2);

		const beat1 = computeRevealState(REVEAL_T.impact[0] + 0.02);
		const beat2 = computeRevealState(REVEAL_T.impact[1] - 0.02);
		expect(beat1.impactBeat).toBe("flash-white");
		expect(beat2.impactBeat).toBe("flash-invert");

		// Peak punch right after detonation
		const samples = [0.05, 0.12, 0.2, 0.28].map((dt) => computeRevealState(REVEAL_T.impact[1] + dt));
		const maxScale = Math.max(...samples.map((s) => s.logo.scale));
		expect(maxScale).toBeGreaterThan(1.22);

		// Visceral camera shake right at detonation, decaying to 0 when Finder settles
		const shakeMag = Math.hypot(samples[0]!.cameraShake.x, samples[0]!.cameraShake.y);
		expect(shakeMag).toBeGreaterThan(2);
		const settled = computeRevealState(REVEAL_T.fin[1]);
		expect(settled.cameraShake).toEqual({ x: 0, y: 0, rot: 0 });
	});

	it("slams the Banksy stencil wordmark with chromatic misregistration that snaps crisp", () => {
		const slam = computeRevealState(REVEAL_T.word[0] + 0.1);
		expect(slam.word.opacity).toBeGreaterThan(0.1);
		expect(slam.word.chromaSplit).toBeGreaterThan(1.5);

		const crowned = computeRevealState(REVEAL_T.word[1] + 0.25);
		expect(crowned.word.opacity).toBeGreaterThan(0.95);
		expect(crowned.word.chromaSplit).toBeLessThanOrEqual(4.5);
	});

	it("opens a cosmic portal and settles the Finder completely crisp before handing off to the tour", () => {
		const midPortal = computeRevealState((REVEAL_T.portal[0] + REVEAL_T.portal[1]) / 2);
		expect(midPortal.cosmos.portalOpen).toBeGreaterThan(0.1);
		expect(midPortal.cosmos.portalOpen).toBeLessThan(1);

		const handoff = computeRevealState(REVEAL_T.dim[0]);
		expect(handoff.tourTriggered).toBe(true);
		expect(handoff.finder.opacity).toBe(1);
		expect(handoff.finder.blur).toBe(0);
		expect(handoff.finder.scale).toBe(1);
		expect(handoff.finder.itemProgress).toEqual([1, 1, 1, 1]);
		expect(handoff.logo.opacity).toBe(0);
		expect(handoff.word.opacity).toBe(0);
		expect(handoff.cosmos.opacity).toBe(0);
	});

	it("remains numerically finite and clamped across negative, in-range, and post-end timestamps", () => {
		for (let i = 0; i <= 120; i += 1) {
			const t = -0.5 + (i / 120) * (REVEAL_T.end + 1.5);
			const s = computeRevealState(t);
			const numbers = [
				s.cameraShake.x,
				s.cameraShake.y,
				s.cameraShake.rot,
				s.logo.move,
				s.logo.scale,
				s.logo.rotate,
				s.logo.blur,
				s.logo.opacity,
				s.logo.glow,
				s.word.opacity,
				s.word.scale,
				s.word.y,
				s.word.blur,
				s.word.chromaSplit,
				s.sweep,
				s.bloom.opacity,
				s.bloom.scale,
				s.cosmos.opacity,
				s.cosmos.bgFade,
				s.cosmos.nebulaAlpha,
				s.cosmos.halftoneAlpha,
				s.cosmos.cropMarksAlpha,
				s.cosmos.portalOpen,
				s.finder.opacity,
				s.finder.scale,
				s.finder.blur,
				...s.finder.itemProgress,
			];
			for (const value of numbers) {
				expect(Number.isFinite(value), `non-finite value at t=${t}`).toBe(true);
			}
			for (const opacity of [s.logo.opacity, s.word.opacity, s.bloom.opacity, s.cosmos.opacity, s.cosmos.bgFade, s.finder.opacity, ...s.finder.itemProgress]) {
				expect(opacity, `opacity out of [0,1] at t=${t}`).toBeGreaterThanOrEqual(0);
				expect(opacity, `opacity out of [0,1] at t=${t}`).toBeLessThanOrEqual(1);
			}
		}
	});
});

describe("Deterministic procedural cosmic × street-art × pop-anime scene", () => {
	it("generates a reproducible, rich scene with stars, speedlines, Banksy splatters, shockwaves, and Right Now pop motifs", () => {
		const a = createRevealScene(42);
		const b = createRevealScene(42);
		expect(a).toEqual(b);

		expect(a.stars.length).toBeGreaterThanOrEqual(160);
		expect(a.speedLines.length).toBeGreaterThanOrEqual(48);
		expect(a.splatters.length).toBeGreaterThanOrEqual(36);
		expect(a.splatters.some((sp) => sp.dripLength > 0)).toBe(true);
		expect(a.shockRings.length).toBeGreaterThanOrEqual(4);

		const motifKinds = new Set(a.popMotifs.map((m) => m.kind));
		expect(motifKinds.has("flower")).toBe(true);
		expect(motifKinds.has("sparkle")).toBe(true);
		expect(motifKinds.has("ring")).toBe(true);
		expect(motifKinds.has("bolt")).toBe(true);
	});

	it("draws both back and front layers across every choreography act without throwing and carves the portal cutout", () => {
		const ops: string[] = [];
		const compositeModes: string[] = [];
		const grad = { addColorStop: vi.fn() };
		const ctx = {
			save: vi.fn(() => ops.push("save")),
			restore: vi.fn(() => ops.push("restore")),
			clearRect: vi.fn(),
			fillRect: vi.fn(),
			beginPath: vi.fn(),
			closePath: vi.fn(),
			moveTo: vi.fn(),
			lineTo: vi.fn(),
			quadraticCurveTo: vi.fn(),
			bezierCurveTo: vi.fn(),
			arc: vi.fn(),
			ellipse: vi.fn(),
			rect: vi.fn(),
			fill: vi.fn(),
			stroke: vi.fn(),
			clip: vi.fn(),
			translate: vi.fn(),
			rotate: vi.fn(),
			scale: vi.fn(),
			setLineDash: vi.fn(),
			createRadialGradient: vi.fn(() => grad),
			createLinearGradient: vi.fn(() => grad),
			set globalCompositeOperation(mode: string) {
				compositeModes.push(mode);
			},
			get globalCompositeOperation() {
				return compositeModes.at(-1) ?? "source-over";
			},
			globalAlpha: 1,
			fillStyle: "#000",
			strokeStyle: "#000",
			lineWidth: 1,
			lineCap: "round",
			lineJoin: "round",
			shadowColor: "transparent",
			shadowBlur: 0,
		} as unknown as CanvasRenderingContext2D;

		const scene = createRevealScene();
		const timestamps = [
			0.3,
			REVEAL_T.impact[0] + 0.02,
			REVEAL_T.impact[1] - 0.02,
			REVEAL_T.impact[1] + 0.35,
			REVEAL_T.word[1] + 0.2,
			(REVEAL_T.portal[0] + REVEAL_T.portal[1]) / 2,
			REVEAL_T.dim[0],
		];

		for (const t of timestamps) {
			const state = computeRevealState(t);
			expect(() => drawRevealCanvas(ctx, 1280, 800, scene, state, t, "back")).not.toThrow();
			expect(() => drawRevealCanvas(ctx, 1280, 800, scene, state, t, "front")).not.toThrow();
		}

		expect(compositeModes).toContain("destination-out");
		expect(ops.filter((o) => o === "save").length).toBe(ops.filter((o) => o === "restore").length);
	});
});
