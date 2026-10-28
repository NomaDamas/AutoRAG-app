/**
 * File actions — the main-process half of the Inspector's action set.
 *
 * Every operation writes new files next to the source and never overwrites an
 * existing name: the output is named Finder-style (`photo.jpeg`, then
 * `photo 2.jpeg`), so a repeated action is safe. Nothing here touches the
 * network; the only external programs are the platform's own image tool
 * (`sips`, macOS), `ffmpeg` when the machine has it, and the launcher used by
 * "Open with". Capabilities report exactly which of those are present, so the
 * renderer can never offer a button that would fail.
 *
 * Both archive directions are streamed: compression reads and deflates one
 * member at a time (fflate's async deflate would spin up a worker thread per
 * entry, which costs more than it saves here), and extraction inflates chunk
 * by chunk without ever holding the whole archive or its contents.
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { finished } from "node:stream/promises";
import { unzlibSync, Zip, ZipDeflate, ZipPassThrough, zlibSync } from "fflate";
import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";
import type { BrowserWindow } from "electron";
import { archiveFormatOf } from "../shared/archive-formats";
import {
	extensionOfName,
	formatByteSize,
	jpegDimensions,
	parseMediaHeader,
	reducedCopyName,
	REDUCIBLE_EXTENSIONS,
	reductionKindOf,
	type MediaHeaderInfo,
	type ReductionLevel,
} from "../shared/size-reduction";
import { t } from "../shared/i18n/core";
import { ArchiveError } from "./archive-guard.mjs";
import { DEFAULT_ARCHIVE_LIMITS, type ArchiveLimits } from "./archive-common";
import { extractGzipInto, extractIntoFolder, flattenWrapper } from "./archive-extract";
import {
	type ActionAnchor,
	type ActionCapabilities,
	type ActionOutcome,
	type ActionProgressEvent,
	type ActionRequest,
	type ImageFormat,
	type OpenWithApplication,
	type VideoContainer,
} from "../shared/actions-contract";
import type { PdfReducer } from "./pdf-reducer";
import { writeSevenZip } from "./sevenzip-writer";
import { errorMessage, pathExists } from "./fs-entry";

/** Result of one external command. */
export interface CommandResult {
	readonly stdout: string;
	readonly stderr: string;
}

/** Runs an external command; rejects with the program's own message on failure. */
export interface CommandRunOptions {
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
	readonly onStdout?: (chunk: string) => void;
	readonly onStderr?: (chunk: string) => void;
}

export type CommandRunner = (
	command: string,
	args: readonly string[],
	options?: CommandRunOptions,
) => Promise<CommandResult>;

/** The "Open with" chooser for applications outside the OS's suggestions; injected so the service never imports `dialog`. */
export interface ApplicationPicker {
	/** The chosen application path, or null when the user cancelled. */
	pick(window: BrowserWindow | null): Promise<string | null>;
}

/** The OS share sheet; injected so the service never imports `ShareMenu`. */
export interface SharePresenter {
	present(paths: readonly string[], anchor: ActionAnchor, window: BrowserWindow | null): void;
}

export interface ActionServiceDeps {
	/** Defaults to process.platform. */
	readonly platform?: NodeJS.Platform;
	readonly applications: ApplicationPicker;
	/** The application's icon as an image URL the renderer can load; absent or null → the menu shows no icon. */
	readonly applicationIcon?: (applicationPath: string) => Promise<string | null>;
	/** Absent when the platform has no share sheet. */
	readonly share?: SharePresenter | null;
	/** Defaults to spawning the command with execFile. */
	readonly run?: CommandRunner;
	/** Extraction caps; tests inject small values to exercise the refusals. */
	readonly archiveLimits?: ArchiveLimits;
	/** Shrinks PDFs (Filee's Compress PDF); absent means PDFs are not offered. */
	readonly pdf?: PdfReducer;
	/** Live progress callback for long-running jobs (`reduceSize` with an `id`). */
	readonly onProgress?: (event: ActionProgressEvent, window: BrowserWindow | null) => void;
	/** Moves a file to the OS Trash before in-place replacement; defaults to `rm` in bare unit harnesses. */
	readonly trash?: (path: string) => Promise<void>;
}

/** The Inspector action surface the IPC layer registers. */
export interface ActionService {
	capabilities(): Promise<ActionCapabilities>;
	run(paths: readonly string[], request: ActionRequest, window: BrowserWindow | null): Promise<ActionOutcome>;
	/** Stop a running cancellable action (`reduceSize`) identified by `id`. */
	cancel(id: string): Promise<void>;
	/** Applications the OS registers for `path`'s type, default first (macOS; empty elsewhere). */
	openWithApplications(path: string): Promise<readonly OpenWithApplication[]>;
	share(paths: readonly string[], anchor: ActionAnchor, window: BrowserWindow | null): Promise<void>;
}

/**
 * Launch Services' view of a file: the handlers the OS registers for its type
 * (`URLsForApplicationsToOpenURL`, the list Finder's own "Open With" shows) and
 * the default one. The path arrives as `argv[0]`, never interpolated, so no
 * file name can alter the script.
 */
const OPEN_WITH_SCRIPT = `
ObjC.import("AppKit");
function run(argv) {
	const workspace = $.NSWorkspace.sharedWorkspace;
	const url = $.NSURL.fileURLWithPath(argv[0]);
	const fallback = workspace.URLForApplicationToOpenURL(url);
	const urls = workspace.URLsForApplicationsToOpenURL(url);
	const paths = [];
	for (let i = 0; i < urls.count; i++) paths.push(ObjC.unwrap(urls.objectAtIndex(i).path));
	return JSON.stringify({ defaultPath: fallback.isNil() ? null : ObjC.unwrap(fallback.path), paths: paths });
}
`;
const OPEN_WITH_TIMEOUT_MS = 10_000;

/** `Numbers.app` → `Numbers`. */
function applicationName(path: string): string {
	const name = basename(path);
	return name.toLowerCase().endsWith(".app") ? name.slice(0, -4) : name;
}

/** The `{ defaultPath, paths }` document the script prints, or null when it is malformed. */
function parseOpenWithListing(stdout: string): { readonly defaultPath: string | null; readonly paths: readonly string[] } | null {
	try {
		const parsed: unknown = JSON.parse(stdout);
		if (typeof parsed !== "object" || parsed === null) return null;
		const { defaultPath, paths } = parsed as { defaultPath?: unknown; paths?: unknown };
		if (!Array.isArray(paths) || !paths.every((entry): entry is string => typeof entry === "string")) return null;
		return { defaultPath: typeof defaultPath === "string" ? defaultPath : null, paths };
	} catch {
		return null;
	}
}

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const COMMAND_MAX_BUFFER = 1 << 24;
/** Deflate level: fflate's default balance, matching zlib's tuned setting. */
const ZIP_LEVEL = 6;
/** Re-encode quality for lossy formats (sips `formatOptions`, ffmpeg `-quality`). */
const LOSSY_QUALITY = 80;
const JPEG_QUALITY = "70";
/**
 * ffmpeg's mjpeg `-q:v` runs 2 (best)–31 (worst); the sips 0–100 scale does
 * not apply there, so the ffmpeg backend uses its own tuned value (≈ quality 80).
 */
const FFMPEG_JPEG_QSCALE = "4";
/** libx265 (HEIC) is rate-controlled by `-crf`, not `-q:v`. */
const FFMPEG_HEIC_CRF = "23";
/** AV1 (AVIF) quality: both libsvtav1 and libaom-av1 read `-crf` on a 0–63 scale. */
const FFMPEG_AVIF_CRF = "30";
/** One palette per image keeps GIF banding down; the default fixed palette posterizes photos. */
const GIF_PALETTE_FILTER = "split[a][b];[a]palettegen[p];[b][p]paletteuse";
/** Every format the conversion menu can offer, in the order it lists them: most common first. */
const IMAGE_FORMAT_ORDER: readonly ImageFormat[] = ["jpeg", "png", "webp", "heic", "avif", "gif", "tiff", "bmp"];
/** Formats sips may write; `sips --formats` decides which this macOS actually can (AVIF arrived later). */
const SIPS_CANDIDATES: readonly ImageFormat[] = ["jpeg", "png", "heic", "avif", "gif", "tiff", "bmp"];
/** What every supported macOS sips writes, used when `sips --formats` cannot be read. */
const SIPS_BASELINE: readonly ImageFormat[] = ["jpeg", "png", "heic", "gif", "tiff", "bmp"];
/**
 * ffmpeg image encoders that satisfy each format on the non-macOS backend. The
 * session probe keeps only the formats whose encoder is actually listed, so the
 * Inspector never offers a conversion this build cannot write.
 */
const FFMPEG_IMAGE_ENCODERS: readonly { readonly format: ImageFormat; readonly encoders: readonly string[] }[] = [
	{ format: "jpeg", encoders: ["mjpeg"] },
	{ format: "png", encoders: ["png"] },
	{ format: "webp", encoders: ["libwebp", "webp"] },
	{ format: "gif", encoders: ["gif"] },
	{ format: "tiff", encoders: ["tiff"] },
	{ format: "bmp", encoders: ["bmp"] },
];
/** HEIC needs a HEVC encoder and the heif muxer; both must be present. */
const HEIC_ENCODER = "libx265";
const HEIC_MUXER = "heif";
/** AVIF needs an AV1 encoder (first listed wins) and the avif muxer. */
const AVIF_ENCODERS: readonly string[] = ["libsvtav1", "libaom-av1"];
const AVIF_MUXER = "avif";
const VIDEO_CONTAINERS: readonly VideoContainer[] = ["mp4", "mov", "mkv"];
/** The extension written for each image format. */
const FORMAT_EXTENSIONS: Readonly<Record<ImageFormat, string>> = {
	jpeg: "jpg",
	png: "png",
	webp: "webp",
	heic: "heic",
	avif: "avif",
	gif: "gif",
	tiff: "tiff",
	bmp: "bmp",
};
const EXTENSION_FORMATS: Readonly<Record<string, ImageFormat>> = {
	jpg: "jpeg",
	jpeg: "jpeg",
	png: "png",
	webp: "webp",
	heic: "heic",
	heif: "heic",
	avif: "avif",
	gif: "gif",
	tif: "tiff",
	tiff: "tiff",
	bmp: "bmp",
};
/** Staging folder a size reduction writes into before the result takes its final name. */
const REDUCE_STAGING_PREFIX = ".dazzi-reduce-";
/** Per-level encoder parameters across image, video, audio, and PDF streams. */
interface LevelSpec {
	readonly sipsQuality: string;
	readonly imageMaxEdge: number | null;
	readonly ffmpegJpegQ: string;
	readonly ffmpegWebpQuality: string;
	readonly ffmpegHeicCrf: string;
	readonly pngPaletteColors: 256 | 144 | 64;
	readonly pngDither: string;
	readonly x264Crf: string;
	readonly vp9Crf: string;
	readonly videoMaxEdge: number | null;
	readonly videoBitrateRatio: number;
	readonly videoAudioKbps: number;
	readonly videoOpusKbps: number;
	readonly audioKbps: number;
	readonly opusKbps: number;
	readonly audioBitrateRatio: number;
	readonly pdfMaxEdge: number;
	readonly pdfJpegQuality: string;
	readonly pdfFfmpegQ: string;
}

const LEVEL_SPECS: Readonly<Record<ReductionLevel, LevelSpec>> = {
	light: {
		sipsQuality: "66",
		imageMaxEdge: 2560,
		ffmpegJpegQ: "6",
		ffmpegWebpQuality: "72",
		ffmpegHeicCrf: "25",
		pngPaletteColors: 256,
		pngDither: "floyd_steinberg",
		x264Crf: "25",
		vp9Crf: "30",
		videoMaxEdge: null,
		videoBitrateRatio: 0.65,
		videoAudioKbps: 128,
		videoOpusKbps: 96,
		audioKbps: 160,
		opusKbps: 96,
		audioBitrateRatio: 0.72,
		pdfMaxEdge: 1600,
		pdfJpegQuality: "62",
		pdfFfmpegQ: "7",
	},
	balanced: {
		sipsQuality: "50",
		imageMaxEdge: 1920,
		ffmpegJpegQ: "10",
		ffmpegWebpQuality: "58",
		ffmpegHeicCrf: "29",
		pngPaletteColors: 144,
		pngDither: "sierra2_4a",
		x264Crf: "28",
		vp9Crf: "34",
		videoMaxEdge: 1920,
		videoBitrateRatio: 0.42,
		videoAudioKbps: 128,
		videoOpusKbps: 64,
		audioKbps: 128,
		opusKbps: 64,
		audioBitrateRatio: 0.5,
		pdfMaxEdge: 1280,
		pdfJpegQuality: "48",
		pdfFfmpegQ: "12",
	},
	max: {
		sipsQuality: "34",
		imageMaxEdge: 1280,
		ffmpegJpegQ: "18",
		ffmpegWebpQuality: "38",
		ffmpegHeicCrf: "35",
		pngPaletteColors: 64,
		pngDither: "sierra2_4a",
		x264Crf: "33",
		vp9Crf: "40",
		videoMaxEdge: 1280,
		videoBitrateRatio: 0.24,
		videoAudioKbps: 96,
		videoOpusKbps: 48,
		audioKbps: 64,
		opusKbps: 32,
		audioBitrateRatio: 0.35,
		pdfMaxEdge: 960,
		pdfJpegQuality: "34",
		pdfFfmpegQ: "18",
	},
};

const STEP_DOWN_LEVEL: Readonly<Record<ReductionLevel, ReductionLevel | null>> = {
	light: "balanced",
	balanced: "max",
	max: null,
};
/** The ffmpeg encoder each audio extension needs. */
const AUDIO_ENCODERS: Readonly<Record<string, string>> = { mp3: "libmp3lame", m4a: "aac", aac: "aac", opus: "libopus" };
/** Containers that can carry the (copied) cover picture of a track. */
const AUDIO_WITH_COVER: readonly string[] = ["mp3", "m4a"];
/** Video extensions the MP4 family flags (`+faststart`) apply to. */
const FASTSTART_EXTENSIONS: readonly string[] = ["mp4", "m4v", "mov"];

export function defaultRun(
	command: string,
	args: readonly string[],
	options?: CommandRunOptions,
): Promise<CommandResult> {
	const signal = options?.signal;
	if (signal?.aborted) return Promise.reject(new Error("aborted"));
	return new Promise<CommandResult>((resolve, reject) => {
		const child = spawn(command, [...args], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let bytes = 0;
		let settled = false;
		const finish = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			fn();
		};
		const killChild = (): void => {
			try {
				child.kill("SIGTERM");
			} catch {
				// Already gone.
			}
		};
		const timer = setTimeout(() => {
			killChild();
			finish(() => reject(new Error(`${command} timed out`)));
		}, options?.timeoutMs ?? COMMAND_TIMEOUT_MS);
		const onAbort = (): void => {
			killChild();
			finish(() => reject(new Error("aborted")));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.byteLength;
			if (bytes <= COMMAND_MAX_BUFFER) stdout.push(chunk);
			options?.onStdout?.(chunk.toString("utf8"));
		});
		child.stderr.on("data", (chunk: Buffer) => {
			bytes += chunk.byteLength;
			if (bytes <= COMMAND_MAX_BUFFER) stderr.push(chunk);
			options?.onStderr?.(chunk.toString("utf8"));
		});
		child.once("error", (error) => finish(() => reject(new Error(errorMessage(error)))));
		child.once("close", (code) => {
			const out = Buffer.concat(stdout).toString("utf8");
			const err = Buffer.concat(stderr).toString("utf8");
			if (code !== 0) {
				const detail = err.trim();
				finish(() => reject(new Error(detail.length > 0 ? detail : `${command} exited with code ${code ?? -1}`)));
				return;
			}
			finish(() => resolve({ stdout: out, stderr: err }));
		});
	});
}

/** The file name without its final extension. */
export function stemOf(path: string): string {
	const name = basename(path);
	const ext = extname(name);
	return ext.length === 0 ? name : name.slice(0, name.length - ext.length);
}

/** The image format a path's extension denotes, or null. */
export function imageFormatOf(path: string): ImageFormat | null {
	return EXTENSION_FORMATS[extname(path).slice(1).toLowerCase()] ?? null;
}

/**
 * `<dir>/<name>`, numbered `<stem> 2<ext>`, `<stem> 3<ext>` … until free — the
 * same shape Finder uses for a duplicated item, so a second run of an action
 * never clobbers the first result.
 */
export async function uniqueChild(dir: string, name: string): Promise<string> {
	const direct = join(dir, name);
	if (!(await pathExists(direct))) return direct;
	const ext = extname(name);
	const stem = name.slice(0, name.length - ext.length);
	for (let n = 2; ; n += 1) {
		const candidate = join(dir, `${stem} ${n}${ext}`);
		if (!(await pathExists(candidate))) return candidate;
	}
}

/** One file or directory to write into an archive, with its in-archive path. */
interface ArchiveMember {
	readonly source: string;
	/** Archive-relative path, always "/"-separated. */
	readonly entry: string;
	readonly directory: boolean;
}

/**
 * Every regular file and directory below `root`, archived under the root's own
 * name (macOS "Compress" keeps the folder wrapper). Symlinks are skipped: the
 * archiver must not escape the tree or chase a cycle.
 */
async function archiveMembers(root: string, isDirectory: boolean): Promise<ArchiveMember[]> {
	// Entry names are written NFC: Windows, Linux and Finder-created files use the
	// composed form, while a name copied from an NFD source (older macOS volumes,
	// other archives) lists on Windows as separate jamo and cannot be matched.
	const name = basename(root).normalize("NFC");
	if (!isDirectory) {
		return [{ source: root, entry: name, directory: false }];
	}
	const members: ArchiveMember[] = [{ source: root, entry: `${name}/`, directory: true }];
	const walk = async (dir: string, prefix: string): Promise<void> => {
		const dirents = await readdir(dir, { withFileTypes: true });
		dirents.sort((a, b) => a.name.localeCompare(b.name));
		for (const dirent of dirents) {
			if (dirent.isSymbolicLink()) continue;
			const source = join(dir, dirent.name);
			const entry = `${prefix}${dirent.name.normalize("NFC")}`;
			if (dirent.isDirectory()) {
				members.push({ source, entry: `${entry}/`, directory: true });
				await walk(source, `${entry}/`);
			} else if (dirent.isFile()) {
				members.push({ source, entry, directory: false });
			}
		}
	};
	await walk(root, `${name}/`);
	return members;
}

/**
 * Write `members` as a zip at `target`. Each file is read and deflated before
 * the next one starts, so peak input memory tracks the largest member rather
 * than the whole tree.
 */
async function writeZip(target: string, members: readonly ArchiveMember[]): Promise<void> {
	const output = createWriteStream(target);
	const archive = new Zip((error, chunk, final) => {
		if (error !== null) {
			output.destroy(error);
			return;
		}
		output.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
		if (final) output.end();
	});
	const drained = finished(output);
	for (const member of members) {
		if (member.directory) {
			const directory = new ZipPassThrough(member.entry);
			archive.add(directory);
			directory.push(new Uint8Array(0), true);
			continue;
		}
		const file = new ZipDeflate(member.entry, { level: ZIP_LEVEL });
		archive.add(file);
		file.push(new Uint8Array(await readFile(member.source)), true);
	}
	archive.end();
	await drained;
}

/** Encoder names from `ffmpeg -encoders`: six flag characters, then the name. */
function parseEncoderNames(listing: string): ReadonlySet<string> {
	const names = new Set<string>();
	for (const line of listing.split("\n")) {
		const name = /^\s*[A-Z.]{6}\s+(\S+)/.exec(line)?.[1];
		if (name !== undefined) names.add(name);
	}
	return names;
}

/** Muxer names from `ffmpeg -muxers`: a three-column flag field (`  E`, ` DE`) then the name. */
function parseMuxerNames(listing: string): ReadonlySet<string> {
	const names = new Set<string>();
	for (const line of listing.split("\n")) {
		const match = /^\s*([A-Z. ]{3})\s{2}(\S+)/.exec(line);
		const flags = match?.[1];
		if (flags === undefined) continue;
		const name = match?.[2];
		// Column three of the flag field marks muxing support: `  E  mp4`, ` DE  mov`.
		if (name !== undefined && flags[2] === "E") names.add(name);
	}
	return names;
}

/**
 * The image formats a `sips --formats` listing marks Writable, by the extension
 * column (`public.avif  avif  Writable`).
 */
function parseSipsWritable(listing: string): ReadonlySet<string> {
	const names = new Set<string>();
	for (const line of listing.split("\n")) {
		const name = /^\S+\s+(\S+)\s+Writable\s*$/.exec(line)?.[1];
		if (name !== undefined) names.add(name);
	}
	return names;
}

/** External-tool argv, one function per command shape. */
function sipsConvertArgs(source: string, target: string, format: ImageFormat): readonly string[] {
	return ["-s", "format", format, "--out", target, source];
}

function sipsResizeArgs(source: string, target: string, maxEdge: number): readonly string[] {
	return ["-Z", String(maxEdge), "--out", target, source];
}

function sipsReduceArgs(source: string, target: string, format: ImageFormat, quality: string, maxEdge: number | null): readonly string[] {
	return [
		"-s",
		"format",
		format,
		"-s",
		"formatOptions",
		quality,
		...(maxEdge === null ? [] : ["-Z", String(maxEdge)]),
		"--out",
		target,
		source,
	];
}

/**
 * image2 reads `%d`/`%0Nd` sequences in a path as frame-number patterns, so
 * `report%20draft.png` would be written as `report00000001raft.jpg` (with `-y`,
 * overwriting an unrelated file) and `shot%d.png` would read `shot1.png` when it
 * exists. Pin only formats handled by image2; container-like image formats must
 * use ffmpeg's native demuxer so HEIC, GIF, and AVIF inputs still decode.
 */
const IMAGE2_INPUT_EXTENSIONS = new Set(["bmp", "jpeg", "jpg", "png", "tif", "tiff", "webp"]);
const ffmpegImageInput = (source: string): readonly string[] =>
	IMAGE2_INPUT_EXTENSIONS.has(extname(source).slice(1).toLowerCase()) ? ["-f", "image2", "-pattern_type", "none"] : [];

/** image2 (the muxer for jpg/png/tiff/bmp) also expands output patterns; the webp/gif/avif muxers write literal names and reject the flag. */
const ffmpegImageOutput = (format: ImageFormat): readonly string[] =>
	format === "jpeg" || format === "png" || format === "tiff" || format === "bmp" ? ["-update", "1"] : [];

function ffmpegWebpArgs(source: string, target: string): readonly string[] {
	return ["-y", ...ffmpegImageInput(source), "-i", source, "-c:v", "libwebp", "-quality", String(LOSSY_QUALITY), target];
}

/**
 * Encoder flags for the ffmpeg image backend: quality for lossy formats, and
 * for AVIF the AV1 encoder the probe found (the avif muxer has no default that
 * is guaranteed to exist) in the 4:2:0 layout AVIF decoders expect.
 */
function ffmpegQualityArgs(format: ImageFormat, avifEncoder: string | null): readonly string[] {
	switch (format) {
		case "jpeg":
			return ["-q:v", FFMPEG_JPEG_QSCALE];
		case "heic":
			return ["-crf", FFMPEG_HEIC_CRF];
		case "webp":
			return ["-quality", String(LOSSY_QUALITY)];
		case "avif":
			return avifEncoder === null ? [] : ["-c:v", avifEncoder, "-pix_fmt", "yuv420p", "-crf", FFMPEG_AVIF_CRF];
		default:
			return [];
	}
}

/** Decode one frame and re-encode to `format`, keeping alpha where the target supports it. */
function ffmpegConvertArgs(source: string, target: string, format: ImageFormat, avifEncoder: string | null): readonly string[] {
	const args = ["-y", ...ffmpegImageInput(source), "-i", source, "-frames:v", "1"];
	if (format === "jpeg") args.push("-pix_fmt", "yuvj420p");
	else if (format === "png" || format === "webp") args.push("-pix_fmt", "rgba");
	else if (format === "gif") args.push("-vf", GIF_PALETTE_FILTER);
	args.push(...ffmpegQualityArgs(format, avifEncoder), ...ffmpegImageOutput(format), target);
	return args;
}

/** Fit inside a `maxEdge` box without enlarging, preserving aspect ratio. */
function ffmpegResizeArgs(
	source: string,
	target: string,
	maxEdge: number,
	format: ImageFormat,
	avifEncoder: string | null,
): readonly string[] {
	const filter = `scale='min(iw,${maxEdge})':'min(ih,${maxEdge})':force_original_aspect_ratio=decrease`;
	const args = ["-y", ...ffmpegImageInput(source), "-i", source, "-frames:v", "1", "-vf", filter];
	args.push(...ffmpegQualityArgs(format, avifEncoder), ...ffmpegImageOutput(format), target);
	return args;
}

/** Re-encode an image for `level`: PNG uses perceptual palette quantization + mixed-filter deflate at all 3 levels. */
function ffmpegReduceImageArgs(
	source: string,
	target: string,
	format: ImageFormat,
	level: ReductionLevel,
	avifEncoder: string | null,
): readonly string[] {
	const spec = LEVEL_SPECS[level];
	const args = ["-y", ...ffmpegImageInput(source), "-i", source, "-frames:v", "1"];
	if (format === "png") {
		const scalePrefix =
			spec.imageMaxEdge === null || level === "light"
				? ""
				: `scale='min(iw,${spec.imageMaxEdge})':'min(ih,${spec.imageMaxEdge})':force_original_aspect_ratio=decrease,`;
		const filter = `${scalePrefix}split[a][b];[a]palettegen=max_colors=${spec.pngPaletteColors}:stats_mode=single:reserve_transparent=1[p];[b][p]paletteuse=dither=${spec.pngDither}`;
		args.push("-vf", filter, "-compression_level", "9", "-pred", "mixed", ...ffmpegImageOutput("png"), target);
		return args;
	}
	if (spec.imageMaxEdge !== null) {
		args.push("-vf", `scale='min(iw,${spec.imageMaxEdge})':'min(ih,${spec.imageMaxEdge})':force_original_aspect_ratio=decrease`);
	}
	if (format === "webp") {
		args.push("-c:v", "libwebp", "-quality", spec.ffmpegWebpQuality, target);
		return args;
	}
	if (format === "jpeg") args.push("-q:v", spec.ffmpegJpegQ);
	else if (format === "heic") args.push("-crf", spec.ffmpegHeicCrf);
	else args.push(...ffmpegQualityArgs(format, avifEncoder));
	args.push(...ffmpegImageOutput(format), target);
	return args;
}

/** The video encoders a container is reduced with: WebM takes VP9 + Opus, the rest H.264 + AAC. */
function videoReduceCodecs(extension: string): { readonly video: string; readonly audio: string } {
	return extension === "webm" ? { video: "libvpx-vp9", audio: "libopus" } : { video: "libx264", audio: "aac" };
}

function ffmpegReduceVideoArgs(
	source: string,
	target: string,
	extension: string,
	level: ReductionLevel,
	media: MediaHeaderInfo | null,
	reportProgress = false,
): readonly string[] {
	const spec = LEVEL_SPECS[level];
	const { video, audio } = videoReduceCodecs(extension);
	const args = ["-y", ...(reportProgress ? ["-progress", "pipe:1", "-nostats"] : []), "-i", source, "-map", "0:v:0", "-map", "0:a?", "-c:v", video];
	const scale =
		spec.videoMaxEdge === null
			? "scale=trunc(iw/2)*2:trunc(ih/2)*2"
			: `scale='min(iw,${spec.videoMaxEdge})':'min(ih,${spec.videoMaxEdge})':force_original_aspect_ratio=decrease:force_divisible_by=2`;
	args.push("-vf", scale, "-pix_fmt", "yuv420p");
	if (video === "libvpx-vp9") args.push("-crf", spec.vp9Crf, "-b:v", "0");
	else args.push("-crf", spec.x264Crf, "-preset", "faster");

	const srcVideoKbps =
		media?.videoKbps ??
		(media?.totalKbps !== null && media?.totalKbps !== undefined
			? Math.max(120, media.totalKbps - (media.audioKbps ?? 128))
			: null);
	if (srcVideoKbps !== null && srcVideoKbps > 0) {
		const maxrate = Math.max(96, Math.round(srcVideoKbps * spec.videoBitrateRatio));
		args.push("-maxrate", `${maxrate}k`, "-bufsize", `${maxrate * 2}k`);
	}

	const baseAudioKbps = audio === "libopus" ? spec.videoOpusKbps : spec.videoAudioKbps;
	const audioKbps =
		media?.audioKbps !== null && media?.audioKbps !== undefined
			? Math.min(baseAudioKbps, Math.max(32, Math.round(media.audioKbps * (level === "light" ? 0.85 : level === "balanced" ? 0.7 : 0.55))))
			: baseAudioKbps;
	args.push("-c:a", audio, "-b:a", `${audioKbps}k`, "-map_metadata", "0");
	if (FASTSTART_EXTENSIONS.includes(extension)) args.push("-movflags", "+faststart");
	args.push(target);
	return args;
}

function ffmpegReduceAudioArgs(
	source: string,
	target: string,
	extension: string,
	level: ReductionLevel,
	media: MediaHeaderInfo | null,
	reportProgress = false,
): readonly string[] {
	const spec = LEVEL_SPECS[level];
	const codec = AUDIO_ENCODERS[extension] ?? "aac";
	const args = ["-y", ...(reportProgress ? ["-progress", "pipe:1", "-nostats"] : []), "-i", source, "-map", "0:a:0"];
	if (AUDIO_WITH_COVER.includes(extension)) args.push("-map", "0:v:0?", "-c:v", "copy");
	if (extension === "m4a") args.push("-disposition:v:0", "attached_pic");
	const defaultKbps = codec === "libopus" ? spec.opusKbps : spec.audioKbps;
	const srcKbps = media?.audioKbps ?? media?.totalKbps ?? null;
	const floorKbps = codec === "libopus" ? 24 : 40;
	const targetKbps =
		srcKbps !== null && srcKbps > 0
			? Math.min(defaultKbps, Math.max(floorKbps, Math.floor(srcKbps * spec.audioBitrateRatio)))
			: defaultKbps;
	args.push("-c:a", codec, "-b:a", `${targetKbps}k`, "-map_metadata", "0", target);
	return args;
}

/** Parses ffmpeg's `Duration: HH:MM:SS.xx` header and `out_time_us=...` lines into monotonic 1–99% steps. */
function createFfmpegProgressTracker(emit: (percent: number) => void): {
	readonly onStdout: (chunk: string) => void;
	readonly onStderr: (chunk: string) => void;
} {
	let durationUs: number | null = null;
	let lastPercent = 0;
	let stderrTail = "";
	let stdoutTail = "";
	return {
		onStderr(chunk) {
			if (durationUs !== null) return;
			stderrTail = (stderrTail + chunk).slice(-2048);
			const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderrTail);
			if (match === null) return;
			const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
			if (Number.isFinite(seconds) && seconds > 0) durationUs = seconds * 1_000_000;
		},
		onStdout(chunk) {
			if (durationUs === null) return;
			const combined = stdoutTail + chunk;
			const lines = combined.split(/\r?\n/);
			stdoutTail = lines.pop() ?? "";
			for (const line of lines) {
				const match = /^out_time_us=(\d+)$/.exec(line.trim());
				if (match === null) continue;
				const currentUs = Number(match[1]);
				const percent = Math.min(99, Math.max(1, Math.floor((currentUs / durationUs) * 100)));
				if (percent > lastPercent) {
					lastPercent = percent;
					emit(percent);
				}
			}
		},
	};
}

/**
 * Re-encodes `/DCTDecode` JPEG image XObjects inside a PDF at the level's target
 * resolution and quality, then writes PDF 1.5 object streams (which also shrinks
 * digital text-only PDFs with uncompressed xref/indirect objects).
 */
async function recompressPdfStreams(
	source: string,
	output: string,
	staging: string,
	level: ReductionLevel,
	reencodeJpeg: (input: string, output: string, maxEdge: number, sipsQuality: string, ffmpegQ: string) => Promise<void>,
): Promise<void> {
	const spec = LEVEL_SPECS[level];
	const fallbackLevel = STEP_DOWN_LEVEL[level];
	const fallbackSpec = fallbackLevel === null ? null : LEVEL_SPECS[fallbackLevel];
	const bytes = await readFile(source);
	const doc = await PDFDocument.load(bytes, { updateMetadata: false });
	let index = 0;
	for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
		if (!(obj instanceof PDFRawStream)) continue;
		const filter = obj.dict.get(PDFName.of("Filter"))?.toString();
		if (filter === "/FlateDecode") {
			try {
				const raw = unzlibSync(obj.contents);
				const tighter = zlibSync(raw, { level: 9 });
				if (tighter.byteLength < obj.contents.byteLength) {
					doc.context.assign(ref, PDFRawStream.of(obj.dict, tighter));
				}
			} catch {
				// Predictor-encoded or non-standard Flate stream: leave untouched.
			}
			continue;
		}
		if (obj.dict.get(PDFName.of("Subtype"))?.toString() !== "/Image") continue;
		const colorSpace = obj.dict.get(PDFName.of("ColorSpace"))?.toString();
		const smask = obj.dict.get(PDFName.of("SMask"));
		if (filter !== "/DCTDecode" || smask !== undefined || colorSpace === "/DeviceCMYK") continue;
		const inPath = join(staging, `pdf-img-${index}.jpg`);
		const outPath = join(staging, `pdf-img-${index}-out.jpg`);
		index += 1;
		await writeFile(inPath, obj.contents);
		try {
			await reencodeJpeg(inPath, outPath, spec.pdfMaxEdge, spec.pdfJpegQuality, spec.pdfFfmpegQ);
			let next = await readFile(outPath);
			if (fallbackSpec !== null && next.byteLength > obj.contents.byteLength * 0.88) {
				await reencodeJpeg(inPath, outPath, fallbackSpec.pdfMaxEdge, fallbackSpec.pdfJpegQuality, fallbackSpec.pdfFfmpegQ).catch(() => undefined);
				const stepped = await readFile(outPath);
				if (stepped.byteLength < next.byteLength) next = stepped;
			}
			if (next.byteLength < obj.contents.byteLength) {
				const dims = jpegDimensions(next);
				if (dims !== null) {
					obj.dict.set(PDFName.of("Width"), PDFNumber.of(dims.width));
					obj.dict.set(PDFName.of("Height"), PDFNumber.of(dims.height));
				}
				doc.context.assign(ref, PDFRawStream.of(obj.dict, new Uint8Array(next)));
			}
		} catch {
			// Leave any unreadable embedded stream untouched.
		}
	}
	const saved = await doc.save({ useObjectStreams: true });
	if (saved.byteLength < bytes.byteLength) await writeFile(output, saved);
}

/**
 * Whether a PNG or WebP holds an animation, which a one-frame re-encode would
 * flatten. PNG: an `acTL` chunk before the first `IDAT`; WebP: the VP8X
 * animation flag.
 */
async function isAnimatedImage(path: string): Promise<boolean> {
	const extension = extensionOfName(path);
	if (extension !== "png" && extension !== "webp") return false;
	const handle = await open(path, "r");
	try {
		if (extension === "webp") {
			const head = Buffer.alloc(32);
			const { bytesRead } = await handle.read(head, 0, 32, 0);
			return bytesRead >= 21 && head.toString("latin1", 12, 16) === "VP8X" && ((head[20] ?? 0) & 0x02) !== 0;
		}
		const chunkHead = Buffer.alloc(8);
		let offset = 8;
		for (let chunks = 0; chunks < 64; chunks += 1) {
			const { bytesRead } = await handle.read(chunkHead, 0, 8, offset);
			if (bytesRead < 8) return false;
			const type = chunkHead.toString("latin1", 4, 8);
			if (type === "acTL") return true;
			if (type === "IDAT" || type === "IEND") return false;
			offset += 12 + chunkHead.readUInt32BE(0);
		}
		return false;
	} finally {
		await handle.close();
	}
}

/** What the ffmpeg image backend can write, and the AV1 encoder AVIF uses when it can. */
interface FfmpegImageProbe {
	readonly formats: readonly ImageFormat[];
	readonly avifEncoder: string | null;
	/** Every encoder `ffmpeg -encoders` lists; size reduction needs x264, VP9, AAC, MP3 and Opus ones. */
	readonly encoders: ReadonlySet<string>;
}

function ffmpegRemuxArgs(source: string, target: string): readonly string[] {
	return ["-y", "-i", source, "-c", "copy", target];
}

export function createActionService(deps: ActionServiceDeps): ActionService {
	const platform = deps.platform ?? process.platform;
	const run = deps.run ?? defaultRun;
	const share = deps.share ?? null;
	const archiveLimits = deps.archiveLimits ?? DEFAULT_ARCHIVE_LIMITS;
	const pdf = deps.pdf ?? null;
	const trash = deps.trash ?? ((target: string) => rm(target, { force: true }));
	/** Memoized ffmpeg probe: one `ffmpeg -version` per session, at most. */
	let ffmpeg: Promise<boolean> | null = null;
	/** Memoized image-encoder probe: one `-encoders` / `-muxers` pass per session. */
	let ffmpegImageProbe: Promise<FfmpegImageProbe> | null = null;
	/** Memoized `sips --formats` probe: one listing per session. */
	let sipsWritable: Promise<readonly ImageFormat[]> | null = null;

	function hasFfmpeg(): Promise<boolean> {
		ffmpeg ??= run("ffmpeg", ["-version"], { timeoutMs: 5000 }).then(
			() => true,
			() => false,
		);
		return ffmpeg;
	}

	/**
	 * The image formats this machine's ffmpeg can write, read once from its
	 * encoder list (and the heif/avif muxers for HEIC/AVIF). A machine without
	 * ffmpeg — or a build missing an encoder — simply does not expose that format.
	 */
	function probeFfmpegImages(): Promise<FfmpegImageProbe> {
		ffmpegImageProbe ??= (async () => {
			try {
				const [encoders, muxers] = await Promise.all([
					run("ffmpeg", ["-hide_banner", "-encoders"], { timeoutMs: 5000 }),
					run("ffmpeg", ["-hide_banner", "-muxers"], { timeoutMs: 5000 }),
				]);
				const encoderNames = parseEncoderNames(encoders.stdout);
				const muxerNames = parseMuxerNames(muxers.stdout);
				const formats = new Set(
					FFMPEG_IMAGE_ENCODERS.filter((spec) => spec.encoders.some((name) => encoderNames.has(name))).map(
						(spec) => spec.format,
					),
				);
				if (encoderNames.has(HEIC_ENCODER) && muxerNames.has(HEIC_MUXER)) formats.add("heic");
				const avifEncoder = muxerNames.has(AVIF_MUXER)
					? (AVIF_ENCODERS.find((name) => encoderNames.has(name)) ?? null)
					: null;
				if (avifEncoder !== null) formats.add("avif");
				return { formats: IMAGE_FORMAT_ORDER.filter((format) => formats.has(format)), avifEncoder, encoders: encoderNames };
			} catch {
				return { formats: [], avifEncoder: null, encoders: new Set() };
			}
		})();
		return ffmpegImageProbe;
	}

	/** The formats this macOS's sips writes; an unreadable listing falls back to the long-standing set. */
	function probeSips(): Promise<readonly ImageFormat[]> {
		sipsWritable ??= run("sips", ["--formats"], { timeoutMs: 5000 }).then(
			({ stdout }) => {
				const writable = parseSipsWritable(stdout);
				return SIPS_CANDIDATES.filter((format) => writable.has(format));
			},
			() => SIPS_BASELINE,
		);
		return sipsWritable;
	}

	async function imageTargets(): Promise<readonly ImageFormat[]> {
		if (platform !== "darwin") return (await probeFfmpegImages()).formats;
		// sips writes everything but WebP; WebP needs an ffmpeg build that lists a WebP encoder.
		const [native, ffmpegFormats] = await Promise.all([probeSips(), probeFfmpegImages()]);
		const formats = new Set(native);
		if (ffmpegFormats.formats.includes("webp")) formats.add("webp");
		return IMAGE_FORMAT_ORDER.filter((format) => formats.has(format));
	}

	async function convertImage(source: string, format: ImageFormat): Promise<string> {
		const target = await uniqueChild(dirname(source), `${stemOf(source)}.${FORMAT_EXTENSIONS[format]}`);
		if (platform === "darwin" && format !== "webp") await run("sips", sipsConvertArgs(source, target, format));
		else if (platform === "darwin") await run("ffmpeg", ffmpegWebpArgs(source, target));
		else await run("ffmpeg", ffmpegConvertArgs(source, target, format, (await probeFfmpegImages()).avifEncoder));
		return target;
	}

	async function resizeImage(source: string, maxEdge: number): Promise<string> {
		const format = imageFormatOf(source);
		// Both engines decode one frame, so resizing a GIF would drop its animation.
		if (format === null || format === "gif") throw new Error(t("main.action.unsupportedResize"));
		const probe = platform === "darwin" ? null : await probeFfmpegImages();
		const encodable = probe === null ? await probeSips() : probe.formats;
		if (!encodable.includes(format)) throw new Error(t("main.action.unsupportedResize"));
		const target = await uniqueChild(dirname(source), `${stemOf(source)}-${maxEdge}${extname(source)}`);
		if (probe === null) await run("sips", sipsResizeArgs(source, target, maxEdge));
		else await run("ffmpeg", ffmpegResizeArgs(source, target, maxEdge, format, probe.avifEncoder));
		return target;
	}

	/** The extensions `reduceSize` can shrink on this machine, in the order the shared table lists them. */
	async function reducibleExtensions(): Promise<readonly string[]> {
		const probe = await probeFfmpegImages();
		const stills = platform === "darwin" ? await probeSips() : probe.formats;
		const can = new Set<string>();
		if (pdf !== null && (await pdf.available())) can.add("pdf");
		if (stills.includes("jpeg")) for (const extension of ["jpg", "jpeg"]) can.add(extension);
		if (stills.includes("heic")) for (const extension of ["heic", "heif"]) can.add(extension);
		// PNG's lossless deflate and WebP's encoder only exist in ffmpeg, on every platform.
		if (probe.formats.includes("png")) can.add("png");
		if (probe.formats.includes("webp")) can.add("webp");
		for (const extension of REDUCIBLE_EXTENSIONS) {
			const kind = reductionKindOf(`x.${extension}`);
			if (kind === "video" && probe.encoders.has(videoReduceCodecs(extension).video) && probe.encoders.has(videoReduceCodecs(extension).audio)) can.add(extension);
			if (kind === "audio" && probe.encoders.has(AUDIO_ENCODERS[extension] ?? "")) can.add(extension);
		}
		return REDUCIBLE_EXTENSIONS.filter((extension) => can.has(extension));
	}

	/** Drops a result that is not smaller than the original, so a reduction never leaves a bigger copy. */
	async function keepIfSmaller(source: string, target: string): Promise<{ readonly before: number; readonly after: number }> {
		const [before, after] = [(await lstat(source)).size, (await lstat(target)).size];
		if (after >= before) {
			await rm(target, { force: true });
			throw new Error(t("main.action.alreadyOptimized"));
		}
		return { before, after };
	}

	const running = new Map<string, AbortController>();

	async function probeMedia(source: string, staging: string, beforeSize: number, signal: AbortSignal): Promise<MediaHeaderInfo | null> {
		try {
			const probeOut = join(staging, "probe.null");
			const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", source, "-t", "0", "-f", "null", probeOut], {
				signal,
				timeoutMs: 10_000,
			});
			const parsed = parseMediaHeader(stderr, beforeSize);
			return parsed.durationSec === null && parsed.videoKbps === null && parsed.audioKbps === null ? null : parsed;
		} catch {
			return null;
		}
	}

	async function reencodePdfJpeg(
		input: string,
		output: string,
		maxEdge: number,
		sipsQuality: string,
		ffmpegQ: string,
		signal: AbortSignal,
	): Promise<void> {
		const ffmpegProbe = await probeFfmpegImages();
		if (ffmpegProbe.formats.includes("jpeg")) {
			await run(
				"ffmpeg",
				[
					"-y",
					...ffmpegImageInput(input),
					"-i",
					input,
					"-frames:v",
					"1",
					"-vf",
					`scale='min(iw,${maxEdge})':'min(ih,${maxEdge})':force_original_aspect_ratio=decrease`,
					"-q:v",
					ffmpegQ,
					"-update",
					"1",
					output,
				],
				{ signal },
			);
			return;
		}
		const dims = jpegDimensions(await readFile(input));
		const cap = dims !== null && Math.max(dims.width, dims.height) > maxEdge ? maxEdge : null;
		await run("sips", sipsReduceArgs(input, output, "jpeg", sipsQuality, cap), { signal });
	}

	async function pickSmallestExisting(candidates: readonly string[]): Promise<string | null> {
		let best: { path: string; size: number } | null = null;
		for (const candidate of candidates) {
			if (!(await pathExists(candidate))) continue;
			const size = (await lstat(candidate)).size;
			if (size > 0 && (best === null || size < best.size)) best = { path: candidate, size };
		}
		return best?.path ?? null;
	}

	async function reducePdfInto(source: string, staging: string, level: ReductionLevel, beforeSize: number, signal: AbortSignal): Promise<string> {
		if (pdf === null) throw new Error(t("main.action.unsupportedReduce"));
		const reencode = (inPath: string, outPath: string, edge: number, sipsQ: string, ffQ: string): Promise<void> =>
			reencodePdfJpeg(inPath, outPath, edge, sipsQ, ffQ, signal);

		if (level === "light") {
			const gentle = join(staging, "light.pdf");
			await recompressPdfStreams(source, gentle, staging, "light", reencode).catch(() => undefined);
			// Only settle for `gentle` alone when it genuinely shrunk (>= 15%); otherwise also consult Filee.
			if ((await pathExists(gentle)) && (await lstat(gentle)).size <= beforeSize * 0.85) return gentle;
			const fileeDir = join(staging, "filee");
			await mkdir(fileeDir, { recursive: true });
			const fromFilee = await pdf.reduce(source, fileeDir, signal);
			return (await pickSmallestExisting([gentle, fromFilee])) ?? fromFilee;
		}

		const fileeDir = join(staging, "filee");
		await mkdir(fileeDir, { recursive: true });
		const fromFilee = await pdf.reduce(source, fileeDir, signal);
		const refined = join(staging, `${level}.pdf`);
		const baseForStreamPass = (await lstat(fromFilee)).size < beforeSize ? fromFilee : source;
		await recompressPdfStreams(baseForStreamPass, refined, staging, level, reencode).catch(() => undefined);
		return (await pickSmallestExisting([refined, fromFilee])) ?? fromFilee;
	}

	async function encodeStillImage(
		source: string,
		stagedTarget: string,
		format: ImageFormat,
		level: ReductionLevel,
		signal: AbortSignal,
	): Promise<void> {
		const probe = await probeFfmpegImages();
		const useFfmpeg =
			format === "png" ||
			format === "webp" ||
			(format === "jpeg" && probe.formats.includes("jpeg")) ||
			platform !== "darwin";
		if (!useFfmpeg) {
			const spec = LEVEL_SPECS[level];
			const dims = format === "jpeg" && spec.imageMaxEdge !== null ? jpegDimensions(await readFile(source)) : null;
			const cap =
				spec.imageMaxEdge !== null && dims !== null && Math.max(dims.width, dims.height) > spec.imageMaxEdge
					? spec.imageMaxEdge
					: null;
			await run("sips", sipsReduceArgs(source, stagedTarget, format, spec.sipsQuality, cap), { signal });
			return;
		}
		await run("ffmpeg", ffmpegReduceImageArgs(source, stagedTarget, format, level, probe.avifEncoder), { signal });
	}

	async function reduceMediaInto(
		source: string,
		extension: string,
		stagedTarget: string,
		staging: string,
		beforeSize: number,
		level: ReductionLevel,
		signal: AbortSignal,
		emitProgress: ((percent: number) => void) | null,
	): Promise<void> {
		const kind = reductionKindOf(source);
		if (kind === "video") {
			const media = await probeMedia(source, staging, beforeSize, signal);
			const tracker = emitProgress === null ? undefined : createFfmpegProgressTracker(emitProgress);
			await run("ffmpeg", ffmpegReduceVideoArgs(source, stagedTarget, extension, level, media, emitProgress !== null), {
				signal,
				timeoutMs: 60 * 60 * 1000,
				...(tracker === undefined ? {} : tracker),
			});
			return;
		}
		if (kind === "audio") {
			const media = await probeMedia(source, staging, beforeSize, signal);
			const tracker = emitProgress === null ? undefined : createFfmpegProgressTracker(emitProgress);
			await run("ffmpeg", ffmpegReduceAudioArgs(source, stagedTarget, extension, level, media, emitProgress !== null), {
				signal,
				...(tracker === undefined ? {} : tracker),
			});
			return;
		}
		const format = imageFormatOf(source);
		if (format === null) throw new Error(t("main.action.unsupportedReduce"));
		await encodeStillImage(source, stagedTarget, format, level, signal);
		// Adaptive step-down: when a JPEG/WebP/HEIC/PNG was already moderately compressed so
		// `light` (or `balanced`) shaved <12%, step down once so the user gets a real reduction.
		const nextLevel = STEP_DOWN_LEVEL[level];
		if (nextLevel !== null && (await pathExists(stagedTarget)) && (await lstat(stagedTarget)).size > beforeSize * 0.88) {
			const stepped = join(staging, `stepped-${basename(stagedTarget)}`);
			await encodeStillImage(source, stepped, format, nextLevel, signal).catch(() => undefined);
			if ((await pathExists(stepped)) && (await lstat(stepped)).size < (await lstat(stagedTarget)).size) {
				await rename(stepped, stagedTarget);
			}
		}
	}

	/**
	 * Same format, fewer bytes: either replaces `source` in place (moving the
	 * original safely to the Trash) or writes one `<stem>-reduced.<ext>` sibling
	 * (recycling any prior `-reduced` copy through the Trash so `-reduced 2 .. 8`
	 * clutter never accumulates).
	 */
	async function reduceSize(
		source: string,
		options: { readonly level?: ReductionLevel; readonly replaceOriginal?: boolean; readonly id?: string },
		window: BrowserWindow | null,
	): Promise<ActionOutcome> {
		const { id, level = "balanced", replaceOriginal = false } = options;
		const name = basename(source);
		const controller = new AbortController();
		if (id !== undefined) running.set(id, controller);
		const { signal } = controller;
		const throwIfCancelled = (): void => {
			if (signal.aborted) throw new Error(t("main.action.reduceCancelled", { name }));
		};
		let staging: string | null = null;
		try {
			const extension = extensionOfName(source);
			if (!(await reducibleExtensions()).includes(extension)) throw new Error(t("main.action.unsupportedReduce"));
			throwIfCancelled();
			if (await isAnimatedImage(source)) throw new Error(t("main.action.animatedReduce"));
			throwIfCancelled();
			const beforeSize = (await lstat(source)).size;
			const directory = dirname(source);
			const copyName = reducedCopyName(name);
			staging = await mkdtemp(join(directory, REDUCE_STAGING_PREFIX));
			throwIfCancelled();

			let produced: string;
			if (extension === "pdf") {
				produced = await reducePdfInto(source, staging, level, beforeSize, signal);
			} else {
				produced = join(staging, copyName);
				const emit =
					id !== undefined && deps.onProgress !== undefined
						? (percent: number): void => deps.onProgress?.({ id, percent }, window)
						: null;
				await reduceMediaInto(source, extension, produced, staging, beforeSize, level, signal, emit);
			}
			throwIfCancelled();
			const { before, after } = await keepIfSmaller(source, produced);
			const percent = Math.floor((1 - after / before) * 100);

			if (replaceOriginal) {
				await trash(source);
				await rename(produced, source);
				return {
					output: source,
					note: t("main.action.reducedReplaced", {
						name,
						before: formatByteSize(before),
						after: formatByteSize(after),
						percent,
					}),
				};
			}

			const desired = join(directory, copyName);
			let target: string;
			if (desired === source) {
				target = await uniqueChild(directory, copyName);
			} else {
				if (await pathExists(desired)) await trash(desired);
				target = desired;
			}
			await rename(produced, target);
			return {
				output: target,
				note: t("main.action.reduced", {
					name: basename(target),
					before: formatByteSize(before),
					after: formatByteSize(after),
					percent,
				}),
			};
		} catch (error) {
			if (signal.aborted) throw new Error(t("main.action.reduceCancelled", { name }));
			throw error;
		} finally {
			if (id !== undefined) running.delete(id);
			if (staging !== null) await rm(staging, { recursive: true, force: true });
		}
	}

	/**
	 * The registered handlers for `path`, default first, each application once.
	 * Only macOS exposes this; a failed lookup degrades to "no suggestions" so
	 * the chooser stays reachable.
	 */
	async function registeredApplications(path: string): Promise<readonly { readonly path: string; readonly isDefault: boolean }[]> {
		if (platform !== "darwin") return [];
		let stdout: string;
		try {
			({ stdout } = await run("osascript", ["-l", "JavaScript", "-e", OPEN_WITH_SCRIPT, path], {
				timeoutMs: OPEN_WITH_TIMEOUT_MS,
			}));
		} catch {
			return [];
		}
		const listing = parseOpenWithListing(stdout);
		if (listing === null) return [];
		const ordered = listing.defaultPath === null ? listing.paths : [listing.defaultPath, ...listing.paths];
		return [...new Set(ordered)].map((application) => ({ path: application, isDefault: application === listing.defaultPath }));
	}

	const iconCache = new Map<string, Promise<string | null>>();
	function iconFor(applicationPath: string): Promise<string | null> {
		const read = deps.applicationIcon;
		if (read === undefined) return Promise.resolve(null);
		let icon = iconCache.get(applicationPath);
		if (icon === undefined) {
			icon = read(applicationPath).catch(() => null);
			iconCache.set(applicationPath, icon);
		}
		return icon;
	}

	/**
	 * Extract `source` into a new Finder-style item next to it. The archive
	 * writes into a hidden staging directory beside the destination, so a failed
	 * run (hostile entry, corruption, bomb) removes the staging and leaves no
	 * half-written folder behind; a successful one is flattened and renamed into
	 * place. A bare `.gz` may hold a tar (a folder) or a single file (the file
	 * itself, named after the archive without `.gz`).
	 */
	async function extractArchive(source: string): Promise<string> {
		const match = archiveFormatOf(basename(source));
		if (match === null) throw new ArchiveError(t("main.action.unsupportedExtract"));
		const directory = dirname(source);
		const staging = await mkdtemp(join(directory, `.${match.stem}-`));
		try {
			if (match.format === "gz") {
				const kind = await extractGzipInto(source, staging, match.stem, archiveLimits);
				if (kind === "file") {
					const target = await uniqueChild(directory, match.stem);
					await rename(join(staging, match.stem), target);
					return target;
				}
			} else {
				await extractIntoFolder(source, match.format, staging, archiveLimits);
			}
			const extracted = await flattenWrapper(staging, match.stem);
			const target = await uniqueChild(directory, match.stem);
			await rename(extracted, target);
			// Renamed out of the staging folder, a lone wrapper leaves the (now empty) staging folder behind.
			if (extracted !== staging) await rm(staging, { recursive: true, force: true });
			return target;
		} catch (error) {
			await rm(staging, { recursive: true, force: true });
			throw error;
		}
	}

	return {
		async capabilities(): Promise<ActionCapabilities> {
			const ffmpegPresent = await hasFfmpeg();
			return {
				openWith: true,
				share: platform === "darwin" && share !== null,
				archive: true,
				imageFormats: await imageTargets(),
				videoContainers: ffmpegPresent ? VIDEO_CONTAINERS : [],
				reducibleExtensions: await reducibleExtensions(),
			};
		},

		async openWithApplications(path: string): Promise<readonly OpenWithApplication[]> {
			const registered = await registeredApplications(path);
			return Promise.all(
				registered.map(
					async (application): Promise<OpenWithApplication> => ({
						path: application.path,
						name: applicationName(application.path),
						isDefault: application.isDefault,
						icon: await iconFor(application.path),
					}),
				),
			);
		},

		async run(paths: readonly string[], request: ActionRequest, window: BrowserWindow | null): Promise<ActionOutcome> {
			const [first] = paths;
			if (first === undefined) throw new Error(t("main.action.emptyTarget"));
			// The edit conversions and extraction are single-target; the menu and
			// the Inspector only ever send them one path, and the archive keeps
			// that promise at the boundary too.
			const sole = (): string => {
				if (paths.length !== 1) throw new Error(t("main.action.singleTargetOnly"));
				return first;
			};
			switch (request.kind) {
				case "openWith": {
					let application: string | null;
					if (request.application === null) {
						application = await deps.applications.pick(window);
						if (application === null) return { output: null, note: t("main.action.openCancelled") };
					} else {
						// A named application must be one the OS offered for this file;
						// anything else goes through the chooser, never straight to exec.
						application = request.application;
						if (!(await registeredApplications(first)).some((candidate) => candidate.path === application)) {
							throw new Error(t("main.action.appCannotOpen"));
						}
					}
					if (platform === "darwin") await run("open", ["-a", application, ...paths]);
					else await run(application, [...paths]);
					return {
						output: null,
						note:
							paths.length === 1
								? t("main.action.openedWithFile", { name: basename(first), app: applicationName(application) })
								: t("main.action.openedWithCount", { count: paths.length, app: applicationName(application) }),
					};
				}
				case "compress": {
					// Finder's rule: one archive per Compress — named after the sole
					// target, or "Archive" when the selection spans several.
					const format = request.format ?? "zip";
					const stem = paths.length === 1 ? basename(first) : "Archive";
					const target = await uniqueChild(dirname(first), `${stem}.${format}`);
					const members: ArchiveMember[] = [];
					for (const path of paths) {
						const stat = await lstat(path);
						members.push(...(await archiveMembers(path, stat.isDirectory())));
					}
					await (format === "7z" ? writeSevenZip(target, members) : writeZip(target, members));
					return { output: target, note: t("main.action.compressed", { name: basename(target) }) };
				}
				case "extract": {
					const output = await extractArchive(sole());
					return { output, note: t("main.action.extracted", { name: basename(output) }) };
				}
				case "convertImage": {
					if (!(await imageTargets()).includes(request.format)) {
						throw new Error(t("main.action.unsupportedConvert", { format: request.format.toUpperCase() }));
					}
					const output = await convertImage(sole(), request.format);
					return { output, note: t("main.action.converted", { name: basename(output) }) };
				}
				case "resizeImage": {
					const output = await resizeImage(sole(), request.maxEdge);
					return { output, note: t("main.action.resized", { name: basename(output) }) };
				}
				case "reduceSize":
					return reduceSize(
						sole(),
						{
							...(request.level === undefined ? {} : { level: request.level }),
							...(request.replaceOriginal === undefined ? {} : { replaceOriginal: request.replaceOriginal }),
							...(request.id === undefined ? {} : { id: request.id }),
						},
						window,
					);
				case "convertVideo": {
					if (!(await hasFfmpeg())) throw new Error(t("main.action.videoNeedsFfmpeg"));
					const path = sole();
					const target = await uniqueChild(dirname(path), `${stemOf(path)}.${request.container}`);
					await run("ffmpeg", ffmpegRemuxArgs(path, target));
					return { output: target, note: t("main.action.containerConverted", { name: basename(target) }) };
				}
			}
		},

		async cancel(id: string): Promise<void> {
			running.get(id)?.abort();
		},

		async share(paths: readonly string[], anchor: ActionAnchor, window: BrowserWindow | null): Promise<void> {
			if (paths.length === 0) throw new Error(t("main.action.emptyTarget"));
			if (platform !== "darwin" || share === null) {
				throw new Error(t("main.action.shareUnsupported"));
			}
			share.present(paths, anchor, window);
		},
	};
}
