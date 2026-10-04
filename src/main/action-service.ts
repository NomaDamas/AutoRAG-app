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
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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

/** The "Open with" chooser; injected so the service never imports `dialog`. */
export interface ApplicationPicker {
	/** The chosen application path, or null when the user cancelled. */
	pick(window: BrowserWindow | null): Promise<string | null>;
}

/** The OS share sheet; injected so the service never imports `ShareMenu`. */
export interface SharePresenter {
	present(path: string, anchor: ActionAnchor, window: BrowserWindow | null): void;
}

export interface ActionServiceDeps {
	/** Defaults to process.platform. */
	readonly platform?: NodeJS.Platform;
	readonly applications: ApplicationPicker;
	/** Absent when the platform has no share sheet. */
	readonly share?: SharePresenter | null;
	/** Defaults to spawning the command with execFile. */
	readonly run?: CommandRunner;
}

/** The Inspector action surface the IPC layer registers. */
export interface ActionService {
	capabilities(): Promise<ActionCapabilities>;
	run(path: string, request: ActionRequest, window: BrowserWindow | null): Promise<ActionOutcome>;
	share(path: string, anchor: ActionAnchor, window: BrowserWindow | null): Promise<void>;
}

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const COMMAND_MAX_BUFFER = 1 << 24;
/** Deflate level: fflate's default balance, matching zlib's tuned setting. */
const ZIP_LEVEL = 6;
/** Re-encode quality for lossy formats (sips `formatOptions`, ffmpeg `-quality`). */
const LOSSY_QUALITY = 80;
const JPEG_QUALITY = "70";
/** sips writes these; `webp` arrives only when ffmpeg can encode it. */
const SIPS_FORMATS: readonly ImageFormat[] = ["jpeg", "png", "tiff", "heic"];
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

function ffmpegWebpArgs(source: string, target: string): readonly string[] {
	return ["-y", "-i", source, "-c:v", "libwebp", "-quality", String(LOSSY_QUALITY), target];
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

	function hasFfmpeg(): Promise<boolean> {
		ffmpeg ??= run("ffmpeg", ["-version"], { timeoutMs: 5000 }).then(
			() => true,
			() => false,
		);
		return ffmpeg;
	}

	function imageTargets(ffmpegPresent: boolean): readonly ImageFormat[] {
		if (platform !== "darwin") return [];
		return ffmpegPresent ? [...SIPS_FORMATS, "webp"] : SIPS_FORMATS;
	}

	async function convertImage(source: string, format: ImageFormat): Promise<string> {
		const target = await uniqueChild(dirname(source), `${stemOf(source)}.${FORMAT_EXTENSIONS[format]}`);
		if (format === "webp") await run("ffmpeg", ffmpegWebpArgs(source, target));
		else await run("sips", sipsConvertArgs(source, target, format));
		return target;
	}

	async function resizeImage(source: string, maxEdge: number): Promise<string> {
		const format = imageFormatOf(source);
		if (format === null || format === "webp") {
			throw new Error("이 형식은 크기 조절을 지원하지 않습니다");
		}
		const target = await uniqueChild(dirname(source), `${stemOf(source)}-${maxEdge}${extname(source)}`);
		await run("sips", sipsResizeArgs(source, target, maxEdge));
		return target;
	}

	async function optimizeImage(source: string): Promise<string> {
		const format = imageFormatOf(source);
		if (format === null || !LOSSY_FORMATS.includes(format)) {
			throw new Error("이 형식은 용량 최적화를 지원하지 않습니다");
		}
		const target = await uniqueChild(dirname(source), `${stemOf(source)}-optimized${extname(source)}`);
		if (format === "webp") await run("ffmpeg", ffmpegWebpArgs(source, target));
		else await run("sips", sipsOptimizeArgs(source, target, format));
		return target;
	}

	return {
		async capabilities(): Promise<ActionCapabilities> {
			const ffmpegPresent = await hasFfmpeg();
			return {
				openWith: true,
				share: platform === "darwin" && share !== null,
				archive: true,
				imageFormats: imageTargets(ffmpegPresent),
				videoContainers: ffmpegPresent ? VIDEO_CONTAINERS : [],
			};
		},

		async run(path: string, request: ActionRequest, window: BrowserWindow | null): Promise<ActionOutcome> {
			switch (request.kind) {
				case "openWith": {
					const application = await deps.applications.pick(window);
					if (application === null) return { output: null, note: "열기를 취소했습니다" };
					if (platform === "darwin") await run("open", ["-a", application, path]);
					else await run(application, [path]);
					return { output: null, note: `${basename(path)} — ${basename(application)}로 열었습니다` };
				}
				case "compress": {
					const stat = await lstat(path);
					const target = await uniqueChild(dirname(path), `${basename(path)}.zip`);
					await writeZip(target, await archiveMembers(path, stat.isDirectory()));
					return { output: target, note: `${basename(target)} — 압축했습니다` };
				}
				case "extract": {
					const stem = stemOf(path);
					const target = await uniqueChild(dirname(path), stem);
					await readZip(path, target, stem);
					return { output: target, note: `${basename(target)} — 압축을 풀었습니다` };
				}
				case "convertImage": {
					if (!imageTargets(await hasFfmpeg()).includes(request.format)) {
						throw new Error(`${request.format.toUpperCase()} 변환을 지원하지 않습니다`);
					}
					const output = await convertImage(path, request.format);
					return { output, note: `${basename(output)} — 변환했습니다` };
				}
				case "resizeImage": {
					const output = await resizeImage(path, request.maxEdge);
					return { output, note: `${basename(output)} — 크기를 조절했습니다` };
				}
				case "optimizeImage": {
					const output = await optimizeImage(path);
					return { output, note: `${basename(output)} — 용량을 최적화했습니다` };
				}
				case "convertVideo": {
					if (!(await hasFfmpeg())) throw new Error("동영상 변환에는 ffmpeg가 필요합니다");
					const target = await uniqueChild(dirname(path), `${stemOf(path)}.${request.container}`);
					await run("ffmpeg", ffmpegRemuxArgs(path, target));
					return { output: target, note: `${basename(target)} — 컨테이너를 변환했습니다` };
				}
			}
		},

		async share(path: string, anchor: ActionAnchor, window: BrowserWindow | null): Promise<void> {
			if (platform !== "darwin" || share === null) {
				throw new Error("이 플랫폼은 시스템 공유를 지원하지 않습니다");
			}
			share.present(path, anchor, window);
		},
	};
}
