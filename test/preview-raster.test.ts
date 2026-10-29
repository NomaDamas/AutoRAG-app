import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EmbeddedThumbnail } from "../src/preview/node/odf";
import { RASTER_MAX_SIDE, readRasterPreview, type RasterDeps } from "../src/preview/node/raster";
import type { SipsRun } from "../src/preview/node/sips";
import { byteNeed, mimeForExtension, viewerForExtension } from "../src/preview/shared/registry";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const SIPS_OUT = new Uint8Array([9, 9, 9, 9]);

const RAW_EXTENSIONS = ["cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "raw"];
const OS_DRAWN_EXTENSIONS = ["psd", "tga", "exr", "icns"];

async function withFile<T>(name: string, body: (path: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "autorag-raster-"));
	try {
		const path = join(dir, name);
		await writeFile(path, new Uint8Array(64));
		return await body(path);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

interface Calls {
	readonly sips: string[][];
	readonly embedded: string[];
	readonly warnings: string[];
}

/** Stand-ins for sips and the embedded readers that record how they were driven. */
function harness(options: {
	readonly platform: NodeJS.Platform;
	readonly embedded?: EmbeddedThumbnail | null | Error;
	readonly sips?: "ok" | "fail";
	readonly size?: { readonly width: number; readonly height: number } | null;
}): { readonly deps: RasterDeps; readonly calls: Calls } {
	const calls: Calls = { sips: [], embedded: [], warnings: [] };
	const run: SipsRun = async (_command, args) => {
		calls.sips.push([...args]);
		if (options.sips === "fail") throw new Error("sips: unsupported");
		const out = args[args.indexOf("--out") + 1];
		if (out === undefined) throw new Error("no --out");
		await writeFile(out, SIPS_OUT);
	};
	return {
		calls,
		deps: {
			platform: options.platform,
			run,
			warn: (message) => calls.warnings.push(message),
			size: async () => options.size ?? null,
			embedded: async (_path, ext) => {
				calls.embedded.push(ext);
				if (options.embedded instanceof Error) throw options.embedded;
				return options.embedded ?? null;
			},
		},
	};
}

describe("raster viewer routing", () => {
	it("sends camera RAW, Photoshop, EPS, icns, tga, exr, Sketch and Figma files to the raster viewer", () => {
		for (const ext of [...RAW_EXTENSIONS, ...OS_DRAWN_EXTENSIONS, "eps", "sketch", "fig"]) {
			expect(viewerForExtension(ext), ext).toBe("raster");
		}
		expect(viewerForExtension("PSD")).toBe("raster");
		expect(byteNeed("raster")).toBe("decode");
	});

	it("shows Illustrator files with the PDF viewer, since a current .ai is a PDF", () => {
		expect(viewerForExtension("ai")).toBe("pdf");
	});

	it("streams JPEG XL to the image viewer with its own MIME type", () => {
		expect(viewerForExtension("jxl")).toBe("image");
		expect(mimeForExtension("jxl")).toBe("image/jxl");
	});
});

describe("readRasterPreview", () => {
	it("shows a RAW's embedded JPEG without starting the OS decoder", async () => {
		const { deps, calls } = harness({ platform: "darwin", embedded: { bytes: JPEG, mime: "image/jpeg" } });
		await withFile("IMG_0001.CR3", async (path) => {
			const document = await readRasterPreview(path, deps);
			expect(document.mime).toBe("image/jpeg");
			expect(document.bytes).toEqual(JPEG);
			expect(document.truncated).toBe(false);
			expect(document.ext).toBe("cr3");
			expect(document.size).toBe(64);
		});
		expect(calls.embedded).toEqual(["cr3"]);
		expect(calls.sips).toEqual([]);
	});

	it("falls back to a sips JPEG for a RAW with no embedded preview", async () => {
		const { deps, calls } = harness({ platform: "darwin", embedded: null });
		await withFile("flip.dng", async (path) => {
			const document = await readRasterPreview(path, deps);
			expect(document.mime).toBe("image/jpeg");
			expect(document.bytes).toEqual(SIPS_OUT);
		});
		expect(calls.sips).toHaveLength(1);
		expect(calls.sips[0]).toEqual(expect.arrayContaining(["-s", "format", "jpeg"]));
	});

	it("asks sips for a PNG of a Photoshop file first and keeps the embedded image as the fallback", async () => {
		const first = harness({ platform: "darwin", embedded: { bytes: PNG, mime: "image/png" } });
		await withFile("poster.psd", async (path) => {
			const document = await readRasterPreview(path, first.deps);
			expect(document.mime).toBe("image/png");
			expect(document.bytes).toEqual(SIPS_OUT);
		});
		expect(first.calls.embedded).toEqual([]);

		const second = harness({ platform: "darwin", sips: "fail", embedded: { bytes: PNG, mime: "image/png" } });
		await withFile("poster.psd", async (path) => {
			const document = await readRasterPreview(path, second.deps);
			expect(document.mime).toBe("image/png");
			expect(document.bytes).toEqual(PNG);
		});
		expect(second.calls.embedded).toEqual(["psd"]);
		expect(second.calls.warnings).toHaveLength(1);
	});

	it("reads only the embedded image off macOS and never shells out", async () => {
		const { deps, calls } = harness({ platform: "win32", embedded: { bytes: PNG, mime: "image/png" } });
		await withFile("poster.psd", async (path) => {
			expect((await readRasterPreview(path, deps)).bytes).toEqual(PNG);
		});
		expect(calls.sips).toEqual([]);
	});

	it("leaves a format only the OS can draw without bytes off macOS", async () => {
		const { deps, calls } = harness({ platform: "linux", embedded: null });
		await withFile("texture.tga", async (path) => {
			const document = await readRasterPreview(path, deps);
			expect(document.bytes).toBeNull();
			expect(document.truncated).toBe(false);
			expect(document.size).toBe(64);
		});
		expect(calls.sips).toEqual([]);
	});

	it("never asks the OS to draw an EPS, which it cannot", async () => {
		const { deps, calls } = harness({ platform: "darwin", embedded: null });
		await withFile("logo.eps", async (path) => {
			expect((await readRasterPreview(path, deps)).bytes).toBeNull();
		});
		expect(calls.sips).toEqual([]);
		expect(calls.embedded).toEqual(["eps"]);
	});

	it("shrinks a picture past the longest-side cap but never enlarges a small one", async () => {
		const big = harness({ platform: "darwin", size: { width: 6000, height: 4000 } });
		await withFile("big.exr", async (path) => void (await readRasterPreview(path, big.deps)));
		expect(big.calls.sips[0]).toEqual(expect.arrayContaining(["--resampleHeightWidthMax", String(RASTER_MAX_SIDE)]));

		const small = harness({ platform: "darwin", size: { width: 48, height: 40 } });
		await withFile("small.psd", async (path) => void (await readRasterPreview(path, small.deps)));
		expect(small.calls.sips[0]).not.toContain("--resampleHeightWidthMax");
	});

	it("survives an embedded reader that throws", async () => {
		const { deps, calls } = harness({ platform: "darwin", embedded: new Error("boom"), sips: "fail" });
		await withFile("x.nef", async (path) => {
			expect((await readRasterPreview(path, deps)).bytes).toBeNull();
		});
		expect(calls.warnings.some((message) => message.includes("boom"))).toBe(true);
	});

	it("removes its scratch folder after a conversion", async () => {
		let out = "";
		const deps: RasterDeps = {
			platform: "darwin",
			size: async () => null,
			embedded: async () => null,
			run: async (_command, args) => {
				out = args[args.indexOf("--out") + 1] ?? "";
				await writeFile(out, SIPS_OUT);
			},
		};
		await withFile("t.tga", async (path) => void (await readRasterPreview(path, deps)));
		await expect(readFile(out)).rejects.toThrow();
	});
});
