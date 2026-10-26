import { describe, expect, it } from "vitest";
import { ICON_SIZE, PREVIEW_ICON_SIZE, type IconTarget, createIconProvider, isBlankBitmap, isNativeThumbnailExtension } from "../src/main/file-icon";
import { iconUrl } from "../src/main/icon-protocol";

const NATIVE = new Uint8Array([1, 1, 1]);
const EMBEDDED = new Uint8Array([2, 2, 2]);
const SYSTEM = new Uint8Array([3, 3, 3]);
const MTIME = Date.parse("2026-10-26T00:00:00.000Z");
const target = (path: string): IconTarget => ({ path, mtimeMs: MTIME, ext: path.slice(path.lastIndexOf(".") + 1).toLowerCase() });

/** A provider whose three sources record who was asked, in order. */
function recorded(platform: NodeJS.Platform, answers: { readonly native?: Uint8Array | null; readonly embedded?: Uint8Array | null | Error } = {}) {
	const asked: string[] = [];
	const sizes: number[] = [];
	const warnings: string[] = [];
	const provider = createIconProvider({
		platform,
		thumbnail: async (path) => {
			asked.push(`native:${path}`);
			return answers.native === undefined ? NATIVE : answers.native;
		},
		embeddedImage: async (path, _ext, size) => {
			asked.push(`embedded:${path}`);
			sizes.push(size);
			if (answers.embedded instanceof Error) throw answers.embedded;
			return answers.embedded === undefined ? EMBEDDED : answers.embedded;
		},
		systemIcon: async (path) => {
			asked.push(`system:${path}`);
			return SYSTEM;
		},
		warn: (message) => warnings.push(message),
	});
	return { provider, asked, sizes, warnings };
}

describe("thumbnails from the picture a file embeds", () => {
	it("lets macOS draw Photoshop, Illustrator, RAW, icns, JPEG XL, tga and exr, and reads the file only when the OS draws nothing", async () => {
		// Given macOS, where Quick Look draws the real page
		const { provider, asked } = recorded("darwin");

		// When the formats macOS renders are listed
		const files = ["/a/poster.psd", "/a/logo.ai", "/a/shot.cr3", "/a/shot.NEF", "/a/icon.icns", "/a/pic.jxl", "/a/tex.tga", "/a/hdr.exr"].map(target);
		const icons = await provider.icons(files);

		// Then every file got its tile from the OS alone
		expect(icons.size).toBe(files.length);
		expect(asked.every((entry) => entry.startsWith("native:"))).toBe(true);
	});

	it("falls back to the embedded image on macOS when Quick Look draws nothing (a RAW it renders blank)", async () => {
		// Given Quick Look answering nothing for a DNG
		const { provider, asked } = recorded("darwin", { native: null });

		// When the DNG is listed
		const icons = await provider.icons([target("/a/flip.dng")]);

		// Then the embedded preview, not the type icon, is the tile
		expect(asked).toEqual(["native:/a/flip.dng", "embedded:/a/flip.dng"]);
		expect(provider.read("/a/flip.dng", MTIME)).toEqual(EMBEDDED);
		expect(icons.get("/a/flip.dng")).toBe(iconUrl("/a/flip.dng", MTIME));
	});

	it("skips Quick Look for formats it only answers with a generic icon: EPS, Sketch, Figma", async () => {
		// Given macOS and three files whose embedded image is the only real picture
		const { provider, asked } = recorded("darwin");

		// When they are listed
		await provider.icons([target("/a/logo.eps"), target("/a/ui.sketch"), target("/a/ui.fig")]);

		// Then Quick Look was never asked, and the embedded images were used
		expect(asked.filter((entry) => entry.startsWith("native:"))).toEqual([]);
		expect(asked.sort()).toEqual(["embedded:/a/logo.eps", "embedded:/a/ui.fig", "embedded:/a/ui.sketch"]);
	});

	it("reads the embedded image first on Windows, where the OS thumbnailer may have no codec", async () => {
		// Given Windows
		const { provider, asked } = recorded("win32");

		// When a RAW is listed
		await provider.icons([target("/a/shot.arw")]);

		// Then the embedded image answered and the OS was not needed
		expect(asked).toEqual(["embedded:/a/shot.arw"]);

		// And when the file has no embedded image, the OS thumbnailer is the next source
		const without = recorded("win32", { embedded: null });
		await without.provider.icons([target("/a/shot.arw")]);
		expect(without.asked).toEqual(["embedded:/a/shot.arw", "native:/a/shot.arw"]);
	});

	it("uses the embedded image on Linux and falls to the type icon, never calling the thumbnailer", async () => {
		// Given Linux, which has no OS thumbnailer
		const { provider, asked } = recorded("linux", { embedded: null });

		// When a Photoshop file and a JPEG XL file are listed
		await provider.icons([target("/a/poster.psd"), target("/a/pic.jxl")]);

		// Then the PSD was read for its embedded image, and both ended on the type icon
		expect(asked.filter((entry) => entry.startsWith("native:"))).toEqual([]);
		expect(asked).toContain("embedded:/a/poster.psd");
		expect(asked).not.toContain("embedded:/a/pic.jxl");
		expect(provider.read("/a/poster.psd", MTIME)).toEqual(SYSTEM);
		expect(provider.read("/a/pic.jxl", MTIME)).toEqual(SYSTEM);
	});

	it("asks the embedded reader for the size of the tier it is filling", async () => {
		// Given Linux, so the embedded image is the only source
		const { provider, sizes } = recorded("linux");

		// When a tile and then an Inspector preview are generated for the same file
		await provider.icons([target("/a/shot.cr2")]);
		await provider.preview(target("/a/shot.cr2"));

		// Then the reader was told 128px for the tile and 640px for the Inspector
		expect(sizes).toEqual([ICON_SIZE, PREVIEW_ICON_SIZE]);
	});

	it("keeps going when the embedded reader fails, logging it verbatim", async () => {
		// Given an embedded reader that throws on macOS, after Quick Look drew nothing
		const { provider, warnings } = recorded("darwin", { native: null, embedded: new Error("bad ifd") });

		// When the file is listed
		await provider.icons([target("/a/shot.orf")]);

		// Then the failure is logged and the OS type icon stands in
		expect(warnings.some((message) => message.includes("bad ifd") && message.includes("/a/shot.orf"))).toBe(true);
		expect(provider.read("/a/shot.orf", MTIME)).toEqual(SYSTEM);
	});

	it("never reads formats with no embedded image", async () => {
		// Given macOS and a format only the OS decodes
		const { provider, asked } = recorded("darwin", { native: null });

		// When it is listed
		await provider.icons([target("/a/tex.tga")]);

		// Then the embedded reader was not asked
		expect(asked.some((entry) => entry.startsWith("embedded:"))).toBe(false);
	});
});

describe("isNativeThumbnailExtension", () => {
	it("admits the new picture formats and still refuses source text", () => {
		for (const ext of ["psd", "ai", "eps", "jxl", "icns", "tga", "exr", "sketch", "fig", "cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "raw"]) {
			expect(isNativeThumbnailExtension(ext), ext).toBe(true);
		}
		expect(isNativeThumbnailExtension("xcf")).toBe(false);
		expect(isNativeThumbnailExtension("ts")).toBe(false);
	});
});

describe("isBlankBitmap", () => {
	/** BGRA pixels, as Electron's `toBitmap()` returns them. */
	const pixels = (...rows: Array<readonly [number, number, number, number]>): Uint8Array => Uint8Array.from(rows.flat());

	it("treats a canvas whose visible pixels are all one colour as a failed render", () => {
		// A black picture centred on a transparent square, like the DNG Quick Look drew
		expect(isBlankBitmap(pixels([0, 0, 0, 0], [0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 0]))).toBe(true);
		expect(isBlankBitmap(pixels([0, 0, 0, 0], [0, 0, 0, 0]))).toBe(true);
	});

	it("keeps a picture with any visible variation", () => {
		expect(isBlankBitmap(pixels([0, 0, 0, 255], [0, 0, 0, 255], [9, 0, 0, 255]))).toBe(false);
	});
});
