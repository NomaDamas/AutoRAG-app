/**
 * OS-provided file icons for the tile left of a file name.
 *
 * macOS produces real Finder-style thumbnails: batched
 * `qlmanage -t -s 128 -o <chunkdir> <paths...>` calls cover a listing, split
 * into small chunks so qlmanage's internal thumbnail queue never goes deep
 * (bigger in-process batches hit a known SIGSEGV). Chunks run through one
 * provider-wide process semaphore, so two concurrent listings never multiply
 * the qlmanage process count. Other platforms fall back to Electron's
 * `app.getFileIcon`, the OS's per-type icon, also through a bounded pool with
 * a per-file timeout. Generation failures degrade to "no icon" (the caller
 * keeps the letter tile) and are logged verbatim; a failed chunk never costs
 * the chunks that succeeded.
 *
 * The produced PNG bytes stay in this module's in-process cache, keyed by the
 * same `(path, modifiedAt)` identity the caller passes in, and bounded both by
 * entry count and total bytes (least-recently-used eviction). Callers receive
 * a stable `autorag-thumb://` URL (never a base64 data URL); the protocol
 * handler in `icon-protocol.ts` serves the cached bytes for that identity.
 * Concurrent requests for the same identity are single-flighted, so one
 * listing that races another never regenerates the same file twice.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { errorMessage, hasErrorCode } from "./fs-entry";
import { iconUrl } from "./icon-protocol";

/** Thumbnail edge in px; 128 covers the icon view's 64px tile at 2x (and the 18px row tile easily). */
export const ICON_SIZE = 128;
/** One listing never generates more than this many icons. */
export const ICON_LIMIT = 240;
/** One qlmanage call only handles this many files at once — bigger in-process batches drive its internal thumbnail queue into a known SIGSEGV. */
export const THUMBNAIL_CHUNK = 10;
/** qlmanage processes allowed to run at once across every concurrent listing. */
export const THUMBNAIL_POOL = 8;
/** OS type-icon lookups allowed to run at once across every concurrent listing. */
export const SYSTEM_ICON_CONCURRENCY = 8;
/** Icon cache entries kept before the least-recently-used ones are evicted. */
export const ICON_CACHE_MAX_ENTRIES = 4096;
/** Total PNG bytes kept in the icon cache before the least-recently-used entries are evicted. */
export const ICON_CACHE_MAX_BYTES = 64 * 1024 * 1024;

const ICON_TIMEOUT_MS = 4000;
const ICON_MAX_BUFFER = 1 << 20;
const SYSTEM_ICON_TIMEOUT_MS = 4000;
const THUMBNAIL_SUFFIX = ".png";

export interface IconTarget {
	/** Absolute OS path. */
	readonly path: string;
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
	/** macOS thumbnail generation into outDir; defaults to qlmanage. */
	readonly generate?: (paths: readonly string[], outDir: string) => Promise<void>;
	/** OS type icon PNG bytes, or null; defaults to Electron app.getFileIcon. */
	readonly systemIcon?: (path: string) => Promise<Uint8Array | null>;
	/** Cap on the selected targets for a single call; defaults to ICON_LIMIT. */
	readonly limit?: number;
	/** qlmanage processes at once across calls; defaults to THUMBNAIL_POOL. */
	readonly maxConcurrent?: number;
	/** getFileIcon lookups at once across calls; defaults to SYSTEM_ICON_CONCURRENCY. */
	readonly systemConcurrency?: number;
	/** Per-file getFileIcon deadline; defaults to ICON_TIMEOUT_MS. */
	readonly systemIconTimeoutMs?: number;
	/** Icon cache entry cap; defaults to ICON_CACHE_MAX_ENTRIES. */
	readonly cacheMaxEntries?: number;
	/** Icon cache byte cap; defaults to ICON_CACHE_MAX_BYTES. */
	readonly cacheMaxBytes?: number;
	/** Defaults to console.warn. */
	readonly warn?: (message: string) => void;
}

function cacheKey(target: IconTarget): string {
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
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
	const { promise: guarded, resolve, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => reject(new Error(`getFileIcon timed out after ${timeoutMs}ms`)), timeoutMs);
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

function defaultGenerate(paths: readonly string[], outDir: string): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const args = ["-t", "-s", String(ICON_SIZE), "-o", outDir, ...paths];
	execFile("/usr/bin/qlmanage", args, { timeout: ICON_TIMEOUT_MS, maxBuffer: ICON_MAX_BUFFER }, (error) => {
		if (error) {
			reject(error);
			return;
		}
		resolve();
	});
	return promise;
}

async function defaultSystemIcon(path: string): Promise<Uint8Array | null> {
	// Dynamic: `electron` is a main-process-only module and is not importable when
	// this file is loaded outside Electron (unit tests inject `systemIcon` instead).
	const { app } = await import("electron");
	const image = await app.getFileIcon(path, { size: "normal" });
	return image.isEmpty() ? null : image.toPNG();
}

/**
 * Split targets into qlmanage chunks of at most `THUMBNAIL_CHUNK`, never
 * putting two targets with the same basename in one chunk. qlmanage writes
 * `<basename>.png` into a single directory, so same-named files from different
 * folders must run in their own chunk (and therefore their own temp dir) or
 * they overwrite each other.
 */
function planChunks(targets: readonly IconTarget[]): IconTarget[][] {
	const chunks: IconTarget[][] = [];
	const names: Array<Set<string>> = [];
	for (const target of targets) {
		const name = basename(target.path);
		let placed = -1;
		for (let index = 0; index < chunks.length; index += 1) {
			if ((chunks[index]?.length ?? 0) < THUMBNAIL_CHUNK && !names[index]?.has(name)) {
				placed = index;
				break;
			}
		}
		if (placed === -1) {
			chunks.push([target]);
			names.push(new Set([name]));
		} else {
			chunks[placed]?.push(target);
			names[placed]?.add(name);
		}
	}
	return chunks;
}

export function createIconProvider(deps: IconProviderDeps = {}): IconSource {
	const platform = deps.platform ?? process.platform;
	const generate = deps.generate ?? defaultGenerate;
	const systemIcon = deps.systemIcon ?? defaultSystemIcon;
	const limit = Math.max(0, Math.floor(deps.limit ?? ICON_LIMIT));
	const maxConcurrent = positive(deps.maxConcurrent ?? THUMBNAIL_POOL, THUMBNAIL_POOL);
	const systemConcurrency = positive(deps.systemConcurrency ?? SYSTEM_ICON_CONCURRENCY, SYSTEM_ICON_CONCURRENCY);
	const systemIconTimeoutMs = deps.systemIconTimeoutMs ?? SYSTEM_ICON_TIMEOUT_MS;
	const warn = deps.warn ?? ((message: string) => console.warn(message));
	// Bounded by entries and bytes; nulls are cached too, so files with no OS
	// thumbnail (and timed-out chunks) are not regenerated on every listing.
	const cache = new IconCache(
		positive(deps.cacheMaxEntries ?? ICON_CACHE_MAX_ENTRIES, ICON_CACHE_MAX_ENTRIES),
		Math.max(1, Math.floor(deps.cacheMaxBytes ?? ICON_CACHE_MAX_BYTES)),
	);
	// One semaphore per provider (the app has exactly one), so concurrent
	// listings share the process/lookup budget rather than each opening its own.
	const qlmanageSemaphore = createSemaphore(maxConcurrent);
	const systemSemaphore = createSemaphore(systemConcurrency);
	/** key -> the generation currently producing that identity, for single-flight reuse. */
	const inflight = new Map<string, Promise<Uint8Array | null>>();

	/** macOS path: chunked qlmanage processes, one temp dir per chunk. */
	async function runThumbnails(
		targets: readonly IconTarget[],
		resolve: (key: string, bytes: Uint8Array | null) => void,
	): Promise<void> {
		const chunks = planChunks(targets);
		const workers = Math.max(1, Math.min(maxConcurrent, chunks.length));
		let cursor = 0;
		const run = async (): Promise<void> => {
			for (let index = cursor++; index < chunks.length; index = cursor++) {
				const chunk = chunks[index] ?? [];
				const outDir = await mkdtemp(join(tmpdir(), "autorag-icons-"));
				try {
					await qlmanageSemaphore.acquire();
					try {
						await generate(
							chunk.map((target) => target.path),
							outDir,
						);
					} finally {
						qlmanageSemaphore.release();
					}
					for (const target of chunk) {
						try {
							const bytes = new Uint8Array(await readFile(join(outDir, `${basename(target.path)}${THUMBNAIL_SUFFIX}`)));
							resolve(cacheKey(target), bytes);
						} catch (error) {
							// No thumbnail for this file: qlmanage simply writes nothing.
							if (!hasErrorCode(error, "ENOENT")) {
								warn(`file-icon: reading thumbnail for ${target.path} failed: ${errorMessage(error)}`);
							}
							resolve(cacheKey(target), null);
						}
					}
				} catch (error) {
					// A crashed or stuck qlmanage costs only this chunk; the others keep trying.
					warn(`file-icon: thumbnail chunk of ${chunk.length} failed: ${errorMessage(error)}`);
					for (const target of chunk) resolve(cacheKey(target), null);
				} finally {
					await rm(outDir, { recursive: true, force: true });
				}
			}
		};
		await Promise.all(Array.from({ length: workers }, run));
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
					const bytes = await withTimeout(systemIcon(target.path), systemIconTimeoutMs);
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
		const generation = platform === "darwin" ? runThumbnails(missing, resolve) : runSystem(missing, resolve);
		void generation.catch((error: unknown) => {
			// mkdtemp/pool-level failure: the whole batch degrades to "no icon".
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
			// Cap applies to the selected target slice, not to whatever happens to
			// miss the cache this call: a warm listing stays at `limit` total.
			const selected = targets.slice(0, limit);
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
