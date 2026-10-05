/**
 * Finder metadata used by Sort By / Group By.
 *
 * macOS keeps these values in two places, neither guaranteed. The extended
 * attributes `com.apple.metadata:_kMDItemUserTags` and
 * `com.apple.metadata:kMDItemFinderComment` carry the tags and comment even
 * when Spotlight has not indexed the file, so a fresh fixture reports them;
 * their binary property lists are decoded by the platform `plutil`. The
 * Spotlight index (`mdls`) supplies what only it knows: Date Added, Date Last
 * Opened, and the star rating. Dimensions come from the app's own image reader
 * so an unindexed image still reports its pixel size, and the Application is
 * the Launch Services default opener — deliberately not
 * `kMDItemApplicationName`, which names an app that merely referenced the file
 * rather than the one that opens it. The resolver is best-effort: a value the
 * platform cannot answer stays null instead of being faked, and it never
 * blocks the filesystem listing. Only macOS exposes this metadata; every other
 * platform reports none.
 */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { FsFinderMetadata } from "../shared/fs-contract";
import { errorMessage, extensionOf, hasErrorCode } from "./fs-entry";
import { readImageMetadata } from "./image-metadata";

/** Runs one native helper with argv (never a shell) and optional stdin. */
export type FinderCommandRunner = (
	command: string,
	args: readonly string[],
	input?: Uint8Array,
) => Promise<string>;

export interface FinderMetadataDeps {
	/** Defaults to process.platform. */
	readonly platform?: NodeJS.Platform;
	/** Defaults to spawning the macOS helpers with execFile. */
	readonly run?: FinderCommandRunner;
	/** Defaults to the app's EXIF/IHDR reader; tests may inject a stub. */
	readonly readImage?: (path: string, ext: string) => Promise<Pick<FsFinderMetadata, "width" | "height"> | null>;
	/** Defaults to console.warn. */
	readonly warn?: (message: string) => void;
	/** Maximum concurrent lookups; each holds at most a few helper processes. Defaults to 4. */
	readonly concurrency?: number;
	/** Injectable clock for the cache TTL; defaults to Date.now. */
	readonly now?: () => number;
	/** How long a cached result may be reused. Defaults to 30 s. */
	readonly ttlMs?: number;
}

/** Resolve Finder metadata for one path, or null when the platform has none. */
export type FinderMetadataLookup = (path: string) => Promise<FsFinderMetadata | null>;

const TAGS_XATTR = "com.apple.metadata:_kMDItemUserTags";
const COMMENT_XATTR = "com.apple.metadata:kMDItemFinderComment";
const XATTR = "/usr/bin/xattr";
const MDLS = "/usr/bin/mdls";
const OSASCRIPT = "/usr/bin/osascript";
const PLUTIL = "/usr/bin/plutil";
/** `plutil` reads the binary property list from stdin and writes XML to stdout. */
const PLUTIL_XML_ARGS: readonly string[] = ["-convert", "xml1", "-o", "-", "--", "-"];
const COMMAND_TIMEOUT_MS = 5000;
const COMMAND_MAX_BUFFER = 2 << 20;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TTL_MS = 30_000;
/** Hard cap on cached paths so a long-running session cannot grow without bound. */
const CACHE_LIMIT = 4096;

/**
 * Launch Services, through JavaScript for Automation: which app the OS opens
 * `argv[0]` with. The path is an argument, never interpolated into the script.
 */
const DEFAULT_APP_SCRIPT = `
ObjC.import("AppKit");
function run(argv) {
	const url = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.fileURLWithPath(argv[0]));
	if (url.isNil()) return "";
	const bundle = $.NSBundle.bundleWithURL(url);
	if (!bundle.isNil()) {
		const info = bundle.localizedInfoDictionary.isNil() ? bundle.infoDictionary : bundle.localizedInfoDictionary;
		for (const key of ["CFBundleDisplayName", "CFBundleName"]) {
			const value = info.isNil() ? $() : info.objectForKey(key);
			if (!value.isNil() && ObjC.unwrap(value) !== "") return ObjC.unwrap(value);
		}
	}
	return ObjC.unwrap(url.lastPathComponent).replace(/\\.app$/, "");
}`;

function xmlEscape(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rawValue(xml: string, key: string): string | null {
	const escaped = xmlEscape(key);
	const match = new RegExp(`<key>${escaped}<\\/key>\\s*<(date|string|integer|real)>([\\s\\S]*?)<\\/\\1>`).exec(xml);
	return match?.[2] ?? null;
}

function arrayStrings(xml: string, key: string): readonly string[] {
	const escaped = xmlEscape(key);
	const match = new RegExp(`<key>${escaped}<\\/key>\\s*<array>([\\s\\S]*?)<\\/array>`).exec(xml);
	const body = match?.[1];
	if (body === undefined) return [];
	return [...body.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((item) => decodeXml(item[1] ?? ""));
}

function decodeXml(value: string): string {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}

/**
 * The strings in one `plutil -convert xml1` document: every `<string>` of a
 * top-level array, or the single `<string>` of a scalar. An empty array decodes
 * to `[]`; anything else plutil could not turn into strings is null.
 */
function xmlStringValues(xml: string): readonly string[] | null {
	const strings = [...xml.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((item) => decodeXml(item[1] ?? ""));
	if (strings.length > 0) return strings;
	return /<array[\s/>]/.test(xml) ? [] : null;
}

function dateValue(value: string | null): string | null {
	if (value === null) return null;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function numberValue(value: string | null): number | null {
	if (value === null) return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

/** Finder ratings are 0–5 stars; the raw attribute is sometimes a 0–100 scale. */
function clampRating(value: number, scaledToHundred: boolean): number {
	const stars = scaledToHundred && value > 5 ? value / 20 : value;
	return Math.max(0, Math.min(5, stars));
}

function starRating(xml: string): number | null {
	const stars = numberValue(rawValue(xml, "kMDItemStarRating"));
	if (stars !== null) return clampRating(stars, false);
	const rating = numberValue(rawValue(xml, "kMDItemRating"));
	return rating === null ? null : clampRating(rating, true);
}

/** Finder appends the tag's colour index to its name: "Urgent\n6". */
function stripTagColor(tag: string): string {
	return tag.replace(/\n\d+$/, "");
}

/**
 * The indexed fields inside one `mdls -plist` document. Tags and comments are
 * read here too, but only as a fallback: the extended attributes win when the
 * file carries them. Application is never read from the index — that field
 * names referencing apps, not the default opener.
 */
export function parseFinderMetadataPlist(xml: string): FsFinderMetadata {
	const comment = rawValue(xml, "kMDItemFinderComment");
	return {
		createdAt: dateValue(rawValue(xml, "kMDItemFSCreationDate")),
		addedAt: dateValue(rawValue(xml, "kMDItemDateAdded")),
		lastOpenedAt: dateValue(rawValue(xml, "kMDItemLastUsedDate")),
		tags: arrayStrings(xml, "kMDItemUserTags").map(stripTagColor),
		comments: comment === null ? null : decodeXml(comment),
		width: numberValue(rawValue(xml, "kMDItemPixelWidth")),
		height: numberValue(rawValue(xml, "kMDItemPixelHeight")),
		rating: starRating(xml),
		application: null,
	};
}

function defaultRun(command: string, args: readonly string[], input?: Uint8Array): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const child = execFile(
		command,
		[...args],
		{ timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER, encoding: "utf8" },
		(error, stdout) => {
			if (error !== null) {
				reject(error);
				return;
			}
			resolve(stdout);
		},
	);
	if (input !== undefined && child.stdin !== null) {
		// A helper that fails before reading leaves nothing to write to.
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	}
	return promise;
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

/** Insert and evict the oldest entry once the map outgrows its cap. */
function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
	map.set(key, value);
	while (map.size > CACHE_LIMIT) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
}

interface Semaphore {
	run<T>(task: () => Promise<T>): Promise<T>;
}

/** A small FIFO gate so a large listing cannot spawn helper processes without bound. */
function createSemaphore(limit: number): Semaphore {
	let available = limit;
	const waiters: Array<() => void> = [];
	const release = (): void => {
		const next = waiters.shift();
		if (next !== undefined) next();
		else available += 1;
	};
	return {
		async run<T>(task: () => Promise<T>): Promise<T> {
			if (available > 0) {
				available -= 1;
			} else {
				const { promise, resolve } = Promise.withResolvers<void>();
				waiters.push(resolve);
				await promise;
			}
			try {
				return await task();
			} finally {
				release();
			}
		},
	};
}

interface Identity {
	readonly fingerprint: string;
	readonly isDirectory: boolean;
}

interface CacheEntry {
	readonly fingerprint: string;
	readonly expiresAt: number;
	readonly value: Promise<FsFinderMetadata | null>;
}

/**
 * A path's current state: mtime and ctime catch content and metadata changes
 * alike. Null when there is nothing the helpers could read: the path (or a
 * symlink's target) is gone, or the user lacks read access — a volume's
 * `.Trashes` / `.TemporaryItems` / `.DocumentRevisions-V100`, a cloud domain's
 * `.tmp` — where `xattr` and `mdls` can only fail with a permission error.
 */
async function identify(path: string): Promise<Identity | null> {
	try {
		const info = await stat(path);
		await access(path, constants.R_OK);
		return {
			fingerprint: `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.ino}`,
			isDirectory: info.isDirectory(),
		};
	} catch (error) {
		if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].some((code) => hasErrorCode(error, code))) return null;
		throw error;
	}
}

export function createFinderMetadataResolver(deps: FinderMetadataDeps = {}): FinderMetadataLookup {
	const platform = deps.platform ?? process.platform;
	const run = deps.run ?? defaultRun;
	const readImage = deps.readImage ?? readImageMetadata;
	const warn = deps.warn ?? ((message: string) => console.warn(message));
	const now = deps.now ?? (() => Date.now());
	const ttlMs = positiveInteger(deps.ttlMs, DEFAULT_TTL_MS);
	const semaphore = createSemaphore(positiveInteger(deps.concurrency, DEFAULT_CONCURRENCY));
	const cache = new Map<string, CacheEntry>();
	const applicationCache = new Map<string, { readonly value: Promise<string | null>; readonly expiresAt: number }>();

	async function readXattr(path: string, name: string): Promise<string | null> {
		try {
			return await run(XATTR, ["-p", "-x", name, path]);
		} catch (error) {
			const message = errorMessage(error);
			// An attribute the file simply does not carry is the common case.
			if (!message.includes("No such xattr")) warn(`finder-metadata: ${name} failed for ${path}: ${message}`);
			return null;
		}
	}

	async function readIndexed(path: string): Promise<FsFinderMetadata | null> {
		try {
			return parseFinderMetadataPlist(await run(MDLS, ["-plist", "-", path]));
		} catch (error) {
			warn(`finder-metadata: mdls failed for ${path}: ${errorMessage(error)}`);
			return null;
		}
	}

	/** Decode one extended attribute's binary property list with the platform `plutil`. */
	async function decodeXattr(path: string, name: string, hex: string | null): Promise<readonly string[] | null> {
		if (hex === null) return null;
		const bytes = Buffer.from(hex.replace(/[^0-9a-fA-F]/g, ""), "hex");
		if (bytes.length === 0) return null;
		try {
			return xmlStringValues(await run(PLUTIL, PLUTIL_XML_ARGS, bytes));
		} catch (error) {
			warn(`finder-metadata: ${name} is not a property list for ${path}: ${errorMessage(error)}`);
			return null;
		}
	}

	/** The default opener depends on the type, not the file, so it is cached per type. */
	function applicationCacheKey(path: string, isDirectory: boolean): string {
		if (isDirectory) return "folder";
		const ext = extensionOf(basename(path));
		return ext === "" ? `path:${path}` : `ext:${ext}`;
	}

	function resolveApplication(path: string, isDirectory: boolean): Promise<string | null> {
		const key = applicationCacheKey(path, isDirectory);
		const time = now();
		const cached = applicationCache.get(key);
		if (cached !== undefined && time < cached.expiresAt) return cached.value;
		// The caller already holds the lookup semaphore; this must not acquire it again.
		const value = (async () => {
			try {
				const name = (await run(OSASCRIPT, ["-l", "JavaScript", "-e", DEFAULT_APP_SCRIPT, path])).trim();
				return name === "" ? null : name;
			} catch (error) {
				warn(`finder-metadata: default app failed for ${path}: ${errorMessage(error)}`);
				return null;
			}
		})();
		setBounded(applicationCache, key, { value, expiresAt: time + ttlMs });
		return value;
	}

	async function resolve(path: string, isDirectory: boolean): Promise<FsFinderMetadata> {
		const [tagsHex, commentHex, indexed, image, application] = await Promise.all([
			readXattr(path, TAGS_XATTR),
			readXattr(path, COMMENT_XATTR),
			readIndexed(path),
			readImage(path, extensionOf(basename(path))).catch(() => null),
			resolveApplication(path, isDirectory),
		]);
		const tagValues = await decodeXattr(path, TAGS_XATTR, tagsHex);
		const commentValues = await decodeXattr(path, COMMENT_XATTR, commentHex);
		const tags = tagValues === null ? indexed?.tags ?? [] : tagValues.map(stripTagColor);
		const commentValue = commentValues?.[0];
		const comments =
			commentValues === null
				? indexed?.comments ?? null
				: commentValue !== undefined && commentValue !== ""
					? commentValue
					: null;
		return {
			createdAt: indexed?.createdAt ?? null,
			addedAt: indexed?.addedAt ?? null,
			lastOpenedAt: indexed?.lastOpenedAt ?? null,
			tags,
			comments,
			width: image?.width ?? indexed?.width ?? null,
			height: image?.height ?? indexed?.height ?? null,
			rating: indexed?.rating ?? null,
			application,
		};
	}

	return async (path) => {
		if (platform !== "darwin") return null;
		const identity = await identify(path);
		if (identity === null) return null;
		const time = now();
		const cached = cache.get(path);
		if (cached !== undefined && cached.fingerprint === identity.fingerprint && time < cached.expiresAt) {
			return cached.value;
		}
		const value = semaphore.run(() => resolve(path, identity.isDirectory));
		setBounded(cache, path, { fingerprint: identity.fingerprint, expiresAt: time + ttlMs, value });
		return value;
	};
}
