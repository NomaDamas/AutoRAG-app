import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactElement } from "react";
import { previewStreamUrl, type AudioMetadata, type PreviewDocument } from "../shared/contract";
import { formatClock, formatFinderSize } from "../shared/format";
import { useChrome } from "./chrome";
import { FallbackView } from "./fallback";
import { ContinueIcon, LoopIcon, PauseIcon, PictureInPictureIcon, PlayIcon, SkipIcon, SpeakerIcon } from "./icons";

const SKIP_SECONDS = 15;
const ARROW_SECONDS = 5;
const VIDEO_SPEEDS = [1, 1.25, 1.5, 2, 0.5] as const;
const AUDIO_SPEEDS = [1, 1.25, 1.5, 2, 0.75] as const;
/** The playing HUD fades after this long without the pointer moving. */
const HUD_IDLE_MS = 2500;
/** The audio panel is a fixed card in the reference: 620 × 368 with the toolbar. */
const AUDIO_BODY = { width: 620, height: 322 } as const;
const WAVE_BARS = 56;
/** Files past this size skip the waveform: decoding them costs more memory than the bars are worth. */
const WAVE_DECODE_CAP = 24 * 1024 * 1024;
/** Decoding at a low rate keeps the PCM small; peaks need no fidelity. */
const WAVE_SAMPLE_RATE = 8000;

interface MediaState {
	readonly playing: boolean;
	readonly time: number;
	readonly duration: number;
	readonly volume: number;
	readonly muted: boolean;
	readonly rate: number;
	readonly loop: boolean;
}

const INITIAL: MediaState = { playing: false, time: 0, duration: 0, volume: 1, muted: false, rate: 1, loop: false };

const EVENTS = ["play", "pause", "ended", "timeupdate", "durationchange", "loadedmetadata", "volumechange", "ratechange", "seeked"] as const;

/** Mirrors an `<audio>`/`<video>` element into React state and exposes its controls. */
function useMedia(element: HTMLMediaElement | null): MediaState & {
	readonly toggle: () => void;
	readonly seek: (seconds: number) => void;
	readonly skip: (seconds: number) => void;
	readonly setVolume: (volume: number) => void;
	readonly toggleMute: () => void;
	readonly cycleRate: (rates: readonly number[]) => void;
	readonly toggleLoop: () => void;
} {
	const [state, setState] = useState<MediaState>(INITIAL);
	useEffect(() => {
		if (element === null) return;
		const sync = (): void =>
			setState({
				playing: !element.paused && !element.ended,
				time: element.currentTime,
				duration: Number.isFinite(element.duration) ? element.duration : 0,
				volume: element.volume,
				muted: element.muted,
				rate: element.playbackRate,
				loop: element.loop,
			});
		sync();
		for (const name of EVENTS) element.addEventListener(name, sync);
		return () => {
			for (const name of EVENTS) element.removeEventListener(name, sync);
		};
	}, [element]);
	const controls = useMemo(() => {
		const seek = (seconds: number): void => {
			if (element === null) return;
			const end = Number.isFinite(element.duration) ? element.duration : seconds;
			element.currentTime = Math.min(Math.max(0, seconds), end);
		};
		return {
			seek,
			toggle: (): void => {
				if (element === null) return;
				if (element.paused || element.ended) void element.play().catch(() => undefined);
				else element.pause();
			},
			skip: (seconds: number): void => {
				if (element !== null) seek(element.currentTime + seconds);
			},
			setVolume: (volume: number): void => {
				if (element === null) return;
				element.volume = volume;
				element.muted = false;
			},
			toggleMute: (): void => {
				if (element !== null) element.muted = !element.muted;
			},
			cycleRate: (rates: readonly number[]): void => {
				if (element === null) return;
				element.playbackRate = rates[(rates.indexOf(element.playbackRate) + 1) % rates.length] ?? 1;
			},
			toggleLoop: (): void => {
				if (element === null) return;
				element.loop = !element.loop;
				setState((current) => ({ ...current, loop: element.loop }));
			},
		};
	}, [element]);
	return { ...state, ...controls };
}

/** Left/Right seek like Quick Look; Space, Escape, and Up/Down belong to the main process. */
function useArrowSeek(skip: (seconds: number) => void): void {
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			if (event.target instanceof HTMLInputElement && event.target.type !== "range") return;
			if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
				event.preventDefault();
				skip(event.key === "ArrowLeft" ? -ARROW_SECONDS : ARROW_SECONDS);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [skip]);
}

function percent(value: number, total: number): string {
	return total > 0 ? `${Math.min(100, Math.max(0, (value / total) * 100)).toFixed(2)}%` : "0%";
}

const RANGE = "absolute left-0 -top-6 w-full h-16 m-0 opacity-0 cursor-default";
const HUD_BUTTON = "grid flex-none place-items-center w-32 h-32 p-0 border-0 rounded-8 bg-transparent text-ql-hud-ink cursor-default hover:bg-ql-hud-hover";

/** A thin track with a white fill, an optional knob, and an invisible native range on top for input. */
function Track({
	value,
	max,
	step,
	label,
	onChange,
	className,
	knob,
	track,
}: {
	readonly value: number;
	readonly max: number;
	readonly step: number;
	readonly label: string;
	readonly onChange: (value: number) => void;
	readonly className: string;
	readonly knob: string | null;
	readonly track: string;
}): ReactElement {
	const fill = percent(value, max);
	return (
		<div className={`relative ${className} ${track}`}>
			<div className="h-full rounded-[inherit] bg-ql-hud-ink" style={{ width: fill }} />
			{knob === null ? null : <div className={`absolute rounded-full bg-ql-hud-ink shadow-ql-knob pointer-events-none ${knob}`} style={{ left: fill }} />}
			<input
				className={RANGE}
				type="range"
				min={0}
				max={max > 0 ? max : 1}
				step={step}
				value={value}
				aria-label={label}
				onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(Number(event.target.value))}
			/>
		</div>
	);
}

/**
 * Video with the reference's floating HUD: volume, ±15s and play in the
 * middle, speed, loop, and picture-in-picture on the right, and a scrubber
 * with elapsed and remaining time. Clicking the picture plays or pauses.
 */
export function VideoView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const [element, setElement] = useState<HTMLVideoElement | null>(null);
	const [failed, setFailed] = useState(false);
	const [idle, setIdle] = useState(false);
	const media = useMedia(element);
	useArrowSeek(media.skip);
	const timer = useRef<number | undefined>(undefined);
	const wake = useCallback(() => {
		setIdle(false);
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => setIdle(true), HUD_IDLE_MS);
	}, []);
	useEffect(() => {
		wake();
		return () => window.clearTimeout(timer.current);
	}, [wake]);
	if (failed) return <FallbackView file={file} note="동영상을 재생할 수 없습니다" />;
	const hidden = idle && media.playing;
	const volume = media.muted ? 0 : media.volume;
	return (
		<div className="ql-video relative flex-1 min-h-0 overflow-hidden bg-ql-media" data-idle={hidden} onPointerMove={wake} onPointerLeave={() => setIdle(true)}>
			<video
				ref={setElement}
				className="ql__video absolute inset-0 w-full h-full object-contain"
				src={previewStreamUrl(file.path)}
				autoPlay
				playsInline
				preload="auto"
				onError={() => setFailed(true)}
			/>
			<button type="button" className="absolute inset-0 p-0 border-0 bg-transparent cursor-default" aria-label="재생 또는 일시정지" onClick={media.toggle} />
			{media.playing ? null : (
				<div className="absolute left-1/2 top-1/2 grid place-items-center w-76 h-76 -mt-58 -ml-38 rounded-full bg-ql-hud-badge text-ql-hud-ink [backdrop-filter:blur(16px)] pointer-events-none">
					<PlayIcon size={34} />
				</div>
			)}
			<div
				className="ql-hud absolute left-1/2 bottom-20 flex flex-col gap-8 w-[min(640px,calc(100%-40px))] px-18 pt-10 pb-12 rounded-[18px] bg-ql-hud text-ql-hud-ink shadow-ql-hud [backdrop-filter:var(--backdrop-ql-hud)] -translate-x-1/2 transition-opacity duration-300 data-[hidden=true]:opacity-0"
				data-hidden={hidden}
			>
				<div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center">
					<div className="flex items-center gap-8">
						<button type="button" className={HUD_BUTTON} aria-label="음소거 전환" onClick={media.toggleMute}>
							<SpeakerIcon size={20} muted={volume === 0} />
						</button>
						<Track value={volume} max={1} step={0.01} label="볼륨" onChange={media.setVolume} className="w-84 h-4 rounded-2" track="bg-ql-hud-track" knob={null} />
					</div>
					<div className="flex items-center gap-16">
						<button type="button" className={HUD_BUTTON} aria-label="15초 뒤로" onClick={() => media.skip(-SKIP_SECONDS)}>
							<SkipIcon direction="back" />
						</button>
						<button type="button" className={`${HUD_BUTTON} w-40 h-40`} aria-label="재생 또는 일시정지" onClick={media.toggle}>
							{media.playing ? <PauseIcon size={28} /> : <PlayIcon size={28} />}
						</button>
						<button type="button" className={HUD_BUTTON} aria-label="15초 앞으로" onClick={() => media.skip(SKIP_SECONDS)}>
							<SkipIcon direction="forward" />
						</button>
					</div>
					<div className="flex items-center justify-end gap-4">
						<button
							type="button"
							className="h-22 px-8 border-0 rounded-6 bg-ql-hud-pill text-ql-hud-ink font-ql text-[11px] font-semibold tabular-nums cursor-default"
							aria-label="재생 속도"
							onClick={() => media.cycleRate(VIDEO_SPEEDS)}
						>
							{media.rate}×
						</button>
						<button
							type="button"
							className={`${HUD_BUTTON} ${media.loop ? "" : "text-ql-hud-ink-off"}`}
							aria-label="반복 재생"
							aria-pressed={media.loop}
							onClick={media.toggleLoop}
						>
							<LoopIcon size={18} weight={1.7} />
						</button>
						<button
							type="button"
							className={HUD_BUTTON}
							aria-label="PIP 모드"
							onClick={() => {
								if (element !== null) void element.requestPictureInPicture().catch(() => undefined);
							}}
						>
							<PictureInPictureIcon />
						</button>
					</div>
				</div>
				<div className="flex items-center gap-10 text-ql-hud-ink-dim text-[11px] tabular-nums">
					<span className="w-36">{formatClock(media.time)}</span>
					<Track value={media.time} max={media.duration} step={0.1} label="재생 위치" onChange={media.seek} className="flex-1 h-4 rounded-2" track="bg-ql-hud-track" knob="-top-4 w-12 h-12 -ml-6" />
					<span className="w-40 text-right">-{formatClock(media.duration - media.time)}</span>
				</div>
			</div>
		</div>
	);
}

/** Peak heights (px) for the waveform, or null while decoding or when the file is too large. */
function useWaveform(file: PreviewDocument): readonly number[] | null {
	const [peaks, setPeaks] = useState<readonly number[] | null>(null);
	useEffect(() => {
		if (file.size > WAVE_DECODE_CAP) return;
		const controller = new AbortController();
		const context = new OfflineAudioContext(1, 1, WAVE_SAMPLE_RATE);
		void fetch(previewStreamUrl(file.path), { signal: controller.signal })
			.then((response) => response.arrayBuffer())
			.then((buffer) => context.decodeAudioData(buffer))
			.then((audio) => {
				if (controller.signal.aborted) return;
				const channels = Array.from({ length: audio.numberOfChannels }, (_unused, index) => audio.getChannelData(index));
				const bucket = Math.max(1, Math.floor(audio.length / WAVE_BARS));
				const raw: number[] = [];
				for (let bar = 0; bar < WAVE_BARS; bar += 1) {
					let peak = 0;
					const end = Math.min(audio.length, (bar + 1) * bucket);
					for (const data of channels) {
						for (let sample = bar * bucket; sample < end; sample += 4) {
							const value = Math.abs(data[sample] ?? 0);
							if (value > peak) peak = value;
						}
					}
					raw.push(peak);
				}
				const loudest = Math.max(...raw, 0.0001);
				setPeaks(raw.map((peak) => 4 + (peak / loudest) * 24));
			})
			.catch(() => {
				if (!controller.signal.aborted) setPeaks(null);
			});
		return () => controller.abort();
	}, [file.path, file.size]);
	return peaks;
}

function useAudioMetadata(file: PreviewDocument): { readonly metadata: AudioMetadata | null; readonly cover: string | null } {
	const { bridge } = useChrome();
	const [metadata, setMetadata] = useState<AudioMetadata | null>(null);
	useEffect(() => {
		let cancelled = false;
		bridge.audioMetadata(file.path).then(
			(next) => {
				if (!cancelled) setMetadata(next);
			},
			(caught: unknown) => {
				if (!cancelled && !(caught instanceof Error)) throw caught;
			},
		);
		return () => {
			cancelled = true;
		};
	}, [bridge, file.path]);
	const picture = metadata?.picture ?? null;
	const cover = useMemo(() => (picture === null ? null : URL.createObjectURL(new Blob([new Uint8Array(picture.data)], { type: picture.mime }))), [picture]);
	useEffect(() => () => {
		if (cover !== null) URL.revokeObjectURL(cover);
	}, [cover]);
	return { metadata, cover };
}

function streamFacts(file: PreviewDocument, metadata: AudioMetadata | null): string {
	const facts = [file.ext.toUpperCase() || "AUDIO"];
	if (metadata?.bitrate != null) facts.push(`${Math.round(metadata.bitrate / 1000)} kbps`);
	if (metadata?.sampleRate != null) facts.push(`${Number((metadata.sampleRate / 1000).toFixed(1))} kHz`);
	facts.push(formatFinderSize(file.size));
	return facts.join(" · ");
}

const CHIP = "inline-flex items-center gap-5 h-22 px-8 border-0 rounded-6 bg-ql-button text-ql-ink-secondary font-ql text-[11px] font-semibold cursor-default aria-pressed:text-ql-accent";

/**
 * Audio as the reference's music card: cover art (or a stand-in sleeve),
 * title, artist, album, and time, a waveform that doubles as a scrubber,
 * stream facts with speed and repeat chips, a volume pill, and a transport bar
 * whose last button continues in the default app.
 */
export function AudioView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { report, bridge, app } = useChrome();
	const [element, setElement] = useState<HTMLAudioElement | null>(null);
	const [failed, setFailed] = useState(false);
	const media = useMedia(element);
	useArrowSeek(media.skip);
	const peaks = useWaveform(file);
	const { metadata, cover } = useAudioMetadata(file);
	useEffect(() => report(AUDIO_BODY, "clamp"), [report]);
	if (failed) return <FallbackView file={file} note="오디오를 재생할 수 없습니다" />;
	const title = metadata?.title ?? file.name.replace(/\.[^.]+$/, "");
	const duration = media.duration > 0 ? media.duration : (metadata?.duration ?? 0);
	const played = duration > 0 ? media.time / duration : 0;
	const rows: readonly (readonly [string, string])[] = [
		...(metadata?.artist == null ? [] : [["Artist", metadata.artist] as const]),
		...(metadata?.album == null ? [] : [["Album", metadata.album] as const]),
		["Time", formatClock(duration)],
	];
	return (
		<div className="ql-audio relative flex-1 min-h-0">
			<audio ref={setElement} src={previewStreamUrl(file.path)} autoPlay preload="auto" onError={() => setFailed(true)} />
			<div className="absolute right-14 top-0 flex items-center gap-10 w-196 h-36 px-14 rounded-[18px] bg-ql-hud-volume text-ql-hud-ink [backdrop-filter:var(--backdrop-ql-float)]">
				<Track
					value={media.muted ? 0 : media.volume}
					max={1}
					step={0.01}
					label="볼륨"
					onChange={media.setVolume}
					className="flex-1 h-5 rounded-3"
					track="bg-ql-hud-track"
					knob="-top-5 w-15 h-15 -ml-8"
				/>
				<SpeakerIcon size={20} muted={media.muted || media.volume === 0} />
			</div>
			<div className="ql-audio__art absolute left-60 top-8 w-212 h-212 overflow-hidden rounded-4 shadow-ql-art">
				{cover === null ? (
					<div className="relative w-full h-full [background:var(--ql-art-placeholder)]">
						<div className="absolute left-1/2 top-[58%] w-64 h-64 -mt-32 -ml-32 rounded-full bg-ql-art-ink" />
						<div className="absolute left-14 right-14 bottom-12 overflow-hidden text-ql-art-ink text-[11px] font-bold tracking-[0.2em] text-ellipsis whitespace-nowrap uppercase">{title}</div>
					</div>
				) : (
					<img className="block w-full h-full object-cover" alt="" src={cover} />
				)}
			</div>
			<div className="absolute left-300 right-24 top-34 flex flex-col gap-4">
				<div className="ql-audio__title mb-6 overflow-hidden text-[23px] font-bold tracking-[-0.01em] text-ellipsis whitespace-nowrap select-text">{title}</div>
				{rows.map(([label, value]) => (
					<div key={label} className="overflow-hidden text-[16px] text-ql-ink-secondary text-ellipsis whitespace-nowrap">
						{label}: <b className="font-semibold text-ql-ink">{value}</b>
					</div>
				))}
				<div className="relative flex items-center gap-2 h-30 mt-14">
					{Array.from({ length: WAVE_BARS }, (_unused, index) => (
						<span
							key={index}
							className={`flex-none w-[2.5px] rounded-2 ${(index + 0.5) / WAVE_BARS <= played ? "bg-ql-ink" : "bg-ql-wave-off"}`}
							style={{ height: `${(peaks?.[index] ?? 4).toFixed(1)}px` }}
						/>
					))}
					<input
						className="absolute inset-0 w-full h-full m-0 opacity-0 cursor-default"
						type="range"
						min={0}
						max={duration > 0 ? duration : 1}
						step={0.5}
						value={media.time}
						aria-label="파형에서 재생 위치 이동"
						onChange={(event) => media.seek(Number(event.target.value))}
					/>
				</div>
				<div className="flex items-center gap-6 mt-6 text-ql-ink-secondary text-[11px]">
					<span className="overflow-hidden text-ellipsis whitespace-nowrap">{streamFacts(file, metadata)}</span>
					<span className="flex-1" />
					<button type="button" className={CHIP} aria-label="재생 속도" onClick={() => media.cycleRate(AUDIO_SPEEDS)}>
						{media.rate}×
					</button>
					<button type="button" className={CHIP} aria-label="반복 재생" aria-pressed={media.loop} onClick={media.toggleLoop}>
						<LoopIcon size={13} weight={2.2} />
						반복
					</button>
				</div>
			</div>
			<div className="absolute left-8 right-8 bottom-8 flex items-center gap-4 h-48 px-10 rounded-14 bg-ql-hud-audio text-ql-hud-ink text-[12px] tabular-nums [backdrop-filter:var(--backdrop-ql-hud)]">
				<button type="button" className={HUD_BUTTON} aria-label="15초 뒤로" onClick={() => media.skip(-SKIP_SECONDS)}>
					<SkipIcon direction="back" />
				</button>
				<button type="button" className={HUD_BUTTON} aria-label="재생 또는 일시정지" onClick={media.toggle}>
					{media.playing ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
				</button>
				<button type="button" className={HUD_BUTTON} aria-label="15초 앞으로" onClick={() => media.skip(SKIP_SECONDS)}>
					<SkipIcon direction="forward" />
				</button>
				<span className="w-46 text-center text-ql-hud-ink-dim">{formatClock(media.time)}</span>
				<Track value={media.time} max={duration} step={0.5} label="재생 위치" onChange={media.seek} className="flex-1 h-4 rounded-2" track="bg-ql-hud-track" knob="-top-6 w-16 h-16 -ml-8" />
				<span className="w-46 text-center text-ql-hud-ink-dim">{formatClock(duration)}</span>
				<button type="button" className={HUD_BUTTON} aria-label={app === null ? "기본 앱에서 계속 듣기" : `${app}에서 계속 듣기`} title={app === null ? "기본 앱에서 계속 듣기" : `${app}에서 계속 듣기`} onClick={() => {
					element?.pause();
					void bridge.request("open");
				}}>
					<ContinueIcon />
				</button>
			</div>
		</div>
	);
}
