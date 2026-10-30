/**
 * Keeps an `<audio>` playing in step with a `<video>`: the video's sound, when the
 * page cannot decode it, comes from ffmpeg as a separate stream (see
 * ../shared/video-audio.ts). The video stays the clock and the one the user
 * controls; the audio only follows its play state, position, speed, and volume.
 */

/** The part of an `HTMLMediaElement` the follower reads and drives. */
export interface FollowedMedia extends EventTarget {
	currentTime: number;
	readonly paused: boolean;
	readonly ended: boolean;
	playbackRate: number;
	volume: number;
	muted: boolean;
	readonly readyState: number;
	play(): Promise<void>;
	pause(): void;
}

export interface FollowOptions {
	/** How far the audio may stray from the video before it is moved back. */
	readonly maxDriftSeconds?: number;
	/** True once the video turns out to decode its own sound; the follower then stops, so nothing plays twice. */
	readonly hasNativeAudio?: () => boolean;
	readonly onNativeAudio?: () => void;
	/** Milliseconds clock; defaults to `performance.now`. */
	readonly now?: () => number;
}

/** HAVE_FUTURE_DATA: enough buffered to start without stalling at once. */
const HAVE_FUTURE_DATA = 3;
/** Positions this close count as the same spot: moving the audio restarts its stream, so near enough is left alone. */
const SAME_SPOT_SECONDS = 0.04;
/** Audio further from the video than this is moved back. */
const DEFAULT_MAX_DRIFT_SECONDS = 0.12;
/** A correction restarts the audio stream; this keeps a slow one from being restarted again before it lands. */
const FIX_INTERVAL_MS = 1500;
/** Longest head start the audio is given for a move that takes this long to land. */
const MAX_LEAD_SECONDS = 0.75;

const VIDEO_EVENTS = ["play", "playing", "pause", "ended", "waiting", "seeking", "seeked", "timeupdate", "ratechange", "volumechange"] as const;

/** Starts following; the returned function stops and silences the audio. */
export function followVideo(video: FollowedMedia, audio: FollowedMedia, options: FollowOptions = {}): () => void {
	const maxDrift = options.maxDriftSeconds ?? DEFAULT_MAX_DRIFT_SECONDS;
	const now = options.now ?? ((): number => performance.now());
	/** The video is buffering: it is not paused, but it is not advancing either. */
	let stalled = false;
	let released = false;
	/** How long the audio's last move took to land, so the next one can start that far ahead of the video. */
	let lead = 0;
	let moveStartedAt: number | null = null;
	let lastFixAt = Number.NEGATIVE_INFINITY;

	const running = (): boolean => !video.paused && !video.ended && !stalled;
	const buffered = (): boolean => audio.readyState >= HAVE_FUTURE_DATA;

	function moveTo(seconds: number): void {
		moveStartedAt = now();
		audio.currentTime = seconds;
	}

	function copyOutput(): void {
		audio.playbackRate = video.playbackRate;
		audio.volume = video.volume;
		audio.muted = video.muted;
	}

	/** The spot the audio has to be at to sound with a video that is playing: ahead by what a move costs. */
	function inStep(): number {
		return video.currentTime + lead * video.playbackRate;
	}

	/** Plays the audio beside the running video once it has data; `ahead` is for a move the video does not wait for. */
	function engage(ahead: boolean): void {
		if (released || !running() || !buffered()) return;
		const target = ahead ? inStep() : video.currentTime;
		if (Math.abs(audio.currentTime - target) > SAME_SPOT_SECONDS) moveTo(target);
		if (audio.paused) void audio.play().catch(() => undefined);
	}

	function onSeek(): void {
		if (!released && Math.abs(audio.currentTime - video.currentTime) > SAME_SPOT_SECONDS) moveTo(video.currentTime);
	}

	function onTime(): void {
		if (options.hasNativeAudio?.() === true) {
			release();
			options.onNativeAudio?.();
			return;
		}
		if (!running() || !buffered()) return;
		if (audio.paused) {
			engage(true);
			return;
		}
		if (Math.abs(audio.currentTime - video.currentTime) > maxDrift && now() - lastFixAt >= FIX_INTERVAL_MS) {
			lastFixAt = now();
			moveTo(inStep());
		}
	}

	const handlers: Readonly<Record<(typeof VIDEO_EVENTS)[number], () => void>> = {
		play: () => engage(true),
		playing: () => {
			stalled = false;
			engage(false);
		},
		pause: () => audio.pause(),
		ended: () => audio.pause(),
		waiting: () => {
			stalled = true;
			audio.pause();
		},
		seeking: onSeek,
		seeked: onSeek,
		timeupdate: onTime,
		ratechange: copyOutput,
		volumechange: copyOutput,
	};
	const onAudioSeeked = (): void => {
		if (moveStartedAt === null) return;
		lead = Math.min(Math.max(now() - moveStartedAt, 0) / 1000, MAX_LEAD_SECONDS);
		moveStartedAt = null;
	};
	// An audio that gets its data after the video started joins then; one already playing is left to the drift check.
	const onAudioCanPlay = (): void => {
		if (audio.paused) engage(true);
	};

	function release(): void {
		if (released) return;
		released = true;
		for (const name of VIDEO_EVENTS) video.removeEventListener(name, handlers[name]);
		audio.removeEventListener("seeked", onAudioSeeked);
		audio.removeEventListener("canplay", onAudioCanPlay);
		audio.pause();
	}

	for (const name of VIDEO_EVENTS) video.addEventListener(name, handlers[name]);
	audio.addEventListener("seeked", onAudioSeeked);
	audio.addEventListener("canplay", onAudioCanPlay);
	copyOutput();
	engage(false);
	return release;
}
