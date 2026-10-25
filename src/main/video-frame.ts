/**
 * One decoded frame of a video, as PNG bytes, for the file tile and the
 * Inspector's preview paper.
 *
 * macOS Quick Look (and the Windows shell) have no decoder for Matroska, WebM,
 * Ogg video, or most AVI files, so the OS answers with a generic type icon.
 * Those containers take their picture from `ffmpeg` instead, when the machine
 * has it (the same optional program the video-conversion action uses). No
 * `ffmpeg` is "no frame": the caller keeps the OS thumbnail/type-icon chain, so
 * a machine without it behaves exactly as before. A file `ffmpeg` cannot decode
 * rejects with its own message; the caller logs it and falls back the same way.
 */

import { execFile } from "node:child_process";

/** Containers whose frame is drawn by ffmpeg rather than asked of the OS. */
const VIDEO_FRAME_EXTENSIONS: Readonly<Record<string, true>> = { mkv: true, webm: true, ogv: true, avi: true };

export function isVideoFrameExtension(ext: string): boolean {
	return Object.hasOwn(VIDEO_FRAME_EXTENSIONS, ext.toLowerCase().replace(/^\./, ""));
}

/** Where the frame is taken: past a black or title lead-in, before a short clip ends. */
const SEEK_SECONDS = 1;
/** The process is killed at this deadline; the provider's own deadline is slightly longer. */
const FFMPEG_TIMEOUT_MS = 3500;
/** A 640px PNG is far below this; the cap only bounds a runaway process. */
const FRAME_MAX_BYTES = 16 * 1024 * 1024;

export interface VideoFrameDeps {
	/** The ffmpeg program; defaults to `ffmpeg` on PATH. */
	readonly command?: string;
	/** Process deadline in ms; defaults to FFMPEG_TIMEOUT_MS. */
	readonly timeoutMs?: number;
}

function frameArgs(path: string, size: number, seekSeconds: number): string[] {
	// Square the pixels first (anamorphic sources), then fit inside the box without enlarging.
	const filter = `scale=trunc(iw*sar):ih,setsar=1,scale='min(iw,${size})':'min(ih,${size})':force_original_aspect_ratio=decrease`;
	return [
		"-v", "error", "-nostdin",
		"-ss", String(seekSeconds), "-i", path,
		"-frames:v", "1", "-an", "-sn", "-vf", filter,
		"-f", "image2pipe", "-c:v", "png", "pipe:1",
	];
}

function runFfmpeg(command: string, args: string[], timeoutMs: number): Promise<Uint8Array | null> {
	const { promise, resolve, reject } = Promise.withResolvers<Uint8Array | null>();
	execFile(command, args, { encoding: "buffer", timeout: timeoutMs, maxBuffer: FRAME_MAX_BYTES, windowsHide: true }, (error, stdout, stderr) => {
		if (error !== null) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				resolve(null);
				return;
			}
			const detail = stderr.toString("utf8").trim();
			reject(new Error(detail.length > 0 ? detail : error.message));
			return;
		}
		resolve(stdout.length > 0 ? new Uint8Array(stdout) : null);
	});
	return promise;
}

/**
 * The frame at the one-second mark, fitted inside `size`×`size` px, or the
 * first frame when the clip ends before that. Null when ffmpeg is not
 * installed or the clip has no video frame; rejects when ffmpeg fails.
 */
export async function extractVideoFrame(path: string, size: number, deps: VideoFrameDeps = {}): Promise<Uint8Array | null> {
	const command = deps.command ?? "ffmpeg";
	const timeoutMs = deps.timeoutMs ?? FFMPEG_TIMEOUT_MS;
	// A seek past the end exits cleanly with no output, so an empty answer retries from the start.
	return (await runFfmpeg(command, frameArgs(path, size, SEEK_SECONDS), timeoutMs)) ?? (await runFfmpeg(command, frameArgs(path, size, 0), timeoutMs));
}
