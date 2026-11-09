/**
 * The sound under the Ready → Finder reveal, scored against the reveal's own clock
 * (`REVEAL_T`): a brass-and-sub swell that opens while the stage dims, a rising air
 * that follows the light sweep, one impact as the sunflower lifts and the Finder
 * pulls into focus, a chime that rings up through it, and a warm pad that carries
 * into the tour.
 *
 * It is synthesised, not played from a file: nothing to ship or license, and the
 * cues move with `REVEAL_T`. Everything sits on D (open fifths in the swell, a D
 * major chime on the hit) so it reads as "ready", not as a warning.
 *
 * `scheduleRevealScore` only builds nodes on any `BaseAudioContext`, so the same
 * score renders offline for inspection; `playRevealScore` is what the reveal calls.
 */

import { REVEAL_SPEED, REVEAL_T } from "./reveal-timing";

/** How long the score rings, in real seconds from the click (the reverb tail included). */
export const SCORE_SECONDS = 9;

/** The master level: loud enough to be an event, quiet enough to land in a silent room (peak is about -6 dBFS). */
const MASTER_LEVEL = 0.5;

/** Exponential ramps cannot touch zero. */
const FLOOR = 0.0001;

/** The moment the sunflower lifts and the Finder comes in, on the reveal's clock. */
const HIT = REVEAL_T.lift[0] + 0.05;

/** The breath: how long (mockup seconds) the swell drops away before the hit, so the hit lands as an event. */
const BREATH = 0.2;

/** Hz of the note `semitones` away from A4. */
const note = (semitones: number): number => 440 * 2 ** (semitones / 12);
const NOTE = {
	D1: note(-43),
	D2: note(-31),
	A2: note(-24),
	D3: note(-19),
	A3: note(-12),
	D4: note(-7),
	Fs4: note(-3),
	A4: note(0),
	D5: note(5),
	A5: note(12),
	D6: note(17),
	Fs6: note(21),
} as const;

/** A repeatable noise source, so a render is the same every time. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function noiseBuffer(ctx: BaseAudioContext, seconds: number, seed: number): AudioBuffer {
	const buffer = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
	const data = buffer.getChannelData(0);
	const random = mulberry32(seed);
	for (let i = 0; i < data.length; i += 1) data[i] = random() * 2 - 1;
	return buffer;
}

/** A hall: stereo noise that dies away and darkens as it goes. */
function hallImpulse(ctx: BaseAudioContext): AudioBuffer {
	const seconds = 3.4;
	const length = Math.ceil(seconds * ctx.sampleRate);
	const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
	for (let channel = 0; channel < 2; channel += 1) {
		const data = buffer.getChannelData(channel);
		const random = mulberry32(7 + channel * 101);
		let low = 0;
		for (let i = 0; i < length; i += 1) {
			const t = i / ctx.sampleRate;
			const follow = 0.9 - 0.78 * Math.min(1, t / seconds);
			low += ((random() * 2 - 1) - low) * follow;
			data[i] = low * Math.exp(-t * 2.3) * Math.min(1, t / 0.012);
		}
	}
	return buffer;
}

/** Ramps `param` through `[mockup time, value]` points, exponentially (all values above zero). */
function ramp(param: AudioParam, at: (t: number) => number, points: readonly (readonly [number, number])[]): void {
	const [first, ...rest] = points;
	if (first === undefined) return;
	param.setValueAtTime(first[1], at(first[0]));
	for (const [t, value] of rest) param.exponentialRampToValueAtTime(value, at(t));
}

interface Bus {
	/** A layer's `send` is how much of it goes through the hall. */
	connect(node: AudioNode, send: number): void;
}

/** The soft clip that gives the brass its bite. */
function brassCurve(): Float32Array<ArrayBuffer> {
	const curve = new Float32Array(new ArrayBuffer(1024 * 4));
	for (let i = 0; i < curve.length; i += 1) {
		const x = (i / (curve.length - 1)) * 2 - 1;
		curve[i] = Math.tanh(x * 2.4) / Math.tanh(2.4);
	}
	return curve;
}

/**
 * Builds the score on `ctx`, starting at `start` (context seconds). Returns the master
 * gain so a caller can fade the whole thing out.
 */
export function scheduleRevealScore(ctx: BaseAudioContext, start: number): { readonly master: GainNode } {
	const real = (t: number): number => start + t / REVEAL_SPEED;
	const hit = real(HIT);

	const master = ctx.createGain();
	master.gain.setValueAtTime(FLOOR, start);
	master.gain.linearRampToValueAtTime(MASTER_LEVEL, start + 0.05);
	master.gain.setValueAtTime(MASTER_LEVEL, start + SCORE_SECONDS - 1.5);
	master.gain.linearRampToValueAtTime(0, start + SCORE_SECONDS);

	const glue = ctx.createDynamicsCompressor();
	glue.threshold.value = -16;
	glue.knee.value = 12;
	glue.ratio.value = 3;
	glue.attack.value = 0.012;
	glue.release.value = 0.3;
	glue.connect(master);
	master.connect(ctx.destination);

	const hall = ctx.createConvolver();
	hall.buffer = hallImpulse(ctx);
	const hallReturn = ctx.createGain();
	hallReturn.gain.value = 0.55;
	hall.connect(hallReturn);
	hallReturn.connect(glue);

	const bus: Bus = {
		connect(node, send) {
			node.connect(glue);
			const feed = ctx.createGain();
			feed.gain.value = send;
			node.connect(feed);
			feed.connect(hall);
		},
	};

	// 1. The swell: stacked, slightly detuned saws on D, A, D (an open fifth, no third), through a filter that opens
	// as the stage dims and closes after the hit. This is the "부우우웅".
	const brassLevel = ctx.createGain();
	ramp(brassLevel.gain, real, [[0.1, FLOOR], [1.2, 0.02], [2.2, 0.22], [HIT - BREATH, 0.3], [HIT - BREATH / 2, 0.01], [HIT, 0.5], [3.4, 0.22], [4.7, FLOOR]]);
	const brassFilter = ctx.createBiquadFilter();
	brassFilter.type = "lowpass";
	brassFilter.Q.value = 2.2;
	ramp(brassFilter.frequency, real, [[0.1, 140], [HIT, 2600], [4.2, 380]]);
	const brassClip = ctx.createWaveShaper();
	brassClip.curve = brassCurve();
	brassClip.oversample = "2x";
	for (const frequency of [NOTE.D2, NOTE.A2, NOTE.D3]) {
		for (const detune of [-13, 0, 13]) {
			const voice = ctx.createOscillator();
			voice.type = "sawtooth";
			voice.frequency.value = frequency;
			voice.detune.value = detune;
			const trim = ctx.createGain();
			trim.gain.value = 0.085;
			voice.connect(trim);
			trim.connect(brassFilter);
			voice.start(real(0.1));
			voice.stop(real(4.8));
		}
	}
	brassFilter.connect(brassClip);
	brassClip.connect(brassLevel);
	bus.connect(brassLevel, 0.22);

	// 2. The floor: a sine on D1 and D2 that swells with it, so the room feels it more than the speakers play it.
	const subLevel = ctx.createGain();
	ramp(subLevel.gain, real, [[0.1, FLOOR], [1.6, 0.1], [HIT - BREATH, 0.2], [HIT - BREATH / 2, 0.01], [HIT, 0.5], [3.7, FLOOR]]);
	for (const [frequency, trim] of [[NOTE.D1, 1], [NOTE.D2, 0.5]] as const) {
		const voice = ctx.createOscillator();
		voice.frequency.value = frequency;
		const level = ctx.createGain();
		level.gain.value = trim;
		voice.connect(level);
		level.connect(subLevel);
		voice.start(real(0.1));
		voice.stop(real(3.8));
	}
	bus.connect(subLevel, 0.05);

	// 3. The air: filtered noise that climbs while the light sweeps the sunflower and is cut at the hit.
	const air = ctx.createBufferSource();
	air.buffer = noiseBuffer(ctx, 3, 11);
	air.loop = true;
	const airBand = ctx.createBiquadFilter();
	airBand.type = "bandpass";
	airBand.Q.value = 1.1;
	ramp(airBand.frequency, real, [[REVEAL_T.sweep[0] - 0.2, 300], [HIT - BREATH, 7000]]);
	const airLevel = ctx.createGain();
	ramp(airLevel.gain, real, [[REVEAL_T.sweep[0] - 0.2, FLOOR], [HIT - BREATH, 0.26], [HIT - BREATH / 2, FLOOR]]);
	air.connect(airBand);
	airBand.connect(airLevel);
	bus.connect(airLevel, 0.45);
	air.start(real(REVEAL_T.sweep[0] - 0.2));
	air.stop(real(HIT + 0.1));

	// 4. The impact: a falling sine and a short burst of low noise on the lift.
	const boom = ctx.createOscillator();
	boom.frequency.setValueAtTime(74, hit);
	boom.frequency.exponentialRampToValueAtTime(33, hit + 0.9);
	const boomLevel = ctx.createGain();
	boomLevel.gain.setValueAtTime(FLOOR, hit - 0.01);
	boomLevel.gain.exponentialRampToValueAtTime(0.55, hit + 0.015);
	boomLevel.gain.exponentialRampToValueAtTime(FLOOR, hit + 1.9);
	boom.connect(boomLevel);
	bus.connect(boomLevel, 0.12);
	boom.start(hit - 0.01);
	boom.stop(hit + 2);
	const thump = ctx.createBufferSource();
	thump.buffer = noiseBuffer(ctx, 1, 23);
	const thumpFilter = ctx.createBiquadFilter();
	thumpFilter.type = "lowpass";
	thumpFilter.frequency.value = 2200;
	const thumpLevel = ctx.createGain();
	thumpLevel.gain.setValueAtTime(FLOOR, hit - 0.01);
	thumpLevel.gain.exponentialRampToValueAtTime(0.4, hit + 0.012);
	thumpLevel.gain.exponentialRampToValueAtTime(FLOOR, hit + 0.7);
	thump.connect(thumpFilter);
	thumpFilter.connect(thumpLevel);
	bus.connect(thumpLevel, 0.3);
	thump.start(hit - 0.01);
	thump.stop(hit + 0.8);

	// 5. The chime: a root bell on the hit and a quick D major arpeggio climbing out of it. This is the "따랑".
	const bell = (frequency: number, when: number, level: number, decay: number): void => {
		for (const [ratio, gain, shorter] of [[1, 1, 1], [2.003, 0.4, 0.6], [3.01, 0.25, 0.4], [4.2, 0.12, 0.25]] as const) {
			const voice = ctx.createOscillator();
			voice.frequency.value = frequency * ratio;
			const envelope = ctx.createGain();
			envelope.gain.setValueAtTime(FLOOR, when);
			envelope.gain.linearRampToValueAtTime(level * gain, when + 0.004);
			envelope.gain.exponentialRampToValueAtTime(FLOOR, when + decay * shorter);
			voice.connect(envelope);
			bus.connect(envelope, 0.85);
			voice.start(when);
			voice.stop(when + decay * shorter + 0.05);
		}
	};
	bell(NOTE.D4, hit, 0.2, 3.8);
	[NOTE.D5, NOTE.A5, NOTE.D6, NOTE.Fs6].forEach((frequency, index) => bell(frequency, hit + 0.02 + index * 0.085, [0.17, 0.15, 0.13, 0.11][index] ?? 0.1, 3.2));

	// 6. The afterglow: a soft D major pad that comes up as the Finder lands and rings into the tour.
	const padFilter = ctx.createBiquadFilter();
	padFilter.type = "lowpass";
	padFilter.frequency.value = 1600;
	const padLevel = ctx.createGain();
	ramp(padLevel.gain, real, [[2.8, FLOOR], [4, 0.05], [4.9, 0.045], [6.3, FLOOR]]);
	for (const frequency of [NOTE.D3, NOTE.A3, NOTE.D4, NOTE.Fs4, NOTE.A4]) {
		for (const detune of [-6, 6]) {
			const voice = ctx.createOscillator();
			voice.type = "triangle";
			voice.frequency.value = frequency;
			voice.detune.value = detune;
			const trim = ctx.createGain();
			trim.gain.value = 0.5;
			voice.connect(trim);
			trim.connect(padFilter);
			voice.start(real(2.8));
			voice.stop(real(6.4));
		}
	}
	padFilter.connect(padLevel);
	bus.connect(padLevel, 0.7);

	return { master };
}

/**
 * Plays the score now. Returns a function that fades it out (for a reveal cut short);
 * a score that is left alone rings to its end and closes its own context. Never throws:
 * no audio device, or no Web Audio, is silence.
 */
export function playRevealScore(): () => void {
	if (typeof AudioContext === "undefined") return () => undefined;
	try {
		const ctx = new AudioContext({ latencyHint: "interactive" });
		void ctx.resume().catch(() => undefined);
		const { master } = scheduleRevealScore(ctx, ctx.currentTime + 0.03);
		const close = (): void => void ctx.close().catch(() => undefined);
		const closer = window.setTimeout(close, (SCORE_SECONDS + 0.5) * 1000);
		return () => {
			window.clearTimeout(closer);
			master.gain.cancelScheduledValues(ctx.currentTime);
			master.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
			window.setTimeout(close, 250);
		};
	} catch {
		return () => undefined;
	}
}
