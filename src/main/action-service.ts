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
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { finished } from "node:stream/promises";
import { Unzip, UnzipInflate, Zip, ZipDeflate, ZipPassThrough } from "fflate";
import type { BrowserWindow } from "electron";
import {
	type ActionAnchor,
	type ActionCapabilities,
	type ActionOutcome,
	type ActionRequest,
	type ImageFormat,
	type OpenWithApplication,
	type VideoContainer,
} from "../shared/actions-contract";
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
/** sips writes these; `webp` arrives only when ffmpeg can encode it. */
const SIPS_FORMATS: readonly ImageFormat[] = ["jpeg", "png", "tiff", "heic"];
/**
 * ffmpeg image encoders that satisfy each format on the non-macOS backend. The
 * session probe keeps only the formats whose encoder is actually listed, so the
 * Inspector never offers a conversion this build cannot write.
 */
const FFMPEG_IMAGE_ENCODERS: readonly { readonly format: ImageFormat; readonly encoders: readonly string[] }[] = [
	{ format: "jpeg", encoders: ["mjpeg"] },
	{ format: "png", encoders: ["png"] },
	{ format: "webp", encoders: ["libwebp", "webp"] },
	{ format: "tiff", encoders: ["tiff"] },
];
/** HEIC needs a HEVC encoder and the heif muxer; both must be present. */
const HEIC_ENCODER = "libx265";
const HEIC_MUXER = "heif";
const VIDEO_CONTAINERS: readonly VideoContainer[] = ["mp4", "mov", "mkv"];
/** The extension written for each image format. */
const FORMAT_EXTENSIONS: Readonly<Record<ImageFormat, string>> = {
	jpeg: "jpg",
	png: "png",
	webp: "webp",
	tiff: "tiff",
	heic: "heic",
};
const EXTENSION_FORMATS: Readonly<Record<string, ImageFormat>> = {
	jpg: "jpeg",
	jpeg: "jpeg",
	png: "png",
	webp: "webp",
	tif: "tiff",
	tiff: "tiff",
	heic: "heic",
};
/** Lossy formats, where "optimize" actually saves bytes. */
const LOSSY_FORMATS: readonly ImageFormat[] = ["jpeg", "webp", "heic"];

function defaultRun(
	command: string,
	args: readonly string[],
	options?: { readonly timeoutMs?: number },
): Promise<CommandResult> {
	const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
	execFile(
		command,
		[...args],
		{ timeout: options?.timeoutMs ?? COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER },
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

/**
 * The absolute path a zip entry extracts to, and whether it is a directory.
 * Rejects absolute entries and any entry escaping `destDir` (zip-slip), so a
 * hostile archive can never write outside the chosen folder.
 */
export function zipEntryPath(destDir: string, name: string): { readonly path: string; readonly directory: boolean } {
	if (name.includes("\0")) {
		throw new Error(`압축 파일 항목 이름이 올바르지 않습니다: ${JSON.stringify(name)}`);
	}
	const normalized = name.replace(/\\/g, "/");
	if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
		throw new Error(`압축 파일에 절대 경로 항목이 있습니다: ${name}`);
	}
	const directory = normalized.endsWith("/");
	const trimmed = directory ? normalized.slice(0, -1) : normalized;
	const root = resolve(destDir);
	const target = resolve(root, trimmed);
	if (target !== root && !target.startsWith(root + sep)) {
		throw new Error(`압축 파일 항목이 대상 폴더를 벗어납니다: ${name}`);
	}
	return { path: target, directory };
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
	const name = basename(root);
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
			const entry = `${prefix}${dirent.name}`;
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

/**
 * Stream `source` into `destDir`. Entries arrive one at a time and are written
 * as they complete, so peak memory tracks the largest member; anything that
 * escapes `destDir` is refused (zip-slip) and sinks the whole extraction.
 */
async function readZip(source: string, destDir: string, stem: string): Promise<void> {
	await mkdir(destDir, { recursive: true });
	const writes: Promise<void>[] = [];
	let failure: Error | null = null;
	/** Resolve one entry, recording the first refusal instead of throwing out of the parser. */
	function resolveEntry(name: string): { readonly path: string; readonly directory: boolean } | null {
		if (failure !== null) return null;
		try {
			return zipEntryPath(destDir, name);
		} catch (error) {
			failure = error instanceof Error ? error : new Error(String(error));
			return null;
		}
	}

	/**
	 * A "Compress" archive wraps everything in one folder named after the
	 * source, which is also the destination folder's name. Stripping exactly
	 * that entry avoids double-nesting while leaving an archive with several
	 * top-level folders intact.
	 */
	const rootEntry = `${stem}/`;
	let strip: string | null = null;
	const unzipper = new Unzip((file) => {
		if (strip === null && file.name === rootEntry) strip = rootEntry;
		const name = strip !== null && file.name.startsWith(strip) ? file.name.slice(strip.length) : file.name;
		const target = name.length === 0 ? null : resolveEntry(name);
		// A refused (or root) entry is still drained, so the parser stays in sync.
		if (target === null || target.directory) {
			if (target !== null) writes.push(mkdir(target.path, { recursive: true }).then(() => undefined));
			file.ondata = () => {};
			file.start();
			return;
		}
		const chunks: Uint8Array[] = [];
		file.ondata = (error, chunk, final) => {
			if (error !== null) {
				failure = error;
				return;
			}
			chunks.push(chunk);
			if (!final) return;
			const body = Buffer.concat(chunks.map((part) => Buffer.from(part.buffer, part.byteOffset, part.byteLength)));
			writes.push(mkdir(dirname(target.path), { recursive: true }).then(() => writeFile(target.path, body)));
			chunks.length = 0;
		};
		file.start();
	});
	unzipper.register(UnzipInflate);
	for await (const chunk of createReadStream(source)) {
		unzipper.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), false);
	}
	unzipper.push(new Uint8Array(0), true);
	await Promise.all(writes);
	if (failure !== null) throw failure;
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

/** image2 (the muxer for jpg/png/tiff) also expands output patterns; the webp muxer writes literal names and rejects the flag. */
const ffmpegImageOutput = (format: ImageFormat): readonly string[] =>
	format === "jpeg" || format === "png" || format === "tiff" ? ["-update", "1"] : [];

function ffmpegWebpArgs(source: string, target: string): readonly string[] {
	return ["-y", ...ffmpegImageInput(source), "-i", source, "-c:v", "libwebp", "-quality", String(LOSSY_QUALITY), target];
}

/** Lossy quality flags for the ffmpeg image backend; lossless formats add none. */
function ffmpegQualityArgs(format: ImageFormat): readonly string[] {
	switch (format) {
		case "jpeg":
			return ["-q:v", FFMPEG_JPEG_QSCALE];
		case "heic":
			return ["-crf", FFMPEG_HEIC_CRF];
		case "webp":
			return ["-quality", String(LOSSY_QUALITY)];
		default:
			return [];
	}
}

/** Decode one frame and re-encode to `format`, keeping alpha where the target supports it. */
function ffmpegConvertArgs(source: string, target: string, format: ImageFormat): readonly string[] {
	const args = ["-y", ...ffmpegImageInput(source), "-i", source, "-frames:v", "1"];
	if (format === "jpeg") args.push("-pix_fmt", "yuvj420p");
	else if (format === "png" || format === "webp") args.push("-pix_fmt", "rgba");
	args.push(...ffmpegQualityArgs(format), ...ffmpegImageOutput(format), target);
	return args;
}

/** Fit inside a `maxEdge` box without enlarging, preserving aspect ratio. */
function ffmpegResizeArgs(source: string, target: string, maxEdge: number, format: ImageFormat): readonly string[] {
	const filter = `scale='min(iw,${maxEdge})':'min(ih,${maxEdge})':force_original_aspect_ratio=decrease`;
	const args = ["-y", ...ffmpegImageInput(source), "-i", source, "-frames:v", "1", "-vf", filter];
	args.push(...ffmpegQualityArgs(format), ...ffmpegImageOutput(format), target);
	return args;
}

/** Re-encode for size: PNG uses maximum deflate, lossy formats re-encode at the tuning quality. */
function ffmpegOptimizeArgs(source: string, target: string, format: ImageFormat): readonly string[] {
	const args = ["-y", ...ffmpegImageInput(source), "-i", source, "-frames:v", "1"];
	if (format === "png") args.push("-compression_level", "9", "-pred", "mixed");
	else args.push(...ffmpegQualityArgs(format));
	args.push(...ffmpegImageOutput(format), target);
	return args;
}

function ffmpegRemuxArgs(source: string, target: string): readonly string[] {
	return ["-y", "-i", source, "-c", "copy", target];
}

export function createActionService(deps: ActionServiceDeps): ActionService {
	const platform = deps.platform ?? process.platform;
	const run = deps.run ?? defaultRun;
	const share = deps.share ?? null;
	/** Memoized ffmpeg probe: one `ffmpeg -version` per session, at most. */
	let ffmpeg: Promise<boolean> | null = null;
	/** Memoized image-encoder probe: one `-encoders` / `-muxers` pass per session. */
	let ffmpegImageFormats: Promise<readonly ImageFormat[]> | null = null;

	function hasFfmpeg(): Promise<boolean> {
		ffmpeg ??= run("ffmpeg", ["-version"], { timeoutMs: 5000 }).then(
			() => true,
			() => false,
		);
		return ffmpeg;
	}

	/**
	 * The image formats this machine's ffmpeg can write, read once from its
	 * encoder list (and the heif muxer for HEIC). A machine without ffmpeg — or a
	 * build missing an encoder — simply does not expose that format.
	 */
	function probeImageFormats(): Promise<readonly ImageFormat[]> {
		ffmpegImageFormats ??= (async () => {
			try {
				const [encoders, muxers] = await Promise.all([
					run("ffmpeg", ["-hide_banner", "-encoders"], { timeoutMs: 5000 }),
					run("ffmpeg", ["-hide_banner", "-muxers"], { timeoutMs: 5000 }),
				]);
				const encoderNames = parseEncoderNames(encoders.stdout);
				const formats = FFMPEG_IMAGE_ENCODERS.filter((spec) =>
					spec.encoders.some((name) => encoderNames.has(name)),
				).map((spec) => spec.format);
				if (encoderNames.has(HEIC_ENCODER) && parseMuxerNames(muxers.stdout).has(HEIC_MUXER)) formats.push("heic");
				return formats;
			} catch {
				return [];
			}
		})();
		return ffmpegImageFormats;
	}

	async function imageTargets(): Promise<readonly ImageFormat[]> {
		if (platform !== "darwin") return probeImageFormats();
		return (await hasFfmpeg()) ? [...SIPS_FORMATS, "webp"] : SIPS_FORMATS;
	}

	async function convertImage(source: string, format: ImageFormat): Promise<string> {
		const target = await uniqueChild(dirname(source), `${stemOf(source)}.${FORMAT_EXTENSIONS[format]}`);
		if (platform === "darwin" && format !== "webp") await run("sips", sipsConvertArgs(source, target, format));
		else if (platform === "darwin") await run("ffmpeg", ffmpegWebpArgs(source, target));
		else await run("ffmpeg", ffmpegConvertArgs(source, target, format));
		return target;
	}

	async function resizeImage(source: string, maxEdge: number): Promise<string> {
		const format = imageFormatOf(source);
		if (format === null) throw new Error("이 형식은 크기 조절을 지원하지 않습니다");
		if (platform === "darwin" && format === "webp") {
			throw new Error("이 형식은 크기 조절을 지원하지 않습니다");
		}
		if (platform !== "darwin" && !(await probeImageFormats()).includes(format)) {
			throw new Error("이 형식은 크기 조절을 지원하지 않습니다");
		}
		const target = await uniqueChild(dirname(source), `${stemOf(source)}-${maxEdge}${extname(source)}`);
		if (platform === "darwin") await run("sips", sipsResizeArgs(source, target, maxEdge));
		else await run("ffmpeg", ffmpegResizeArgs(source, target, maxEdge, format));
		return target;
	}

	async function optimizeImage(source: string): Promise<string> {
		const format = imageFormatOf(source);
		if (format === null) throw new Error("이 형식은 용량 최적화를 지원하지 않습니다");
		if (platform === "darwin" && !LOSSY_FORMATS.includes(format)) {
			throw new Error("이 형식은 용량 최적화를 지원하지 않습니다");
		}
		if (platform !== "darwin" && !(await probeImageFormats()).includes(format)) {
			throw new Error("이 형식은 용량 최적화를 지원하지 않습니다");
		}
		const target = await uniqueChild(dirname(source), `${stemOf(source)}-optimized${extname(source)}`);
		if (platform === "darwin" && format === "webp") await run("ffmpeg", ffmpegWebpArgs(source, target));
		else if (platform === "darwin") await run("sips", sipsOptimizeArgs(source, target, format));
		else {
			await run("ffmpeg", ffmpegOptimizeArgs(source, target, format));
			// Keep the output only when it actually shrank; ffmpeg may re-encode larger.
			if ((await lstat(target)).size >= (await lstat(source)).size) {
				await rm(target, { force: true });
				throw new Error("이미 최적화된 파일입니다");
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
			if (first === undefined) throw new Error("작업 대상이 비어 있습니다");
			// The edit conversions and extraction are single-target; the menu and
			// the Inspector only ever send them one path, and the archive keeps
			// that promise at the boundary too.
			const sole = (): string => {
				if (paths.length !== 1) throw new Error("이 작업은 한 번에 하나의 항목만 지원합니다");
				return first;
			};
			switch (request.kind) {
				case "openWith": {
					let application: string | null;
					if (request.application === null) {
						application = await deps.applications.pick(window);
						if (application === null) return { output: null, note: "열기를 취소했습니다" };
					} else {
						// A named application must be one the OS offered for this file;
						// anything else goes through the chooser, never straight to exec.
						application = request.application;
						if (!(await registeredApplications(first)).some((candidate) => candidate.path === application)) {
							throw new Error("이 파일을 열 수 있는 앱이 아닙니다");
						}
					}
					if (platform === "darwin") await run("open", ["-a", application, ...paths]);
					else await run(application, [...paths]);
					return {
						output: null,
						note:
							paths.length === 1
								? `${basename(first)} — ${applicationName(application)}로 열었습니다`
								: `파일 ${paths.length}개 — ${applicationName(application)}로 열었습니다`,
					};
				}
				case "compress": {
					// Finder's rule: one archive per Compress — named after the sole
					// target, or "Archive" when the selection spans several.
					const name = paths.length === 1 ? `${basename(first)}.zip` : "Archive.zip";
					const target = await uniqueChild(dirname(first), name);
					const members: ArchiveMember[] = [];
					for (const path of paths) {
						const stat = await lstat(path);
						members.push(...(await archiveMembers(path, stat.isDirectory())));
					}
					await writeZip(target, members);
					return { output: target, note: `${basename(target)} — 압축했습니다` };
				}
				case "extract": {
					const path = sole();
					const stem = stemOf(path);
					const target = await uniqueChild(dirname(path), stem);
					await readZip(path, target, stem);
					return { output: target, note: `${basename(target)} — 압축을 풀었습니다` };
				}
				case "convertImage": {
					if (!(await imageTargets()).includes(request.format)) {
						throw new Error(`${request.format.toUpperCase()} 변환을 지원하지 않습니다`);
					}
					const output = await convertImage(sole(), request.format);
					return { output, note: `${basename(output)} — 변환했습니다` };
				}
				case "resizeImage": {
					const output = await resizeImage(sole(), request.maxEdge);
					return { output, note: `${basename(output)} — 크기를 조절했습니다` };
				}
				case "optimizeImage": {
					const output = await optimizeImage(sole());
					return { output, note: `${basename(output)} — 용량을 최적화했습니다` };
				}
				case "convertVideo": {
					if (!(await hasFfmpeg())) throw new Error("동영상 변환에는 ffmpeg가 필요합니다");
					const path = sole();
					const target = await uniqueChild(dirname(path), `${stemOf(path)}.${request.container}`);
					await run("ffmpeg", ffmpegRemuxArgs(path, target));
					return { output: target, note: `${basename(target)} — 컨테이너를 변환했습니다` };
				}
			}
		},

		async share(paths: readonly string[], anchor: ActionAnchor, window: BrowserWindow | null): Promise<void> {
			if (paths.length === 0) throw new Error("작업 대상이 비어 있습니다");
			if (platform !== "darwin" || share === null) {
				throw new Error("이 플랫폼은 시스템 공유를 지원하지 않습니다");
			}
			share.present(paths, anchor, window);
		},
	};
}
