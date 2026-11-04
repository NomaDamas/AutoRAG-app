// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	VoiceWaveform,
	pushWaveformBar,
	resizeWaveformBars,
	waveformLevel,
	waveformSlotCount,
} from "../src/renderer/src/components/VoiceWaveform";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

describe("waveformLevel", () => {
	it("is 0 for silence and empty buffers", () => {
		expect(waveformLevel(new Float32Array(0))).toBe(0);
		expect(waveformLevel(new Float32Array(128))).toBe(0);
	});

	it("scales normal speech amplitude into a visible 0..1 level and clamps loud peaks at 1", () => {
		const quiet = new Float32Array(128).fill(0.04);
		const normal = new Float32Array(128).fill(0.15);
		const loud = new Float32Array(128).fill(0.95);
		expect(waveformLevel(quiet)).toBeGreaterThan(0.1);
		expect(waveformLevel(normal)).toBeGreaterThan(waveformLevel(quiet));
		expect(waveformLevel(loud)).toBe(1);
	});
});

describe("pushWaveformBar & resizeWaveformBars", () => {
	it("shifts bars left and appends the latest level at fixed length", () => {
		expect(pushWaveformBar([0.1, 0.2, 0.3], 0.8)).toEqual([0.2, 0.3, 0.8]);
	});

	it("computes slot count from container width and preserves recent history on resize", () => {
		expect(waveformSlotCount(0)).toBeGreaterThanOrEqual(40);
		expect(waveformSlotCount(500)).toBeGreaterThan(waveformSlotCount(250));
		expect(resizeWaveformBars([0.4, 0.9], 4)).toEqual([0, 0, 0.4, 0.9]);
		expect(resizeWaveformBars([0.1, 0.2, 0.4, 0.9], 2)).toEqual([0.4, 0.9]);
	});
});

describe("VoiceWaveform", () => {
	let host: HTMLDivElement;
	let root: Root;
	let sampleAmplitude = 0;
	let closedContexts = 0;
	let rafCallbacks: FrameRequestCallback[];

	class FakeAnalyser {
		fftSize = 256;
		getFloatTimeDomainData(target: Float32Array<ArrayBuffer>): void {
			target.fill(sampleAmplitude);
		}
	}

	class FakeAudioContext {
		state: AudioContextState = "running";
		readonly analyser = new FakeAnalyser();
		createAnalyser(): AnalyserNode {
			return this.analyser as unknown as AnalyserNode;
		}
		createMediaStreamSource(): MediaStreamAudioSourceNode {
			return { connect: vi.fn(), disconnect: vi.fn() } as unknown as MediaStreamAudioSourceNode;
		}
		resume(): Promise<void> {
			return Promise.resolve();
		}
		close(): Promise<void> {
			closedContexts += 1;
			return Promise.resolve();
		}
	}

	beforeEach(() => {
		sampleAmplitude = 0;
		closedContexts = 0;
		rafCallbacks = [];
		vi.stubGlobal("AudioContext", FakeAudioContext);
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
			rafCallbacks.push(cb);
			return rafCallbacks.length;
		});
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("renders a full-width dotted baseline on silence, grows neutral bars on speech without red styling, and closes AudioContext", () => {
		const stream = {} as MediaStream;
		sampleAmplitude = 0;
		act(() => root.render(<VoiceWaveform stream={stream} />));

		const initialBars = [...host.querySelectorAll<HTMLElement>("[data-waveform-bar]")];
		expect(initialBars.length).toBeGreaterThanOrEqual(40);
		expect(initialBars.every((el) => Number.parseFloat(el.style.height) === 2)).toBe(true);
		expect(host.innerHTML).not.toContain("danger");

		sampleAmplitude = 0.35;
		act(() => {
			for (let step = 0; step < 6; step += 1) {
				const next = rafCallbacks.shift();
				next?.(step * 50);
			}
		});

		const heightsAfter = [...host.querySelectorAll<HTMLElement>("[data-waveform-bar]")].map((el) => Number.parseFloat(el.style.height));
		expect(Math.max(...heightsAfter)).toBeGreaterThan(10);
		expect(Math.min(...heightsAfter)).toBe(2);

		act(() => root.unmount());
		expect(closedContexts).toBe(1);
		root = createRoot(host);
	});
});
