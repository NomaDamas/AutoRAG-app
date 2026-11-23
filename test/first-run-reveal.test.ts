import { describe, expect, it, vi } from "vitest";
import {
	REVEAL_SPEED,
	REVEAL_T,
	bezier,
	easeInOut,
	easeOut,
	easeSpring,
	glyphProgress,
	progressIn,
	revealMs,
	revealPhaseAt,
} from "../src/renderer/src/first-run/reveal-timing";
import {
	ARC_FRAGMENT_SHADER,
	ARC_VERTEX_SHADER,
	computeArcRevealState,
	computeGlyphStates,
	createArcShaderRenderer,
	drawFallbackReveal,
} from "../src/renderer/src/first-run/reveal-shader";

describe("Arc/Dia × Dazzi reveal timing & choreography clock", () => {
	it("runs in a tight ~4.7 s Arc/Dia cinematic arc well under the tour timeout", () => {
		const totalMs = revealMs(REVEAL_T.end);
		const tourMs = revealMs(REVEAL_T.dim[0]);
		expect(REVEAL_SPEED).toBeGreaterThan(0);
		expect(totalMs).toBeGreaterThanOrEqual(4200);
		expect(totalMs).toBeLessThanOrEqual(5200);
		expect(tourMs).toBeGreaterThanOrEqual(3800);
		expect(tourMs).toBeLessThan(totalMs);
	});

	it("orders every Arc/Dia beat: darken & gather → luminous orb & letter cascade → organic melt → Finder settle before dim", () => {
		expect(REVEAL_T.orbIn[0]).toBeGreaterThan(REVEAL_T.textOut[0]);
		expect(REVEAL_T.word[0]).toBeGreaterThan(REVEAL_T.orbIn[0]);
		expect(REVEAL_T.sweep[0]).toBeGreaterThanOrEqual(REVEAL_T.word[0]);
		expect(REVEAL_T.melt[0]).toBeGreaterThan(REVEAL_T.word[1]);
		expect(REVEAL_T.fin[0]).toBeGreaterThanOrEqual(REVEAL_T.melt[0]);
		expect(REVEAL_T.fin[1]).toBeLessThanOrEqual(REVEAL_T.dim[0]);
		expect(REVEAL_T.items + 3 * REVEAL_T.itemStep + 0.65).toBeLessThanOrEqual(REVEAL_T.dim[0]);
	});

	it("transitions monotonically through gather → orb → melt → settle → done", () => {
		expect(revealPhaseAt(0)).toBe("gather");
		expect(revealPhaseAt(REVEAL_T.word[0] + 0.2)).toBe("orb");
		expect(revealPhaseAt((REVEAL_T.melt[0] + REVEAL_T.melt[1]) / 2)).toBe("melt");
		expect(revealPhaseAt(REVEAL_T.dim[0] + 0.05)).toBe("settle");
		expect(revealPhaseAt(REVEAL_T.end)).toBe("done");
	});

	it("staggers per-glyph progress cleanly from first letter to last letter", () => {
		const mid = REVEAL_T.word[0] + 0.24;
		const p0 = glyphProgress(mid, 0, REVEAL_T.word[0], 0.055, 0.55);
		const p2 = glyphProgress(mid, 2, REVEAL_T.word[0], 0.055, 0.55);
		const p4 = glyphProgress(mid, 4, REVEAL_T.word[0], 0.055, 0.55);
		expect(p0).toBeGreaterThan(p2);
		expect(p2).toBeGreaterThan(p4);
		expect(glyphProgress(0, 0, REVEAL_T.word[0], 0.055, 0.55)).toBe(0);
		expect(glyphProgress(REVEAL_T.word[1] + 0.5, 4, REVEAL_T.word[0], 0.055, 0.55)).toBe(1);
	});

	it("solves cubic-bezier endpoints cleanly and provides a gentle spring curve", () => {
		const linear = bezier(0, 0, 1, 1);
		expect(linear(0)).toBe(0);
		expect(linear(1)).toBe(1);
		expect(linear(0.5)).toBeCloseTo(0.5, 3);
		expect(progressIn(0, [0.5, 1.5], easeOut)).toBe(0);
		expect(progressIn(9, [0.5, 1.5], easeInOut)).toBe(1);
		expect(easeSpring(0)).toBe(0);
		expect(easeSpring(1)).toBe(1);
		expect(easeSpring(0.55)).toBeGreaterThan(1.0);
	});
});

describe("Arc/Dia × Dazzi frame choreography & per-letter 3D cascade", () => {
	it("matches the exact idle ready screen at t = 0 with zero jump", () => {
		const s = computeArcRevealState(0);
		expect(s.phase).toBe("gather");
		expect(s.readyBgOpacity).toBe(1);
		expect(s.desktopBackdrop).toBe(0);
		expect(s.shader.alpha).toBe(0);
		expect(s.shader.meltProgress).toBe(0);
		expect(s.logo.move).toBe(0);
		expect(s.logo.scale).toBe(1);
		expect(s.logo.opacity).toBe(1);
		expect(s.logo.blur).toBe(0);
		expect(s.finder.opacity).toBe(0);
		expect(s.finder.blur).toBeCloseTo(REVEAL_T.finBlur, 4);
		expect(s.finder.scale).toBeCloseTo(1 + REVEAL_T.finScale, 4);
		expect(s.tourTriggered).toBe(false);
	});

	it("darkens the stage, breathes the luminous glass orb around the centered Dazzi logo, and reveals letters in a 3D blur cascade", () => {
		const orbMid = computeArcRevealState(REVEAL_T.word[0] + 0.25);
		expect(orbMid.phase).toBe("orb");
		expect(orbMid.desktopBackdrop).toBeGreaterThan(0.75);
		expect(orbMid.shader.alpha).toBeGreaterThan(0.95);
		expect(orbMid.shader.darkness).toBeGreaterThan(0.85);
		expect(orbMid.shader.orbRadius).toBeGreaterThan(0.18);
		expect(orbMid.shader.orbIntensity).toBeGreaterThan(0.7);
		expect(orbMid.logo.move).toBeGreaterThan(0.95);
		expect(orbMid.logo.scale).toBeGreaterThan(1.0);
		expect(orbMid.logo.opacity).toBe(1);

		const glyphs = computeGlyphStates("Dazzi", REVEAL_T.word[0] + 0.22);
		expect(glyphs).toHaveLength(5);
		// Earlier letters are more revealed, crisper, and less tilted than trailing letters
		expect(glyphs[0]!.opacity).toBeGreaterThan(glyphs[4]!.opacity);
		expect(glyphs[0]!.blur).toBeLessThan(glyphs[4]!.blur);
		expect(Math.abs(glyphs[0]!.rotateZ)).toBeLessThan(Math.abs(glyphs[4]!.rotateZ));

		// Once landed, all letters are crisp and upright
		const settledGlyphs = computeGlyphStates("Dazzi", REVEAL_T.word[1] + 0.2);
		for (const g of settledGlyphs) {
			expect(g.opacity).toBeGreaterThan(0.98);
			expect(g.blur).toBeLessThan(0.1);
			expect(Math.abs(g.rotateZ)).toBeLessThan(0.2);
		}
	});

	it("melts open via an organic aperture and settles the real Finder crisp before handing off to the tour", () => {
		const midMelt = computeArcRevealState((REVEAL_T.melt[0] + REVEAL_T.melt[1]) / 2);
		expect(midMelt.phase).toBe("melt");
		expect(midMelt.shader.meltProgress).toBeGreaterThan(0.2);
		expect(midMelt.shader.meltProgress).toBeLessThan(0.95);
		expect(midMelt.shader.rimGlow).toBeGreaterThan(0.35);
		expect(midMelt.finder.opacity).toBeGreaterThan(0.25);

		const handoff = computeArcRevealState(REVEAL_T.dim[0]);
		expect(handoff.tourTriggered).toBe(true);
		expect(handoff.desktopBackdrop).toBe(0);
		expect(handoff.shader.alpha).toBe(0);
		expect(handoff.readyBgOpacity).toBe(0);
		expect(handoff.logo.opacity).toBe(0);
		expect(handoff.finder.opacity).toBe(1);
		expect(handoff.finder.blur).toBe(0);
		expect(handoff.finder.scale).toBe(1);
		expect(handoff.finder.itemProgress).toEqual([1, 1, 1, 1]);
	});

	it("stays finite and bounded across all negative, active, and post-end timestamps", () => {
		for (let i = 0; i <= 120; i += 1) {
			const t = -0.3 + (i / 120) * (REVEAL_T.end + 1.0);
			const s = computeArcRevealState(t);
			const vals = [
				s.readyBgOpacity,
				s.desktopBackdrop,
				s.shader.alpha,
				s.shader.darkness,
				s.shader.orbRadius,
				s.shader.orbIntensity,
				s.shader.meltProgress,
				s.shader.rimGlow,
				s.shader.prismShift,
				s.logo.move,
				s.logo.scale,
				s.logo.opacity,
				s.logo.blur,
				s.logo.halo,
				s.sweep,
				s.wordLift.opacity,
				s.wordLift.blur,
				s.wordLift.scale,
				s.finder.opacity,
				s.finder.scale,
				s.finder.blur,
				...s.finder.itemProgress,
			];
			for (const v of vals) {
				expect(Number.isFinite(v), `non-finite value at t=${t}`).toBe(true);
			}
			for (const a of [s.readyBgOpacity, s.shader.alpha, s.shader.meltProgress, s.logo.opacity, s.finder.opacity, ...s.finder.itemProgress]) {
				expect(a).toBeGreaterThanOrEqual(0);
				expect(a).toBeLessThanOrEqual(1);
			}
		}
	});
});

describe("WebGL GLSL shader & fallback renderer", () => {
	it("defines valid GLSL shaders with domain-warped organic melt aperture, liquid-glass Fresnel rim, and film grain", () => {
		expect(ARC_VERTEX_SHADER).toContain("gl_Position");
		expect(ARC_FRAGMENT_SHADER).toContain("u_melt");
		expect(ARC_FRAGMENT_SHADER).toContain("u_orbRadius");
		expect(ARC_FRAGMENT_SHADER).toContain("u_rimGlow");
		expect(ARC_FRAGMENT_SHADER).toContain("fbm");
		expect(ARC_FRAGMENT_SHADER).toContain("gl_FragColor");
	});

	it("renders cleanly via the 2D fallback when WebGL is unavailable and balances canvas save/restore", () => {
		const ops: string[] = [];
		const compositeModes: string[] = [];
		const grad = { addColorStop: vi.fn() };
		const ctx2d = {
			save: vi.fn(() => ops.push("save")),
			restore: vi.fn(() => ops.push("restore")),
			clearRect: vi.fn(),
			fillRect: vi.fn(),
			beginPath: vi.fn(),
			closePath: vi.fn(),
			moveTo: vi.fn(),
			lineTo: vi.fn(),
			arc: vi.fn(),
			fill: vi.fn(),
			stroke: vi.fn(),
			setTransform: vi.fn(),
			createRadialGradient: vi.fn(() => grad),
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
			filter: "none",
		} as unknown as CanvasRenderingContext2D;

		const fakeCanvas = {
			width: 1280,
			height: 800,
			getContext: vi.fn((kind: string) => (kind === "2d" ? ctx2d : null)),
		} as unknown as HTMLCanvasElement;

		const renderer = createArcShaderRenderer(fakeCanvas);
		expect(renderer.backend).toBe("canvas2d");

		for (const t of [0.4, 1.5, 2.9, 3.6, REVEAL_T.dim[0]]) {
			const state = computeArcRevealState(t);
			expect(() => renderer.render(1280, 800, 1, state, t)).not.toThrow();
			expect(() => drawFallbackReveal(ctx2d, 1280, 800, state, t)).not.toThrow();
		}

		expect(compositeModes).toContain("destination-out");
		expect(ops.filter((o) => o === "save").length).toBe(ops.filter((o) => o === "restore").length);
		expect(() => renderer.dispose()).not.toThrow();
	});
});
