import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { planPlaybackEncode, parsePlaybackProbe, type PlaybackEncode, type VideoPlaybackPlan } from "../shared/video-playback";
import { ffmpegListing, MIX_FILTER } from "./video-audio";

/**
 * Plays what Chromium cannot open (an AVI) by rewriting it with ffmpeg into an
 * MP4 in a cache directory, once per file version. Streams that an MP4 plays as
 * they are are copied, so a typical h264 AVI takes seconds; the rest is
 * re-encoded to H.264 and AAC. Anything that goes wrong (no ffmpeg, not a video,
 * aborted) answers "native": the panel then plays the file itself, which fails
 * the way it did before and shows its fallback.
 */

export interface VideoPlaybackDeps {
	/** Where finished copies live; created on first use. */
	readonly dir: string;
	/** The ffmpeg program; defaults to `ffmpeg` on PATH. */
	readonly command?: string;
	/** Total size the finished copies may use; the least recently used go first. */
	readonly maxBytes?: number;
}

export interface VideoPlaybackRequest {
	readonly signal?: AbortSignal;
	/** How much of the video is rewritten, 0 to 1; 1 when a copy already exists. */
	readonly onProgress?: (fraction: number) => void;
}

export interface VideoPlayback {
	prepare(path: string, request?: VideoPlaybackRequest): Promise<VideoPlaybackPlan>;
}

const PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 4 * 1024 ** 3;
const PART_SUFFIX = ".part";
const COPY_SUFFIX = ".mp4";

function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function encodeArgs(source: string, target: string, encode: PlaybackEncode): string[] {
	const video = encode.video === "copy" ? ["-c:v", "copy"] : ["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"];
	const audio = encode.audio === "none" ? ["-an"] : encode.audio === "copy" ? ["-c:a", "copy"] : ["-af", MIX_FILTER, "-c:a", "aac", "-b:a", "192k"];
	return [
		"-hide_banner",
		"-nostdin",
		"-v",
		"error",
		"-y",
		"-i",
		source,
		"-map",
		"0:v:0",
		...(encode.audio === "none" ? [] : ["-map", "0:a:0"]),
		...video,
		...audio,
		"-movflags",
		"+faststart",
		"-f",
		"mp4",
		"-progress",
		"pipe:1",
		"-nostats",
		target,
	];
}

/** Runs one ffmpeg rewrite; true when it exited cleanly and was not aborted. */
function runEncode(command: string, args: readonly string[], durationSeconds: number | null, signal: AbortSignal | undefined, onFraction: (fraction: number) => void): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
	const stop = (): void => {
		child.kill("SIGTERM");
	};
	signal?.addEventListener("abort", stop, { once: true });
	let pending = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		pending += chunk;
		const lines = pending.split("\n");
		pending = lines.pop() ?? "";
		for (const line of lines) {
			const match = /^out_time_us=(\d+)$/.exec(line);
			if (match === null || durationSeconds === null) continue;
			onFraction(Math.min(1, Number(match[1]) / 1e6 / durationSeconds));
		}
	});
	child.on("error", () => resolve(false));
	child.on("close", (code) => {
		signal?.removeEventListener("abort", stop);
		resolve(code === 0 && signal?.aborted !== true);
	});
	if (signal?.aborted === true) stop();
	return promise;
}

/** Deletes the least recently used copies until the rest fit `maxBytes`; `keep` is never deleted. */
async function evict(dir: string, keep: string, maxBytes: number): Promise<void> {
	const copies = [];
	for (const name of await readdir(dir)) {
		if (!name.endsWith(COPY_SUFFIX)) continue;
		const path = join(dir, name);
		try {
			const info = await stat(path);
			copies.push({ path, size: info.size, mtimeMs: info.mtimeMs });
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	let total = copies.reduce((sum, copy) => sum + copy.size, 0);
	for (const copy of copies.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
		if (total <= maxBytes) return;
		if (copy.path === keep) continue;
		await rm(copy.path, { force: true });
		total -= copy.size;
	}
}

export function createVideoPlayback(deps: VideoPlaybackDeps): VideoPlayback {
	const command = deps.command ?? "ffmpeg";
	const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
	const native: VideoPlaybackPlan = { kind: "native" };
	/** The directory exists and holds no partial output of a run that died; every job waits for this. */
	let ready: Promise<void> | null = null;
	const prepareDir = (): Promise<void> => {
		ready ??= (async () => {
			await mkdir(deps.dir, { recursive: true });
			for (const name of await readdir(deps.dir)) {
				if (name.endsWith(PART_SUFFIX)) await rm(join(deps.dir, name), { force: true });
			}
		})();
		return ready;
	};

	async function prepare(path: string, request: VideoPlaybackRequest = {}): Promise<VideoPlaybackPlan> {
		const { signal, onProgress } = request;
		if (signal?.aborted === true) return native;
		let info;
		try {
			info = await stat(path);
		} catch (error) {
			if (isEnoent(error)) return native;
			throw error;
		}
		const name = createHash("sha1").update(`${path}\0${info.mtimeMs}\0${info.size}`).digest("hex");
		const target = join(deps.dir, `${name}${COPY_SUFFIX}`);
		try {
			await stat(target);
			const now = new Date();
			await utimes(target, now, now);
			onProgress?.(1);
			return { kind: "file", path: target };
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}

		const listing = await ffmpegListing(command, path, PROBE_TIMEOUT_MS);
		if (listing === null) return native;
		const probe = parsePlaybackProbe(listing);
		const encode = planPlaybackEncode(probe);
		if (encode === null) return native;

		await prepareDir();
		const part = join(deps.dir, `${name}${PART_SUFFIX}`);
		let reported = 0;
		const report = (fraction: number): void => {
			if (fraction <= reported) return;
			reported = fraction;
			onProgress?.(fraction);
		};
		// Copying can fail where re-encoding does not (timestamps an MP4 rejects), so a failed copy gets one full re-encode.
		const attempts: PlaybackEncode[] = encode.video === "copy" || encode.audio === "copy" ? [encode, { video: "transcode", audio: encode.audio === "none" ? "none" : "transcode" }] : [encode];
		let done = false;
		for (const attempt of attempts) {
			done = await runEncode(command, encodeArgs(path, part, attempt), probe.durationSeconds, signal, (fraction) => report(Math.min(fraction, 0.99)));
			if (done || signal?.aborted) break;
		}
		if (!done) {
			await rm(part, { force: true });
			return native;
		}
		await rename(part, target);
		report(1);
		await evict(deps.dir, target, maxBytes);
		return { kind: "file", path: target };
	}

	return { prepare };
}
