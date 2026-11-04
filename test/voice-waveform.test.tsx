// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceWaveform, pushWaveformBar, waveformLevel } from "../src/renderer/src/components/VoiceWaveform";

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

describe("pushWaveformBar", () => {
	it("shifts bars left and appends the latest level at fixed length", () => {
		expect(pushWaveformBar([0.1, 0.2, 0.3], 0.8)).toEqual([0.2, 0.3, 0.8]);
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

	it("grows the live waveform bars from microphone audio and closes the AudioContext on unmount", () => {
		const stream = {} as MediaStream;
		sampleAmplitude = 0;
		act(() => root.render(<VoiceWaveform stream={stream} />));

		const barsBefore = [...host.querySelectorAll<HTMLElement>("[data-waveform-bar]")].map((el) => Number.parseFloat(el.style.height));
		expect(barsBefore.length).toBeGreaterThanOrEqual(9);
		const quietMax = Math.max(...barsBefore);

		sampleAmplitude = 0.35;
		act(() => {
			for (let step = 0; step < 6; step += 1) {
				const next = rafCallbacks.shift();
				next?.(step * 50);
			}
		});

		const barsAfter = [...host.querySelectorAll<HTMLElement>("[data-waveform-bar]")].map((el) => Number.parseFloat(el.style.height));
		expect(Math.max(...barsAfter)).toBeGreaterThan(quietMax);

		act(() => root.unmount());
		expect(closedContexts).toBe(1);
		root = createRoot(host);
	});
});
