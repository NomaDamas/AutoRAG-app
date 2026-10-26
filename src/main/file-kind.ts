/**
 * OS-native file kind — the same string the platform itself reports: Finder's
 * Kind column on macOS (Spotlight `kMDItemKind`) and Explorer's Type column on
 * Windows (the registry's ProgID description). A lookup that the OS cannot
 * answer returns null so the caller keeps the extension-map fallback; it never
 * throws, and a failure is logged verbatim.
 *
 * macOS asks `mdls` once per extension. Windows reads the registry, which is
 * keyed by extension alone, so every extension that is waiting is answered by
 * one PowerShell process, never more than one running at a time: a PowerShell
 * start costs 300-400 ms and blocks the caller's event loop while it is created,
 * so a folder of 60 extensions used to freeze the file-system worker for 6.8 s.
 */

import { execFile } from "node:child_process";
import { lstat, stat } from "node:fs/promises";
import { errorMessage, hasErrorCode } from "./fs-entry";
import { POWERSHELL_UTF8_OUTPUT } from "./powershell-output";

export interface KindQuery {
	readonly command: string;
	readonly args: readonly string[];
	/** Windows only: the registry extensions this one process answers, one stdout line each, in order. */
	readonly extensions?: readonly string[];
}

export interface OsKindResolver {
	/** The OS kind for a path; "" extensions are keyed by path. Null when unknown. */
	kindFor(path: string, ext: string): Promise<string | null>;
}

export interface OsKindDeps {
	/** Defaults to process.platform. */
	readonly platform?: NodeJS.Platform;
	/** Runs the query and returns its stdout. Defaults to spawning the platform command with execFile. */
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
/** One process answers at most this many extensions, which keeps its command line short and its run inside the timeout. */
const WINDOWS_BATCH_LIMIT = 100;

/**
 * The extension Explorer's Type column looks up in the registry, lower-cased as the registry is
 * case-insensitive: ".pdf" for `report.PDF`, ".gitignore" for `.gitignore` (as .NET's
 * Path.GetExtension reads it), "" for a name with no extension or a trailing dot.
 */
export function windowsRegistryExtension(path: string): string {
	const name = path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
	const dot = name.lastIndexOf(".");
	if (dot === -1 || dot === name.length - 1) return "";
	return name.slice(dot).toLowerCase();
}

/** One PowerShell process that prints the Explorer type name of each extension, one line each, empty when unknown. */
export function windowsKindQuery(extensions: readonly string[]): KindQuery {
	const list = extensions.map((extension) => `'${extension.replace(/'/g, "''")}'`).join(",");
	const script = [
		POWERSHELL_UTF8_OUTPUT,
		`foreach ($ext in @(${list})) { $line = ''`,
		"$progId = (Get-ItemProperty -LiteralPath ('Registry::HKEY_CLASSES_ROOT\\' + $ext) -ErrorAction SilentlyContinue).'(default)'",
		"if (-not [string]::IsNullOrEmpty($progId)) { $typeName = (Get-ItemProperty -LiteralPath ('Registry::HKEY_CLASSES_ROOT\\' + $progId) -ErrorAction SilentlyContinue).'(default)'; if (-not [string]::IsNullOrEmpty($typeName)) { $line = $typeName -replace '[\\r\\n]+', ' ' } }",
		"[Console]::Out.WriteLine($line) }",
	].join("; ");
	return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", script], extensions };
}

/** The kind of each of `count` extensions from a batch's stdout; a line the process did not print is unknown. */
export function parseWindowsKindStdout(stdout: string, count: number): (string | null)[] {
	const lines = stdout.split(/\r?\n/);
	return Array.from({ length: count }, (_, index) => {
		const line = (lines[index] ?? "").trim();
		return line === "" ? null : line;
	});
}

/** The per-path OS command on macOS; null elsewhere (Windows answers whole batches of extensions, see windowsKindQuery). */
export function kindQueryForPlatform(platform: NodeJS.Platform, path: string): KindQuery | null {
	if (platform === "darwin") {
		return { command: "/usr/bin/mdls", args: ["-name", "kMDItemKind", "-raw", path] };
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
		execFile(query.command, [...query.args], { timeout: KIND_TIMEOUT_MS, maxBuffer: KIND_MAX_BUFFER, windowsHide: true }, (error, stdout) => {
			if (error) {
				reject(error);
				return;
			}
			resolve(stdout);
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

interface WaitingKind {
	readonly promise: Promise<string | null>;
	readonly settle: (kind: string | null) => void;
}

/**
 * macOS: one `mdls` per distinct extension, shared across a session: the kind follows the type
 * identifier, which the extension determines, so a folder of 200 .mp4 files costs a single
 * `mdls`. Windows: one PowerShell per batch of distinct extensions (see the file header).
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
			const stdout = await run(request);
			return stdout === null ? null : parseKindStdout(stdout);
		} catch (error) {
			warn(`file-kind: ${request.command} failed for ${path}: ${errorMessage(error)}`);
			throw error;
		}
	}

	/** Most recently used last, so eviction drops the coldest key. */
	function touch(key: string, cached: Promise<string | null>): Promise<string | null> {
		cache.delete(key);
		cache.set(key, cached);
		return cached;
	}

	function remember(key: string, pending: Promise<string | null>): void {
		cache.set(key, pending);
		// Extensionless files key by path, so a long session over many such
		// files would otherwise grow the map without bound.
		while (cache.size > limit) {
			const oldest = cache.keys().next().value;
			if (oldest === undefined) break;
			cache.delete(oldest);
		}
	}

	// Windows: extensions asked for and not yet sent to a process, in request order.
	const waiting = new Map<string, WaitingKind>();
	let draining = false;
	let scheduled = false;

	async function drain(): Promise<void> {
		draining = true;
		try {
			while (waiting.size > 0) {
				const batch = [...waiting].slice(0, WINDOWS_BATCH_LIMIT);
				for (const [extension] of batch) waiting.delete(extension);
				const extensions = batch.map(([extension]) => extension);
				let kinds: (string | null)[] | null = null;
				try {
					const stdout = await run(windowsKindQuery(extensions));
					kinds = parseWindowsKindStdout(stdout ?? "", extensions.length);
				} catch (error) {
					warn(`file-kind: powershell.exe failed for ${extensions.length} extension(s) (${extensions.slice(0, 8).join(" ")}): ${errorMessage(error)}`);
				}
				batch.forEach(([extension, entry], index) => {
					// A failed process must not erase the kind of an extension a later folder can still ask for.
					if (kinds === null && cache.get(extension) === entry.promise) cache.delete(extension);
					entry.settle(kinds?.[index] ?? null);
				});
			}
		} finally {
			draining = false;
		}
	}

	/** Everything requested in the same tick goes to one process; later requests wait for the running one. */
	function scheduleDrain(): void {
		if (draining || scheduled) return;
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			void drain();
		});
	}

	function windowsKindFor(path: string): Promise<string | null> {
		// The registry is keyed by extension: a file without one has no answer, so no process is worth starting.
		const extension = windowsRegistryExtension(path);
		if (extension === "") return Promise.resolve(null);
		const cached = cache.get(extension);
		if (cached !== undefined) return touch(extension, cached);
		let settle: (kind: string | null) => void = () => {};
		const pending = new Promise<string | null>((resolve) => {
			settle = resolve;
		});
		remember(extension, pending);
		waiting.set(extension, { promise: pending, settle });
		scheduleDrain();
		return pending;
	}

	return {
		kindFor(path, ext) {
			if (platform === "win32") return windowsKindFor(path);
			const key = ext === "" ? path : ext;
			const cached = cache.get(key);
			if (cached !== undefined) return touch(key, cached);
			const pending = query(path).catch(() => {
				// One unanswerable file must not erase the kind of every file sharing its extension.
				if (cache.get(key) === pending) cache.delete(key);
				return null;
			});
			remember(key, pending);
			return pending;
		},
	};
}
