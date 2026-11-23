// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Reveal, cancelPrewarm, prewarmReveal } from "../src/renderer/src/first-run/reveal";
import { REVEAL_T, revealMs } from "../src/renderer/src/first-run/reveal-timing";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function createFake2dContext(): CanvasRenderingContext2D {
	const grad = { addColorStop: vi.fn() };
	return {
		save: vi.fn(),
		restore: vi.fn(),
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
		globalCompositeOperation: "source-over",
		globalAlpha: 1,
		fillStyle: "#000",
		strokeStyle: "#000",
		lineWidth: 1,
		filter: "none",
	} as unknown as CanvasRenderingContext2D;
}

describe("Arc/Dia Reveal component DOM lifecycle", () => {
	let host: HTMLDivElement;
	let desk: HTMLDivElement;
	let ready: HTMLElement;
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((kind: string) =>
			kind === "2d" ? createFake2dContext() : null) as unknown as typeof HTMLCanvasElement.prototype.getContext);

		host = document.createElement("div");
		desk = document.createElement("div");
		desk.className = "desk";
		desk.innerHTML = `
			<aside class="sidebar"></aside>
			<header class="toolbar"></header>
			<section class="workspace-pane"></section>
			<section class="workspace-pane"></section>
			<aside class="inspector-column"></aside>
		`;
		ready = document.createElement("section");
		ready.className = "fr-ready";
		ready.innerHTML = `
			<div class="fr-done-mark">
				<span class="fr-reveal-sweep"><span></span></span>
				<span class="fr-status-mark"></span>
			</div>
			<h1 class="fr-title">Ready</h1>
			<p class="fr-lead">Done</p>
			<button data-action="first-run-start">Start</button>
		`;
		container = document.createElement("div");
		host.append(desk, ready, container);
		document.body.append(host);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("prewarms and cancels .desk compositing styles cleanly", () => {
		prewarmReveal();
		expect(desk.style.opacity).toBe("0");
		expect(desk.style.filter).toContain("blur(");
		cancelPrewarm();
		expect(desk.style.opacity).toBe("");
		expect(desk.style.filter).toBe("");
	});

	it("mounts shader canvas and per-letter spans idle when playing=false", () => {
		const onTour = vi.fn();
		const onEnd = vi.fn();
		const onRelease = vi.fn();
		const rafSpy = vi.spyOn(window, "requestAnimationFrame");

		act(() => {
			root.render(<Reveal playing={false} onTour={onTour} onEnd={onEnd} onRelease={onRelease} />);
		});

		expect(container.querySelector('.fr-reveal[data-playing="true"]')).toBeNull();
		expect(container.querySelector('canvas[data-reveal="shader"]')).not.toBeNull();
		expect(container.querySelectorAll('[data-reveal="glyph"]').length).toBe(5);
		expect(rafSpy).not.toHaveBeenCalled();
		expect(onTour).not.toHaveBeenCalled();
		expect(onEnd).not.toHaveBeenCalled();
	});
	it("drives gather → orb (with staggered glyphs & desktop backdrop spotlight) → melt → settle, fires onTour then onEnd, and releases .desk styles", () => {
		const onTour = vi.fn();
		const onEnd = vi.fn();
		const onRelease = vi.fn();
		const backdropCalls: number[] = [];
		Reflect.set(globalThis, "autorag", {
			onboarding: {
				setRevealBackdrop: (opacity: number) => backdropCalls.push(opacity),
			},
		});
		let now = 1000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const callbacks: FrameRequestCallback[] = [];
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
			callbacks.push(cb);
			return callbacks.length;
		});
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

		const stepTo = (clockSeconds: number): void => {
			now = 1000 + revealMs(clockSeconds);
			const next = callbacks.shift();
			if (next) next(now);
		};

		act(() => {
			root.render(<Reveal playing={true} onTour={onTour} onEnd={onEnd} onRelease={onRelease} />);
		});

		const rootEl = container.querySelector<HTMLElement>(".fr-reveal");
		expect(rootEl?.getAttribute("data-playing")).toBe("true");
		expect(rootEl?.getAttribute("data-phase")).toBe("gather");

		act(() => stepTo(REVEAL_T.word[0] + 0.24));
		expect(rootEl?.getAttribute("data-phase")).toBe("orb");
		const glyphs = Array.from(container.querySelectorAll<HTMLElement>('[data-reveal="glyph"]'));
		expect(Number(glyphs[0]?.style.opacity)).toBeGreaterThan(Number(glyphs[4]?.style.opacity));

		act(() => stepTo((REVEAL_T.melt[0] + REVEAL_T.melt[1]) / 2));
		expect(rootEl?.getAttribute("data-phase")).toBe("melt");
		expect(Number(desk.style.opacity)).toBeGreaterThan(0.2);

		act(() => stepTo(REVEAL_T.dim[0] + 0.05));
		expect(rootEl?.getAttribute("data-phase")).toBe("settle");
		expect(onTour).toHaveBeenCalledTimes(1);
		expect(onEnd).not.toHaveBeenCalled();

		act(() => stepTo(REVEAL_T.end + 0.05));
		expect(onEnd).toHaveBeenCalledTimes(1);

		act(() => root.unmount());
		expect(backdropCalls.some((v) => v > 0.7)).toBe(true);
		expect(backdropCalls.at(-1)).toBe(0);
		Reflect.deleteProperty(globalThis, "autorag");
		expect(desk.style.opacity).toBe("1");
		act(() => {
			vi.advanceTimersByTime(1600);
		});
		expect(onRelease).toHaveBeenCalledTimes(1);
		expect(desk.style.opacity).toBe("");
		expect(desk.style.transform).toBe("");
	});
});
