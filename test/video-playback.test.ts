import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVideoPlayback } from "../src/preview/node/video-playback";
import { isVideoPlaybackProgress, needsPlaybackCopy, parsePlaybackProbe, planPlaybackEncode } from "../src/preview/shared/video-playback";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

const AVI_XVID_MP3 = `Input #0, avi, from 'old.avi':
  Duration: 00:01:30.50, start: 0.000000, bitrate: 1200 kb/s
  Stream #0:0: Video: mpeg4 (Simple Profile) (XVID / 0x44495658), yuv420p, 624x352 [SAR 1:1 DAR 39:22], 25 fps, 25 tbr, 25 tbn
  Stream #0:1: Audio: mp3 (mp3float) ([1][0][0][0] / 0x0055), 48000 Hz, stereo, fltp, 128 kb/s
At least one output file must be specified
`;

const AVI_H264_AC3 = `Input #0, avi, from 'rip.avi':
  Duration: 01:00:00.00, start: 0.000000, bitrate: 2000 kb/s
  Stream #0:0: Video: h264 (High) (H264 / 0x34363248), yuv420p(progressive), 1280x720 [SAR 1:1 DAR 16:9], 23.98 fps
  Stream #0:1: Audio: ac3 ([0][0][0][0] / 0x2000), 48000 Hz, 5.1(side), fltp, 448 kb/s
`;

const AVI_H264_10BIT = `Input #0, avi, from 'ten.avi':
  Duration: 00:10:00.00, start: 0.000000, bitrate: 2000 kb/s
  Stream #0:0: Video: h264 (High 10) (H264 / 0x34363248), yuv420p10le(tv, progressive), 1280x720, 23.98 fps
`;

describe("needsPlaybackCopy", () => {
	it("is true for an avi in any case and false for containers Chromium opens", () => {
		expect(needsPlaybackCopy("avi")).toBe(true);
		expect(needsPlaybackCopy("AVI")).toBe(true);
		expect(needsPlaybackCopy("mkv")).toBe(false);
		expect(needsPlaybackCopy("mp4")).toBe(false);
		expect(needsPlaybackCopy("constructor")).toBe(false);
	});
});

describe("parsePlaybackProbe", () => {
	it("reads the first video and audio codec, the pixel format, and the duration", () => {
		expect(parsePlaybackProbe(AVI_XVID_MP3)).toEqual({ durationSeconds: 90.5, video: { codec: "mpeg4", pixelFormat: "yuv420p" }, audioCodec: "mp3" });
		expect(parsePlaybackProbe(AVI_H264_AC3)).toEqual({ durationSeconds: 3600, video: { codec: "h264", pixelFormat: "yuv420p" }, audioCodec: "ac3" });
	});

	it("keeps a 10-bit pixel format distinct from the 8-bit one and reports a missing audio stream", () => {
		expect(parsePlaybackProbe(AVI_H264_10BIT)).toEqual({ durationSeconds: 600, video: { codec: "h264", pixelFormat: "yuv420p10le" }, audioCodec: null });
	});

	it("finds no streams in text that is not a listing", () => {
		expect(parsePlaybackProbe("moov atom not found")).toEqual({ durationSeconds: null, video: null, audioCodec: null });
	});
});

describe("planPlaybackEncode", () => {
	it("re-encodes the picture of an xvid file and copies its mp3", () => {
		expect(planPlaybackEncode(parsePlaybackProbe(AVI_XVID_MP3))).toEqual({ video: "transcode", audio: "copy" });
	});

	it("copies 8-bit h264 and re-encodes AC-3", () => {
		expect(planPlaybackEncode(parsePlaybackProbe(AVI_H264_AC3))).toEqual({ video: "copy", audio: "transcode" });
	});

	it("re-encodes 10-bit h264, which the element cannot decode, and keeps a silent file silent", () => {
		expect(planPlaybackEncode(parsePlaybackProbe(AVI_H264_10BIT))).toEqual({ video: "transcode", audio: "none" });
	});

	it("has nothing to play without a video stream", () => {
		expect(planPlaybackEncode({ durationSeconds: 10, video: null, audioCodec: "mp3" })).toBeNull();
	});
});

describe("isVideoPlaybackProgress", () => {
	it("accepts an id with a fraction from 0 to 1 and nothing else", () => {
		expect(isVideoPlaybackProgress({ id: "a", fraction: 0.5 })).toBe(true);
		expect(isVideoPlaybackProgress({ id: "a", fraction: 1.2 })).toBe(false);
		expect(isVideoPlaybackProgress({ id: "a", fraction: Number.NaN })).toBe(false);
		expect(isVideoPlaybackProgress({ fraction: 0.5 })).toBe(false);
		expect(isVideoPlaybackProgress(null)).toBe(false);
	});
});

function listing(path: string): string {
	return spawnSync("ffmpeg", ["-hide_banner", "-i", path], { encoding: "utf8" }).stderr;
}

describe.skipIf(!hasFfmpeg)("createVideoPlayback", () => {
	let dir = "";
	let cache = "";
	const clip = (name: string) => join(dir, name);
	const BEEP = "aevalsrc='0.8*sin(2*PI*1000*t)*between(t,1,1.1)':s=44100:d=4";

	function make(name: string, video: string[], audio: string[]): string {
		const path = clip(name);
		execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=4", "-f", "lavfi", "-i", BEEP, ...video, ...audio, path]);
		return path;
	}

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "video-playback-"));
		cache = join(dir, "cache");
		make("xvid-mp3.avi", ["-c:v", "mpeg4", "-pix_fmt", "yuv420p"], ["-c:a", "libmp3lame"]);
		make("h264-mp3.avi", ["-c:v", "libx264", "-pix_fmt", "yuv420p"], ["-c:a", "libmp3lame"]);
		make("h264-ac3.avi", ["-c:v", "libx264", "-pix_fmt", "yuv420p"], ["-c:a", "ac3"]);
		execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=4", "-an", "-c:v", "mpeg4", clip("silent.avi")]);
	});
	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("rewrites an xvid and mp3 avi into an mp4 of h264 and the original mp3 with the same length", async () => {
		const playback = createVideoPlayback({ dir: cache });
		const plan = await playback.prepare(clip("xvid-mp3.avi"));
		expect(plan.kind).toBe("file");
		if (plan.kind !== "file") return;
		const out = listing(plan.path);
		expect(out).toMatch(/Input #0, mov,mp4/);
		expect(out).toMatch(/Video: h264/);
		expect(out).toMatch(/Audio: mp3/);
		expect(out).toMatch(/Duration: 00:00:0[34]\./);
		expect(plan.path.startsWith(cache)).toBe(true);
	});

	it("copies the h264 picture without re-encoding it and turns AC-3 into AAC", async () => {
		const playback = createVideoPlayback({ dir: cache });
		const plan = await playback.prepare(clip("h264-ac3.avi"));
		expect(plan.kind).toBe("file");
		if (plan.kind !== "file") return;
		const out = listing(plan.path);
		expect(out).toMatch(/Video: h264/);
		expect(out).toMatch(/Audio: aac/);
	});

	it("copies both streams of an h264 and mp3 avi", async () => {
		const playback = createVideoPlayback({ dir: cache });
		const plan = await playback.prepare(clip("h264-mp3.avi"));
		expect(plan.kind).toBe("file");
		if (plan.kind !== "file") return;
		expect(listing(plan.path)).toMatch(/Audio: mp3/);
	});

	it("rewrites a file with no sound", async () => {
		const playback = createVideoPlayback({ dir: cache });
		const plan = await playback.prepare(clip("silent.avi"));
		expect(plan.kind).toBe("file");
		if (plan.kind !== "file") return;
		const out = listing(plan.path);
		expect(out).toMatch(/Video: h264/);
		expect(out).not.toMatch(/Audio:/);
	});

	it("reports rising progress that ends at 1", async () => {
		const playback = createVideoPlayback({ dir: join(dir, "cache-progress") });
		const seen: number[] = [];
		await playback.prepare(clip("xvid-mp3.avi"), { onProgress: (fraction) => seen.push(fraction) });
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.at(-1)).toBe(1);
		expect(seen).toEqual([...seen].sort((a, b) => a - b));
		expect(Math.min(...seen)).toBeGreaterThanOrEqual(0);
	});

	it("answers from the cache the second time, without ffmpeg", async () => {
		const warm = createVideoPlayback({ dir: join(dir, "cache-hit") });
		const first = await warm.prepare(clip("xvid-mp3.avi"));
		const seen: number[] = [];
		const cold = createVideoPlayback({ dir: join(dir, "cache-hit"), command: join(dir, "no-such-ffmpeg") });
		const second = await cold.prepare(clip("xvid-mp3.avi"), { onProgress: (fraction) => seen.push(fraction) });
		expect(second).toEqual(first);
		expect(seen).toEqual([1]);
	});

	it("makes a new copy when the source file changes", async () => {
		const path = clip("changing.avi");
		execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=2", "-c:v", "mpeg4", path]);
		const playback = createVideoPlayback({ dir: join(dir, "cache-change") });
		const first = await playback.prepare(path);
		execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=3", "-c:v", "mpeg4", path]);
		const second = await playback.prepare(path);
		expect(second.kind === "file" && first.kind === "file" && second.path !== first.path).toBe(true);
	});

	it("leaves the file to play as it is when there is no ffmpeg", async () => {
		const playback = createVideoPlayback({ dir: join(dir, "cache-none"), command: join(dir, "no-such-ffmpeg") });
		expect(await playback.prepare(clip("xvid-mp3.avi"))).toEqual({ kind: "native" });
	});

	it("leaves a file that is not a video, and a missing one, to play as they are and keeps no partial output", async () => {
		const bogus = clip("bogus.avi");
		execFileSync("sh", ["-c", `printf 'not a video' > '${bogus}'`]);
		const playback = createVideoPlayback({ dir: join(dir, "cache-bad") });
		expect(await playback.prepare(bogus)).toEqual({ kind: "native" });
		expect(await playback.prepare(clip("gone.avi"))).toEqual({ kind: "native" });
		expect(await readdir(join(dir, "cache-bad")).catch(() => [])).toEqual([]);
	});

	it("stops ffmpeg and keeps no partial output when the signal aborts", async () => {
		const long = clip("long.avi");
		execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=120", "-c:v", "mpeg4", long]);
		const playback = createVideoPlayback({ dir: join(dir, "cache-abort") });
		const controller = new AbortController();
		const task = playback.prepare(long, { signal: controller.signal, onProgress: () => controller.abort() });
		expect(await task).toEqual({ kind: "native" });
		expect(await readdir(join(dir, "cache-abort"))).toEqual([]);
	});

	it("drops the least recently used copies once the cache is over its size limit, never the one just made", async () => {
		const cacheDir = join(dir, "cache-evict");
		const playback = createVideoPlayback({ dir: cacheDir, maxBytes: 1 });
		const first = await playback.prepare(clip("xvid-mp3.avi"));
		const old = new Date(Date.now() - 60_000);
		if (first.kind === "file") await utimes(first.path, old, old);
		const second = await playback.prepare(clip("silent.avi"));
		expect(second.kind).toBe("file");
		if (first.kind !== "file" || second.kind !== "file") return;
		await expect(stat(first.path)).rejects.toThrow();
		expect((await stat(second.path)).isFile()).toBe(true);
		expect(await readdir(cacheDir)).toEqual([second.path.slice(cacheDir.length + 1)]);
	});

	it("clears partial output a crashed run left behind", async () => {
		const cacheDir = join(dir, "cache-stale");
		execFileSync("sh", ["-c", `mkdir -p '${cacheDir}' && printf x > '${cacheDir}/dead.part'`]);
		const playback = createVideoPlayback({ dir: cacheDir });
		await playback.prepare(clip("silent.avi"));
		expect((await readdir(cacheDir)).some((name) => name.endsWith(".part"))).toBe(false);
	});
});
