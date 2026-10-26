/**
 * OS-provided file icons for the tile left of a file name.
 *
 * macOS and Windows produce real Finder-style thumbnails through Electron's
 * in-process Quick Look Thumbnailing API
 * (`nativeImage.createThumbnailFromPath`): no child process, no Dock tile —
 * so nothing can orphan to `ppid=1` and pile up. A file the thumbnail API
 * renders nothing for falls back to Electron's `app.getFileIcon` — the OS's
 * per-type icon — and platforms that have no native thumbnail API use it
 * directly, so every file gets an OS icon (the caller's letter tile is the
 * last resort, not the first). Both paths run through
 * a provider-wide bounded pool with a per-file deadline, so two concurrent
 * listings share one budget and one stuck Quick Look extension never stalls
 * the rest. The pool serves the newest listing call first, so on a slow disk
 * the folder the user just opened never queues behind one they already left.
 * Generation failures degrade to "no icon" (the caller keeps the
 * letter tile) and are logged verbatim; one failed file never costs the batch.
 *
 * The produced PNG bytes stay in this module's in-process cache, keyed by the
 * same `(path, mtimeMs)` identity the caller passes in plus the tier edge,
 * and bounded both by entry count and total bytes (least-recently-used
 * eviction). Callers receive a stable `autorag-thumb://` URL (never a base64
 * data URL); the protocol handler in `icon-protocol.ts` serves the cached
 * bytes for that identity. Two tiers share the cache: the listing's 128px
 * tile tier (`icons`) and the Inspector's 640px preview tier (`preview`), so
 * the panel renders the page's real content crisply at 2x. Generation runs on
 * two lanes — the listing pool and a small dedicated preview lane — because
 * inspecting a file is the user's critical path and must never queue behind
 * a slow batch. Concurrent requests for the same identity are
 * single-flighted, so one listing that races another never regenerates the
 * same file twice.
 */

import { extname } from "node:path";
import { realpath } from "node:fs/promises";
import { EMBEDDED_IMAGE_EXTENSIONS, readEmbeddedImage } from "../preview/node/embedded-image";
import { EMBEDDED_THUMBNAIL_EXTENSIONS } from "../preview/node/odf";
import { GOOGLE_DRIVE_EXTENSIONS } from "../preview/shared/google-drive";
import { RAW_PHOTO_EXTENSIONS } from "../preview/shared/raster-formats";
import { errorMessage } from "./fs-entry";
import { ICON_SIZE, iconUrl } from "./icon-protocol";
import { extractVideoFrame, isVideoFrameExtension } from "./video-frame";
import { createPriorityGate, type PriorityGate } from "./priority-gate";

/** Tile tier edge in px, defined beside the URL contract; re-exported for the listing code. */
export { ICON_SIZE } from "./icon-protocol";
/** Inspector preview tier edge in px: the large Quick Look rendering the Info panel shows. */
export const PREVIEW_ICON_SIZE = 640;
/** One listing never generates more than this many icons. */
export const ICON_LIMIT = 240;
/** Native thumbnail calls allowed to run at once across every concurrent listing. */
export const THUMBNAIL_CONCURRENCY = 8;
/**
 * Inspector previews allowed to run at once, on a lane separate from the
 * listing pool: inspecting a file is the user's critical path, so a slow
 * 240-file batch (videos can hold a permit until the deadline) must never
 * make the panel wait.
 */
export const PREVIEW_CONCURRENCY = 2;
/** OS type-icon lookups allowed to run at once across every concurrent listing. */
export const SYSTEM_ICON_CONCURRENCY = 8;
/** Icon cache entries kept before the least-recently-used ones are evicted. */
export const ICON_CACHE_MAX_ENTRIES = 4096;
/** Total PNG bytes kept in the icon cache before the least-recently-used entries are evicted. */
export const ICON_CACHE_MAX_BYTES = 64 * 1024 * 1024;

const THUMBNAIL_TIMEOUT_MS = 4000;
const SYSTEM_ICON_TIMEOUT_MS = 4000;

/**
 * Extensions for which a content thumbnail is useful and Quick Look has a
 * stable visual representation. Plain text/source files deliberately stay on
 * their letter tiles: macOS Quick Look can spend the full deadline on large
 * batches of plain-text files without producing a useful tile.
 */
const NATIVE_THUMBNAIL_EXTENSIONS = new Set([
	"png", "jpg", "jpeg", "jfif", "pjpeg", "pjp", "gif", "webp", "bmp", "svg", "avif", "ico", "apng",
	"tif", "tiff", "heic", "heif",
	"mp4", "m4v", "webm", "ogv", "mov", "mkv", "avi", "mpeg", "mpg", "mpe", "3gp", "3gpp",
	"pdf", "md", "markdown", "mdx", "csv", "tsv",
	// Apple's iWork packages: Quick Look draws the first sheet, page, or slide
	// (Numbers, Pages, Keynote). Windows has no thumbnailer for them and falls
	// through to the type icon.
	"numbers", "pages", "key",
	// Legacy binary Office: Office.qlgenerator draws the first page, slide, or
	// sheet in ~300-600 ms cold (24 files at 8 in flight: 2.3-5 s, none empty).
	// The OOXML siblings (docx/xlsx/pptx) deliberately stay on letter tiles.
	"doc", "dot", "ppt", "pps", "pot", "xls", "xlt",
	// OpenDocument packages and `.potx` are not rendered by Quick Look; their
	// tile is the first-page image the package embeds (`odf.ts`), on every platform.
	// Google Drive's pointer files (.gdoc, .gsheet, .gslides, .gform, ...): Drive
	// for desktop's file provider answers the OS thumbnailer with the document's
	// first page. Where it has none the type icon (Docs, Sheets, ...) stands in.
	...GOOGLE_DRIVE_EXTENSIONS,
	// Photoshop, Illustrator (a PDF), JPEG XL, Apple icons, Targa and OpenEXR are
	// drawn by Quick Look; so is every camera RAW macOS can decode. A RAW it
	// renders blank (a Samsung DNG with no preview) is detected and read from the
	// file instead. EPS and XCF are absent on purpose: Quick Look answers them
	// with a generic icon (qlmanage hangs on them), so a tile for them needs an
	// embedded image (`embedded-image.ts`) or stays on the type icon.
	"psd", "ai", "jxl", "icns", "tga", "exr", ...RAW_PHOTO_EXTENSIONS,
	// A macOS application bundle is a directory on disk, but Quick Look renders
	// the app's own icon for it — at the listing tier and at the Inspector's
	// 640px tier — so it takes this lane exactly like a document does.
	"app",
]);
export function isNativeThumbnailExtension(ext: string): boolean {
	const key = ext.toLowerCase().replace(/^\./, "");
	return NATIVE_THUMBNAIL_EXTENSIONS.has(key) || EMBEDDED_IMAGE_EXTENSIONS.has(key);
}

/**
 * Files whose only real picture is the one they embed: the OS draws nothing
 * for them (Quick Look answers an EPS, Sketch or Figma file with a generic
 * icon), so the thumbnailer is never asked and the embedded image comes first.
 */
const EMBEDDED_ONLY_EXTENSIONS: ReadonlySet<string> = new Set([...EMBEDDED_THUMBNAIL_EXTENSIONS, "eps"]);

export interface IconTarget {
	/** Absolute OS path. */
	readonly path: string;
	/** Lowercase file extension without the dot; plain folders are never targets (a macOS `.app` bundle is, with ext "app"). */
	readonly ext: string;
	/** Cache identity: a changed file must not reuse a stale thumbnail. */
	readonly mtimeMs: number;
	/** Tier edge in px; the listing's tile tier when omitted. */
	readonly size?: number;
}

export interface IconProvider {
	/**
	 * path -> `autorag-thumb://` URL, for the selected subset the OS produced
	 * an icon for. Only the first `limit` targets are considered, so a warm
	 * listing re-listed with a growing tail neither regenerates nor emits more
	 * than the cap. The PNG bytes stay in the provider cache (see
	 * `IconStore`), so the IPC payload carries no base64. Missing files are
	 * simply absent from the map; the caller keeps the letter tile.
	 */
	icons(targets: readonly IconTarget[]): Promise<ReadonlyMap<string, string>>;
	/**
	 * One file's large-tier thumbnail for the Inspector's preview paper, as an
	 * `autorag-thumb://` URL carrying `size=PREVIEW_ICON_SIZE`; null when the
	 * OS produced nothing (the panel keeps its letter tile). Bypasses the
	 * listing's `limit` cap — inspecting a file is an explicit user action —
	 * but shares the cache, the single-flight map, and the bounded pool.
	 */
	preview(target: IconTarget): Promise<string | null>;
}

/**
 * Read side of the provider cache: the `autorag-thumb://` protocol handler
 * serves exactly these bytes. Keyed by the same `(path, mtimeMs)` identity
 * the URL encodes, so it is safe to hold only while the enrichment result is
 * live.
 */
export interface IconStore {
	/** PNG bytes for one cache identity and tier, or null when the OS produced none. */
	read(path: string, mtimeMs: number, size?: number): Uint8Array | null;
}

/**
 * `preview`'s URL when that tier is already cached for this exact file
 * version, else null; never generates anything. Lets the Quick Look window,
 * which must open within a frame, use a thumbnail an earlier selection made.
 */
export interface IconPreviewCache {
	cachedPreview(target: IconTarget): string | null;
}

/** The provider the fs service consumes, plus the byte cache the protocol serves. */
export type IconSource = IconProvider & IconStore & IconPreviewCache;

export interface IconProviderDeps {
	/** Defaults to process.platform. */
	readonly platform?: NodeJS.Platform;
	/** Native thumbnail PNG bytes at the requested tier edge, or null; defaults to Electron nativeImage.createThumbnailFromPath on macOS/Windows. */
	readonly thumbnail?: (path: string, size: number) => Promise<Uint8Array | null>;
	/**
	 * The picture a file embeds of itself (a camera's preview JPEG, a PSD
	 * thumbnail, a Sketch preview) as PNG bytes within `size` px; null when it
	 * has none. Defaults to `readEmbeddedImage` re-encoded by Electron.
	 */
	readonly embeddedImage?: (path: string, ext: string, size: number) => Promise<Uint8Array | null>;
	/** OS type icon PNG bytes, or null; defaults to Electron app.getFileIcon. */
	readonly systemIcon?: (path: string) => Promise<Uint8Array | null>;
	/**
	 * One decoded video frame (PNG) at the tier edge, for containers the OS has
	 * no decoder for (mkv, webm, ogv, avi); null when none can be drawn. Defaults
	 * to ffmpeg. A null or failure falls through to the OS thumbnail and type icon.
	 */
	readonly videoFrame?: (path: string, size: number) => Promise<Uint8Array | null>;
	/** Cap on the selected targets for a single call; defaults to ICON_LIMIT. */
	readonly limit?: number;
	/** Native thumbnail calls at once across calls; defaults to THUMBNAIL_CONCURRENCY. */
	readonly thumbnailConcurrency?: number;
	/** Inspector previews at once on their own lane; defaults to PREVIEW_CONCURRENCY. */
	readonly previewConcurrency?: number;
	/** getFileIcon lookups at once across calls; defaults to SYSTEM_ICON_CONCURRENCY. */
	readonly systemConcurrency?: number;
	/** Per-file native thumbnail deadline; defaults to THUMBNAIL_TIMEOUT_MS. */
	readonly thumbnailTimeoutMs?: number;
	/** Per-file getFileIcon deadline; defaults to SYSTEM_ICON_TIMEOUT_MS. */
	readonly systemIconTimeoutMs?: number;
	/** Icon cache entry cap; defaults to ICON_CACHE_MAX_ENTRIES. */
	readonly cacheMaxEntries?: number;
	/** Icon cache byte cap; defaults to ICON_CACHE_MAX_BYTES. */
	readonly cacheMaxBytes?: number;
	/** Defaults to console.warn. */
	readonly warn?: (message: string) => void;
}

function cacheKey(target: Pick<IconTarget, "path" | "mtimeMs"> & { readonly size?: number }): string {
	return `${target.path}\u0000${target.mtimeMs}\u0000${target.size ?? ICON_SIZE}`;
}

/** Positive integer with a floor of one, so a zero/negative option still makes progress. */
function positive(value: number, fallback: number): number {
	return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

/**
 * The Inspector preview outranks every listing batch: its own thumbnail lane
 * is uncontended anyway, and its `getFileIcon` fallback shares the system
 * lane with listings, where the panel the user is looking at must not queue.
 */
const PREVIEW_PRIORITY = Number.POSITIVE_INFINITY;

/** Reject when the underlying promise outlives `timeoutMs` (<= 0 disables). */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
	const { promise: guarded, resolve, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
	promise.then(
		(value) => {
			clearTimeout(timer);
			resolve(value);
		},
		(error: unknown) => {
			clearTimeout(timer);
			reject(error instanceof Error ? error : new Error(String(error)));
		},
	);
	return guarded;
}

/** LRU byte/entry-bounded cache; a stored `null` is a negative result and counts as one entry. */
class IconCache {
	private readonly entries = new Map<string, Uint8Array | null>();
	private bytes = 0;

	constructor(
		private readonly maxEntries: number,
		private readonly maxBytes: number,
	) {}

	/** Bytes for `key`, refreshing its recency; `undefined` when never cached. */
	get(key: string): Uint8Array | null | undefined {
		const value = this.entries.get(key);
		if (value === undefined) return undefined;
		this.entries.delete(key);
		this.entries.set(key, value);
		return value;
	}

	set(key: string, value: Uint8Array | null): void {
		if (this.entries.has(key)) {
			this.bytes -= this.entries.get(key)?.byteLength ?? 0;
			this.entries.delete(key);
		}
		this.entries.set(key, value);
		this.bytes += value?.byteLength ?? 0;
		// The newest entry is always kept so a single icon larger than the byte
		// budget still serves instead of being evicted on insert.
		while (this.entries.size > 1 && (this.entries.size > this.maxEntries || this.bytes > this.maxBytes)) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.bytes -= this.entries.get(oldest)?.byteLength ?? 0;
			this.entries.delete(oldest);
		}
	}
}

const RAW_PHOTO_SET: ReadonlySet<string> = new Set(RAW_PHOTO_EXTENSIONS);

/**
 * True when the pixels (BGRA, as `toBitmap()` returns them) show nothing: no
 * visible pixel at all, or every visible pixel one colour. Quick Look answers a
 * RAW it cannot develop (a Samsung DNG with no preview) with a black picture
 * on a transparent square instead of with nothing, which would hide the
 * embedded preview and the type icon behind it. Stops at the first pixel that
 * differs, so a real picture costs a few reads.
 */
export function isBlankBitmap(bitmap: Uint8Array): boolean {
	let first = -1;
	for (let at = 0; at + 3 < bitmap.length; at += 4) {
		if (bitmap[at + 3] === 0) continue;
		if (first < 0) {
			first = at;
			continue;
		}
		if (bitmap[at] !== bitmap[first] || bitmap[at + 1] !== bitmap[first + 1] || bitmap[at + 2] !== bitmap[first + 2]) return false;
	}
	return true;
}

async function defaultThumbnail(path: string, size: number): Promise<Uint8Array | null> {
	// Dynamic: `electron` is a main-process-only module and is not importable when
	// this file is loaded outside Electron (unit tests inject `thumbnail` instead).
	const [{ nativeImage }, resolved] = await Promise.all([
		import("electron"),
		realpath(path).catch(() => path),
	]);
	const image = await nativeImage.createThumbnailFromPath(resolved, { width: size, height: size });
	if (image.isEmpty()) return null;
	if (RAW_PHOTO_SET.has(extname(path).slice(1).toLowerCase()) && isBlankBitmap(image.toBitmap())) return null;
	return image.toPNG();
}

/** Longest side from a PNG's IHDR, or null when the bytes do not start like a PNG. */
function pngLongestSide(bytes: Uint8Array): number | null {
	if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return Math.max(view.getUint32(16), view.getUint32(20));
}

/**
 * The picture a file embeds of itself, as PNG bytes no larger than `size` on
 * the long side: the embedded reader picks the smallest image that is big
 * enough, and a JPEG (a camera's preview, a PSD thumbnail) is decoded and
 * re-encoded because the icon cache serves PNG. A PNG already inside the tier
 * is kept byte for byte.
 */
async function defaultEmbeddedImage(path: string, ext: string, size: number): Promise<Uint8Array | null> {
	const embedded = await readEmbeddedImage(path, ext, { want: size });
	if (embedded === null) return null;
	if (embedded.mime === "image/png") {
		const side = pngLongestSide(embedded.bytes);
		if (side === null || side <= size) return embedded.bytes;
	}
	const { nativeImage } = await import("electron");
	const image = nativeImage.createFromBuffer(Buffer.from(embedded.bytes));
	if (image.isEmpty()) return null;
	const { width, height } = image.getSize();
	const longest = Math.max(width, height);
	const fitted =
		longest > size
			? image.resize({ width: Math.max(1, Math.round((width * size) / longest)), height: Math.max(1, Math.round((height * size) / longest)), quality: "best" })
			: image;
	return fitted.toPNG();
}

async function defaultSystemIcon(path: string): Promise<Uint8Array | null> {
	// Dynamic: `electron` is a main-process-only module and is not importable when
	// this file is loaded outside Electron (unit tests inject `systemIcon` instead).
	const [{ app }, resolved] = await Promise.all([
		import("electron"),
		realpath(path).catch(() => path),
	]);
	const image = await app.getFileIcon(resolved, { size: "normal" });
	return image.isEmpty() ? null : image.toPNG();
}

export function createIconProvider(deps: IconProviderDeps = {}): IconSource {
	const platform = deps.platform ?? process.platform;
	// Preview thumbnails come from the in-process Quick Look Thumbnailing API on
	// macOS/Windows; other platforms keep the OS's per-type icon.
	const usesNativeThumbnails = platform === "darwin" || platform === "win32";
	const thumbnail = deps.thumbnail ?? defaultThumbnail;
	const embeddedImage = deps.embeddedImage ?? defaultEmbeddedImage;
	const systemIcon = deps.systemIcon ?? defaultSystemIcon;
	const videoFrame = deps.videoFrame ?? extractVideoFrame;
	const limit = Math.max(0, Math.floor(deps.limit ?? ICON_LIMIT));
	const thumbnailConcurrency = positive(deps.thumbnailConcurrency ?? THUMBNAIL_CONCURRENCY, THUMBNAIL_CONCURRENCY);
	const previewConcurrency = positive(deps.previewConcurrency ?? PREVIEW_CONCURRENCY, PREVIEW_CONCURRENCY);
	const systemConcurrency = positive(deps.systemConcurrency ?? SYSTEM_ICON_CONCURRENCY, SYSTEM_ICON_CONCURRENCY);
	const thumbnailTimeoutMs = deps.thumbnailTimeoutMs ?? THUMBNAIL_TIMEOUT_MS;
	const systemIconTimeoutMs = deps.systemIconTimeoutMs ?? SYSTEM_ICON_TIMEOUT_MS;
	const warn = deps.warn ?? ((message: string) => console.warn(message));
	// Bounded by entries and bytes; nulls are cached too, so files with no OS
	// thumbnail (and timed-out lookups) are not regenerated on every listing.
	const cache = new IconCache(
		positive(deps.cacheMaxEntries ?? ICON_CACHE_MAX_ENTRIES, ICON_CACHE_MAX_ENTRIES),
		Math.max(1, Math.floor(deps.cacheMaxBytes ?? ICON_CACHE_MAX_BYTES)),
	);
	// One gate per provider (the app has exactly one), so concurrent listings
	// share the lookup budget rather than each opening its own. Every listing
	// call takes a higher priority than the last: the folder the user just
	// opened, or the rows they just scrolled to, never queue behind a large
	// folder they already left on a slow disk. The Inspector preview gets its
	// own lane: the user is staring at the panel while a listing batch can
	// hold every shared permit until the deadline.
	const thumbnailGate = createPriorityGate(thumbnailConcurrency);
	const previewGate = createPriorityGate(previewConcurrency);
	const systemGate = createPriorityGate(systemConcurrency);
	let nextBatchPriority = 0;
	/** key -> the generation currently producing that identity, for single-flight reuse. */
	const inflight = new Map<string, Promise<Uint8Array | null>>();

	/** One bounded `getFileIcon` lookup; a failure or deadline degrades to "no icon" and is logged. */
	async function generateSystemIcon(target: IconTarget, priority: number): Promise<Uint8Array | null> {
		await systemGate.acquire(priority);
		try {
			return await withTimeout(systemIcon(target.path), systemIconTimeoutMs, "getFileIcon");
		} catch (error) {
			// One unreadable/timed-out file must not cost the rest of the batch.
			warn(`file-icon: system icon for ${target.path} failed: ${errorMessage(error)}`);
			return null;
		} finally {
			systemGate.release();
		}
	}

	/**
	 * An ffmpeg-drawn frame for the containers the OS cannot decode, on the same
	 * bounded lane as a native thumbnail; null (no ffmpeg, no decodable frame, a
	 * failure logged verbatim, or any other container) leaves the OS chain to answer.
	 */
	async function generateVideoFrame(target: IconTarget, gate: PriorityGate, priority: number): Promise<Uint8Array | null> {
		if (!isVideoFrameExtension(target.ext)) return null;
		await gate.acquire(priority);
		try {
			return await withTimeout(videoFrame(target.path, target.size ?? ICON_SIZE), thumbnailTimeoutMs, "video frame");
		} catch (error) {
			warn(`file-icon: video frame for ${target.path} failed: ${errorMessage(error)}`);
			return null;
		} finally {
			gate.release();
		}
	}

	/**
	 * The picture a file embeds of itself, on the same bounded lane as a native
	 * thumbnail. Null for a format that embeds nothing (without taking a permit),
	 * a file with no usable image, or a failure (logged verbatim): the chain moves on.
	 */
	async function generateEmbedded(target: IconTarget, gate: PriorityGate, priority: number): Promise<Uint8Array | null> {
		const ext = target.ext.toLowerCase();
		if (!EMBEDDED_IMAGE_EXTENSIONS.has(ext)) return null;
		await gate.acquire(priority);
		try {
			return await withTimeout(embeddedImage(target.path, ext, target.size ?? ICON_SIZE), thumbnailTimeoutMs, "embedded image");
		} catch (error) {
			warn(`file-icon: embedded image for ${target.path} failed: ${errorMessage(error)}`);
			return null;
		} finally {
			gate.release();
		}
	}

	/** One bounded native thumbnail call; a failure or deadline degrades to "no thumbnail" and is logged. */
	async function generateNative(target: IconTarget, gate: PriorityGate, priority: number): Promise<Uint8Array | null> {
		await gate.acquire(priority);
		try {
			return await withTimeout(thumbnail(target.path, target.size ?? ICON_SIZE), thumbnailTimeoutMs, "thumbnail");
		} catch (error) {
			// One unreadable/timed-out file must not cost the rest of the batch.
			warn(`file-icon: thumbnail for ${target.path} failed: ${errorMessage(error)}`);
			return null;
		} finally {
			gate.release();
		}
	}

	/**
	 * macOS/Windows: a decoded video frame where the OS has no decoder, then the
	 * file's own embedded picture and the in-process Quick Look thumbnail, then
	 * the OS type icon for every file those produced nothing for (Windows has no
	 * native thumbnail for most documents, so without the fallback those rows
	 * would be left with a letter tile). The embedded picture goes first where
	 * the OS draws nothing for the format (EPS, Sketch, Figma, ODF) and on
	 * Windows, whose thumbnailer may have no codec for a RAW or PSD; macOS asks
	 * Quick Look first, which draws the real page, and reads the file only when
	 * it answers nothing. Bounded and individually fault-tolerant.
	 */
	async function runThumbnails(
		targets: readonly IconTarget[],
		resolve: (key: string, bytes: Uint8Array | null) => void,
		gate: PriorityGate,
		priority: number,
	): Promise<void> {
		await Promise.all(
			targets.map(async (target): Promise<void> => {
				let bytes: Uint8Array | null = await generateVideoFrame(target, gate, priority);
				if (bytes !== null) {
					resolve(cacheKey(target), bytes);
					return;
				}
				const embeddedOnly = EMBEDDED_ONLY_EXTENSIONS.has(target.ext.toLowerCase());
				const embeddedFirst = embeddedOnly || platform !== "darwin";
				if (embeddedFirst) bytes = await generateEmbedded(target, gate, priority);
				if (bytes === null && !embeddedOnly) bytes = await generateNative(target, gate, priority);
				if (bytes === null && !embeddedFirst) bytes = await generateEmbedded(target, gate, priority);
				if (bytes === null) bytes = await generateSystemIcon(target, priority);
				resolve(cacheKey(target), bytes);
			}),
		);
	}

	/** Other platforms: the embedded picture, else Electron `getFileIcon` per file, bounded and individually fault-tolerant. */
	async function runSystem(
		targets: readonly IconTarget[],
		resolve: (key: string, bytes: Uint8Array | null) => void,
		priority: number,
		gate: PriorityGate,
	): Promise<void> {
		await Promise.all(
			targets.map(async (target): Promise<void> => {
				const picture = (await generateVideoFrame(target, gate, priority)) ?? (await generateEmbedded(target, gate, priority));
				resolve(cacheKey(target), picture ?? (await generateSystemIcon(target, priority)));
			}),
		);
	}

	/** Register single-flight promises for every missing identity, then generate them on the given lane. */
	function startGeneration(
		missing: readonly IconTarget[],
		gate: PriorityGate,
		priority: number,
	): Array<Promise<Uint8Array | null>> {
		const resolvers = new Map<string, (bytes: Uint8Array | null) => void>();
		const promises: Array<Promise<Uint8Array | null>> = [];
		for (const target of missing) {
			const key = cacheKey(target);
			const { promise, resolve: resolvePromise } = Promise.withResolvers<Uint8Array | null>();
			resolvers.set(key, resolvePromise);
			inflight.set(key, promise);
			promises.push(promise);
			void promise.then(() => {
				if (inflight.get(key) === promise) inflight.delete(key);
			});
		}
		const resolve = (key: string, bytes: Uint8Array | null): void => {
			cache.set(key, bytes);
			resolvers.get(key)?.(bytes);
		};
		const generation = usesNativeThumbnails ? runThumbnails(missing, resolve, gate, priority) : runSystem(missing, resolve, priority, gate);
		void generation.catch((error: unknown) => {
			// Pool-level failure: the whole batch degrades to "no icon".
			warn(`file-icon: icon generation failed for ${missing.length} file(s): ${errorMessage(error)}`);
			for (const target of missing) {
				const key = cacheKey(target);
				if (cache.get(key) === undefined) resolve(key, null);
			}
		});
		return promises;
	}

	return {
		async icons(targets) {
			// Native Quick Look is deliberately limited to visual document types:
			// unsupported text/source files can otherwise occupy every permit until
			// the deadline while producing no useful image. Linux keeps the existing
			// getFileIcon behavior for every target.
			const candidates = usesNativeThumbnails ? targets.filter((target) => isNativeThumbnailExtension(target.ext)) : targets;
			// Cap applies to the selected target slice, not to whatever happens to
			// miss the cache this call: a warm listing stays at `limit` total.
			const selected = candidates.slice(0, limit);
			const seen = new Set<string>();
			const missing: IconTarget[] = [];
			const awaited: Array<Promise<Uint8Array | null>> = [];
			for (const target of selected) {
				const key = cacheKey(target);
				if (seen.has(key)) continue;
				seen.add(key);
				if (cache.get(key) !== undefined) continue;
				const pending = inflight.get(key);
				if (pending !== undefined) {
					awaited.push(pending);
					continue;
				}
				missing.push(target);
			}
			if (missing.length > 0) {
				nextBatchPriority += 1;
				for (const promise of startGeneration(missing, thumbnailGate, nextBatchPriority)) awaited.push(promise);
			}
			if (awaited.length > 0) await Promise.all(awaited);

			const found = new Map<string, string>();
			for (const target of selected) {
				const bytes = cache.get(cacheKey(target));
				if (bytes !== null && bytes !== undefined) found.set(target.path, iconUrl(target.path, target.mtimeMs));
			}
			return found;
		},
		async preview(target) {
			// Same visual-types gate as the listing: text/source/spreadsheet files
			// can occupy the whole deadline in Quick Look for no usable image, so
			// the panel keeps its letter tile instead of waiting.
			if (usesNativeThumbnails && !isNativeThumbnailExtension(target.ext)) return null;
			const sized: IconTarget = { ...target, size: PREVIEW_ICON_SIZE };
			const key = cacheKey(sized);
			if (cache.get(key) === undefined) {
				const pending = inflight.get(key);
				if (pending !== undefined) {
					await pending;
				} else {
					await Promise.all(startGeneration([sized], previewGate, PREVIEW_PRIORITY));
				}
			}
			const bytes = cache.get(key);
			return bytes === null || bytes === undefined
				? null
				: iconUrl(target.path, target.mtimeMs, PREVIEW_ICON_SIZE);
		},
		cachedPreview(target) {
			if (usesNativeThumbnails && !isNativeThumbnailExtension(target.ext)) return null;
			const bytes = cache.get(cacheKey({ ...target, size: PREVIEW_ICON_SIZE }));
			return bytes === null || bytes === undefined ? null : iconUrl(target.path, target.mtimeMs, PREVIEW_ICON_SIZE);
		},
		read(path, mtimeMs, size) {
			const key = cacheKey(size === undefined ? { path, mtimeMs } : { path, mtimeMs, size });
			return cache.get(key) ?? null;
		},
	};
}
