import { useEffect, useRef, useState, type ReactElement } from "react";
import { cn } from "../lib/cn";

const BAR_WIDTH_PX = 2;
const BAR_GAP_PX = 3;
const DEFAULT_SLOTS = 72;
const MIN_SLOTS = 24;
const MAX_SLOTS = 180;
const DOT_PX = 2;
const MIN_SPEECH_PX = 4;
const MAX_SPEECH_PX = 22;
const SAMPLE_INTERVAL_MS = 45;

/** Number of 2px waveform slots that fit across `widthPx`. */
export function waveformSlotCount(widthPx: number): number {
	if (!Number.isFinite(widthPx) || widthPx <= 0) return DEFAULT_SLOTS;
	const count = Math.floor((widthPx + BAR_GAP_PX) / (BAR_WIDTH_PX + BAR_GAP_PX));
	return Math.max(MIN_SLOTS, Math.min(MAX_SLOTS, count));
}

/** Resizes the level buffer while keeping the newest samples on the right. */
export function resizeWaveformBars(bars: readonly number[], count: number): readonly number[] {
	if (count <= 0) return [];
	if (bars.length === count) return bars;
	if (bars.length > count) return bars.slice(bars.length - count);
	return [...Array.from({ length: count - bars.length }, () => 0), ...bars];
}

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
 * Full-width neutral voice track: a fine baseline of muted 2px dots on silence
 * that rises into monochrome vertical bars as microphone audio streams in.
 * Closes its own `AudioContext` as soon as listening stops.
 */
export function VoiceWaveform({ stream }: { readonly stream: MediaStream | null }): ReactElement {
	const trackRef = useRef<HTMLDivElement | null>(null);
	const [bars, setBars] = useState<readonly number[]>(() => Array.from({ length: DEFAULT_SLOTS }, () => 0));

	useEffect(() => {
		const el = trackRef.current;
		if (el === null) return;
		const syncWidth = (): void => {
			const count = waveformSlotCount(el.clientWidth);
			setBars((prev) => resizeWaveformBars(prev, count));
		};
		syncWidth();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(syncWidth);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (stream === null || typeof AudioContext === "undefined") {
			setBars((prev) => Array.from({ length: prev.length }, () => 0));
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
		<div ref={trackRef} className="voice-waveform flex h-24 w-full min-w-0 items-center justify-between gap-[3px] overflow-hidden" aria-hidden="true">
			{bars.map((level, index) => {
				const speaking = level > 0.01;
				const height = speaking ? Math.round(MIN_SPEECH_PX + level * (MAX_SPEECH_PX - MIN_SPEECH_PX)) : DOT_PX;
				return (
					<span
						key={index}
						data-waveform-bar=""
						className={cn(
							"w-[2px] flex-none rounded-full transition-[height,background-color,opacity] duration-75 ease-out",
							speaking ? "bg-ink opacity-90" : "bg-ink-faint opacity-55",
						)}
						style={{ height: `${height}px` }}
					/>
				);
			})}
		</div>
	);
}
