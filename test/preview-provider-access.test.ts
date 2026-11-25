import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listArchive } from "../src/main/archive-list";
import { createIconProvider } from "../src/main/file-icon";
import { readNativePreview } from "../src/preview/node/apple";
import { readAudioMetadata } from "../src/preview/node/audio-metadata";
import { previewData } from "../src/preview/node/data";
import { fileDetails, sha256File } from "../src/preview/node/details";
import { readEmbeddedImage } from "../src/preview/node/embedded-image";
import { readIworkPreview } from "../src/preview/node/iwork";
import { exportWithQuickLook } from "../src/preview/node/keynote-render";
import { readEmbeddedThumbnail } from "../src/preview/node/odf";
import { previewResponseForPath } from "../src/preview/node/protocol";
import { withReadableFile } from "../src/preview/node/provider-access";
import { pixelSize } from "../src/preview/node/sips";
import { FIXTURE_7Z } from "./archive-fixtures";
import { buildIwa, concat, pbBytes, pbVarint } from "./iwa-fixture";
vi.mock("node:child_process", async (original) => {
	const actual = await original<typeof childProcess>();
	return { ...actual, execFile: vi.fn(actual.execFile) };
});

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof fs>();
	const open = vi.fn(actual.open);
	const readFile = vi.fn(actual.readFile);
	return { ...actual, open, readFile, default: { ...actual, open, readFile } };
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
function refuseRead(targetPath: string = path): void {
	vi.mocked(fs.open).mockImplementation(async (...args) => {
		const handle = await realFs.open(...args);
		if (args[0] === targetPath) vi.spyOn(handle, "read").mockRejectedValue(deadlock);
		return handle;
	});
	vi.mocked(fs.readFile).mockImplementation(async (...args) => {
		if (args[0] === targetPath) throw deadlock;
		return realFs.readFile(...args);
	});
}
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const PNG = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
	0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
	0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
	0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d,
	0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
	0x44, 0xae, 0x42, 0x60, 0x82,
]);
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
	it.skipIf(process.platform !== "darwin")("recovers Numbers and Keynote iWork previews when POSIX reads fail with EDEADLK", async () => {
		const numbersPath = join(dir, "기관별 사업비 요약표(제안서용)_템플릿.numbers");
		await fs.writeFile(numbersPath, zipSync({ "preview.jpg": JPEG }));
		refuseRead(numbersPath);
		const numbersPreview = await readIworkPreview(numbersPath);
		expect(numbersPreview).toEqual({ firstPage: JPEG, pages: null });

		const slide2 = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 0xff, 0xd9]);
		const doc = buildIwa([
			{ identifier: 1, type: 2, payload: pbBytes(3, concat([pbBytes(2, pbVarint(1, 11)), pbBytes(2, pbVarint(1, 12))])) },
			{ identifier: 11, type: 4, payload: pbBytes(16, pbVarint(1, 100)) },
			{ identifier: 12, type: 4, payload: pbBytes(16, pbVarint(1, 200)) },
		]);
		const keyPath = join(dir, "ContextCite.key");
		await fs.writeFile(keyPath, zipSync({
			"preview.jpg": JPEG,
			"Index/Document.iwa": doc,
			"Data/st-AAA-100.jpg": JPEG,
			"Data/st-BBB-200.jpg": slide2,
		}));
		refuseRead(keyPath);
		const keyPreview = await readIworkPreview(keyPath);
		expect(keyPreview).toEqual({ firstPage: JPEG, pages: [JPEG, slide2] });
	});
	it.skipIf(process.platform !== "darwin")("recovers ODF embedded thumbnails when POSIX reads fail with EDEADLK", async () => {
		const odgPath = join(dir, "diagram.odg");
		await fs.writeFile(odgPath, zipSync({ "Thumbnails/thumbnail.png": PNG }));
		refuseRead(odgPath);
		expect(await readEmbeddedThumbnail(odgPath, "odg")).toEqual({ bytes: PNG, mime: "image/png" });
	});
	it.skipIf(process.platform !== "darwin")("recovers Keynote qlmanage export via coordinated snapshot when qlmanage fails on a provider-refused deck", async () => {
		const keyPath = join(dir, "REGENT 슬라이드.key");
		const outDir = join(dir, "slides-out");
		await fs.mkdir(outDir);
		await fs.writeFile(keyPath, zipSync({ "preview.jpg": JPEG }));
		refuseRead(keyPath);
		const calls: string[] = [];
		await exportWithQuickLook(
			{ path: keyPath, outDir },
			{
				run: async (command, args) => {
					if (command === "/usr/bin/qlmanage") {
						const inputPath = args[1]!;
						const scratch = args[3]!;
						calls.push(inputPath);
						if (inputPath === keyPath) throw new Error("qlmanage failed");
						const pack = join(scratch, `${basename(inputPath)}.qlpreview`);
						await fs.mkdir(pack);
						await fs.writeFile(join(pack, "Preview.html"), '<img src="Attachment1.pdf">');
						await fs.writeFile(join(pack, "Attachment1.pdf"), "pdf");
						return;
					}
					if (command === "/usr/bin/sips") {
						const out = args.at(-1)!;
						await fs.writeFile(join(out, "Attachment1.jpg"), JPEG);
					}
				},
			},
		);
		expect(calls).toHaveLength(2);
		expect(calls[0]).toBe(keyPath);
		expect(calls[1]).not.toBe(keyPath);
		expect(await fs.readFile(join(outDir, "slides.001.jpeg"))).toEqual(Buffer.from(JPEG));
	});
	it.skipIf(process.platform !== "darwin")("recovers icns and xmp embedded images when POSIX reads fail with EDEADLK", async () => {
		const icnsPath = join(dir, "app.icns");
		const entryLen = 8 + PNG.length;
		const icns = Buffer.alloc(8 + entryLen);
		icns.write("icns", 0);
		icns.writeUInt32BE(icns.length, 4);
		icns.write("ic07", 8);
		icns.writeUInt32BE(entryLen, 12);
		Buffer.from(PNG).copy(icns, 16);
		await fs.writeFile(icnsPath, icns);
		refuseRead(icnsPath);
		expect(await readEmbeddedImage(icnsPath, "icns")).toEqual({ bytes: PNG, mime: "image/png" });

		const epsPath = join(dir, "art.eps");
		const xmp = `<x:xmpmeta><xmpGImg:image>${Buffer.from(JPEG).toString("base64")}</xmpGImg:image></x:xmpmeta>`;
		await fs.writeFile(epsPath, `%!PS-Adobe-3.0\n${xmp}`);
		refuseRead(epsPath);
		expect(await readEmbeddedImage(epsPath, "eps")).toEqual({ bytes: JPEG, mime: "image/jpeg" });
	});
	it.skipIf(process.platform !== "darwin")("recovers file details, sha256, sqlite data, native webloc, and archive listing on EDEADLK", async () => {
		const binPath = join(dir, "sample.bin");
		const content = Buffer.from("hello-icloud-world");
		await fs.writeFile(binPath, content);
		refuseRead(binPath);
		vi.mocked(nodeFs.createReadStream).mockImplementation((file, options) => {
			if (file !== binPath) return realStreams.createReadStream(file, options);
			return Readable.from((async function* () { throw deadlock; })()) as nodeFs.ReadStream;
		});
		const details = await fileDetails(binPath);
		expect(details.location.length).toBeGreaterThan(0);
		const digest = await sha256File(binPath, () => false);
		expect(digest).toBe(createHash("sha256").update(content).digest("hex"));
		const dbPath = join(dir, "notes.sqlite");
		const db = new DatabaseSync(dbPath);
		db.exec("create table items (id integer primary key, title text); insert into items (title) values ('ok');");
		db.close();
		refuseRead(dbPath);
		const dataPreview = await previewData(dbPath, null);
		expect(dataPreview.kind).toBe("database");

		const weblocPath = join(dir, "Site.webloc");
		await fs.writeFile(weblocPath, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>URL</key><string>https://example.com</string></dict></plist>`);
		refuseRead(weblocPath);
		expect(await readNativePreview(weblocPath)).toEqual({ kind: "webloc", title: "Site", url: "https://example.com" });

		const archivePath = join(dir, "bundle.7z");
		await fs.writeFile(archivePath, Buffer.from(FIXTURE_7Z, "base64"));
		refuseRead(archivePath);
		const archived = await listArchive(archivePath);
		expect(archived.kind).toBe("entries");
	});
	it("falls back to the embedded iWork preview image when macOS native thumbnailing times out or returns null", async () => {
		const keyPath = join(dir, "ContextCite.key");
		await fs.writeFile(keyPath, zipSync({ "preview.jpg": JPEG }));
		const embedded = vi.fn(async () => PNG);
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async () => null,
			embeddedImage: embedded,
			systemIcon: async () => null,
			warn: () => undefined,
		});
		const mtimeMs = 1;
		const url = await provider.preview({ path: keyPath, ext: "key", mtimeMs });
		expect(url).not.toBeNull();
		expect(embedded).toHaveBeenCalledWith(keyPath, "key", 640);
		expect(provider.read(keyPath, mtimeMs, 640)).toEqual(PNG);
	});
});
