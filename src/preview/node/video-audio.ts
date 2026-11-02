import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { parseByteRange } from "../shared/range";
import {
	parseAudioProbe,
	pickSidecarTrack,
	SIDECAR_BYTES_PER_FRAME,
	SIDECAR_SAMPLE_RATE,
	sidecarDataBytes,
	WAV_HEADER_BYTES,
	wavHeader,
	type AudioProbe,
	type VideoAudioPlan,
} from "../shared/video-audio";

/**
 * The ffmpeg half of the video-audio sidecar (see shared/video-audio.ts for why
 * it exists): finds out whether a video's sound needs it, and serves the track as
 * a seekable stereo WAV decoded on demand. No `ffmpeg` on the machine means no
 * sidecar: the video then plays as it always did (the same optional program the
 * video thumbnails and conversions use).
 */

export interface VideoAudioDeps {
	/** The ffmpeg program; defaults to `ffmpeg` on PATH. */
	readonly command?: string;
	/** Probe deadline in ms; defaults to PROBE_TIMEOUT_MS. */
	readonly timeoutMs?: number;
}

const PROBE_TIMEOUT_MS = 10_000;
/** `ffmpeg -i` lists a file's streams and chapters; the cap only bounds a runaway process. */
const PROBE_MAX_BUFFER = 1024 * 1024;
const PROBE_CACHE_LIMIT = 32;

/**
 * 5.1 and 7.1 tracks mix down at the gain that keeps them from clipping, which
 * leaves dialogue about 8 dB quieter than the same file in a player; `rematrix_maxval`
 * lifts the mix to its natural level and the limiter catches the peaks that
 * would clip. `async=1:first_pts=0` keeps every sample at its timestamp: a track
 * with damaged frames still ends when the video does (measured on a mkv whose
 * AC-3 stream drops frames: 232 MB of PCM without it, 323 MB of 323.3 MB with it).
 */
export const MIX_FILTER = "aresample=osr=48000:ochl=stereo:rematrix_maxval=3:async=1:first_pts=0,alimiter=limit=0.95:level=disabled:latency=1";

/** Streams of files already probed, by file identity: Chromium issues a request per seek, each needing the duration. */
const probes = new Map<string, Promise<AudioProbe | null>>();

function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** The stderr listing of `ffmpeg -i <path>`; null when there is no ffmpeg or it ran out of time. */
export function ffmpegListing(command: string, path: string, timeoutMs: number): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	// `ffmpeg -i` with no output prints the listing and exits 1, so the error is expected; only a missing program or a deadline means "no answer".
	execFile(command, ["-hide_banner", "-nostdin", "-i", path], { encoding: "utf8", timeout: timeoutMs, maxBuffer: PROBE_MAX_BUFFER, windowsHide: true }, (error, _stdout, stderr) => {
		resolve(error !== null && (isEnoent(error) || error.killed === true) ? null : stderr);
	});
	return promise;
}

async function runProbe(command: string, path: string, timeoutMs: number): Promise<AudioProbe | null> {
	const listing = await ffmpegListing(command, path, timeoutMs);
	return listing === null ? null : parseAudioProbe(listing);
}

/** The audio streams and duration of `path`; null when there is no ffmpeg, no such file, or ffmpeg ran out of time. */
async function probeAudio(path: string, deps: VideoAudioDeps): Promise<AudioProbe | null> {
	let info;
	try {
		info = await stat(path);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
	const command = deps.command ?? "ffmpeg";
	const key = `${command}\0${path}\0${info.mtimeMs}\0${info.size}`;
	let probe = probes.get(key);
	if (probe === undefined) {
		probe = runProbe(command, path, deps.timeoutMs ?? PROBE_TIMEOUT_MS);
		probes.set(key, probe);
		if (probes.size > PROBE_CACHE_LIMIT) {
			const oldest = probes.keys().next().value;
			if (oldest !== undefined) probes.delete(oldest);
		}
		void probe.then((result) => {
			if (result === null && probes.get(key) === probe) probes.delete(key);
		});
	}
	return probe;
}

/** How the panel gets the sound of the video at `path`: its own track, or the ffmpeg-decoded sidecar of the track Chromium cannot play. */
export async function planVideoAudio(path: string, deps: VideoAudioDeps = {}): Promise<VideoAudioPlan> {
	const probe = await probeAudio(path, deps);
	const track = probe === null ? null : pickSidecarTrack(probe);
	return track === null ? { kind: "native" } : { kind: "sidecar", track: track.ordinal, codec: track.codec };
}

function decodeArgs(path: string, track: number, firstFrame: number): string[] {
	// A microsecond seek keeps the start within half a microsecond (a 48 kHz frame is 21 µs) of the frame asked for.
	const seek = firstFrame === 0 ? [] : ["-ss", `${Math.round((firstFrame * 1e6) / SIDECAR_SAMPLE_RATE)}us`];
	return ["-v", "quiet", "-nostdin", ...seek, "-i", path, "-map", `0:a:${track}`, "-vn", "-sn", "-dn", "-af", MIX_FILTER, "-f", "s16le", "pipe:1"];
}

const ZEROS = new Uint8Array(64 * 1024);

/**
 * Exactly `length` bytes of the track's PCM starting `skip` bytes into frame
 * `firstFrame`: ffmpeg's output trimmed to that, then silence if the track ends
 * early (the response declared its length, and a body that falls short of it is a
 * network error to the media pipeline). ffmpeg is stopped as soon as the reader
 * lets go, so a seek or a closed panel never leaves it decoding.
 */
async function* decodePcm(command: string, path: string, track: number, firstFrame: number, skip: number, length: number): AsyncGenerator<Uint8Array> {
	const child = spawn(command, decodeArgs(path, track, firstFrame), { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
	let failure: Error | null = null;
	child.once("error", (error) => {
		failure = error;
	});
	const closed = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
	let remaining = length;
	let toSkip = skip;
	try {
		for await (const chunk of child.stdout as AsyncIterable<Uint8Array>) {
			let bytes = chunk;
			if (toSkip > 0) {
				const dropped = Math.min(toSkip, bytes.byteLength);
				toSkip -= dropped;
				bytes = bytes.subarray(dropped);
			}
			if (bytes.byteLength === 0) continue;
			if (bytes.byteLength > remaining) bytes = bytes.subarray(0, remaining);
			remaining -= bytes.byteLength;
			yield bytes;
			if (remaining === 0) return;
		}
		const code = await closed;
		// Nothing decoded and ffmpeg failed: silence would hide that the track cannot be played.
		if (remaining === length && (failure !== null || (code !== null && code !== 0))) {
			throw failure ?? new Error(`ffmpeg exited with code ${code} decoding audio track ${track}`);
		}
		while (remaining > 0) {
			const pad = Math.min(remaining, ZEROS.byteLength);
			remaining -= pad;
			yield ZEROS.subarray(0, pad);
		}
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill();
	}
}

async function* sidecarBytes(command: string, path: string, track: number, start: number, end: number, dataBytes: number): AsyncGenerator<Uint8Array> {
	if (start < WAV_HEADER_BYTES) yield wavHeader(dataBytes).subarray(start, Math.min(end, WAV_HEADER_BYTES - 1) + 1);
	if (end < WAV_HEADER_BYTES) return;
	const pcmStart = Math.max(start, WAV_HEADER_BYTES) - WAV_HEADER_BYTES;
	const firstFrame = Math.floor(pcmStart / SIDECAR_BYTES_PER_FRAME);
	yield* decodePcm(command, path, track, firstFrame, pcmStart - firstFrame * SIDECAR_BYTES_PER_FRAME, end - WAV_HEADER_BYTES - pcmStart + 1);
}

/**
 * Audio track `track` of `path` as a stereo 48 kHz 16-bit WAV, with HTTP range
 * support. The header declares the whole length up front (from the container's
 * duration), so a seek is a byte-range request and decoding starts at that time;
 * nothing is stored. 404 when the file, the track, or a duration to size the
 * stream with is missing.
 */
export async function videoAudioResponse(path: string, track: number, rangeHeader: string | null, deps: VideoAudioDeps = {}): Promise<Response> {
	const probe = await probeAudio(path, deps);
	if (probe === null || probe.durationSeconds === null || probe.streams[track] === undefined) return new Response("no such audio", { status: 404 });
	const dataBytes = sidecarDataBytes(probe.durationSeconds);
	const total = WAV_HEADER_BYTES + dataBytes;
	const headers = new Headers({ "accept-ranges": "bytes", "content-type": "audio/wav", "cache-control": "no-store" });
	let start = 0;
	let end = total - 1;
	let status = 200;
	if (rangeHeader !== null) {
		const range = parseByteRange(rangeHeader, total);
		if (range === null) {
			headers.set("content-range", `bytes */${total}`);
			return new Response(null, { status: 416, headers });
		}
		({ start, end } = range);
		status = 206;
		headers.set("content-range", `bytes ${start}-${end}/${total}`);
	}
	headers.set("content-length", String(end - start + 1));
	const body = Readable.toWeb(Readable.from(sidecarBytes(deps.command ?? "ffmpeg", path, track, start, end, dataBytes), { objectMode: false })) as ReadableStream<Uint8Array>;
	return new Response(body, { status, headers });
}
