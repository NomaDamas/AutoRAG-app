import { useEffect, useState, type ReactElement } from "react";

const BAR_COUNT = 13;
const MIN_BAR_PX = 3;
const MAX_BAR_PX = 16;
const SAMPLE_INTERVAL_MS = 45;
const INITIAL_BARS: readonly number[] = Array.from({ length: BAR_COUNT }, () => 0);

/**
 * Turns a short window of floating-point PCM samples (-1..1) into a 0..1 bar
 * height. Speech RMS normally sits around 0.03–0.25, so a square-root curve
 * lifts quiet syllables without letting normal speech peg at the ceiling.
 */
export function waveformLevel(samples: Float32Array): number {
	if (samples.length === 0) return 0;
	let sumSquares = 0;
	let peak = 0;
	for (let i = 0; i < samples.length; i += 1) {
		const value = Math.abs(samples[i] ?? 0);
		sumSquares += value * value;
		if (value > peak) peak = value;
	}
	const rms = Math.sqrt(sumSquares / samples.length);
	const blended = rms * 0.7 + peak * 0.3;
	if (blended < 0.006) return 0;
	return Math.min(1, Math.sqrt(Math.min(1, blended * 3.4)));
}

/** Shifts the history one slot left and appends the newest 0..1 level. */
export function pushWaveformBar(previous: readonly number[], next: number): readonly number[] {
	if (previous.length === 0) return [];
	return [...previous.slice(1), Math.max(0, Math.min(1, next))];
}

/**
 * Live scrolling bar waveform fed directly by the active microphone stream.
 * Renders minimum-height dots before the stream opens or during silence, and
 * closes its own `AudioContext` as soon as listening ends.
 */
export function VoiceWaveform({ stream }: { readonly stream: MediaStream | null }): ReactElement {
	const [bars, setBars] = useState<readonly number[]>(INITIAL_BARS);

	useEffect(() => {
		if (stream === null || typeof AudioContext === "undefined") {
			setBars(INITIAL_BARS);
			return;
		}
		const ctx = new AudioContext();
		void ctx.resume().catch(() => {});
		const analyser = ctx.createAnalyser();
		analyser.fftSize = 256;
		const source = ctx.createMediaStreamSource(stream);
		source.connect(analyser);
		const buffer = new Float32Array(analyser.fftSize);

		let rafId = 0;
		let lastSampleAt = -SAMPLE_INTERVAL_MS;
		let active = true;

		const tick = (now: number): void => {
			if (!active) return;
			if (now - lastSampleAt >= SAMPLE_INTERVAL_MS) {
				lastSampleAt = now;
				analyser.getFloatTimeDomainData(buffer);
				const level = waveformLevel(buffer);
				setBars((prev) => pushWaveformBar(prev, level));
			}
			rafId = window.requestAnimationFrame(tick);
		};
		rafId = window.requestAnimationFrame(tick);

		return () => {
			active = false;
			window.cancelAnimationFrame(rafId);
			source.disconnect();
			void ctx.close().catch(() => {});
		};
	}, [stream]);

	return (
		<span className="voice-waveform flex h-16 items-center gap-[2px]" aria-hidden="true">
			{bars.map((level, index) => {
				const height = Math.round(MIN_BAR_PX + level * (MAX_BAR_PX - MIN_BAR_PX));
				return (
					<span
						key={index}
						data-waveform-bar=""
						className="w-[2px] flex-none rounded-full bg-current transition-[height] duration-75 ease-out"
						style={{ height: `${height}px` }}
					/>
				);
			})}
		</span>
	);
}
