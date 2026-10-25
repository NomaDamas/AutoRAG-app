import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractVideoFrame, isVideoFrameExtension } from "../src/main/video-frame";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

/** PNG header: signature, then the IHDR width and height. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	expect(Array.from(bytes.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

function makeClip(path: string, seconds: number, codec: string[], size = "320x180"): void {
	execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=10:duration=${seconds}`, ...codec, path]);
}

describe("isVideoFrameExtension", () => {
	it("names the containers macOS Quick Look has no decoder for", () => {
		expect(["mkv", "webm", "ogv", "avi", "MKV", ".webm"].map(isVideoFrameExtension)).toEqual([true, true, true, true, true, true]);
		expect(["mp4", "mov", "m4v", "png", "pdf", ""].map(isVideoFrameExtension)).toEqual([false, false, false, false, false, false]);
	});
});

describe.skipIf(!hasFfmpeg)("extractVideoFrame", () => {
	let dir = "";
	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "video-frame-"));
	});
	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("decodes a PNG frame from a webm and an mkv, fitted inside the requested edge", async () => {
		// Given a VP8 webm and an H.264 mkv, both 320x180
		const webm = join(dir, "a.webm");
		const mkv = join(dir, "a.mkv");
		makeClip(webm, 3, ["-c:v", "libvpx", "-b:v", "200k"]);
		makeClip(mkv, 3, ["-c:v", "mpeg4"]);

		// When a 128px frame is requested
		const fromWebm = await extractVideoFrame(webm, 128);
		const fromMkv = await extractVideoFrame(mkv, 128);

		// Then each is a PNG that fits the box with the aspect ratio kept
		expect(fromWebm).not.toBeNull();
		expect(fromMkv).not.toBeNull();
		expect(pngSize(fromWebm!)).toEqual({ width: 128, height: 72 });
		expect(pngSize(fromMkv!)).toEqual({ width: 128, height: 72 });
	});

	it("never enlarges a clip smaller than the requested edge", async () => {
		// Given a 64x36 clip
		const small = join(dir, "small.webm");
		makeClip(small, 2, ["-c:v", "libvpx"], "64x36");

		// When the 640px tier is requested
		const frame = await extractVideoFrame(small, 640);

		// Then the frame keeps its own size
		expect(pngSize(frame!)).toEqual({ width: 64, height: 36 });
	});

	it("still finds a frame in a clip shorter than the seek point", async () => {
		// Given a 0.3 s clip, shorter than the 1 s the extractor seeks to first
		const short = join(dir, "short.mkv");
		makeClip(short, 0.3, ["-c:v", "mpeg4"]);

		// When a frame is requested
		const frame = await extractVideoFrame(short, 128);

		// Then it falls back to the first frame instead of answering nothing
		expect(frame).not.toBeNull();
		expect(pngSize(frame!).width).toBe(128);
	});

	it("squares anamorphic pixels so the thumbnail is not stretched", async () => {
		// Given a 160x180 clip whose 2:1 sample aspect ratio displays as 320x180
		const anamorphic = join(dir, "anamorphic.mkv");
		execFileSync("ffmpeg", [
			"-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x180:rate=10:duration=2,setsar=2/1",
			"-c:v", "mpeg4", anamorphic,
		]);

		// When a 128px frame is requested
		const frame = await extractVideoFrame(anamorphic, 128);

		// Then the display aspect ratio (16:9) is preserved
		expect(pngSize(frame!)).toEqual({ width: 128, height: 72 });
	});

	it("rejects with ffmpeg's own message for a file that is not a video", async () => {
		// Given a text file named like a video
		const fake = join(dir, "fake.mkv");
		await writeFile(fake, "not a video");

		// When a frame is requested, then the decoder's message is surfaced
		await expect(extractVideoFrame(fake, 128)).rejects.toThrow(/Invalid data|could not|Error/i);
	});
});

describe("extractVideoFrame without ffmpeg", () => {
	it("answers null when the program is not installed, so the caller keeps the OS icon", async () => {
		expect(await extractVideoFrame("/nonexistent/a.mkv", 128, { command: "autorag-no-such-ffmpeg" })).toBeNull();
	});
});
