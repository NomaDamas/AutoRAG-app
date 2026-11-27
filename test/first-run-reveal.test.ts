import { describe, expect, it } from "vitest";
import { REVEAL_LIGHT_FRAGMENT, isRevealLightFrame, revealBackdropPageHtml } from "../src/shared/reveal-light";
import { REVEAL_SPEED, REVEAL_T, bezier, easeInOut, easeOut, progressIn, revealMs, revealPhaseAt, spring } from "../src/renderer/src/first-run/reveal-timing";
import { computeGlyphStates, computeRevealState } from "../src/renderer/src/first-run/reveal-shader";

describe("reveal clock", () => {
	it("runs about 5.6 s and hands off to the tour at its end", () => {
		expect(REVEAL_SPEED).toBeGreaterThan(0);
		expect(revealMs(REVEAL_T.end)).toBeGreaterThanOrEqual(5000);
		expect(revealMs(REVEAL_T.end)).toBeLessThanOrEqual(6200);
	});

	it("orders the beats: dusk → light and word → the window opens and rises → the light lifts", () => {
		expect(REVEAL_T.lightIn[0]).toBeGreaterThanOrEqual(REVEAL_T.dusk[1]);
		expect(REVEAL_T.word).toBeGreaterThan(REVEAL_T.lightIn[0]);
		expect(REVEAL_T.spread[1]).toBeLessThanOrEqual(REVEAL_T.open);
		expect(REVEAL_T.open).toBeLessThanOrEqual(REVEAL_T.rise[0]);
		expect(REVEAL_T.markOut[0]).toBeGreaterThanOrEqual(REVEAL_T.rise[0]);
		expect(REVEAL_T.lightOut[0]).toBeGreaterThan(REVEAL_T.rise[0]);
		expect(REVEAL_T.lightOut[1]).toBeLessThanOrEqual(REVEAL_T.end);
		expect(REVEAL_T.duskOut[1]).toBeLessThanOrEqual(REVEAL_T.end);
	});

	it("names its phases in order", () => {
		expect(revealPhaseAt(0)).toBe("dusk");
		expect(revealPhaseAt(2.5)).toBe("light");
		expect(revealPhaseAt(4.2)).toBe("rise");
		expect(revealPhaseAt(5.3)).toBe("clear");
		expect(revealPhaseAt(REVEAL_T.end)).toBe("done");
	});

	it("eases with exact endpoints and clamps progress", () => {
		const curve = bezier(0.2, 0.8, 0.2, 1);
		expect(curve(0)).toBe(0);
		expect(curve(1)).toBe(1);
		expect(easeOut(0.5)).toBeGreaterThan(0.5);
		expect(easeInOut(0.5)).toBeGreaterThan(0.3);
		expect(progressIn(-1, [0, 1])).toBe(0);
		expect(progressIn(2, [0, 1])).toBe(1);
	});

	it("springs past 1 once and settles", () => {
		expect(spring(0)).toBe(0);
		const peak = Math.max(...Array.from({ length: 60 }, (_, i) => spring(i * 0.01)));
		expect(peak).toBeGreaterThan(1);
		expect(peak).toBeLessThan(1.2);
		expect(spring(2)).toBeCloseTo(1, 3);
	});
});

describe("reveal state", () => {
	it("dims, lights and spreads, then opens the window and lifts everything", () => {
		const start = computeRevealState(0);
		expect(start.light.dusk).toBe(0);
		expect(start.light.light).toBe(0);
		expect(start.finder.visible).toBe(false);

		const lit = computeRevealState(3.4);
		expect(lit.light.dusk).toBeGreaterThan(0.95);
		expect(lit.light.light).toBeGreaterThan(0.9);
		expect(lit.light.spread).toBe(1);
		expect(lit.light.open).toBe(0);
		expect(lit.readyBg).toBe(0);

		const rising = computeRevealState(4.3);
		expect(rising.light.open).toBe(1);
		expect(rising.finder.visible).toBe(true);
		expect(rising.finder.y).toBeGreaterThan(0);
		expect(rising.finder.scale).toBeLessThan(1);
		expect(rising.logo.opacity).toBeLessThan(0.05);
		expect(rising.logo.rotate).toBeCloseTo(REVEAL_T.markTurn, 0);

		const end = computeRevealState(REVEAL_T.end);
		expect(end.light.dusk).toBe(0);
		expect(end.light.light).toBe(0);
		expect(end.finder.y).toBe(0);
		expect(end.finder.scale).toBe(1);
		expect(end.finder.blur).toBe(0);
		expect(end.finder.itemProgress.every((p) => p === 1)).toBe(true);
		expect(end.tourTriggered).toBe(true);
	});

	it("keeps the sunflower crisp: it turns and fades, never blurs or scales", () => {
		const state = computeRevealState(4.0);
		expect(state.logo.opacity).toBeGreaterThan(0);
		expect(state.logo.opacity).toBeLessThan(1);
		expect(state.logo.rotate).toBeGreaterThan(0);
		expect(Object.keys(state.logo).sort()).toEqual(["move", "opacity", "rotate"]);
	});

	it("staggers the letters from first to last", () => {
		const glyphs = computeGlyphStates("Dazzi", REVEAL_T.word + 0.1);
		expect(glyphs).toHaveLength(5);
		expect(glyphs[0]!.opacity).toBeGreaterThan(glyphs[4]!.opacity);
		expect(computeGlyphStates("Dazzi", 0).every((g) => g.opacity === 0)).toBe(true);
		expect(computeGlyphStates("Dazzi", REVEAL_T.word + 2).every((g) => g.opacity === 1 && Math.abs(g.y) < 0.01)).toBe(true);
	});
});

describe("shared reveal light", () => {
	it("validates frames sent over IPC", () => {
		expect(isRevealLightFrame(computeRevealState(2).light)).toBe(true);
		expect(isRevealLightFrame({ time: 1 })).toBe(false);
		expect(isRevealLightFrame({ time: 0, dusk: Number.NaN, light: 0, spread: 0, glow: 0, rise: 0, open: 0 })).toBe(false);
		expect(isRevealLightFrame(null)).toBe(false);
	});

	it("builds a self-contained desktop page that carries the shader and the scene", () => {
		const html = revealBackdropPageHtml({ originX: 0, originY: 25, windowX: 100, windowY: 80, windowWidth: 1200, windowHeight: 760, unit: 900, duskMax: 0.9 });
		expect(html).toContain("__revealFrame");
		expect(html).toContain('"windowWidth":1200');
		expect(html).toContain("sdRoundBox");
		expect(html).not.toMatch(/<script[^>]+src=/);
		expect(REVEAL_LIGHT_FRAGMENT).toContain("u_open");
	});
});
