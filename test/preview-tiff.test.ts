import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pixelSize, type SipsRun } from "../src/preview/node/sips";
import { TIFF_DECODE_BYTE_CAP, TIFF_DECODE_MAX_SIDE, readTiffPreview } from "../src/preview/node/tiff";
import { byteNeed, viewerForExtension } from "../src/preview/shared/registry";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
/** Little-endian TIFF header; the body is irrelevant to a fake `sips`. */
const RAW = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]);

/** A 24-bit BMP of `w`x`h` red pixels. sips writes a valid TIFF from this (it refuses a 1x1 RGBA PNG). */
function bmp(w: number, h: number): Buffer {
	const row = Buffer.alloc(Math.ceil((w * 3) / 4) * 4);
	for (let x = 0; x < w; x += 1) row.writeUInt8(0xff, x * 3 + 2);
	const pixels = Buffer.concat(Array.from({ length: h }, () => row));
	const header = Buffer.alloc(54);
	header.write("BM", 0, "ascii");
	header.writeUInt32LE(54 + pixels.length, 2);
	header.writeUInt32LE(54, 10);
	header.writeUInt32LE(40, 14);
	header.writeInt32LE(w, 18);
	header.writeInt32LE(h, 22);
	header.writeUInt16LE(1, 26);
	header.writeUInt16LE(24, 28);
	header.writeUInt32LE(pixels.length, 34);
	return Buffer.concat([header, pixels]);
}

function execSips(args: string[]): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	execFile("sips", args, (error) => (error === null ? resolve() : reject(error)));
	return promise;
}

async function withFile<T>(body: (path: string, dir: string) => Promise<T>, name = "scan.tif", bytes: Uint8Array = RAW): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "autorag-tiff-"));
	try {
		const path = join(dir, name);
		await writeFile(path, bytes);
		return await body(path, dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** A stand-in for `sips`: records its argv and writes `PNG` to the `--out` path. */
function fakeSips(calls: string[][], output: Uint8Array = PNG): SipsRun {
	return async (command, args) => {
		calls.push([command, ...args]);
		const out = args[args.indexOf("--out") + 1];
		if (out === undefined) throw new Error("no --out");
		await writeFile(out, output);
	};
}

describe("TIFF preview routing", () => {
	it("is a decode viewer: the main process hands it a finished picture", () => {
		expect(viewerForExtension("tif")).toBe("tiff");
		expect(viewerForExtension("tiff")).toBe("tiff");
		expect(byteNeed("tiff")).toBe("decode");
	});
});

describe("TIFF preview", () => {
	it("hands the viewer a PNG the OS decoded, without reading the TIFF into memory", async () => {
		await withFile(async (path) => {
			const calls: string[][] = [];
			const document = await readTiffPreview(path, { platform: "darwin", run: fakeSips(calls) });
			expect(document.mime).toBe("image/png");
			expect(Array.from(document.bytes ?? [])).toEqual(Array.from(PNG));
			expect(document.size).toBe(RAW.byteLength);
			expect(document.ext).toBe("tif");
			expect(document.truncated).toBe(false);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.slice(0, 4)).toEqual(["sips", "-s", "format", "png"]);
			expect(calls[0]).toContain(path);
		});
	});

	it("asks sips to shrink a picture longer than the cap", async () => {
		await withFile(async (path) => {
			const calls: string[][] = [];
			await readTiffPreview(path, { platform: "darwin", run: fakeSips(calls), size: async () => ({ width: TIFF_DECODE_MAX_SIDE + 1, height: 100 }) });
			const args = calls[0] ?? [];
			expect(args[args.indexOf("--resampleHeightWidthMax") + 1]).toBe(String(TIFF_DECODE_MAX_SIDE));
		});
	});

	it("does not ask sips to resize a picture within the cap, since that scales it up", async () => {
		await withFile(async (path) => {
			for (const size of [{ width: 40, height: 30 }, { width: TIFF_DECODE_MAX_SIDE, height: TIFF_DECODE_MAX_SIDE }, null]) {
				const calls: string[][] = [];
				await readTiffPreview(path, { platform: "darwin", run: fakeSips(calls), size: async () => size });
				expect(calls[0]).not.toContain("--resampleHeightWidthMax");
			}
		});
	});

	it("removes its scratch PNG after reading it", async () => {
		await withFile(async (path) => {
			let scratch = "";
			const run: SipsRun = async (command, args, options) => {
				scratch = args[args.indexOf("--out") + 1] ?? "";
				await fakeSips([])(command, args, options);
			};
			await readTiffPreview(path, { platform: "darwin", run });
			expect(scratch).not.toBe("");
			await expect(readFile(scratch)).rejects.toMatchObject({ code: "ENOENT" });
		});
	});

	it("falls back to the raw TIFF bytes when the OS tool fails", async () => {
		await withFile(async (path) => {
			const run: SipsRun = async () => {
				throw new Error("sips: boom");
			};
			const document = await readTiffPreview(path, { platform: "darwin", run, warn: () => undefined });
			expect(document.mime).not.toBe("image/png");
			expect(Array.from(document.bytes ?? [])).toEqual(Array.from(RAW));
		});
	});

	it("falls back to the raw TIFF bytes when the tool wrote nothing", async () => {
		await withFile(async (path) => {
			const document = await readTiffPreview(path, { platform: "darwin", run: fakeSips([], new Uint8Array()), warn: () => undefined });
			expect(Array.from(document.bytes ?? [])).toEqual(Array.from(RAW));
		});
	});

	it("never shells out off macOS", async () => {
		await withFile(async (path) => {
			let called = false;
			const run: SipsRun = async () => {
				called = true;
			};
			const document = await readTiffPreview(path, { platform: "linux", run });
			expect(called).toBe(false);
			expect(Array.from(document.bytes ?? [])).toEqual(Array.from(RAW));
		});
	});

	it("gives no bytes for a TIFF too large for the in-page decoder, so the panel shows its info", async () => {
		await withFile(async (path) => {
			const document = await readTiffPreview(path, { platform: "linux", run: fakeSips([]), decodeCap: RAW.byteLength - 1 });
			expect(document.bytes).toBeNull();
			expect(document.truncated).toBe(true);
			expect(document.size).toBe(RAW.byteLength);
		});
	});

	it("still decodes a large TIFF with the OS, which has no such limit", async () => {
		await withFile(async (path) => {
			const document = await readTiffPreview(path, { platform: "darwin", run: fakeSips([]), decodeCap: 1 });
			expect(document.mime).toBe("image/png");
			expect(document.bytes).not.toBeNull();
		});
	});

	it("has a cap that a small in-page decode can finish", () => {
		expect(TIFF_DECODE_BYTE_CAP).toBeLessThanOrEqual(8 * 1024 * 1024);
		expect(TIFF_DECODE_BYTE_CAP).toBeGreaterThan(0);
	});

	describe.runIf(process.platform === "darwin")("with the system sips", () => {
		async function tiffOf(width: number, height: number): Promise<{ dir: string; tiff: string }> {
			const dir = await mkdtemp(join(tmpdir(), "autorag-tiff-real-"));
			const seed = join(dir, "seed.bmp");
			const tiff = join(dir, "scan.tiff");
			await writeFile(seed, bmp(width, height));
			await execSips(["-s", "format", "tiff", seed, "--out", tiff]);
			return { dir, tiff };
		}
		const widthOf = async (png: Uint8Array | null): Promise<number> => {
			expect(png).not.toBeNull();
			expect(Array.from((png ?? new Uint8Array()).slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
			return new DataView((png ?? new Uint8Array()).buffer, (png ?? new Uint8Array()).byteOffset).getUint32(16);
		};

		it("decodes a real TIFF to a PNG", async () => {
			const { dir, tiff } = await tiffOf(40, 30);
			try {
				const document = await readTiffPreview(tiff);
				expect(document.mime).toBe("image/png");
				expect(await widthOf(document.bytes)).toBe(40);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		});

		it("never enlarges a small picture: sips would scale a 40px scan up to the cap", async () => {
			const { dir, tiff } = await tiffOf(40, 30);
			try {
				expect(await widthOf((await readTiffPreview(tiff)).bytes)).toBe(40);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		});

		it("shrinks a picture past the cap to the cap", async () => {
			const { dir, tiff } = await tiffOf(3000, 100);
			try {
				const document = await readTiffPreview(tiff);
				expect(await widthOf(document.bytes)).toBe(2048);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		});

		it("reads a TIFF's pixel size without decoding it", async () => {
			const { dir, tiff } = await tiffOf(64, 48);
			try {
				expect(await pixelSize(tiff)).toEqual({ width: 64, height: 48 });
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		});
	});
});
