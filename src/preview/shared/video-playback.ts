/**
 * Videos whose container Chromium cannot open at all. The `<video>` element
 * raises MEDIA_ERR_SRC_NOT_SUPPORTED for an AVI whatever codecs it holds (the
 * engine ships no AVI demuxer), so ffmpeg rewrites the file into an MP4 the
 * element plays, once, into a cache (see ../node/video-playback.ts).
 */

const PROXIED_EXTENSIONS: Readonly<Record<string, true>> = { avi: true };

/** Whether the panel must play a rewritten copy of a file with this extension (no dot, any case). */
export function needsPlaybackCopy(extension: string): boolean {
	return Object.hasOwn(PROXIED_EXTENSIONS, extension.toLowerCase());
}

/** What the panel plays for a file: itself, or the MP4 ffmpeg made from it. */
export type VideoPlaybackPlan = { readonly kind: "native" } | { readonly kind: "file"; readonly path: string };

/** Main -> panel while a copy is being made: how much of the video is done, 0 to 1. */
export interface VideoPlaybackProgress {
	readonly id: string;
	readonly fraction: number;
}

export function isVideoPlaybackProgress(value: unknown): value is VideoPlaybackProgress {
	if (typeof value !== "object" || value === null) return false;
	const { id, fraction } = value as Record<string, unknown>;
	return typeof id === "string" && typeof fraction === "number" && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1;
}

/** The first video and first audio stream of a file, as `ffmpeg -i` lists them. */
export interface PlaybackProbe {
	readonly durationSeconds: number | null;
	readonly video: { readonly codec: string; readonly pixelFormat: string | null } | null;
	readonly audioCodec: string | null;
}

const DURATION = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;
const VIDEO_STREAM = /^[ \t]*Stream #\d+:\d+[^\n]*?: Video: ([A-Za-z0-9_]+)([^\n]*)$/m;
const AUDIO_STREAM = /^[ \t]*Stream #\d+:\d+[^\n]*?: Audio: ([A-Za-z0-9_]+)/m;
/** The pixel format is the first bare token after the codec's parenthesised details. */
const PIXEL_FORMAT = /,\s*([a-z][a-z0-9]*?)(?:\([^)]*\))?\s*(?:,|$)/;

export function parsePlaybackProbe(listing: string): PlaybackProbe {
	const input = listing.split(/Stream mapping:|Output #0/)[0] ?? listing;
	const time = DURATION.exec(input);
	const seconds = time === null ? Number.NaN : Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]);
	const video = VIDEO_STREAM.exec(input);
	const audio = AUDIO_STREAM.exec(input);
	return {
		durationSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
		video: video === null ? null : { codec: video[1] ?? "", pixelFormat: PIXEL_FORMAT.exec(video[2] ?? "")?.[1] ?? null },
		audioCodec: audio?.[1] ?? null,
	};
}

/** What the rewrite does with each stream: copied bit for bit when an MP4 plays it as is, else re-encoded. */
export interface PlaybackEncode {
	readonly video: "copy" | "transcode";
	readonly audio: "copy" | "transcode" | "none";
}

const COPYABLE_PIXEL_FORMATS: Readonly<Record<string, true>> = { yuv420p: true, yuvj420p: true };
/** Audio an MP4 holds and the element decodes. */
const COPYABLE_AUDIO: Readonly<Record<string, true>> = { aac: true, mp3: true };

/** The rewrite for a file, or null when it has no picture to play. */
export function planPlaybackEncode(probe: PlaybackProbe): PlaybackEncode | null {
	if (probe.video === null) return null;
	const video = probe.video.codec === "h264" && probe.video.pixelFormat !== null && Object.hasOwn(COPYABLE_PIXEL_FORMATS, probe.video.pixelFormat) ? "copy" : "transcode";
	const audio = probe.audioCodec === null ? "none" : Object.hasOwn(COPYABLE_AUDIO, probe.audioCodec) ? "copy" : "transcode";
	return { video, audio };
}
