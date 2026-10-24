/**
 * OS-native file kind — the same string the platform itself reports: Finder's
 * Kind column on macOS (Spotlight `kMDItemKind`) and Explorer's Type column on
 * Windows (the registry's ProgID description). A lookup that the OS cannot
 * answer returns null so the caller keeps the extension-map fallback; it never
 * throws, and a failure is logged verbatim.
 */

import { execFile } from "node:child_process";
import { lstat, stat } from "node:fs/promises";
import { errorMessage, hasErrorCode } from "./fs-entry";
import { POWERSHELL_UTF8_OUTPUT } from "./powershell-output";

export interface KindQuery {
	readonly command: string;
	readonly args: readonly string[];
}

export interface OsKindResolver {
	/** The OS kind for a path; "" extensions are keyed by path. Null when unknown. */
	kindFor(path: string, ext: string): Promise<string | null>;
}

export interface OsKindDeps {
	/** Defaults to process.platform. */
	readonly platform?: NodeJS.Platform;
	/** Defaults to spawning the platform command with execFile. */
	readonly run?: (query: KindQuery) => Promise<string | null>;
	/** Defaults to console.warn. */
	readonly warn?: (message: string) => void;
	/** Most cached kinds kept; the least recently used drop first. Defaults to 2048. */
	readonly cacheLimit?: number;
}

const KIND_TIMEOUT_MS = 5000;
/** Extensions are few; extensionless files key by path, so this bounds a long session. */
const KIND_CACHE_LIMIT = 2048;
const KIND_MAX_BUFFER = 1 << 20;

function windowsKindScript(path: string): string {
	const literal = path.replace(/'/g, "''");
	return [
		POWERSHELL_UTF8_OUTPUT,
		`$path = '${literal}'`,
		"$ext = [System.IO.Path]::GetExtension($path)",
		"if ([string]::IsNullOrEmpty($ext)) { return }",
		"$progId = (Get-ItemProperty -LiteralPath ('Registry::HKEY_CLASSES_ROOT\\' + $ext) -ErrorAction SilentlyContinue).'(default)'",
		"if ([string]::IsNullOrEmpty($progId)) { return }",
		"$typeName = (Get-ItemProperty -LiteralPath ('Registry::HKEY_CLASSES_ROOT\\' + $progId) -ErrorAction SilentlyContinue).'(default)'",
		"if (-not [string]::IsNullOrEmpty($typeName)) { [Console]::Out.Write($typeName) }",
	].join("; ");
}

/** The OS command that reports a path's kind, or null on an unsupported platform. */
export function kindQueryForPlatform(platform: NodeJS.Platform, path: string): KindQuery | null {
	if (platform === "darwin") {
		return { command: "/usr/bin/mdls", args: ["-name", "kMDItemKind", "-raw", path] };
	}
	if (platform === "win32") {
		return {
			command: "powershell.exe",
			args: ["-NoProfile", "-NonInteractive", "-Command", windowsKindScript(path)],
		};
	}
	return null;
}

/** The kind inside a probe's stdout; null when the OS reported nothing. */
export function parseKindStdout(stdout: string): string | null {
	const value = stdout.trim().replace(/^"+|"+$/g, "").trim();
	if (value === "" || value.toLowerCase() === "null" || value === "(null)") return null;
	return value;
}

function defaultRun(query: KindQuery): Promise<string | null> {
	return new Promise((resolve, reject) => {
		execFile(query.command, [...query.args], { timeout: KIND_TIMEOUT_MS, maxBuffer: KIND_MAX_BUFFER }, (error, stdout) => {
			if (error) {
				reject(error);
				return;
			}
			resolve(parseKindStdout(stdout));
		});
	});
}

/** True when `path` is a symlink whose target no longer exists. */
async function isDanglingSymlink(path: string): Promise<boolean> {
	const link = await lstat(path).catch(() => null);
	if (link === null || !link.isSymbolicLink()) return false;
	try {
		await stat(path);
		return false;
	} catch (error) {
		return hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR");
	}
}

/**
 * One OS-query process per distinct extension, shared across a session: the
 * kind follows the type identifier, which the extension determines, so a folder
 * of 200 .mp4 files costs a single `mdls`.
 */
export function createOsKindResolver(deps: OsKindDeps = {}): OsKindResolver {
	const platform = deps.platform ?? process.platform;
	const run = deps.run ?? defaultRun;
	const warn = deps.warn ?? ((message: string) => console.warn(message));
	const cache = new Map<string, Promise<string | null>>();
	const limit = deps.cacheLimit ?? KIND_CACHE_LIMIT;

	/** The OS kind, or a rejection when there is no answer to share with other files of the extension. */
	async function query(path: string): Promise<string | null> {
		const request = kindQueryForPlatform(platform, path);
		if (request === null) return null;
		// A symlink whose target is gone (an uninstalled app's alias, an Android
		// device's /bin) has no kind for the OS to report; asking only logs noise.
		if (await isDanglingSymlink(path)) throw new Error("dangling symlink");
		try {
			return await run(request);
		} catch (error) {
			warn(`file-kind: ${request.command} failed for ${path}: ${errorMessage(error)}`);
			throw error;
		}
	}

	return {
		kindFor(path, ext) {
			const key = ext === "" ? path : ext;
			const cached = cache.get(key);
			if (cached !== undefined) {
				// Most recently used last, so eviction drops the coldest key.
				cache.delete(key);
				cache.set(key, cached);
				return cached;
			}
			const pending = query(path).catch(() => {
				// One unanswerable file must not erase the kind of every file sharing its extension.
				if (cache.get(key) === pending) cache.delete(key);
				return null;
			});
			cache.set(key, pending);
			// Extensionless files key by path, so a long session over many such
			// files would otherwise grow the map without bound.
			while (cache.size > limit) {
				const oldest = cache.keys().next().value;
				if (oldest === undefined) break;
				cache.delete(oldest);
			}
			return pending;
		},
	};
}
