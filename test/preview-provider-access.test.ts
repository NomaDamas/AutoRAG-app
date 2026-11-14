import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAudioMetadata } from "../src/preview/node/audio-metadata";
import { previewResponseForPath } from "../src/preview/node/protocol";
import { withReadableFile } from "../src/preview/node/provider-access";
import { pixelSize } from "../src/preview/node/sips";

vi.mock("node:child_process", async (original) => {
	const actual = await original<typeof childProcess>();
	return { ...actual, execFile: vi.fn(actual.execFile) };
});

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof fs>();
	const open = vi.fn(actual.open);
	return { ...actual, open, default: { ...actual, open } };
});
vi.mock("node:fs", async (original) => {
	const actual = await original<typeof nodeFs>();
	return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});
const realFs = await vi.importActual<typeof fs>("node:fs/promises");
const realStreams = await vi.importActual<typeof nodeFs>("node:fs");
const deadlock = Object.assign(new Error("Unknown system error -11"), { errno: -11 });
let dir: string;
let path: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), "dazzi-provider-test-"));
	path = join(dir, "한글 'audio'.wav");
});
afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(dir, { recursive: true, force: true });
});
function refuseRead(): void {
	vi.mocked(fs.open).mockImplementation(async (...args) => {
		const handle = await realFs.open(...args);
		if (args[0] === path) vi.spyOn(handle, "read").mockRejectedValue(deadlock);
		return handle;
	});
}
function wave(): Buffer {
	const bytes = Buffer.alloc(44 + 16000);
	bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
	bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
	bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
	bytes.write("data", 36); bytes.writeUInt32LE(16000, 40);
	return bytes;
}

describe("preview provider access", () => {
	it("keeps successful local operations on the original path without probing or snapshotting", async () => {
		await fs.writeFile(path, wave());
		vi.mocked(fs.open).mockClear();
		expect(await withReadableFile(path, async (local) => ({ local, bytes: await fs.readFile(local) }))).toEqual({ local: path, bytes: wave() });
		expect(fs.open).not.toHaveBeenCalled();
	});
	it("does not retry unsupported local formats or permission errors as provider conflicts", async () => {
		await fs.writeFile(path, wave());
		const failure = new Error("unsupported image");
		const consume = vi.fn(async () => { throw failure; });
		await expect(withReadableFile(path, consume, true)).rejects.toBe(failure);
		expect(consume).toHaveBeenCalledTimes(1);
	});
	it.skipIf(process.platform !== "darwin")("preserves full audio stream facts when music-metadata is refused POSIX access", async () => {
		await fs.writeFile(path, wave());
		refuseRead();
		const metadata = await readAudioMetadata(path);
		expect(metadata.sampleRate).toBe(8000);
		expect(metadata.duration).toBe(1);
		expect(metadata.bitrate).toBe(128000);
	});
	it.skipIf(process.platform !== "darwin")("retries a native-tool failure only after a real read confirms EDEADLK and cleans up the full copy", async () => {
		const bytes = Buffer.alloc(2 * 1024 * 1024 + 123, 0xa5);
		await fs.writeFile(path, bytes);
		refuseRead();
		let snapshot = "";
		const result = await withReadableFile(path, async (local) => {
			if (local === path) throw new Error("sips Error 13");
			snapshot = local;
			expect(basename(local)).toBe(basename(path));
			return fs.readFile(local);
		}, true);
		expect(result).toEqual(bytes);
		await expect(fs.stat(snapshot)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it.skipIf(process.platform !== "darwin")("copies symlink target bytes rather than returning another link into the refused provider", async () => {
		const target = join(dir, "real.wav");
		await fs.writeFile(target, wave());
		await fs.symlink(target, path);
		refuseRead();
		const bytes = await withReadableFile(path, async (local) => {
			if (local === path) throw deadlock;
			expect((await fs.lstat(local)).isSymbolicLink()).toBe(false);
			return fs.readFile(local);
		});
		expect(bytes).toEqual(wave());
	});
	it.skipIf(process.platform !== "darwin")("recovers image dimensions when sips exits zero with nil dimensions after a provider refusal", async () => {
		const imagePath = join(dir, "pixel.bmp");
		const bmp = Buffer.alloc(58);
		bmp.write("BM"); bmp.writeUInt32LE(58, 2); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14);
		bmp.writeInt32LE(1, 18); bmp.writeInt32LE(1, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
		bmp[56] = 255;
		await fs.writeFile(imagePath, bmp);
		path = imagePath;
		refuseRead();
		vi.mocked(childProcess.execFile).mockImplementationOnce((...args) => {
			const callback = args.at(-1) as (error: null, stdout: string, stderr: string) => void;
			callback(null, "pixelWidth: <nil>\npixelHeight: <nil>\n", "");
			return {} as childProcess.ChildProcess;
		});
		expect(await pixelSize(imagePath)).toEqual({ width: 1, height: 1 });
	});
	it.skipIf(process.platform !== "darwin")("recovers a failed byte-range stream without losing or repeating an already delivered prefix", async () => {
		const bytes = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
		await fs.writeFile(path, bytes);
		vi.mocked(nodeFs.createReadStream).mockImplementation((file, options) => {
			if (file !== path) return realStreams.createReadStream(file, options);
			return Readable.from((async function* () {
				yield bytes.subarray(3, 10);
				throw deadlock;
			})()) as nodeFs.ReadStream;
		});
		const response = await previewResponseForPath(path, "bytes=3-25");
		expect(response.status).toBe(206);
		expect(response.headers.get("content-range")).toBe(`bytes 3-25/${bytes.length}`);
		expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(3, 26));
	});
});
