/**
 * OS-provided file icons for the tile left of a file name.
 *
 * macOS and Windows produce real Finder-style thumbnails through Electron's
 * in-process Quick Look Thumbnailing API
 * (`nativeImage.createThumbnailFromPath`): no child process, no Dock tile —
 * so nothing can orphan to `ppid=1` and pile up. Other platforms fall back to
 * Electron's `app.getFileIcon`, the OS's per-type icon. Both paths run through
 * a provider-wide bounded pool with a per-file deadline, so two concurrent
 * listings share one budget and one stuck Quick Look extension never stalls
 * the rest. Generation failures degrade to "no icon" (the caller keeps the
 * letter tile) and are logged verbatim; one failed file never costs the batch.
 *
 * The produced PNG bytes stay in this module's in-process cache, keyed by the
 * same `(path, modifiedAt)` identity the caller passes in, and bounded both by
 * entry count and total bytes (least-recently-used eviction). Callers receive
 * a stable `autorag-thumb://` URL (never a base64 data URL); the protocol
 * handler in `icon-protocol.ts` serves the cached bytes for that identity.
 * Concurrent requests for the same identity are single-flighted, so one
 * listing that races another never regenerates the same file twice.
 */

import { errorMessage } from "./fs-entry";
import { iconUrl } from "./icon-protocol";

/** Thumbnail edge in px; 128 covers the icon view's 64px tile at 2x (and the 18px row tile easily). */
export const ICON_SIZE = 128;
/** One listing never generates more than this many icons. */
export const ICON_LIMIT = 240;
/** Native thumbnail calls allowed to run at once across every concurrent listing. */
export const THUMBNAIL_CONCURRENCY = 8;
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
	* stable visual representation. Text, source, office, and archive files
	* deliberately stay on their letter tiles: macOS Quick Look can spend the
	* full deadline on those files without producing a useful tile.
	*/
const NATIVE_THUMBNAIL_EXTENSIONS = new Set([
	"png", "jpg", "jpeg", "jfif", "pjpeg", "pjp", "gif", "webp", "bmp", "svg", "avif", "ico", "apng",
	"tif", "tiff", "heic", "heif",
	"mp4", "m4v", "webm", "ogv", "mov", "mkv", "avi", "mpeg", "mpg", "mpe", "3gp", "3gpp",
	"pdf",
]);

export function isNativeThumbnailExtension(ext: string): boolean {
	return NATIVE_THUMBNAIL_EXTENSIONS.has(ext.toLowerCase().replace(/^\./, ""));
}

export interface IconTarget {
	/** Absolute OS path. */
	readonly path: string;
	/** Lowercase file extension without the dot; folders are never targets. */
	readonly ext: string;
	/** Cache identity: a changed file must not reuse a stale thumbnail. */
	readonly modifiedAt: string;
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
}

/**
 * Read side of the provider cache: the `autorag-thumb://` protocol handler
 * serves exactly these bytes. Keyed by the same `(path, modifiedAt)` identity
 * the URL encodes, so it is safe to hold only while the enrichment result is
 * live.
 */
export interface IconStore {
	/** PNG bytes for one cache identity, or null when the OS produced none. */
	read(path: string, modifiedAt: string): Uint8Array | null;
}

/** The provider the fs service consumes, plus the byte cache the protocol serves. */
export type IconSource = IconProvider & IconStore;

export interface IconProviderDeps {
	/** Defaults to process.platform. */
	readonly platform?: NodeJS.Platform;
	/** Native thumbnail PNG bytes, or null; defaults to Electron nativeImage.createThumbnailFromPath on macOS/Windows. */
	readonly thumbnail?: (path: string) => Promise<Uint8Array | null>;
	/** OS type icon PNG bytes, or null; defaults to Electron app.getFileIcon. */
	readonly systemIcon?: (path: string) => Promise<Uint8Array | null>;
	/** Cap on the selected targets for a single call; defaults to ICON_LIMIT. */
	readonly limit?: number;
	/** Native thumbnail calls at once across calls; defaults to THUMBNAIL_CONCURRENCY. */
	readonly thumbnailConcurrency?: number;
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

function cacheKey(target: Pick<IconTarget, "path" | "modifiedAt">): string {
	return `${target.path}\u0000${target.modifiedAt}`;
}

/** Positive integer with a floor of one, so a zero/negative option still makes progress. */
function positive(value: number, fallback: number): number {
	return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

/** Counting semaphore; `acquire` resolves when a permit is free. */
function createSemaphore(permits: number): { acquire(): Promise<void>; release(): void } {
	let available = permits;
	const waiters: Array<() => void> = [];
	return {
		async acquire(): Promise<void> {
			if (available > 0) {
				available -= 1;
				return;
			}
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push(resolve);
			await promise;
		},
		release(): void {
			const next = waiters.shift();
			if (next !== undefined) {
				next();
				return;
			}
			available += 1;
		},
	};
}

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

async function defaultThumbnail(path: string): Promise<Uint8Array | null> {
	// Dynamic: `electron` is a main-process-only module and is not importable when
	// this file is loaded outside Electron (unit tests inject `thumbnail` instead).
	const { nativeImage } = await import("electron");
	const image = await nativeImage.createThumbnailFromPath(path, { width: ICON_SIZE, height: ICON_SIZE });
	return image.isEmpty() ? null : image.toPNG();
}

async function defaultSystemIcon(path: string): Promise<Uint8Array | null> {
	// Dynamic: `electron` is a main-process-only module and is not importable when
	// this file is loaded outside Electron (unit tests inject `systemIcon` instead).
	const { app } = await import("electron");
	const image = await app.getFileIcon(path, { size: "normal" });
	return image.isEmpty() ? null : image.toPNG();
}

export function createIconProvider(deps: IconProviderDeps = {}): IconSource {
	const platform = deps.platform ?? process.platform;
	// Preview thumbnails come from the in-process Quick Look Thumbnailing API on
	// macOS/Windows; other platforms keep the OS's per-type icon.
	const usesNativeThumbnails = platform === "darwin" || platform === "win32";
	const thumbnail = deps.thumbnail ?? defaultThumbnail;
	const systemIcon = deps.systemIcon ?? defaultSystemIcon;
	const limit = Math.max(0, Math.floor(deps.limit ?? ICON_LIMIT));
	const thumbnailConcurrency = positive(deps.thumbnailConcurrency ?? THUMBNAIL_CONCURRENCY, THUMBNAIL_CONCURRENCY);
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
	// One semaphore per provider (the app has exactly one), so concurrent
	// listings share the lookup budget rather than each opening its own.
	const thumbnailSemaphore = createSemaphore(thumbnailConcurrency);
	const systemSemaphore = createSemaphore(systemConcurrency);
	/** key -> the generation currently producing that identity, for single-flight reuse. */
	const inflight = new Map<string, Promise<Uint8Array | null>>();

	/** macOS/Windows: in-process Quick Look thumbnails, bounded and individually fault-tolerant. */
	async function runThumbnails(
		targets: readonly IconTarget[],
		resolve: (key: string, bytes: Uint8Array | null) => void,
	): Promise<void> {
		await Promise.all(
			targets.map(async (target): Promise<void> => {
				await thumbnailSemaphore.acquire();
				try {
					const bytes = await withTimeout(thumbnail(target.path), thumbnailTimeoutMs, "thumbnail");
					resolve(cacheKey(target), bytes);
				} catch (error) {
					// One unreadable/timed-out file must not cost the rest of the batch.
					warn(`file-icon: thumbnail for ${target.path} failed: ${errorMessage(error)}`);
					resolve(cacheKey(target), null);
				} finally {
					thumbnailSemaphore.release();
				}
			}),
		);
	}

	/** Other platforms: Electron `getFileIcon` per file, bounded and individually fault-tolerant. */
	async function runSystem(
		targets: readonly IconTarget[],
		resolve: (key: string, bytes: Uint8Array | null) => void,
	): Promise<void> {
		await Promise.all(
			targets.map(async (target): Promise<void> => {
				await systemSemaphore.acquire();
				try {
					const bytes = await withTimeout(systemIcon(target.path), systemIconTimeoutMs, "getFileIcon");
					resolve(cacheKey(target), bytes);
				} catch (error) {
					// One unreadable/timed-out file must not cost the rest of the batch.
					warn(`file-icon: system icon for ${target.path} failed: ${errorMessage(error)}`);
					resolve(cacheKey(target), null);
				} finally {
					systemSemaphore.release();
				}
			}),
		);
	}

	/** Register single-flight promises for every missing identity, then generate them. */
	function startGeneration(missing: readonly IconTarget[]): Array<Promise<Uint8Array | null>> {
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
		const generation = usesNativeThumbnails ? runThumbnails(missing, resolve) : runSystem(missing, resolve);
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
				for (const promise of startGeneration(missing)) awaited.push(promise);
			}
			if (awaited.length > 0) await Promise.all(awaited);

			const found = new Map<string, string>();
			for (const target of selected) {
				const bytes = cache.get(cacheKey(target));
				if (bytes !== null && bytes !== undefined) found.set(target.path, iconUrl(target.path, target.modifiedAt));
			}
			return found;
		},
		read(path, modifiedAt) {
			return cache.get(cacheKey({ path, modifiedAt })) ?? null;
		},
	};
}
