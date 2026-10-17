import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readHeicPreview, type HeicRun } from "../src/preview/node/heic";
import { byteNeed } from "../src/preview/shared/registry";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
const RAW = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);

/** A 1x1 white PNG, so the real-sips test needs no image library. */
const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4//8/AwAI/AL+XJ/P2QAAAABJRU5ErkJggg==",
	"base64",
);

async function withFile<T>(body: (path: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "autorag-heic-"));
	try {
		const path = join(dir, "IMG_0001.HEIC");
		await writeFile(path, RAW);
		return await body(path);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** A stand-in for `sips`: records its argv and writes `JPEG` to the `--out` path. */
function fakeSips(calls: string[][]): HeicRun {
	return async (command, args) => {
		calls.push([command, ...args]);
		const out = args[args.indexOf("--out") + 1];
		if (out === undefined) throw new Error("no --out");
		await writeFile(out, JPEG);
	};
}

describe("HEIC preview", () => {
	it("needs decoding, not the raw file bytes", () => {
		expect(byteNeed("heic")).toBe("decode");
	});

	it("hands the viewer a JPEG the OS decoded, without reading the HEIC into memory", async () => {
		await withFile(async (path) => {
			const calls: string[][] = [];
			const document = await readHeicPreview(path, { platform: "darwin", run: fakeSips(calls) });
			expect(document.mime).toBe("image/jpeg");
			expect(Array.from(document.bytes ?? [])).toEqual(Array.from(JPEG));
			expect(document.size).toBe(RAW.byteLength);
			expect(document.ext).toBe("heic");
			expect(document.truncated).toBe(false);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.slice(0, 5)).toEqual(["sips", "-s", "format", "jpeg", "-s"]);
			expect(calls[0]).toContain(path);
		});
	});

	it("removes its scratch JPEG after reading it", async () => {
		await withFile(async (path) => {
			let scratch = "";
			const run: HeicRun = async (command, args, options) => {
				scratch = args[args.indexOf("--out") + 1] ?? "";
				await fakeSips([])(command, args, options);
			};
			await readHeicPreview(path, { platform: "darwin", run });
			expect(scratch).not.toBe("");
			await expect(readFile(scratch)).rejects.toMatchObject({ code: "ENOENT" });
		});
	});

	it("falls back to the raw HEIC bytes when the OS tool fails", async () => {
		await withFile(async (path) => {
			const run: HeicRun = async () => {
				throw new Error("sips: boom");
			};
			const document = await readHeicPreview(path, { platform: "darwin", run, warn: () => undefined });
			expect(document.mime).not.toBe("image/jpeg");
			expect(Array.from(document.bytes ?? [])).toEqual(Array.from(RAW));
		});
	});

	it("falls back to the raw HEIC bytes when the tool wrote nothing", async () => {
		await withFile(async (path) => {
			const run: HeicRun = async (_command, args) => {
				await writeFile(args[args.indexOf("--out") + 1] ?? "", new Uint8Array());
			};
			const document = await readHeicPreview(path, { platform: "darwin", run, warn: () => undefined });
			expect(Array.from(document.bytes ?? [])).toEqual(Array.from(RAW));
		});
	});

	it("never shells out off macOS", async () => {
		await withFile(async (path) => {
			let called = false;
			const run: HeicRun = async () => {
				called = true;
			};
			const document = await readHeicPreview(path, { platform: "linux", run });
			expect(called).toBe(false);
			expect(Array.from(document.bytes ?? [])).toEqual(Array.from(RAW));
		});
	});

	it.runIf(process.platform === "darwin")("decodes a real HEIC with the system sips", async () => {
		const dir = await mkdtemp(join(tmpdir(), "autorag-heic-real-"));
		try {
			const png = join(dir, "seed.png");
			const heic = join(dir, "IMG_0002.HEIC");
			await writeFile(png, PNG_1X1);
			await new Promise<void>((resolve, reject) =>
				execFile("sips", ["-s", "format", "heic", png, "--out", heic], (error) => (error === null ? resolve() : reject(error))),
			);
			const document = await readHeicPreview(heic);
			expect(document.mime).toBe("image/jpeg");
			expect(Array.from((document.bytes ?? new Uint8Array()).slice(0, 3))).toEqual([0xff, 0xd8, 0xff]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
