import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handlePreviewRequest } from "../src/preview/node/protocol";
import { planVideoAudio } from "../src/preview/node/video-audio";
import { pathFromPreviewUrl, previewStreamUrl, previewVideoAudioUrl, videoAudioTrackFromUrl } from "../src/preview/shared/contract";
import {
	chromiumPlaysAudio,
	parseAudioProbe,
	pickSidecarTrack,
	SIDECAR_CHANNELS,
	SIDECAR_SAMPLE_RATE,
	sidecarDataBytes,
	WAV_HEADER_BYTES,
	wavHeader,
} from "../src/preview/shared/video-audio";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

/** What `ffmpeg -i` prints for the user's Silicon Valley episode: the AC-3 5.1 track comes first. */
const MKV_AC3_FIRST = `Input #0, matroska,webm, from 'Silicon.Valley.S01E06.720p.HDTV.x264-KILLERS.mkv':
  Metadata:
    encoder         : libebml v1.2.3 + libmatroska v1.3.0
    creation_time   : 2014-05-12T04:56:20.000000Z
  Duration: 00:28:25.73, start: 0.000000, bitrate: 3003 kb/s
  Stream #0:0: Audio: ac3, 48000 Hz, 5.1(side), fltp, 384 kb/s (default)
  Stream #0:1(eng): Video: h264 (High), yuv420p(tv, bt709/unknown/unknown, progressive), 1280x720, SAR 1:1 DAR 16:9, 23.98 fps, 23.98 tbr, 1k tbn (default)
At least one output file must be specified
`;

const MP4_TWO_TRACKS = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'movie.mp4':
  Duration: 01:42:07.04, start: 0.000000, bitrate: 5500 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080, 5300 kb/s, 23.98 fps (default)
  Stream #0:1[0x2](eng): Audio: eac3 (ec-3 / 0x332D6365), 48000 Hz, 5.1(side), fltp, 640 kb/s (default)
  Stream #0:2[0x3](kor): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s
`;

const TS_NO_DURATION = `Input #0, mpegts, from 'capture.ts':
  Duration: N/A, start: 1.400000, bitrate: N/A
  Stream #0:0[0x100]: Video: mpeg2video (Main), yuv420p, 720x576, 25 fps
  Stream #0:1[0x101](spa): Audio: mp2 ([3][0][0][0] / 0x0003), 48000 Hz, stereo, fltp, 192 kb/s
  Stream #0:2[0x102](eng): Audio: dts (DTS-HD MA), 48000 Hz, 5.1(side), fltp (default)
`;

describe("parseAudioProbe", () => {
	it("lists the audio streams in order with their codec, the default flag, and the duration", () => {
		const probe = parseAudioProbe(MKV_AC3_FIRST);
		expect(probe.durationSeconds).toBeCloseTo(28 * 60 + 25.73, 2);
		expect(probe.streams).toEqual([{ ordinal: 0, codec: "ac3", isDefault: true }]);
	});

	it("numbers audio streams apart from video ones and reads container-specific stream ids", () => {
		const probe = parseAudioProbe(MP4_TWO_TRACKS);
		expect(probe.durationSeconds).toBeCloseTo(102 * 60 + 7.04, 2);
		expect(probe.streams).toEqual([
			{ ordinal: 0, codec: "eac3", isDefault: true },
			{ ordinal: 1, codec: "aac", isDefault: false },
		]);
	});

	it("reports an unknown duration as null and keeps every audio stream", () => {
		const probe = parseAudioProbe(TS_NO_DURATION);
		expect(probe.durationSeconds).toBeNull();
		expect(probe.streams.map((stream) => stream.codec)).toEqual(["mp2", "dts"]);
	});

	it("finds nothing in text that is not a stream listing", () => {
		expect(parseAudioProbe("movie.mkv: No such file or directory")).toEqual({ durationSeconds: null, streams: [] });
	});
});

describe("chromiumPlaysAudio", () => {
	it("is true for the codecs Electron's media pipeline decodes", () => {
		for (const codec of ["aac", "mp3", "opus", "vorbis", "flac", "pcm_s16le", "pcm_s24le", "pcm_f32le", "pcm_alaw", "pcm_mulaw"]) {
			expect(chromiumPlaysAudio(codec)).toBe(true);
		}
	});

	it("is false for the codecs it plays silently (measured: 0 decoded audio bytes)", () => {
		for (const codec of ["ac3", "eac3", "dts", "truehd", "mlp", "alac", "mp2", "wmav2", "adpcm_ms", "pcm_f64le", "AC3"]) {
			expect(chromiumPlaysAudio(codec)).toBe(false);
		}
	});
});

describe("pickSidecarTrack", () => {
	const stream = (ordinal: number, codec: string, isDefault = false) => ({ ordinal, codec, isDefault });

	it("needs no sidecar for a file without audio", () => {
		expect(pickSidecarTrack({ durationSeconds: 10, streams: [] })).toBeNull();
	});

	it("leaves a file alone when any of its tracks plays natively, even behind an AC-3 one", () => {
		expect(pickSidecarTrack({ durationSeconds: 10, streams: [stream(0, "ac3", true), stream(1, "aac")] })).toBeNull();
	});

	it("takes the default track among the ones Chromium cannot play, else the first", () => {
		expect(pickSidecarTrack({ durationSeconds: 10, streams: [stream(0, "mp2"), stream(1, "dts", true)] })).toEqual(stream(1, "dts", true));
		expect(pickSidecarTrack({ durationSeconds: 10, streams: [stream(0, "ac3"), stream(1, "eac3")] })).toEqual(stream(0, "ac3"));
	});

	it("cannot build a seekable stream without a duration", () => {
		expect(pickSidecarTrack({ durationSeconds: null, streams: [stream(0, "ac3")] })).toBeNull();
	});
});

describe("sidecar WAV", () => {
	it("sizes the PCM from the duration: 48 kHz, 16-bit, stereo", () => {
		expect(SIDECAR_SAMPLE_RATE).toBe(48000);
		expect(SIDECAR_CHANNELS).toBe(2);
		expect(sidecarDataBytes(2)).toBe(2 * 48000 * 4);
		expect(sidecarDataBytes(0.00001)).toBe(0);
		// A WAV length is a 32-bit field: a very long video is cut at the largest whole frame that fits.
		expect(sidecarDataBytes(10 * 3600)).toBe(Math.floor((0xffffffff - 36) / 4) * 4);
	});

	it("writes a canonical 44-byte header for exactly that many bytes", () => {
		const header = wavHeader(192000);
		const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
		const text = (at: number) => String.fromCharCode(...header.subarray(at, at + 4));
		expect(header.byteLength).toBe(WAV_HEADER_BYTES);
		expect([text(0), text(8), text(12), text(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
		expect(view.getUint32(4, true)).toBe(36 + 192000);
		expect(view.getUint16(20, true)).toBe(1);
		expect(view.getUint16(22, true)).toBe(2);
		expect(view.getUint32(24, true)).toBe(48000);
		expect(view.getUint32(28, true)).toBe(48000 * 4);
		expect(view.getUint16(32, true)).toBe(4);
		expect(view.getUint16(34, true)).toBe(16);
		expect(view.getUint32(40, true)).toBe(192000);
	});
});

describe("video audio URL", () => {
	it("carries the file path and the audio track, and a plain stream URL carries no track", () => {
		const path = "/Volumes/HDD1/03_Videos/실리콘밸리/Silicon Valley S01E01.mkv";
		const url = previewVideoAudioUrl(path, 2);
		expect(pathFromPreviewUrl(url)).toBe(path);
		expect(videoAudioTrackFromUrl(url)).toBe(2);
		expect(videoAudioTrackFromUrl(previewStreamUrl(path))).toBeNull();
	});

	it("refuses anything but a whole non-negative track number", () => {
		const base = previewStreamUrl("/tmp/a.mkv");
		for (const value of ["", "x", "-1", "1.5", "1e2", "99999999999"]) {
			expect(videoAudioTrackFromUrl(`${base}&audio=${value}`)).toBeNull();
		}
	});
});

/** Index of the first frame whose left sample is clearly above silence, in seconds. */
function onsetSeconds(pcm: Uint8Array, threshold = 3000): number | null {
	const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
	for (let at = 0; at + 4 <= pcm.byteLength; at += 4) {
		if (Math.abs(view.getInt16(at, true)) > threshold) return at / 4 / SIDECAR_SAMPLE_RATE;
	}
	return null;
}

describe.skipIf(!hasFfmpeg)("sidecar over the preview protocol", () => {
	let dir = "";
	const clip = (name: string) => join(dir, name);
	const BEEP = "aevalsrc='0.8*sin(2*PI*1000*t)*between(t,3,3.1)':s=44100:d=6";

	function make(name: string, audio: string[], extra: string[] = []): string {
		const path = clip(name);
		execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=6", "-f", "lavfi", "-i", BEEP, "-pix_fmt", "yuv420p", ...audio, ...extra, path]);
		return path;
	}

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "video-audio-"));
		make("beep-ac3.mkv", ["-c:v", "libx264", "-c:a", "ac3"]);
		make("beep-51.mkv", ["-c:v", "libx264", "-c:a", "ac3", "-ac", "6"]);
		make("beep-aac.mkv", ["-c:v", "libx264", "-c:a", "aac"]);
		execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=3", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip("silent.mp4")]);
	});
	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function pcmOf(response: Response): Promise<Uint8Array> {
		return new Uint8Array(await response.arrayBuffer());
	}

	describe("planVideoAudio", () => {
		it("plays an AC-3 track through the sidecar and leaves natively playable audio alone", async () => {
			expect(await planVideoAudio(clip("beep-ac3.mkv"))).toEqual({ kind: "sidecar", track: 0, codec: "ac3" });
			expect(await planVideoAudio(clip("beep-aac.mkv"))).toEqual({ kind: "native" });
			expect(await planVideoAudio(clip("silent.mp4"))).toEqual({ kind: "native" });
		});

		it("keeps the video as it was when there is no ffmpeg to decode with", async () => {
			expect(await planVideoAudio(clip("beep-ac3.mkv"), { command: join(dir, "no-such-ffmpeg") })).toEqual({ kind: "native" });
		});

		it("keeps the video as it was when the file is not media", async () => {
			expect(await planVideoAudio(join(dir, "missing.mkv"))).toEqual({ kind: "native" });
		});
	});

	describe("whole stream", () => {
		it("answers 200 with a WAV whose length is declared up front and kept exactly", async () => {
			const response = await handlePreviewRequest(new Request(previewVideoAudioUrl(clip("beep-ac3.mkv"), 0)));
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("audio/wav");
			expect(response.headers.get("accept-ranges")).toBe("bytes");
			const declared = Number(response.headers.get("content-length"));
			const bytes = await pcmOf(response);
			expect(bytes.byteLength).toBe(declared);
			expect(declared).toBeGreaterThan(WAV_HEADER_BYTES + 5.9 * 48000 * 4);
			expect(declared).toBeLessThan(WAV_HEADER_BYTES + 6.1 * 48000 * 4);
			expect((declared - WAV_HEADER_BYTES) % 4).toBe(0);
			expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("RIFF");
		});

		it("decodes the source's sound at its own time, resampled from 44.1 kHz to 48 kHz", async () => {
			const bytes = await pcmOf(await handlePreviewRequest(new Request(previewVideoAudioUrl(clip("beep-ac3.mkv"), 0))));
			const onset = onsetSeconds(bytes.subarray(WAV_HEADER_BYTES));
			expect(onset).not.toBeNull();
			expect(Math.abs((onset ?? 0) - 3)).toBeLessThan(0.04);
		});

		it("mixes a 5.1 track down to stereo that is still audible", async () => {
			const bytes = await pcmOf(await handlePreviewRequest(new Request(previewVideoAudioUrl(clip("beep-51.mkv"), 0))));
			const onset = onsetSeconds(bytes.subarray(WAV_HEADER_BYTES), 1500);
			expect(onset).not.toBeNull();
			expect(Math.abs((onset ?? 0) - 3)).toBeLessThan(0.04);
		});
	});

	describe("ranges", () => {
		const frameAt = (seconds: number) => WAV_HEADER_BYTES + Math.round(seconds * 48000) * 4;

		it("serves the header alone without decoding", async () => {
			const response = await handlePreviewRequest(new Request(previewVideoAudioUrl(clip("beep-ac3.mkv"), 0), { headers: { Range: "bytes=0-43" } }));
			expect(response.status).toBe(206);
			expect(response.headers.get("content-length")).toBe("44");
			const bytes = await pcmOf(response);
			expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe("WAVE");
		});

		it("starts decoding at the requested byte, so a seek lands on the same sound", async () => {
			const total = Number((await handlePreviewRequest(new Request(previewVideoAudioUrl(clip("beep-ac3.mkv"), 0)))).headers.get("content-length"));
			const start = frameAt(2.9);
			const response = await handlePreviewRequest(new Request(previewVideoAudioUrl(clip("beep-ac3.mkv"), 0), { headers: { Range: `bytes=${start}-` } }));
			expect(response.status).toBe(206);
			expect(response.headers.get("content-range")).toBe(`bytes ${start}-${total - 1}/${total}`);
			const bytes = await pcmOf(response);
			expect(bytes.byteLength).toBe(total - start);
			expect(Math.abs((onsetSeconds(bytes) ?? 0) - 0.1)).toBeLessThan(0.04);
		});

		it("honours a start that is not on a frame boundary and a bounded end", async () => {
			const start = frameAt(2.9) + 1;
			const response = await handlePreviewRequest(new Request(previewVideoAudioUrl(clip("beep-ac3.mkv"), 0), { headers: { Range: `bytes=${start}-${start + 95999}` } }));
			expect(response.status).toBe(206);
			const bytes = await pcmOf(response);
			expect(bytes.byteLength).toBe(96000);
			expect(Math.abs((onsetSeconds(bytes.subarray(3)) ?? 0) - 0.1)).toBeLessThan(0.04);
		});

		it("rejects a range past the end", async () => {
			const response = await handlePreviewRequest(new Request(previewVideoAudioUrl(clip("beep-ac3.mkv"), 0), { headers: { Range: "bytes=999999999-" } }));
			expect(response.status).toBe(416);
		});
	});

	describe("refusals", () => {
		it("says 404 for a missing file and for a track the file does not have", async () => {
			expect((await handlePreviewRequest(new Request(previewVideoAudioUrl(join(dir, "gone.mkv"), 0)))).status).toBe(404);
			expect((await handlePreviewRequest(new Request(previewVideoAudioUrl(clip("beep-ac3.mkv"), 3)))).status).toBe(404);
		});
	});
});
