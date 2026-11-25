import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

/**
 * True on macOS when `path` is an unmaterialized cloud placeholder (`SF_DATALESS`).
 * Normal local files have `blocks > 0` (or `size === 0`) and short-circuit on `stat()`
 * with zero subprocesses; only zero-block non-empty files are verified with `/usr/bin/stat -f %Sf`
 * so sparse local files are never misclassified. Never opens or reads file data.
 */
export async function isDatalessFile(path: string): Promise<boolean> {
	if (process.platform !== "darwin" || !existsSync(path)) return false;
	try {
		const info = await stat(path);
		if (!info.isFile() || info.size === 0 || info.blocks > 0) return false;
	} catch {
		return false;
	}
	const { promise, resolve } = Promise.withResolvers<boolean>();
	execFile("/usr/bin/stat", ["-f", "%Sf", path], { timeout: 2000 }, (error, stdout) => {
		if (error !== null) {
			resolve(false);
			return;
		}
		resolve(stdout.trim().split(",").includes("dataless"));
	});
	return promise;
}

export const DATALESS_QUICK_LOOK_EDGE = 1440;
/** Time budget to try iCloud's cloud-only thumbnail before materializing a single user-selected State-3 file. */
export const DATALESS_PREVIEW_CLOUD_TIMEOUT_MS = 4000;
/** Uncached State-3 placeholders up to this size may be materialized on explicit user preview (Inspector / Quick Look). */
export const DATALESS_MAX_MATERIALIZE_BYTES = 24 * 1024 * 1024;
const DIRECT_RASTER_EXTENSIONS = new Set(["png", "jpg", "jpeg", "jfif", "pjpeg", "pjp", "webp", "gif", "bmp", "ico"]);

const MATERIALIZE_DATALESS = `
ObjC.import("Foundation");
function run(argv) {
	const url = $.NSURL.fileURLWithPath(argv[0]);
	const maxBytes = Number(argv[1]);
	const vals = url.resourceValuesForKeysError($([$.NSURLFileSizeKey]), Ref());
	const fileSize = vals && !vals.isNil() ? (ObjC.unwrap(vals.objectForKey($.NSURLFileSizeKey)) || 0) : 0;
	if (fileSize <= 0 || fileSize > maxBytes) return "skip";
	const coordinator = $.NSFileCoordinator.alloc.initWithFilePresenter($());
	const err = Ref();
	let ok = false;
	coordinator.coordinateReadingItemAtURLOptionsErrorByAccessor(url, 0, err, function() {
		ok = true;
	});
	return ok ? "materialized" : "skip";
}`;

/**
 * Materializes a single user-selected `SF_DATALESS` placeholder within `maxBytes`
 * when iCloud has no cloud thumbnail (State 3, `QLThumbnailErrorDomain Code=3`).
 * Uses `NSFileCoordinator` (foreground high-priority read across iCloud and all
 * macOS File Providers — unlike `startDownloadingUbiquitousItemAtURL`, which
 * queues at low background priority and can stall for >12s).
 * Never call this during folder listing/scrolling — only on explicit user preview.
 */
export function materializeDatalessFile(
	path: string,
	maxBytes = DATALESS_MAX_MATERIALIZE_BYTES,
): Promise<"materialized" | "skip"> {
	if (process.platform !== "darwin") return Promise.resolve("skip");
	const { promise, resolve } = Promise.withResolvers<"materialized" | "skip">();
	execFile(
		"/usr/bin/osascript",
		["-l", "JavaScript", "-e", MATERIALIZE_DATALESS, path, String(maxBytes)],
		{ timeout: 30_000 },
		(error, stdout) => {
			if (error !== null) {
				resolve("skip");
				return;
			}
			resolve(stdout.trim() === "materialized" ? "materialized" : "skip");
		},
	);
	return promise;
}

/** Decodes a locally materialized raster image directly without touching ThumbnailsAgent. */
export async function directRasterThumbnailPng(path: string, maxEdge: number): Promise<Uint8Array | null> {
	if (!DIRECT_RASTER_EXTENSIONS.has(extname(path).slice(1).toLowerCase())) return null;
	try {
		const { nativeImage } = await import("electron");
		const image = nativeImage.createFromPath(path);
		if (image.isEmpty()) return null;
		const { width, height } = image.getSize();
		const fitted = width > maxEdge || height > maxEdge
			? (width >= height ? image.resize({ width: maxEdge }) : image.resize({ height: maxEdge }))
			: image;
		return fitted.toPNG();
	} catch {
		return null;
	}
}

async function defaultQuickLookThumbnail(path: string, maxEdge: number): Promise<Uint8Array | null> {
	// Dynamic: `electron` is only available in Electron main, not in Node unit tests.
	const { nativeImage } = await import("electron");
	const image = await nativeImage.createThumbnailFromPath(path, { width: maxEdge, height: maxEdge });
	return image.isEmpty() ? null : image.toPNG();
}

function raceTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), timeoutMs);
	});
	return Promise.race([promise.catch(() => null), timeout]).finally(() => {
		clearTimeout(timer);
	});
}

export interface DatalessQuickLookDeps {
	readonly thumbnail?: (path: string, maxEdge: number) => Promise<Uint8Array | null>;
	readonly materialize?: (path: string, maxBytes: number) => Promise<"materialized" | "skip">;
	readonly cloudTimeoutMs?: number;
	readonly maxBytes?: number;
}

/**
 * High-resolution PNG for an unmaterialized cloud placeholder during explicit
 * Quick Look (`Space`). Tries macOS `QLThumbnailGenerator` first (zero download
 * when iCloud has a cloud thumbnail — State 2); only when that returns empty or
 * times out (State 3, `QLThumbnailErrorDomain Code=3`) materializes this single
 * file within `maxBytes` and renders from disk.
 */
export async function datalessQuickLookPng(
	path: string,
	maxEdge = DATALESS_QUICK_LOOK_EDGE,
	deps: DatalessQuickLookDeps = {},
): Promise<Uint8Array | null> {
	if (process.platform !== "darwin") return null;
	const thumb = deps.thumbnail ?? defaultQuickLookThumbnail;
	const cloudTimeoutMs = deps.cloudTimeoutMs ?? DATALESS_PREVIEW_CLOUD_TIMEOUT_MS;
	const cloud = await raceTimeout(thumb(path, maxEdge), cloudTimeoutMs);
	if (cloud !== null && cloud.byteLength > 0) return cloud;
	const materialize = deps.materialize ?? materializeDatalessFile;
	const maxBytes = deps.maxBytes ?? DATALESS_MAX_MATERIALIZE_BYTES;
	if ((await materialize(path, maxBytes)) !== "materialized") return null;
	if (deps.thumbnail === undefined) {
		const direct = await directRasterThumbnailPng(path, maxEdge);
		if (direct !== null && direct.byteLength > 0) return direct;
	}
	const local = await raceTimeout(thumb(path, maxEdge), cloudTimeoutMs);
	return local !== null && local.byteLength > 0 ? local : null;
}
/** Darwin EDEADLK is 11; libuv may expose it only as an unmapped negative errno. */
export function needsFileCoordination(error: unknown): boolean {
	return process.platform === "darwin" && typeof error === "object" && error !== null &&
		(("code" in error && error.code === "EDEADLK") || ("errno" in error && error.errno === -11));
}

const COORDINATED_COPY = `
ObjC.import("Foundation");
function run(argv) {
	const coordinator = $.NSFileCoordinator.alloc.initWithFilePresenter($());
	const error = Ref();
	let copied = false;
	let failure = null;
	coordinator.coordinateReadingItemAtURLOptionsErrorByAccessor(
		$.NSURL.fileURLWithPath(argv[0]), 0, error, function(url) {
			const copyError = Ref();
			copied = $.NSFileManager.defaultManager.copyItemAtURLToURLError(url.URLByResolvingSymlinksInPath, $.NSURL.fileURLWithPath(argv[1]), copyError);
			if (!copied) failure = ObjC.unwrap(copyError[0].localizedDescription);
		}
	);
	if (failure !== null) throw new Error(failure);
	if (!copied) throw new Error(ObjC.unwrap(error[0].localizedDescription));
}`;

/** A disk snapshot, not a whole-file JS/base64 buffer. Released when its consumer finishes. */
export async function coordinatedSnapshot(path: string): Promise<{ readonly path: string; dispose(): Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "dazzi-preview-provider-"));
	const snapshot = join(dir, basename(path));
	const dispose = (): Promise<void> => rm(dir, { recursive: true, force: true });
	try {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", COORDINATED_COPY, path, snapshot], { timeout: 60_000 }, (error) => {
			if (error !== null) reject(error);
			else resolve();
		});
		await promise;
		return { path: snapshot, dispose };
	} catch (error) {
		await dispose();
		throw error;
	}
}

/** Native tools hide errno; probe only after they failed, never on a successful/local fast path. */
async function providerRefusesRead(path: string): Promise<boolean> {
	if (process.platform !== "darwin") return false;
	try {
		const handle = await open(path, "r");
		try {
			await handle.read(new Uint8Array(1), 0, 1, 0);
		} finally {
			await handle.close();
		}
		return false;
	} catch (error) {
		return needsFileCoordination(error);
	}
}

/** Original operation first. Retry only a verified provider deadlock, with no persistent copies or altered local reads. */
export async function withReadableFile<T>(path: string, consume: (localPath: string) => Promise<T>, nativeError = false): Promise<T> {
	if (await isDatalessFile(path)) {
		const snapshot = await coordinatedSnapshot(path);
		try {
			return await consume(snapshot.path);
		} finally {
			await snapshot.dispose();
		}
	}
	try {
		return await consume(path);
	} catch (error) {
		if (!needsFileCoordination(error) && !(nativeError && await providerRefusesRead(path))) throw error;
		const snapshot = await coordinatedSnapshot(path);
		try {
			return await consume(snapshot.path);
		} finally {
			await snapshot.dispose();
		}
	}
}

const COORDINATED_RANGE = `
ObjC.import("Foundation");
function run(argv) {
	const coordinator = $.NSFileCoordinator.alloc.initWithFilePresenter($());
	const error = Ref();
	let accessed = false;
	let failure = null;
	coordinator.coordinateReadingItemAtURLOptionsErrorByAccessor(
		$.NSURL.fileURLWithPath(argv[0]), 0, error, function(url) {
			accessed = true;
			const readError = Ref();
			const input = $.NSFileHandle.fileHandleForReadingFromURLError(url, readError);
			if (input.isNil()) { failure = ObjC.unwrap(readError[0].localizedDescription); return; }
			try {
				input.seekToFileOffset(Number(argv[1]));
				let remaining = Number(argv[2]) - Number(argv[1]) + 1;
				const output = $.NSFileHandle.fileHandleWithStandardOutput;
				while (remaining > 0) {
					const chunk = input.readDataOfLength(Math.min(remaining, 1024 * 1024));
					if (chunk.length === 0) throw new Error("Unexpected end of file during coordinated read");
					output.writeData(chunk);
					remaining -= chunk.length;
				}
			} catch (caught) { failure = String(caught); }
			finally { input.closeFile; }
		}
	);
	if (failure !== null) throw new Error(failure);
	if (!accessed) throw new Error(ObjC.unwrap(error[0].localizedDescription));
}`;

/** Stream just the requested range inside the coordination grant; seeking never copies the whole media file. */
export async function* coordinatedRange(path: string, start: number, end: number): AsyncGenerator<Buffer> {
	const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", COORDINATED_RANGE, path, String(start), String(end)], { stdio: ["ignore", "pipe", "pipe"] });
	const { promise, resolve } = Promise.withResolvers<Error | null>();
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
	child.once("error", (error) => resolve(error));
	child.once("close", (code) => resolve(code === 0 ? null : new Error(stderr.trim() || `Coordinated read exited ${code}`)));
	const timer = setTimeout(() => child.kill(), 60_000);
	try {
		for await (const chunk of child.stdout) {
			clearTimeout(timer);
			yield chunk as Buffer;
		}
		const error = await promise;
		if (error !== null) throw error;
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null) child.kill();
	}
}
