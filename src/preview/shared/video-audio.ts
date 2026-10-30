/**
 * Audio that Electron's media pipeline cannot play, decoded by ffmpeg instead.
 *
 * Chromium plays the picture of a video whose audio is AC-3, E-AC-3, DTS, TrueHD,
 * ALAC, MP2, WMA, or ADPCM, and no sound at all: it reports no error, the element
 * runs, `webkitAudioDecodedByteCount` stays 0 (measured per codec on Electron 44,
 * in mkv and mp4 alike). Broadcast and disc rips (HDTV mkv with AC-3 5.1) are
 * exactly such files.
 *
 * The fix keeps the video element as it is and plays the track beside it: the main
 * process serves the audio as a stereo 48 kHz WAV whose length is known up front
 * (so the player can seek by byte range), and the video drives a hidden `<audio>`
 * (`ui/audio-follow.ts`). This file is the part both processes share: reading what
 * `ffmpeg -i` lists, deciding which files need the sidecar, and the WAV framing.
 */

export const SIDECAR_SAMPLE_RATE = 48000;
export const SIDECAR_CHANNELS = 2;
/** 16-bit samples. */
const BYTES_PER_SAMPLE = 2;
/** One stereo 16-bit frame: the unit a byte offset in the sidecar maps to a time with. */
export const SIDECAR_BYTES_PER_FRAME = SIDECAR_CHANNELS * BYTES_PER_SAMPLE;
export const WAV_HEADER_BYTES = 44;
/** A WAV's RIFF length is a 32-bit field: 36 bytes of the header count toward it. */
const WAV_MAX_DATA_BYTES = Math.floor((0xffffffff - (WAV_HEADER_BYTES - 8)) / SIDECAR_BYTES_PER_FRAME) * SIDECAR_BYTES_PER_FRAME;

export interface AudioStreamInfo {
	/** Position among the file's audio streams (ffmpeg's `0:a:<ordinal>`), not among all streams. */
	readonly ordinal: number;
	readonly codec: string;
	readonly isDefault: boolean;
}

export interface AudioProbe {
	/** Container duration; null when the container does not say. */
	readonly durationSeconds: number | null;
	readonly streams: readonly AudioStreamInfo[];
}

/** What the video panel does about a file's sound. */
export type VideoAudioPlan = { readonly kind: "native" } | { readonly kind: "sidecar"; readonly track: number; readonly codec: string };

const DURATION = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;
const AUDIO_STREAM = /^[ \t]*Stream #\d+:\d+[^\n]*?: Audio: ([A-Za-z0-9_]+)([^\n]*)$/gm;

/** The audio streams and duration in the stderr listing of `ffmpeg -i <file>`. */
export function parseAudioProbe(listing: string): AudioProbe {
	const input = listing.split(/Stream mapping:|Output #0/)[0] ?? listing;
	const time = DURATION.exec(input);
	const seconds = time === null ? Number.NaN : Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]);
	const streams: AudioStreamInfo[] = [];
	for (const match of input.matchAll(AUDIO_STREAM)) {
		streams.push({ ordinal: streams.length, codec: match[1] ?? "", isDefault: (match[2] ?? "").includes("(default)") });
	}
	return { durationSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null, streams };
}

/**
 * Codecs Electron 44's video element was measured to decode (non-zero decoded audio
 * bytes). Anything else is handed to ffmpeg; a codec missing here costs a sidecar,
 * never silence, and the player drops the sidecar when the element decodes after all.
 */
const CHROMIUM_AUDIO: Readonly<Record<string, true>> = {
	aac: true,
	mp3: true,
	opus: true,
	vorbis: true,
	flac: true,
	pcm_s16le: true,
	pcm_s16be: true,
	pcm_s24le: true,
	pcm_s24be: true,
	pcm_s32le: true,
	pcm_f32le: true,
	pcm_u8: true,
	pcm_alaw: true,
	pcm_mulaw: true,
};

export function chromiumPlaysAudio(codec: string): boolean {
	return Object.hasOwn(CHROMIUM_AUDIO, codec);
}

/**
 * The track the sidecar plays, or null when the file needs none: no audio, a track
 * the element plays itself (it picks that one, whatever else the file lists), or no
 * duration to size a seekable stream with. Among tracks it cannot play: the default
 * one, else the first.
 */
export function pickSidecarTrack(probe: AudioProbe): AudioStreamInfo | null {
	if (probe.durationSeconds === null || probe.streams.length === 0) return null;
	if (probe.streams.some((stream) => chromiumPlaysAudio(stream.codec))) return null;
	return probe.streams.find((stream) => stream.isDefault) ?? probe.streams[0] ?? null;
}

/** PCM bytes of `seconds` of sidecar audio, whole frames, capped at what a WAV length field holds. */
export function sidecarDataBytes(seconds: number): number {
	return Math.min(Math.floor(seconds * SIDECAR_SAMPLE_RATE) * SIDECAR_BYTES_PER_FRAME, WAV_MAX_DATA_BYTES);
}

/** The canonical 44-byte header of a 16-bit stereo 48 kHz PCM WAV holding `dataBytes`. */
export function wavHeader(dataBytes: number): Uint8Array {
	const header = new Uint8Array(WAV_HEADER_BYTES);
	const view = new DataView(header.buffer);
	const tag = (at: number, text: string): void => {
		for (let index = 0; index < text.length; index += 1) header[at + index] = text.charCodeAt(index);
	};
	tag(0, "RIFF");
	view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true);
	tag(8, "WAVE");
	tag(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, SIDECAR_CHANNELS, true);
	view.setUint32(24, SIDECAR_SAMPLE_RATE, true);
	view.setUint32(28, SIDECAR_SAMPLE_RATE * SIDECAR_BYTES_PER_FRAME, true);
	view.setUint16(32, SIDECAR_BYTES_PER_FRAME, true);
	view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
	tag(36, "data");
	view.setUint32(40, dataBytes, true);
	return header;
}
