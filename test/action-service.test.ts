import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { zipSync } from "fflate";
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
import { archiveEntryPath } from "../src/main/archive-guard.mjs";

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
}

/**
 * A realistic `ffmpeg -encoders` body: the image encoders this machine has, but
 * no heif muxer (so HEIC stays hidden), matching the probe's parsing contract.
 */
const FFMPEG_ENCODERS =
	" V....D apng                 APNG image\n" +
	" VFS..D mjpeg                MJPEG (Motion JPEG)\n" +
	" VF...D png                  PNG image\n" +
	" VF...D tiff                 TIFF image\n" +
	" V....D libwebp              libwebp WebP image\n" +
	" V....D libx265              libx265 H.265 / HEVC\n";
/** A muxer list without `heif`, so HEIC is not offered. */
const FFMPEG_MUXERS = "  E  image2          image2 sequence\n  E  mp4             MP4\n";

/** A service whose external commands are recorded and whose "image" output is written. */
function makeService(
	options: {
		readonly platform?: NodeJS.Platform;
		readonly ffmpeg?: boolean;
		readonly picked?: string | null;
		/** Bytes written for a produced image; keep below the source to pass optimize. */
		readonly imageOutput?: string;
		/** Overrides the fake `ffmpeg -muxers` body (default: no heif muxer). */
		readonly muxers?: string;
		/** Applications the fake Launch Services reports for any file, default first. */
		readonly registered?: readonly string[];
		/** Make the Launch Services lookup fail. */
		readonly lookupFails?: boolean;
	} = {},
): Harness {
	const commands: { command: string; args: string[] }[] = [];
	const shares: { paths: string[]; anchor: ActionAnchor }[] = [];
	const imageOutput = options.imageOutput ?? "encoded";
	const run: CommandRunner = async (command, args) => {
		commands.push({ command, args: [...args] });
		if (command === "ffmpeg" && options.ffmpeg === false) throw new Error("ffmpeg: command not found");
		if (command === "ffmpeg" && args[0] === "-version") {
			return { stdout: "ffmpeg version 9", stderr: "" };
		}
		if (command === "ffmpeg" && args.includes("-encoders")) return { stdout: FFMPEG_ENCODERS, stderr: "" };
		if (command === "ffmpeg" && args.includes("-muxers")) return { stdout: options.muxers ?? FFMPEG_MUXERS, stderr: "" };
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
			run,
		}),
		commands,
		shares,
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
		expect(() => archiveEntryPath("/tmp/out", "../evil.txt")).toThrow(/벗어납니다/);
		expect(() => archiveEntryPath("/tmp/out", "docs/../../evil.txt")).toThrow(/벗어납니다/);
		expect(() => archiveEntryPath("/tmp/out", "/etc/passwd")).toThrow(/절대 경로/);
		expect(() => archiveEntryPath("/tmp/out", "C:/Windows/evil.dll")).toThrow(/절대 경로/);
		expect(() => archiveEntryPath("/tmp/out", "docs/bad\0.txt")).toThrow(/올바르지 않습니다/);
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

		await expect(service.run([hostile], { kind: "extract" }, null)).rejects.toThrow(/벗어납니다/);
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
			/WEBP/,
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

	it("resizes to a bounded long edge and refuses WebP sources", async () => {
		const { service, commands } = makeService();
		const source = join(root, "photo.jpeg");
		await writeFile(source, "jpg");
		const outcome = await service.run([source], { kind: "resizeImage", maxEdge: 1920 }, null);
		expect(outcome.output).toBe(join(root, "photo-1920.jpeg"));
		expect(commands.at(-1)?.args).toEqual(["-Z", "1920", "--out", join(root, "photo-1920.jpeg"), source]);

		const webp = join(root, "vector.webp");
		await writeFile(webp, "webp");
		await expect(service.run([webp], { kind: "resizeImage", maxEdge: 1920 }, null)).rejects.toThrow(/지원하지 않습니다/);
	});

	it("optimizes only lossy formats", async () => {
		const { service } = makeService();
		const photo = join(root, "photo.jpeg");
		await writeFile(photo, "jpg");
		const outcome = await service.run([photo], { kind: "optimizeImage" }, null);
		expect(outcome.output).toBe(join(root, "photo-optimized.jpeg"));

		const png = join(root, "flat.png");
		await writeFile(png, "png");
		await expect(service.run([png], { kind: "optimizeImage" }, null)).rejects.toThrow(/지원하지 않습니다/);
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

	it("optimizes a JPEG and keeps the output only when it shrank", async () => {
		const { service, commands } = makeService({ platform: "win32", imageOutput: "s" });
		const source = join(root, "big.jpeg");
		await writeFile(source, "jpeg-bytes");

		const outcome = await service.run([source], { kind: "optimizeImage" }, null);
		expect(outcome.output).toBe(join(root, "big-optimized.jpeg"));
		expect(commands.at(-1)?.command).toBe("ffmpeg");
	});

	it("optimizes PNG losslessly and drops the output when it did not shrink", async () => {
		const shrink = makeService({ platform: "win32", imageOutput: "s" });
		const png = join(root, "flat.png");
		await writeFile(png, "png-bytes");
		await shrink.service.run([png], { kind: "optimizeImage" }, null);
		expect((shrink.commands.at(-1)?.args ?? []).join(" ")).toContain("-compression_level 9");

		const bigger = makeService({ platform: "win32", imageOutput: "much-larger-than-source" });
		const other = join(root, "flat2.png");
		await writeFile(other, "png");
		await expect(bigger.service.run([other], { kind: "optimizeImage" }, null)).rejects.toThrow(/최적화/);
	});

	it("hides formats the ffmpeg build cannot encode", async () => {
		const { service } = makeService({ platform: "win32" });
		const source = join(root, "shot.png");
		await writeFile(source, "png");
		// No heif muxer is listed, so HEIC is not a capability and cannot be run.
		await expect(service.run([source], { kind: "convertImage", format: "heic" }, null)).rejects.toThrow(/HEIC/);
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
		await expect(service.run([source], { kind: "convertVideo", container: "mp4" }, null)).rejects.toThrow(/ffmpeg/);
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
			/열 수 있는 앱/,
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
		await expect(service.run([one, two], { kind: "extract" }, null)).rejects.toThrow(/하나의/);
		await expect(service.run([one, two], { kind: "convertImage", format: "jpeg" }, null)).rejects.toThrow(/하나의/);
	});
});

describe("capabilities", () => {
	it("reports the macOS engines and probes ffmpeg once", async () => {
		const { service, commands } = makeService({ ffmpeg: true });
		const capabilities = await service.capabilities();
		expect(capabilities).toEqual({
			openWith: true,
			share: true,
			archive: true,
			imageFormats: ["jpeg", "png", "tiff", "heic", "webp"],
			videoContainers: ["mp4", "mov", "mkv"],
		});
		await service.capabilities();
		expect(commands.filter((command) => command.command === "ffmpeg")).toHaveLength(1);
	});

	it("drops video containers without ffmpeg and keeps the native image formats", async () => {
		const { service } = makeService({ ffmpeg: false });
		const capabilities = await service.capabilities();
		expect(capabilities.videoContainers).toEqual([]);
		expect(capabilities.imageFormats).toEqual(["jpeg", "png", "tiff", "heic"]);
	});

	it("offers ffmpeg-backed image formats on Windows but still no share sheet", async () => {
		const { service } = makeService({ platform: "win32" });
		const capabilities = await service.capabilities();
		// The probe lists mjpeg/png/libwebp/tiff and no heif muxer.
		expect(capabilities.imageFormats).toEqual(["jpeg", "png", "webp", "tiff"]);
		expect(capabilities.share).toBe(false);
		await expect(service.share([join(root, "a.txt")], { x: 0, y: 0, width: 10, height: 10 }, null)).rejects.toThrow(
			/지원하지 않습니다/,
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
