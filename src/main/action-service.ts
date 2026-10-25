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

import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { finished } from "node:stream/promises";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import type { BrowserWindow } from "electron";
import { archiveFormatOf } from "../shared/archive-formats";
import { t } from "../shared/i18n/core";
import { ArchiveError } from "./archive-guard.mjs";
import { DEFAULT_ARCHIVE_LIMITS, type ArchiveLimits } from "./archive-common";
import { extractGzipInto, extractIntoFolder, flattenWrapper } from "./archive-extract";
import {
	type ActionAnchor,
	type ActionCapabilities,
	type ActionOutcome,
	type ActionRequest,
	type ImageFormat,
	type OpenWithApplication,
	type VideoContainer,
} from "../shared/actions-contract";
import { writeSevenZip } from "./sevenzip-writer";
import { errorMessage, pathExists } from "./fs-entry";

/** Result of one external command. */
export interface CommandResult {
	readonly stdout: string;
	readonly stderr: string;
}

/** Runs an external command; rejects with the program's own message on failure. */
export type CommandRunner = (
	command: string,
	args: readonly string[],
	options?: { readonly timeoutMs?: number },
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
}

/** The Inspector action surface the IPC layer registers. */
export interface ActionService {
	capabilities(): Promise<ActionCapabilities>;
	run(paths: readonly string[], request: ActionRequest, window: BrowserWindow | null): Promise<ActionOutcome>;
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
/** Lossy formats, where "optimize" actually saves bytes. */
const LOSSY_FORMATS: readonly ImageFormat[] = ["jpeg", "webp", "heic"];

export function defaultRun(
	command: string,
	args: readonly string[],
	options?: { readonly timeoutMs?: number },
): Promise<CommandResult> {
	const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
	execFile(
		command,
		[...args],
		{ timeout: options?.timeoutMs ?? COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER, windowsHide: true },
		(error, stdout, stderr) => {
			if (error !== null) {
				const detail = stderr.trim();
				reject(new Error(detail.length > 0 ? detail : errorMessage(error)));
				return;
			}
			resolve({ stdout, stderr });
		},
	);
	return promise;
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

function sipsOptimizeArgs(source: string, target: string, format: ImageFormat): readonly string[] {
	return ["-s", "format", format, "-s", "formatOptions", JPEG_QUALITY, "--out", target, source];
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

/** Re-encode for size: PNG uses maximum deflate, lossy formats re-encode at the tuning quality. */
function ffmpegOptimizeArgs(source: string, target: string, format: ImageFormat, avifEncoder: string | null): readonly string[] {
	const args = ["-y", ...ffmpegImageInput(source), "-i", source, "-frames:v", "1"];
	if (format === "png") args.push("-compression_level", "9", "-pred", "mixed");
	else args.push(...ffmpegQualityArgs(format, avifEncoder));
	args.push(...ffmpegImageOutput(format), target);
	return args;
}

/** What the ffmpeg image backend can write, and the AV1 encoder AVIF uses when it can. */
interface FfmpegImageProbe {
	readonly formats: readonly ImageFormat[];
	readonly avifEncoder: string | null;
}

function ffmpegRemuxArgs(source: string, target: string): readonly string[] {
	return ["-y", "-i", source, "-c", "copy", target];
}

export function createActionService(deps: ActionServiceDeps): ActionService {
	const platform = deps.platform ?? process.platform;
	const run = deps.run ?? defaultRun;
	const share = deps.share ?? null;
	const archiveLimits = deps.archiveLimits ?? DEFAULT_ARCHIVE_LIMITS;
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
				return { formats: IMAGE_FORMAT_ORDER.filter((format) => formats.has(format)), avifEncoder };
			} catch {
				return { formats: [], avifEncoder: null };
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

	async function optimizeImage(source: string): Promise<string> {
		const format = imageFormatOf(source);
		if (format === null) throw new Error(t("main.action.unsupportedOptimize"));
		// Optimize re-encodes lossy formats; the ffmpeg backend also deflates PNG losslessly.
		const optimizable = LOSSY_FORMATS.includes(format) || (platform !== "darwin" && format === "png");
		if (!optimizable) throw new Error(t("main.action.unsupportedOptimize"));
		const probe = platform === "darwin" ? null : await probeFfmpegImages();
		if (probe !== null && !probe.formats.includes(format)) {
			throw new Error(t("main.action.unsupportedOptimize"));
		}
		const target = await uniqueChild(dirname(source), `${stemOf(source)}-optimized${extname(source)}`);
		if (platform === "darwin" && format === "webp") await run("ffmpeg", ffmpegWebpArgs(source, target));
		else if (platform === "darwin") await run("sips", sipsOptimizeArgs(source, target, format));
		else {
			await run("ffmpeg", ffmpegOptimizeArgs(source, target, format, probe?.avifEncoder ?? null));
			// Keep the output only when it actually shrank; ffmpeg may re-encode larger.
			if ((await lstat(target)).size >= (await lstat(source)).size) {
				await rm(target, { force: true });
				throw new Error(t("main.action.alreadyOptimized"));
			}
		}
		return target;
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
			await flattenWrapper(staging, match.stem);
			const target = await uniqueChild(directory, match.stem);
			await rename(staging, target);
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
				case "optimizeImage": {
					const output = await optimizeImage(sole());
					return { output, note: t("main.action.optimized", { name: basename(output) }) };
				}
				case "convertVideo": {
					if (!(await hasFfmpeg())) throw new Error(t("main.action.videoNeedsFfmpeg"));
					const path = sole();
					const target = await uniqueChild(dirname(path), `${stemOf(path)}.${request.container}`);
					await run("ffmpeg", ffmpegRemuxArgs(path, target));
					return { output: target, note: t("main.action.containerConverted", { name: basename(target) }) };
				}
			}
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
