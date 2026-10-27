import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { ArchiveReader, libarchiveWasm } from "libarchive-wasm";
import { unzipSync, zipSync } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActionAnchor } from "../src/shared/actions-contract";
import {
	createActionService,
	imageFormatOf,
	stemOf,
	uniqueChild,
	type ActionService,
	type CommandRunner,
} from "../src/main/action-service";
import { ArchiveError, archiveEntryPath } from "../src/main/archive-guard.mjs";
import type { PdfReducer } from "../src/main/pdf-reducer";
import { t } from "../src/shared/i18n/core";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "autorag-actions-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

interface Harness {
	readonly service: ActionService;
	readonly commands: { readonly command: string; readonly args: readonly string[] }[];
	readonly shares: { readonly paths: readonly string[]; readonly anchor: ActionAnchor }[];
	readonly trashed: string[];
}

/**
 * A realistic `ffmpeg -encoders` body: the image encoders this machine has, but
 * no heif/avif muxer (so HEIC and AVIF stay hidden), matching the probe's
 * parsing contract.
 */
const FFMPEG_ENCODERS =
	" V....D apng                 APNG image\n" +
	" V....D bmp                  BMP (Windows and OS/2 bitmap)\n" +
	" V....D gif                  GIF (Graphics Interchange Format)\n" +
	" VFS..D mjpeg                MJPEG (Motion JPEG)\n" +
	" VF...D png                  PNG image\n" +
	" VF...D tiff                 TIFF image\n" +
	" V....D libwebp              libwebp WebP image\n" +
	" V..... libsvtav1            SVT-AV1 encoder (codec av1)\n" +
	" V....D libx265              libx265 H.265 / HEVC\n";
/** A muxer list without `heif` or `avif`, so HEIC and AVIF are not offered. */
const FFMPEG_MUXERS = "  E  image2          image2 sequence\n  E  gif             GIF\n  E  mp4             MP4\n";
/** `sips --formats` as macOS 26 prints it (abridged): which UTIs ImageIO can write. */
const SIPS_FORMATS_LISTING =
	"Supported Formats:\n" +
	"-------------------------------------------\n" +
	"com.adobe.pdf                pdf   Writable\n" +
	"com.compuserve.gif           gif   Writable\n" +
	"com.microsoft.bmp            bmp   Writable\n" +
	"org.webmproject.webp         webp  \n" +
	"public.avif                  avif  Writable\n" +
	"public.heic                  heic  Writable\n" +
	"public.heif                  heif  \n" +
	"public.jpeg                  jpeg  Writable\n" +
	"public.png                   png   Writable\n" +
	"public.tiff                  tiff  Writable\n";

/** A service whose external commands are recorded and whose "image" output is written. */
function makeService(
	options: {
		readonly platform?: NodeJS.Platform;
		readonly ffmpeg?: boolean;
		readonly picked?: string | null;
		/** Bytes written for a produced image; keep below the source to pass optimize. */
		readonly imageOutput?: string;
		/** Overrides the fake `ffmpeg -encoders` body. */
		readonly encoders?: string;
		/** Overrides the fake `ffmpeg -muxers` body (default: no heif/avif muxer). */
		readonly muxers?: string;
		/** Overrides the fake `sips --formats` body; `null` makes the probe fail. */
		readonly sipsFormats?: string | null;
		/** Applications the fake Launch Services reports for any file, default first. */
		readonly registered?: readonly string[];
		/** Make the Launch Services lookup fail. */
		readonly lookupFails?: boolean;
		/** The Filee-backed PDF reducer; absent means the machine has none. */
		readonly pdf?: PdfReducer;
	} = {},
): Harness {
	const commands: { command: string; args: string[] }[] = [];
	const shares: { paths: string[]; anchor: ActionAnchor }[] = [];
	const trashed: string[] = [];
	const imageOutput = options.imageOutput ?? "encoded";
	const run: CommandRunner = async (command, args) => {
		commands.push({ command, args: [...args] });
		if (command === "ffmpeg" && options.ffmpeg === false) throw new Error("ffmpeg: command not found");
		if (command === "ffmpeg" && args[0] === "-version") {
			return { stdout: "ffmpeg version 9", stderr: "" };
		}
		if (command === "ffmpeg" && args.includes("-encoders")) return { stdout: options.encoders ?? FFMPEG_ENCODERS, stderr: "" };
		if (command === "ffmpeg" && args.includes("-muxers")) return { stdout: options.muxers ?? FFMPEG_MUXERS, stderr: "" };
		if (command === "sips" && args[0] === "--formats") {
			const listing = options.sipsFormats === undefined ? SIPS_FORMATS_LISTING : options.sipsFormats;
			if (listing === null) throw new Error("sips: unrecognized option");
			return { stdout: listing, stderr: "" };
		}
		if (command === "osascript") {
			if (options.lookupFails === true) throw new Error("osascript failed");
			const [defaultPath = null, ...rest] = options.registered ?? [];
			return { stdout: JSON.stringify({ defaultPath, paths: [...rest, ...(defaultPath === null ? [] : [defaultPath])] }), stderr: "" };
		}
		const outIndex = args.indexOf("--out");
		const target = outIndex >= 0 ? args[outIndex + 1] : args[args.length - 1];
		if (target !== undefined && isAbsolute(target)) {
			await writeFile(target, imageOutput);
		}
		return { stdout: "", stderr: "" };
	};
	return {
		service: createActionService({
			platform: options.platform ?? "darwin",
			applications: { pick: async () => options.picked ?? null },
			applicationIcon: async (path) => `data:image/png;base64,${basename(path)}`,
			share: {
				present: (paths, anchor) => {
					shares.push({ paths: [...paths], anchor });
				},
			},
			...(options.pdf === undefined ? {} : { pdf: options.pdf }),
			trash: async (target) => {
				trashed.push(target);
				await rm(target, { force: true });
			},
			run,
		}),
		commands,
		shares,
		trashed,
	};
}

describe("archiveEntryPath", () => {
	it("keeps ordinary and nested entries inside the destination", () => {
		expect(archiveEntryPath("/tmp/out", "docs/readme.md")).toEqual({
			path: resolve("/tmp/out", "docs/readme.md"),
			directory: false,
		});
		expect(archiveEntryPath("/tmp/out", "docs/")).toEqual({ path: resolve("/tmp/out", "docs"), directory: true });
	});

	it("refuses zip-slip and absolute entries", () => {
		expect(() => archiveEntryPath("/tmp/out", "../evil.txt")).toThrow(ArchiveError);
		expect(() => archiveEntryPath("/tmp/out", "docs/../../evil.txt")).toThrow(ArchiveError);
		expect(() => archiveEntryPath("/tmp/out", "/etc/passwd")).toThrow(ArchiveError);
		expect(() => archiveEntryPath("/tmp/out", "C:/Windows/evil.dll")).toThrow(ArchiveError);
		expect(() => archiveEntryPath("/tmp/out", "docs/bad\0.txt")).toThrow(ArchiveError);
	});
});

describe("uniqueChild", () => {
	it("numbers the way Finder does", async () => {
		await writeFile(join(root, "photo.jpg"), "x");
		const first = await uniqueChild(root, "photo.jpg");
		expect(first).toBe(join(root, "photo 2.jpg"));
		await writeFile(first, "x");
		expect(await uniqueChild(root, "photo.jpg")).toBe(join(root, "photo 3.jpg"));
		expect(await uniqueChild(root, "fresh.jpg")).toBe(join(root, "fresh.jpg"));
	});
});

describe("archive round-trip", () => {
	it("compresses a folder, keeps empty directories, and extracts it back", async () => {
		const { service } = makeService();
		const source = join(root, "docs");
		await mkdir(join(source, "empty"), { recursive: true });
		await writeFile(join(source, "readme.md"), "hello");
		await writeFile(join(source, "empty", "keep.txt"), "keep");

		const packed = await service.run([source], { kind: "compress" }, null);
		expect(packed.output).toBe(join(root, "docs.zip"));
		expect((await readFile(packed.output ?? "", "utf8")).slice(0, 2)).toBe("PK");

		const unpacked = await service.run([packed.output ?? ""], { kind: "extract" }, null);
		expect(unpacked.output).toBe(join(root, "docs 2"));
		expect(await readFile(join(unpacked.output ?? "", "readme.md"), "utf8")).toBe("hello");
		expect(await readFile(join(unpacked.output ?? "", "empty", "keep.txt"), "utf8")).toBe("keep");
		expect((await readdir(join(unpacked.output ?? "", "empty"))).length).toBe(1);
	});

	it("compresses to 7z with empty files and directories, and extracts it back byte for byte", async () => {
		const { service } = makeService();
		const source = join(root, "docs");
		await mkdir(join(source, "empty"), { recursive: true });
		await mkdir(join(source, "hollow"));
		await writeFile(join(source, "readme.md"), "hello");
		await writeFile(join(source, "text.txt"), "한글 본문\n".repeat(5000));
		await writeFile(join(source, "zero.txt"), "");
		await writeFile(join(source, "empty", "keep.txt"), "keep");
		const noise = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 2654435761) >>> 24));
		await writeFile(join(source, "noise.bin"), noise);

		const packed = await service.run([source], { kind: "compress", format: "7z" }, null);
		expect(packed.output).toBe(join(root, "docs.7z"));
		expect((await readFile(packed.output ?? "")).subarray(0, 6)).toEqual(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]));

		const unpacked = await service.run([packed.output ?? ""], { kind: "extract" }, null);
		expect(unpacked.output).toBe(join(root, "docs 2"));
		const out = unpacked.output ?? "";
		expect(await readFile(join(out, "readme.md"), "utf8")).toBe("hello");
		expect(await readFile(join(out, "text.txt"), "utf8")).toBe("한글 본문\n".repeat(5000));
		expect(await readFile(join(out, "zero.txt"), "utf8")).toBe("");
		expect(await readFile(join(out, "empty", "keep.txt"), "utf8")).toBe("keep");
		expect(await readFile(join(out, "noise.bin"))).toEqual(noise);
		expect((await stat(join(out, "hollow"))).isDirectory()).toBe(true);
	});

	it("writes decomposed (NFD) Mac names composed into the zip and 7z entries themselves", async () => {
		const { service } = makeService();
		const source = join(root, "한글 폴더".normalize("NFD"));
		await mkdir(source);
		await writeFile(join(source, "보고서.txt".normalize("NFD")), "본문 ".repeat(1000));
		// APFS keeps the decomposed spelling, so the walk really does see NFD names.
		expect((await readdir(source))[0]).not.toBe("보고서.txt");

		const zip = await service.run([source], { kind: "compress", format: "zip" }, null);
		const zipNames = Object.keys(unzipSync(new Uint8Array(await readFile(zip.output ?? ""))));
		expect(zipNames.sort()).toEqual(["한글 폴더/", "한글 폴더/보고서.txt"]);

		// Read the 7z's own entry names, bypassing the extractor's guard, which would also compose them.
		const sevenZip = await service.run([source], { kind: "compress", format: "7z" }, null);
		const archive = await readFile(sevenZip.output ?? "");
		const reader = new ArchiveReader(
			await libarchiveWasm({ wasmBinary: await readFile(new URL("../src/main/vendor/libarchive.wasm", import.meta.url)) }),
			new Int8Array(archive.buffer, archive.byteOffset, archive.byteLength),
		);
		const sevenZipNames: string[] = [];
		for (const entry of reader.entries()) sevenZipNames.push(entry.getPathname());
		reader.free();
		expect(sevenZipNames.sort()).toEqual(["한글 폴더/", "한글 폴더/보고서.txt"]);
		expect(sevenZipNames.every((name) => name === name.normalize("NFC"))).toBe(true);
	});

	it("names a multi-selection 7z Archive.7z and numbers it when taken", async () => {
		const { service } = makeService();
		await writeFile(join(root, "a.txt"), "a");
		await writeFile(join(root, "b.txt"), "b");
		const first = await service.run([join(root, "a.txt"), join(root, "b.txt")], { kind: "compress", format: "7z" }, null);
		expect(first.output).toBe(join(root, "Archive.7z"));
		const second = await service.run([join(root, "a.txt"), join(root, "b.txt")], { kind: "compress", format: "7z" }, null);
		expect(second.output).toBe(join(root, "Archive 2.7z"));
	});

	it("names a single-file archive after the full file name", async () => {
		const { service } = makeService();
		const file = join(root, "note.txt");
		await writeFile(file, "note");
		const packed = await service.run([file], { kind: "compress" }, null);
		expect(packed.output).toBe(join(root, "note.txt.zip"));
		expect(stemOf(file)).toBe("note");
	});

	it("strips the single wrapper folder that matches the archive name", async () => {
		const { service } = makeService();
		const archive = join(root, "packed.zip");
		await writeFile(
			archive,
			zipSync({
				"packed/": new Uint8Array(0),
				"packed/one.txt": new Uint8Array(Buffer.from("one")),
				"packed/deep/two.txt": new Uint8Array(Buffer.from("two")),
			}),
		);
		const unpacked = await service.run([archive], { kind: "extract" }, null);
		expect(unpacked.output).toBe(join(root, "packed"));
		expect(await readFile(join(unpacked.output ?? "", "one.txt"), "utf8")).toBe("one");
		expect(await readFile(join(unpacked.output ?? "", "deep", "two.txt"), "utf8")).toBe("two");
	});

	it("keeps several top-level folders intact", async () => {
		const { service } = makeService();
		const archive = join(root, "backup.zip");
		await writeFile(
			archive,
			zipSync({
				"alpha/": new Uint8Array(0),
				"alpha/a.txt": new Uint8Array(Buffer.from("a")),
				"beta/b.txt": new Uint8Array(Buffer.from("b")),
			}),
		);
		const unpacked = await service.run([archive], { kind: "extract" }, null);
		expect(await readFile(join(unpacked.output ?? "", "alpha", "a.txt"), "utf8")).toBe("a");
		expect(await readFile(join(unpacked.output ?? "", "beta", "b.txt"), "utf8")).toBe("b");
	});

	it("refuses a hostile archive and writes nothing outside the destination", async () => {
		const { service } = makeService();
		const hostile = join(root, "hostile.zip");
		const bytes = zipSync({ "../escape.txt": new Uint8Array(Buffer.from("pwned")) });
		await writeFile(hostile, bytes);

		await expect(service.run([hostile], { kind: "extract" }, null)).rejects.toThrow(ArchiveError);
		await expect(readFile(join(root, "escape.txt"))).rejects.toThrow();
		// The failed run cleans up its staging: only the archive itself is left.
		expect(await readdir(root)).toEqual(["hostile.zip"]);
	});
});

describe("image actions", () => {
	it("routes a native conversion through sips with the target format", async () => {
		const { service, commands } = makeService({ ffmpeg: false });
		const source = join(root, "photo.png");
		await writeFile(source, "png");

		const outcome = await service.run([source], { kind: "convertImage", format: "jpeg" }, null);
		expect(outcome.output).toBe(join(root, "photo.jpg"));
		expect(commands.at(-1)).toEqual({
			command: "sips",
			args: ["-s", "format", "jpeg", "--out", join(root, "photo.jpg"), source],
		});
	});

	it("routes WebP through ffmpeg and only offers it when ffmpeg exists", async () => {
		const without = makeService({ ffmpeg: false });
		const source = join(root, "photo.png");
		await writeFile(source, "png");
		await expect(without.service.run([source], { kind: "convertImage", format: "webp" }, null)).rejects.toThrow(
			t("main.action.unsupportedConvert", { format: "WEBP" }),
		);

		const withFfmpeg = makeService({ ffmpeg: true });
		const outcome = await withFfmpeg.service.run([source], { kind: "convertImage", format: "webp" }, null);
		expect(outcome.output).toBe(join(root, "photo.webp"));
		expect(withFfmpeg.commands.at(-1)?.command).toBe("ffmpeg");
		expect(withFfmpeg.commands.at(-1)?.args).toEqual([
			"-y",
			"-f",
			"image2",
			"-pattern_type",
			"none",
			"-i",
			source,
			"-c:v",
			"libwebp",
			"-quality",
			"80",
			join(root, "photo.webp"),
		]);
	});

	it("hides WebP on macOS when the ffmpeg build has no libwebp encoder", async () => {
		const { service } = makeService({ ffmpeg: true, encoders: FFMPEG_ENCODERS.replace(/^.*libwebp.*\n/mu, "") });
		expect((await service.capabilities()).imageFormats).not.toContain("webp");
		const source = join(root, "photo.heic");
		await writeFile(source, "heic");
		await expect(service.run([source], { kind: "convertImage", format: "webp" }, null)).rejects.toThrow(t("main.action.unsupportedConvert", { format: "WEBP" }));
	});

	it("resizes to a bounded long edge and refuses WebP sources", async () => {
		const { service, commands } = makeService();
		const source = join(root, "photo.jpeg");
		await writeFile(source, "jpg");
		const outcome = await service.run([source], { kind: "resizeImage", maxEdge: 1920 }, null);
		expect(outcome.output).toBe(join(root, "photo-1920.jpeg"));
		expect(commands.at(-1)?.args).toEqual(["-Z", "1920", "--out", join(root, "photo-1920.jpeg"), source]);

		const webp = join(root, "vector.webp");
		await writeFile(webp, "webp");
		await expect(service.run([webp], { kind: "resizeImage", maxEdge: 1920 }, null)).rejects.toThrow(t("main.action.unsupportedResize"));
	});

	it("converts HEIC to JPEG through sips", async () => {
		const { service, commands } = makeService({ ffmpeg: false });
		const source = join(root, "IMG_0001.HEIC");
		await writeFile(source, "heic");

		const outcome = await service.run([source], { kind: "convertImage", format: "jpeg" }, null);
		expect(outcome.output).toBe(join(root, "IMG_0001.jpg"));
		expect(commands.at(-1)).toEqual({
			command: "sips",
			args: ["-s", "format", "jpeg", "--out", join(root, "IMG_0001.jpg"), source],
		});
	});

	it.each([
		["gif", "gif"],
		["bmp", "bmp"],
		["avif", "avif"],
	] as const)("writes %s through sips with the .%s extension", async (format, extension) => {
		const { service, commands } = makeService({ ffmpeg: false });
		const source = join(root, "photo.heic");
		await writeFile(source, "heic");

		const outcome = await service.run([source], { kind: "convertImage", format }, null);
		expect(outcome.output).toBe(join(root, `photo.${extension}`));
		expect(commands.at(-1)).toEqual({
			command: "sips",
			args: ["-s", "format", format, "--out", join(root, `photo.${extension}`), source],
		});
	});

	it("refuses AVIF when this macOS cannot write it", async () => {
		const { service } = makeService({
			ffmpeg: false,
			sipsFormats: SIPS_FORMATS_LISTING.replace("public.avif                  avif  Writable", "public.avif  avif"),
		});
		const source = join(root, "photo.heic");
		await writeFile(source, "heic");
		await expect(service.run([source], { kind: "convertImage", format: "avif" }, null)).rejects.toThrow(t("main.action.unsupportedConvert", { format: "AVIF" }));
	});

	it("resizes BMP through sips but refuses GIF, whose animation a one-frame resize would drop", async () => {
		const { service, commands } = makeService();
		const bmp = join(root, "scan.bmp");
		await writeFile(bmp, "bmp");
		const outcome = await service.run([bmp], { kind: "resizeImage", maxEdge: 640 }, null);
		expect(outcome.output).toBe(join(root, "scan-640.bmp"));
		expect(commands.at(-1)?.args).toEqual(["-Z", "640", "--out", join(root, "scan-640.bmp"), bmp]);

		const gif = join(root, "anim.gif");
		await writeFile(gif, "gif");
		await expect(service.run([gif], { kind: "resizeImage", maxEdge: 640 }, null)).rejects.toThrow(t("main.action.unsupportedResize"));
	});
});

describe("image actions on Windows (ffmpeg backend)", () => {
	it("converts PNG to JPEG through ffmpeg with a JPEG pixel format", async () => {
		const { service, commands } = makeService({ platform: "win32" });
		const source = join(root, "shot.png");
		await writeFile(source, "png");

		const outcome = await service.run([source], { kind: "convertImage", format: "jpeg" }, null);
		expect(outcome.output).toBe(join(root, "shot.jpg"));
		const last = commands.at(-1);
		expect(last?.command).toBe("ffmpeg");
		expect(last?.args).toContain("-pix_fmt");
		expect(last?.args).toContain("yuvj420p");
		expect(last?.args.at(-1)).toBe(join(root, "shot.jpg"));
	});

	it("resizes through ffmpeg with a no-enlarge scale filter", async () => {
		const { service, commands } = makeService({ platform: "win32" });
		const source = join(root, "shot.png");
		await writeFile(source, "png");

		const outcome = await service.run([source], { kind: "resizeImage", maxEdge: 800 }, null);
		expect(outcome.output).toBe(join(root, "shot-800.png"));
		const args = commands.at(-1)?.args ?? [];
		expect(args).toContain("-vf");
		expect(args.join(" ")).toContain("force_original_aspect_ratio=decrease");
		expect(args.join(" ")).toContain("min(iw,800)");
	});

	it("hides formats the ffmpeg build cannot encode", async () => {
		const { service } = makeService({ platform: "win32" });
		const source = join(root, "shot.png");
		await writeFile(source, "png");
		// No heif muxer is listed, so HEIC is not a capability and cannot be run.
		await expect(service.run([source], { kind: "convertImage", format: "heic" }, null)).rejects.toThrow(t("main.action.unsupportedConvert", { format: "HEIC" }));
	});

	it("pins literal filenames against image2's %d pattern expansion", async () => {
		const { service, commands } = makeService({ platform: "win32" });
		const source = join(root, "report%20draft.png");
		await writeFile(source, "png");

		const outcome = await service.run([source], { kind: "convertImage", format: "jpeg" }, null);
		expect(outcome.output).toBe(join(root, "report%20draft.jpg"));
		const args = commands.at(-1)?.args ?? [];
		// Pattern matching off before the input; literal single-file output.
		expect(args.slice(0, 5)).toEqual(["-y", "-f", "image2", "-pattern_type", "none"]);
		expect(args.indexOf("none")).toBeLessThan(args.indexOf("-i"));
		expect(args.join(" ")).toContain("-update 1");
		expect(args.at(-1)).toBe(join(root, "report%20draft.jpg"));
	});

	it.each(["heic", "gif", "avif"])("leaves the %s input to ffmpeg's native demuxer", async (extension) => {
		const { service, commands } = makeService({ platform: "win32" });
		const source = join(root, `photo.${extension}`);
		await writeFile(source, extension);

		await service.run([source], { kind: "convertImage", format: "jpeg" }, null);
		const args = commands.at(-1)?.args ?? [];
		expect(args).not.toContain("image2");
		expect(args).not.toContain("-pattern_type");
		expect(args).toContain(source);
	});

	it("encodes JPEG at the mjpeg qscale, not the sips quality", async () => {
		const { service, commands } = makeService({ platform: "win32" });
		const source = join(root, "shot.png");
		await writeFile(source, "png");
		await service.run([source], { kind: "convertImage", format: "jpeg" }, null);
		const args = commands.at(-1)?.args ?? [];
		expect(args.join(" ")).toContain("-q:v 4");
		expect(args).not.toContain("70");
	});

	it("leaves the webp muxer its literal output (no -update flag)", async () => {
		const { service, commands } = makeService({ platform: "win32" });
		const source = join(root, "shot.png");
		await writeFile(source, "png");
		await service.run([source], { kind: "convertImage", format: "webp" }, null);
		expect((commands.at(-1)?.args ?? []).join(" ")).not.toContain("-update");
	});

	it("rate-controls HEIC with -crf when the build has a heif muxer", async () => {
		const { service, commands } = makeService({
			platform: "win32",
			muxers: "  E  image2          image2 sequence\n  E  heif            HEIF\n",
		});
		const source = join(root, "shot.png");
		await writeFile(source, "png");
		const outcome = await service.run([source], { kind: "convertImage", format: "heic" }, null);
		expect(outcome.output).toBe(join(root, "shot.heic"));
		const args = commands.at(-1)?.args ?? [];
		expect(args.join(" ")).toContain("-crf 23");
		expect(args.join(" ")).not.toContain("-q:v");
	});

	it("quantizes GIF through a generated palette, without image2's -update", async () => {
		const { service, commands } = makeService({ platform: "win32" });
		const source = join(root, "photo.heic");
		await writeFile(source, "heic");
		const outcome = await service.run([source], { kind: "convertImage", format: "gif" }, null);
		expect(outcome.output).toBe(join(root, "photo.gif"));
		const args = commands.at(-1)?.args ?? [];
		expect(args.join(" ")).toContain("palettegen");
		expect(args.join(" ")).toContain("paletteuse");
		expect(args).not.toContain("-update");
		expect(args.at(-1)).toBe(join(root, "photo.gif"));
	});

	it("writes BMP as a literal single image2 file", async () => {
		const { service, commands } = makeService({ platform: "win32" });
		const source = join(root, "shot.png");
		await writeFile(source, "png");
		const outcome = await service.run([source], { kind: "convertImage", format: "bmp" }, null);
		expect(outcome.output).toBe(join(root, "shot.bmp"));
		const args = commands.at(-1)?.args ?? [];
		expect(args.join(" ")).toContain("-update 1");
		expect(args.at(-1)).toBe(join(root, "shot.bmp"));
	});

	it("hides AVIF without the avif muxer", async () => {
		const { service } = makeService({ platform: "win32" });
		const source = join(root, "shot.png");
		await writeFile(source, "png");
		await expect(service.run([source], { kind: "convertImage", format: "avif" }, null)).rejects.toThrow(t("main.action.unsupportedConvert", { format: "AVIF" }));
	});

	it("encodes AVIF with the AV1 encoder the build lists", async () => {
		const { service, commands } = makeService({
			platform: "win32",
			muxers: "  E  image2          image2 sequence\n  E  avif            AVIF\n",
		});
		const source = join(root, "photo.heic");
		await writeFile(source, "heic");
		const outcome = await service.run([source], { kind: "convertImage", format: "avif" }, null);
		expect(outcome.output).toBe(join(root, "photo.avif"));
		const args = commands.at(-1)?.args ?? [];
		expect(args.join(" ")).toContain("-c:v libsvtav1");
		expect(args.join(" ")).toContain("-pix_fmt yuv420p");
		expect(args.join(" ")).toContain("-crf");
		expect(args).not.toContain("-update");
	});
});

describe("video actions", () => {
	it("remuxes with ffmpeg when it is present", async () => {
		const { service, commands } = makeService({ ffmpeg: true });
		const source = join(root, "clip.mov");
		await writeFile(source, "mov");
		const outcome = await service.run([source], { kind: "convertVideo", container: "mp4" }, null);
		expect(outcome.output).toBe(join(root, "clip.mp4"));
		expect(commands.at(-1)).toEqual({
			command: "ffmpeg",
			args: ["-y", "-i", source, "-c", "copy", join(root, "clip.mp4")],
		});
	});

	it("refuses container conversion without ffmpeg", async () => {
		const { service } = makeService({ ffmpeg: false });
		const source = join(root, "clip.mov");
		await writeFile(source, "mov");
		await expect(service.run([source], { kind: "convertVideo", container: "mp4" }, null)).rejects.toThrow(t("main.action.videoNeedsFfmpeg"));
	});
});

describe("open with", () => {
	const IINA = "/Applications/IINA.app";
	const VLC = "/Applications/VLC.app";

	it("lists the OS-registered applications default first, each once, with icons", async () => {
		const { service, commands } = makeService({ registered: [IINA, VLC] });
		const applications = await service.openWithApplications(join(root, "clip.mkv"));
		expect(applications).toEqual([
			{ path: IINA, name: "IINA", isDefault: true, icon: "data:image/png;base64,IINA.app" },
			{ path: VLC, name: "VLC", isDefault: false, icon: "data:image/png;base64,VLC.app" },
		]);
		// The file path is a script argument, never part of the script text.
		const lookup = commands.find((command) => command.command === "osascript");
		expect(lookup?.args.at(-1)).toBe(join(root, "clip.mkv"));
	});

	it("offers nothing off macOS, where the OS list cannot be read", async () => {
		const { service, commands } = makeService({ platform: "win32", registered: [IINA] });
		expect(await service.openWithApplications(join(root, "clip.mkv"))).toEqual([]);
		expect(commands).toEqual([]);
	});

	it("degrades a failed lookup to no suggestions", async () => {
		const { service } = makeService({ lookupFails: true });
		expect(await service.openWithApplications(join(root, "clip.mkv"))).toEqual([]);
	});

	it("launches an application the OS offered for the file", async () => {
		const { service, commands } = makeService({ registered: [IINA, VLC] });
		const source = join(root, "clip.mkv");
		await writeFile(source, "mkv");
		const outcome = await service.run([source], { kind: "openWith", application: VLC }, null);
		expect(outcome.note).toBe("clip.mkv — VLC로 열었습니다");
		expect(commands.at(-1)).toEqual({ command: "open", args: ["-a", VLC, source] });
	});

	it("refuses a named application the OS did not offer, without launching it", async () => {
		const { service, commands } = makeService({ registered: [IINA] });
		const source = join(root, "clip.mkv");
		await writeFile(source, "mkv");
		await expect(service.run([source], { kind: "openWith", application: "/bin/sh" }, null)).rejects.toThrow(
			t("main.action.appCannotOpen"),
		);
		expect(commands.some((command) => command.command === "open")).toBe(false);
	});

	it("opens the full chooser for 기타… and launches what was picked", async () => {
		const { service, commands } = makeService({ picked: "/Applications/Obscure.app", registered: [IINA] });
		const source = join(root, "clip.mkv");
		await writeFile(source, "mkv");
		const outcome = await service.run([source], { kind: "openWith", application: null }, null);
		expect(outcome.note).toContain("Obscure");
		expect(commands.at(-1)).toEqual({ command: "open", args: ["-a", "/Applications/Obscure.app", source] });
	});

	it("reports a cancelled chooser without launching anything", async () => {
		const { service, commands } = makeService({ picked: null });
		const source = join(root, "clip.mkv");
		await writeFile(source, "mkv");
		const outcome = await service.run([source], { kind: "openWith", application: null }, null);
		expect(outcome.output).toBeNull();
		expect(commands).toEqual([]);
	});
});

describe("batch targets", () => {
	it("compresses a multi-selection into one Archive.zip", async () => {
		const { service } = makeService();
		await mkdir(join(root, "docs"));
		await writeFile(join(root, "docs", "readme.md"), "hello");
		await writeFile(join(root, "note.txt"), "note");
		const packed = await service.run([join(root, "docs"), join(root, "note.txt")], { kind: "compress" }, null);
		expect(packed.output).toBe(join(root, "Archive.zip"));
		expect(packed.note).toBe("Archive.zip — 압축했습니다");

		const unpacked = await service.run([packed.output ?? ""], { kind: "extract" }, null);
		expect(unpacked.output).toBe(join(root, "Archive"));
		expect(await readFile(join(root, "Archive", "docs", "readme.md"), "utf8")).toBe("hello");
		expect(await readFile(join(root, "Archive", "note.txt"), "utf8")).toBe("note");
	});

	it("numbers Archive.zip when one already exists", async () => {
		const { service } = makeService();
		await writeFile(join(root, "Archive.zip"), "old");
		await writeFile(join(root, "note.txt"), "note");
		await writeFile(join(root, "photo.png"), "png");
		const packed = await service.run([join(root, "note.txt"), join(root, "photo.png")], { kind: "compress" }, null);
		expect(packed.output).toBe(join(root, "Archive 2.zip"));
	});

	it("opens every target with one chosen application", async () => {
		const { service, commands } = makeService({ picked: "/Applications/IINA.app" });
		const one = join(root, "a.mkv");
		const two = join(root, "b.mkv");
		await writeFile(one, "x");
		await writeFile(two, "y");
		const outcome = await service.run([one, two], { kind: "openWith", application: null }, null);
		expect(commands.at(-1)).toEqual({ command: "open", args: ["-a", "/Applications/IINA.app", one, two] });
		expect(outcome.note).toContain("2개");
	});

	it("shares the whole selection through one sheet", async () => {
		const { service, shares } = makeService();
		const anchor = { x: 1, y: 2, width: 3, height: 4 };
		await service.share([join(root, "a.txt"), join(root, "b.txt")], anchor, null);
		expect(shares).toEqual([{ paths: [join(root, "a.txt"), join(root, "b.txt")], anchor }]);
	});

	it("extracts and edits exactly one target", async () => {
		const { service } = makeService();
		const one = join(root, "a.zip");
		const two = join(root, "b.zip");
		await expect(service.run([one, two], { kind: "extract" }, null)).rejects.toThrow(t("main.action.singleTargetOnly"));
		await expect(service.run([one, two], { kind: "convertImage", format: "jpeg" }, null)).rejects.toThrow(t("main.action.singleTargetOnly"));
	});
});

const MEDIA_ENCODERS =
	FFMPEG_ENCODERS +
	" V....D libx264              libx264 H.264\n" +
	" V....D libvpx-vp9           libvpx VP9\n" +
	" A....D aac                  AAC\n" +
	" A....D libmp3lame           libmp3lame MP3\n" +
	" A....D libopus              libopus Opus\n";

/** A PNG signature followed by empty chunks of the given types, in order (the CRC is not checked by readers of the chunk list). */
function pngWith(types: readonly string[]): Buffer {
	const chunk = (type: string): Buffer => Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from(type, "latin1"), Buffer.alloc(4)]);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...types.map(chunk)]);
}

/** A reducer double: writes `bytes` bytes as Filee's `<stem>_compressed.pdf` and reports availability. */
function fakePdf(bytes: number, available = true): PdfReducer & { readonly calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		available: async () => available,
		reduce: async (source, outputDir) => {
			calls.push(source);
			const out = join(outputDir, `${stemOf(source)}_compressed.pdf`);
			await writeFile(out, Buffer.alloc(bytes));
			return out;
		},
	};
}

describe("reduceSize", () => {
	it("keeps a picture's format, names the result -reduced and reports the saving", async () => {
		const { service, commands } = makeService({ imageOutput: "s" });
		const photo = join(root, "photo.jpeg");
		await writeFile(photo, "x".repeat(2048));
		const outcome = await service.run([photo], { kind: "reduceSize" }, null);
		expect(outcome.output).toBe(join(root, "photo-reduced.jpeg"));
		expect((await stat(photo)).size).toBe(2048);
		expect((await stat(outcome.output ?? "")).size).toBe(1);
		expect(commands.at(-1)?.command).toBe("sips");
		expect(commands.at(-1)?.args.slice(0, 4)).toEqual(["-s", "format", "jpeg", "-s"]);
		expect(outcome.note).toBe(t("main.action.reduced", { name: "photo-reduced.jpeg", before: "2.0 KB", after: "1 B", percent: 99 }));
	});

	it("leaves nothing behind when the result is not smaller than the original", async () => {
		const { service } = makeService({ imageOutput: "much-larger-than-source" });
		const photo = join(root, "photo.jpg");
		await writeFile(photo, "jpg");
		await expect(service.run([photo], { kind: "reduceSize" }, null)).rejects.toThrow(t("main.action.alreadyOptimized"));
		expect(await readdir(root)).toEqual(["photo.jpg"]);
	});

	it("replaces the original in place (moving the original to Trash) with zero extra files when replaceOriginal is true", async () => {
		const { service, trashed } = makeService({ encoders: MEDIA_ENCODERS, imageOutput: "small" });
		const clip = join(root, "k-skill-ai-rookie.mp4");
		await writeFile(clip, "x".repeat(4096));
		const outcome = await service.run([clip], { kind: "reduceSize", level: "balanced", replaceOriginal: true }, null);
		expect(outcome.output).toBe(clip);
		expect(await readdir(root)).toEqual(["k-skill-ai-rookie.mp4"]);
		expect((await stat(clip)).size).toBe(5);
		expect(trashed).toEqual([clip]);
	});

	it("reuses one -reduced file via Trash in copy mode instead of spawning -reduced 2 .. 8 garbage", async () => {
		const { service, trashed } = makeService({ imageOutput: "s" });
		const photo = join(root, "photo.heic");
		await writeFile(photo, "heic-bytes");
		const first = await service.run([photo], { kind: "reduceSize", replaceOriginal: false }, null);
		const second = await service.run([photo], { kind: "reduceSize", level: "max", replaceOriginal: false }, null);
		expect(first.output).toBe(join(root, "photo-reduced.heic"));
		expect(second.output).toBe(join(root, "photo-reduced.heic"));
		expect((await readdir(root)).sort()).toEqual(["photo-reduced.heic", "photo.heic"]);
		expect(trashed).toEqual([join(root, "photo-reduced.heic")]);
	});

	it("refuses types with no size reduction and several targets", async () => {
		const { service } = makeService();
		const note = join(root, "notes.txt");
		await writeFile(note, "hi");
		await expect(service.run([note], { kind: "reduceSize" }, null)).rejects.toThrow(t("main.action.unsupportedReduce"));
		await expect(service.run([note, note], { kind: "reduceSize" }, null)).rejects.toThrow(t("main.action.singleTargetOnly"));
	});

	it("applies light (lossless deflate), balanced (256-color palette), and max (128-color 1600px) levels to PNG", async () => {
		const { service, commands } = makeService({ imageOutput: "s" });
		const png = join(root, "flat.png");
		await writeFile(png, "png-bytes");
		await service.run([png], { kind: "reduceSize", level: "light" }, null);
		expect((commands.at(-1)?.args ?? []).join(" ")).toContain("-compression_level 9 -pred mixed");
		await service.run([png], { kind: "reduceSize", level: "balanced" }, null);
		expect((commands.at(-1)?.args ?? []).join(" ")).toContain("max_colors=256");
		await service.run([png], { kind: "reduceSize", level: "max" }, null);
		expect((commands.at(-1)?.args ?? []).join(" ")).toContain("max_colors=128");
	});

	it("refuses an animated PNG or WebP, which a one-frame re-encode would flatten", async () => {
		const { service } = makeService({ platform: "win32", imageOutput: "s" });
		const apng = join(root, "anim.png");
		await writeFile(apng, pngWith(["IHDR", "acTL", "IDAT"]));
		const still = join(root, "still.png");
		await writeFile(still, pngWith(["IHDR", "iCCP", "IDAT", "acTL"]));
		await service.run([still], { kind: "reduceSize" }, null);
		await expect(service.run([apng], { kind: "reduceSize" }, null)).rejects.toThrow(t("main.action.animatedReduce"));
		const webp = join(root, "anim.webp");
		const header = Buffer.alloc(30);
		header.write("RIFF", 0);
		header.write("WEBP", 8);
		header.write("VP8X", 12);
		header[20] = 0x02;
		await writeFile(webp, header);
		await expect(service.run([webp], { kind: "reduceSize" }, null)).rejects.toThrow(t("main.action.animatedReduce"));
	});

	it("reduces a PDF through the Filee reducer and keeps a staging folder out of the listing", async () => {
		const pdf = fakePdf(100);
		const { service } = makeService({ pdf });
		const source = join(root, "scan.pdf");
		await writeFile(source, Buffer.alloc(5000));
		const outcome = await service.run([source], { kind: "reduceSize" }, null);
		expect(outcome.output).toBe(join(root, "scan-reduced.pdf"));
		expect(pdf.calls).toEqual([source]);
		expect((await readdir(root)).sort()).toEqual(["scan-reduced.pdf", "scan.pdf"]);
	});

	it("drops a PDF result that did not shrink, and a PDF when Filee is unavailable", async () => {
		const source = join(root, "small.pdf");
		await writeFile(source, Buffer.alloc(50));
		const bigger = makeService({ pdf: fakePdf(500) });
		await expect(bigger.service.run([source], { kind: "reduceSize" }, null)).rejects.toThrow(t("main.action.alreadyOptimized"));
		expect(await readdir(root)).toEqual(["small.pdf"]);

		const none = makeService({ pdf: fakePdf(1, false) });
		await expect(none.service.run([source], { kind: "reduceSize" }, null)).rejects.toThrow(t("main.action.unsupportedReduce"));
	});

	it("applies distinct video CRF, resolution cap, and audio bitrates across light, balanced, and max levels", async () => {
		const { service, commands } = makeService({ encoders: MEDIA_ENCODERS, imageOutput: "s" });
		const clip = join(root, "clip.mov");
		await writeFile(clip, "x".repeat(4096));

		await service.run([clip], { kind: "reduceSize", level: "light" }, null);
		expect(commands.at(-1)?.args).toEqual(expect.arrayContaining(["-c:v", "libx264", "-crf", "23", "-b:a", "160k", "-movflags", "+faststart"]));

		await service.run([clip], { kind: "reduceSize", level: "balanced" }, null);
		expect(commands.at(-1)?.args).toEqual(expect.arrayContaining(["-c:v", "libx264", "-crf", "28", "-b:a", "128k"]));
		expect((commands.at(-1)?.args ?? []).join(" ")).toContain("min(iw,1920)");

		await service.run([clip], { kind: "reduceSize", level: "max" }, null);
		expect(commands.at(-1)?.args).toEqual(expect.arrayContaining(["-c:v", "libx264", "-crf", "33", "-b:a", "96k"]));
		expect((commands.at(-1)?.args ?? []).join(" ")).toContain("min(iw,1280)");
	});

	it("uses VP9 and Opus for WebM, and refuses video the build has no encoder for", async () => {
		const full = makeService({ encoders: MEDIA_ENCODERS, imageOutput: "s" });
		const webm = join(root, "talk.webm");
		await writeFile(webm, "x".repeat(4096));
		await full.service.run([webm], { kind: "reduceSize" }, null);
		expect(full.commands.at(-1)?.args).toEqual(expect.arrayContaining(["libvpx-vp9", "libopus"]));

		const bare = makeService({ imageOutput: "s" });
		const mp4 = join(root, "movie.mp4");
		await writeFile(mp4, "x".repeat(4096));
		await expect(bare.service.run([mp4], { kind: "reduceSize" }, null)).rejects.toThrow(t("main.action.unsupportedReduce"));
	});

	it("re-encodes audio at a lower bitrate and carries the cover art over", async () => {
		const { service, commands } = makeService({ encoders: MEDIA_ENCODERS, imageOutput: "s" });
		const song = join(root, "song.mp3");
		await writeFile(song, "x".repeat(4096));
		const outcome = await service.run([song], { kind: "reduceSize" }, null);
		expect(outcome.output).toBe(join(root, "song-reduced.mp3"));
		const args = commands.at(-1)?.args ?? [];
		expect(args).toEqual(expect.arrayContaining(["libmp3lame", "-b:a", "128k", "-c:v", "copy"]));
	});

	it("never reports a size reduction the engines cannot do: capabilities list only what runs", async () => {
		const bare = makeService({ ffmpeg: false });
		expect((await bare.service.capabilities()).reducibleExtensions).toEqual(["jpg", "jpeg", "heic", "heif"]);
		const media = makeService({ encoders: MEDIA_ENCODERS, pdf: fakePdf(1) });
		expect((await media.service.capabilities()).reducibleExtensions).toEqual([
			"pdf",
			"jpg",
			"jpeg",
			"png",
			"webp",
			"heic",
			"heif",
			"mp4",
			"m4v",
			"mov",
			"mkv",
			"webm",
			"mp3",
			"m4a",
			"aac",
			"opus",
		]);
		const win = makeService({ platform: "win32", ffmpeg: false });
		expect((await win.service.capabilities()).reducibleExtensions).toEqual([]);
		const winPdf = makeService({ platform: "win32", ffmpeg: false, pdf: fakePdf(1, false) });
		expect((await winPdf.service.capabilities()).reducibleExtensions).toEqual([]);
	});

	it("streams determinate ffmpeg progress for the job id and hides the half-written file until done", async () => {
		const progress: { id: string; percent: number }[] = [];
		let duringRun: string[] = [];
		const service = createActionService({
			platform: "darwin",
			applications: { pick: async () => null },
			onProgress: (event) => progress.push({ id: event.id, percent: event.percent }),
			run: async (command, args, options) => {
				if (command === "ffmpeg" && args[0] === "-version") return { stdout: "ffmpeg version 9", stderr: "" };
				if (command === "ffmpeg" && args.includes("-encoders")) return { stdout: MEDIA_ENCODERS, stderr: "" };
				if (command === "ffmpeg" && args.includes("-muxers")) return { stdout: FFMPEG_MUXERS, stderr: "" };
				if (command === "sips") return { stdout: SIPS_FORMATS_LISTING, stderr: "" };
				duringRun = (await readdir(root)).filter((name) => !name.startsWith("."));
				options?.onStderr?.("  Duration: 00:00:04.00, start: 0.000000\n");
				options?.onStdout?.("out_time_us=1000000\n");
				options?.onStdout?.("out_time_us=3000000\nprogress=end\n");
				const target = args.at(-1);
				if (target !== undefined) await writeFile(target, "s");
				return { stdout: "", stderr: "" };
			},
		});
		const clip = join(root, "clip.mp4");
		await writeFile(clip, "x".repeat(4096));
		const outcome = await service.run([clip], { kind: "reduceSize", id: "job-mp4" }, null);
		expect(duringRun).toEqual(["clip.mp4"]);
		expect(outcome.output).toBe(join(root, "clip-reduced.mp4"));
		expect(progress).toEqual([
			{ id: "job-mp4", percent: 25 },
			{ id: "job-mp4", percent: 75 },
		]);
	});

	it("cancels a running PDF or video reduction, cleans staging, and rejects as cancelled", async () => {
		let started!: () => void;
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const pdf: PdfReducer = {
			available: async () => true,
			reduce: (_source, _out, signal) =>
				new Promise((_resolve, reject) => {
					started();
					signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		};
		const service = createActionService({
			platform: "darwin",
			applications: { pick: async () => null },
			pdf,
			run: async () => ({ stdout: "", stderr: "" }),
		});
		const scan = join(root, "scan.pdf");
		await writeFile(scan, Buffer.alloc(4096));
		const running = service.run([scan], { kind: "reduceSize", id: "job-pdf" }, null);
		await entered;
		await service.cancel("job-pdf");
		await expect(running).rejects.toThrow(t("main.action.reduceCancelled", { name: "scan.pdf" }));
		expect(await readdir(root)).toEqual(["scan.pdf"]);
	});

	it("falls back to object-stream compaction when Filee left a digital PDF unshrunk", async () => {
		const doc = await PDFDocument.create();
		const font = await doc.embedFont(StandardFonts.Helvetica);
		for (let i = 0; i < 12; i += 1) {
			const page = doc.addPage([595, 842]);
			for (let line = 0; line < 35; line += 1) {
				page.drawText(`Section ${i}.${line}: digital PDF text line 1234567890`, { x: 40, y: 800 - line * 16, size: 10, font });
			}
		}
		const digital = join(root, "digital.pdf");
		const uncompacted = await doc.save({ useObjectStreams: false });
		await writeFile(digital, uncompacted);
		// Filee copies a digital-only PDF byte-for-byte ("Couldn't make it smaller, so it was copied as it is").
		const copyPdf: PdfReducer = {
			available: async () => true,
			reduce: async (source, outputDir) => {
				const out = join(outputDir, "digital_compressed.pdf");
				await writeFile(out, await readFile(source));
				return out;
			},
		};
		const { service } = makeService({ pdf: copyPdf });
		const outcome = await service.run([digital], { kind: "reduceSize" }, null);
		expect(outcome.output).toBe(join(root, "digital-reduced.pdf"));
		expect((await stat(outcome.output ?? "")).size).toBeLessThan(uncompacted.byteLength);
	});
});

describe("capabilities", () => {
	it("reports the macOS engines, ordered by how common each format is, and probes once", async () => {
		const { service, commands } = makeService({ ffmpeg: true });
		const capabilities = await service.capabilities();
		expect(capabilities).toEqual({
			openWith: true,
			share: true,
			archive: true,
			imageFormats: ["jpeg", "png", "webp", "heic", "avif", "gif", "tiff", "bmp"],
			videoContainers: ["mp4", "mov", "mkv"],
			reducibleExtensions: ["jpg", "jpeg", "png", "webp", "heic", "heif"],
		});
		await service.capabilities();
		// One probe each per session: `-version`, `-encoders`, `-muxers`, and `sips --formats`.
		expect(commands.filter((command) => command.command === "ffmpeg")).toHaveLength(3);
		expect(commands.filter((command) => command.command === "sips")).toHaveLength(1);
	});

	it("drops video containers without ffmpeg and keeps the sips-writable image formats", async () => {
		const { service } = makeService({ ffmpeg: false });
		const capabilities = await service.capabilities();
		expect(capabilities.videoContainers).toEqual([]);
		expect(capabilities.imageFormats).toEqual(["jpeg", "png", "heic", "avif", "gif", "tiff", "bmp"]);
	});

	it("falls back to the formats every sips writes when the format probe fails", async () => {
		const { service } = makeService({ ffmpeg: false, sipsFormats: null });
		const capabilities = await service.capabilities();
		expect(capabilities.imageFormats).toEqual(["jpeg", "png", "heic", "gif", "tiff", "bmp"]);
	});

	it("offers ffmpeg-backed image formats on Windows but still no share sheet", async () => {
		const { service } = makeService({ platform: "win32" });
		const capabilities = await service.capabilities();
		// The probe lists mjpeg/png/libwebp/gif/tiff/bmp and no heif or avif muxer.
		expect(capabilities.imageFormats).toEqual(["jpeg", "png", "webp", "gif", "tiff", "bmp"]);
		expect(capabilities.share).toBe(false);
		await expect(service.share([join(root, "a.txt")], { x: 0, y: 0, width: 10, height: 10 }, null)).rejects.toThrow(
			t("main.action.shareUnsupported"),
		);
	});

	it("hides image actions on Windows without ffmpeg", async () => {
		const { service } = makeService({ platform: "win32", ffmpeg: false });
		const capabilities = await service.capabilities();
		expect(capabilities.imageFormats).toEqual([]);
		expect(capabilities.videoContainers).toEqual([]);
	});

	it("pops the share sheet with the anchored rect on macOS", async () => {
		const { service, shares } = makeService();
		const anchor = { x: 10, y: 20, width: 30, height: 40 };
		await service.share(["/tmp/a.txt"], anchor, null);
		expect(shares).toEqual([{ paths: ["/tmp/a.txt"], anchor }]);
	});
});

describe("imageFormatOf", () => {
	it("maps extensions to their canonical format", () => {
		expect(imageFormatOf("/a/photo.JPG")).toBe("jpeg");
		expect(imageFormatOf("/a/photo.tif")).toBe("tiff");
		expect(imageFormatOf("/a/photo.webp")).toBe("webp");
		expect(imageFormatOf("/a/photo.txt")).toBeNull();
	});
});

describe("extract into an existing name", () => {
	it("numbers the output folder", async () => {
		const { service } = makeService();
		await mkdir(join(root, "docs"), { recursive: true });
		const file = join(root, "note.txt");
		await writeFile(file, "note");
		const packed = await service.run([file], { kind: "compress" }, null);
		// "note.txt.zip" extracts to "note.txt", which is taken by the source file.
		const unpacked = await service.run([packed.output ?? ""], { kind: "extract" }, null);
		expect(unpacked.output).toBe(join(root, "note 2.txt"));
		expect((await stat(join(unpacked.output ?? "", "note.txt"))).isFile()).toBe(true);
	});
});
