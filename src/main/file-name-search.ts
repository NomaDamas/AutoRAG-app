import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { EverythingSearchRequest } from "@autorag/librarian";
import { RECENTS_PATH, type FsLocation } from "../shared/fs-contract";

/**
 * Fast filename search for the Finder, routed through a platform index instead
 * of the recursive disk walk:
 *
 * - macOS/Linux: the user's `fsearch-cli` (FSearch) database — the same one the
 *   FSearch app and `fsearch-cli` share by default. A `fsearch-cli watch`
 *   daemon is kept alive for the app session so searches after the first never
 *   pay the database cold-load again.
 * - Windows: the voidtools Everything instance bundled with `@autorag/librarian`.
 *
 * The index is user-owned and never rebuilt here (that stays a `fsearch-cli` /
 * Everything concern); when no index exists, or the CLI is missing, `search`
 * answers `null` and the caller falls back to the disk walk.
 */

/** One external search-process invocation. */
export interface FileNameRunResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

export type FileNameSearchRunner = (
	command: string,
	args: readonly string[],
	timeoutMs: number,
) => Promise<FileNameRunResult>;

/** Launches a detached daemon; returns its pid when known. */
export type FileNameSearchLauncher = (command: string, args: readonly string[]) => number | undefined;

export type EverythingIndexOutcome =
	| { readonly ok: true; readonly indexedItems: number }
	| { readonly ok: false; readonly reason?: string; readonly message?: string };

export type EverythingSearchOutcome =
	| { readonly ok: true; readonly results: readonly { readonly path: string }[] }
	| { readonly ok: false; readonly reason?: string; readonly message?: string };

/** The slice of `EverythingClient` the app needs; a seam so the Windows path is unit-testable off-Windows. */
export interface EverythingSearchClient {
	index(): Promise<EverythingIndexOutcome>;
	search(request: EverythingSearchRequest): Promise<EverythingSearchOutcome>;
	stop(): Promise<void>;
}

export interface FileNameSearchBackend {
	/**
	 * Absolute paths whose file/folder name contains `query` (case-insensitive
	 * substring); `scope` restricts hits to that folder subtree. `null` means
	 * "no index could answer" so the caller walks the disk instead.
	 */
	search(query: string, scope?: string): Promise<readonly string[] | null>;
	/** Start the platform index daemon/instance and leave it running. Never throws. */
	ensureDaemon(): Promise<void>;
	/** Stop a daemon this process started (tests / manual QA). Never throws. */
	stop(): Promise<void>;
}

export interface FileNameSearchDeps {
	/** App-owned state (the watch pid file lives under `<userDataDir>/fsearch`). */
	readonly userDataDir: string;
	/** The sidebar locations; Everything indexes the scanned ones. */
	readonly locations: () => Promise<readonly FsLocation[]>;
	readonly platform?: NodeJS.Platform;
	readonly env?: NodeJS.ProcessEnv;
	/** Explicit `fsearch-cli` path; overrides PATH and the Homebrew fallbacks. */
	readonly binaryPath?: string;
	readonly run?: FileNameSearchRunner;
	readonly launch?: FileNameSearchLauncher;
	readonly isProcessAlive?: (pid: number) => boolean;
	readonly killProcess?: (pid: number) => void;
	readonly everythingFactory?: (options: {
		readonly root: string;
		readonly folders: readonly string[];
	}) => EverythingSearchClient;
	readonly onWarn?: (message: string) => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 5_000;
const FAST_XDG_PROBE_TIMEOUT_MS = 250;
const POLL_INTERVAL_MS = 250;
const SEARCH_MAX_RESULTS = 200;
const FSEARCH_CANDIDATE_CAP = 1_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

interface FsearchTarget {
	readonly dbPath: string;
	readonly socketPath: string;
}

/**
 * Short, stable daemon socket path for an AutoRAG workspace database — matches
 * `FSearchClient.fsearchSocketPath` in `@autorag/librarian` so we connect to the
 * live watch daemon Dazzi's index refresh already keeps running.
 */
function fsearchWorkspaceSocketPath(dbPath: string): string {
	let canonical: string;
	try {
		canonical = realpathSync(dbPath);
	} catch {
		canonical = resolve(dbPath);
	}
	const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
	return `/tmp/autorag-fsearch-${process.getuid?.() ?? 0}-${hash}.sock`;
}

function buildFSearchArgs(
	dbPath: string,
	socketPath: string,
	request: { readonly query: string; readonly maxResults: number; readonly path?: string },
): string[] {
	const limit = request.path !== undefined ? FSEARCH_CANDIDATE_CAP : Math.min(request.maxResults, FSEARCH_CANDIDATE_CAP);
	return ["search", "--db", dbPath, "--socket", socketPath, "--json", "-r", "--limit", String(limit), "--", request.query];
}

function parseFSearchPaths(stdout: string): string[] {
	const paths: string[] = [];
	for (const line of stdout.split("\n")) {
		const text = line.trim();
		if (text.length === 0) continue;
		const record = JSON.parse(text) as { done?: unknown; path?: unknown };
		if (record.done === true) continue;
		paths.push(String(record.path ?? ""));
	}
	return paths;
}

function userHomeDir(env: NodeJS.ProcessEnv): string {
	const candidate = env.HOME ?? env.USERPROFILE;
	return candidate && isAbsolute(candidate) ? candidate : homedir();
}

function expandConfiguredPath(raw: string, baseDir: string, home: string): string {
	if (raw === "~") return home;
	if (raw.startsWith("~/") || raw.startsWith("~\\")) return join(home, raw.slice(2));
	return isAbsolute(raw) ? raw : resolve(baseDir, raw);
}

function workspaceFsearchTarget(env: NodeJS.ProcessEnv): FsearchTarget | undefined {
	const home = userHomeDir(env);
	const autoragHome = env.AUTORAG_HOME?.trim() ? resolve(env.AUTORAG_HOME.trim()) : join(home, ".autorag");
	const configPath = env.AUTORAG_CONFIG?.trim() || join(autoragHome, "config.json");
	let workspacePath = env.AUTORAG_WORKSPACE?.trim() ? resolve(env.AUTORAG_WORKSPACE.trim()) : undefined;
	if (workspacePath === undefined && existsSync(configPath)) {
		try {
			const raw = JSON.parse(readFileSync(configPath, "utf8")) as { workspacePath?: unknown };
			if (typeof raw.workspacePath === "string" && raw.workspacePath.trim().length > 0) {
				workspacePath = expandConfiguredPath(raw.workspacePath.trim(), dirname(resolve(configPath)), home);
			}
		} catch {
			// Malformed config → skip workspace fallback.
		}
	}
	workspacePath ??= join(autoragHome, "workspace");
	const dbPath = join(workspacePath, ".autorag", "fsearch", "fsearch.db");
	if (!existsSync(dbPath)) return undefined;
	return { dbPath, socketPath: fsearchWorkspaceSocketPath(dbPath) };
}

function xdgFsearchTarget(env: NodeJS.ProcessEnv): FsearchTarget | undefined {
	const home = userHomeDir(env);
	const xdgData = env.XDG_DATA_HOME?.trim() ? resolve(env.XDG_DATA_HOME.trim()) : join(home, ".local", "share");
	const dbPath = join(xdgData, "fsearch", "fsearch.db");
	if (!existsSync(dbPath)) return undefined;
	return { dbPath, socketPath: `${dbPath}.sock` };
}

function parseStatsDb(stdout: string): { readonly db?: string; readonly live: boolean; readonly empty: boolean } | undefined {
	try {
		const parsed = JSON.parse(stdout.trim()) as { db?: unknown; live?: unknown; files?: unknown; folders?: unknown };
		const files = typeof parsed.files === "number" ? parsed.files : undefined;
		const folders = typeof parsed.folders === "number" ? parsed.folders : undefined;
		return {
			...(typeof parsed.db === "string" && parsed.db.length > 0 ? { db: parsed.db } : {}),
			live: parsed.live === true,
			empty: files !== undefined && folders !== undefined && files + folders === 0,
		};
	} catch {
		return undefined;
	}
}
/**
 * `fsearch-cli` on the login PATH; a Finder-launched app inherits a minimal
 * PATH, so the Homebrew/Linux install locations are probed too.
 */
function fsearchCandidates(deps: FileNameSearchDeps): readonly string[] {
	const env = deps.env ?? process.env;
	return [
		deps.binaryPath,
		env.AUTORAG_FSEARCH_BIN,
		"fsearch-cli",
		"/opt/homebrew/bin/fsearch-cli",
		"/usr/local/bin/fsearch-cli",
		"/usr/bin/fsearch-cli",
	].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
}

/** Escape a literal query so the index's regex mode matches it as a substring. */
export function escapeSearchRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Regex for the fsearch index. macOS stores Hangul file names decomposed (NFD)
 * while typed queries are composed (NFC), and the index compares bytes, so a
 * name matches only when the query uses the same form. Sending both forms as
 * an alternation finds either spelling; a query that has one form (ASCII)
 * stays the plain escaped substring.
 */
export function fsearchRegexQuery(text: string): string {
	const trimmed = text.trim();
	const forms = [...new Set([trimmed.normalize("NFC"), trimmed.normalize("NFD")])];
	if (forms.length === 1) return escapeSearchRegex(trimmed);
	return `(?:${forms.map(escapeSearchRegex).join("|")})`;
}

/**
 * Everything's `regex:` search function is the working regex surface on the
 * bundled ES build (`-regex` answers nothing there). A bare space ends the
 * function's argument, so spaces become `\x20` to keep a literal substring.
 */
export function everythingRegexQuery(text: string): string {
	return `regex:${escapeSearchRegex(text.trim()).replace(/ /g, "\\x20")}`;
}

export function createFileNameSearch(deps: FileNameSearchDeps): FileNameSearchBackend {
	const platform = deps.platform ?? process.platform;
	const warn = deps.onWarn ?? ((message: string) => console.warn(`[file-name-search] ${message}`));
	if (platform === "win32") return createEverythingBackend(deps, warn);
	if (platform === "darwin" || platform === "linux") return createFsearchBackend(deps, warn);
	return {
		search: async () => null,
		ensureDaemon: async () => {},
		stop: async () => {},
	};
}

function createFsearchBackend(deps: FileNameSearchDeps, warn: (message: string) => void): FileNameSearchBackend {
	const env = deps.env ?? process.env;
	const run = deps.run ?? runProcess;
	const launch = deps.launch ?? launchDetached;
	const isAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
	const kill = deps.killProcess ?? ((pid: number) => process.kill(pid, "SIGTERM"));
	const pidPath = join(deps.userDataDir, "fsearch", "watch.pid");
	let binary: string | undefined;
	let binaryResolved = false;
	let target: FsearchTarget | undefined;
	let targetResolved = false;
	let targetInFlight: Promise<FsearchTarget | undefined> | undefined;
	let spawnedPid: number | undefined;

	async function resolveBinary(): Promise<string | undefined> {
		if (binaryResolved) return binary;
		binaryResolved = true;
		for (const candidate of fsearchCandidates(deps)) {
			const probe = await run(candidate, ["--version"], PROBE_TIMEOUT_MS);
			if (probe.code === 0) {
				binary = candidate;
				return binary;
			}
		}
		return undefined;
	}

	/**
	 * Resolve a populated `fsearch` database + socket once:
	 * 1. Probe the user's XDG default database first (passing `--socket` when the file exists on disk so a live
	 *    daemon answers in ~30 ms instead of cold-loading a multi-hundred-MB index from disk).
	 * 2. When no XDG database exists, or when it is empty/wedged while Dazzi's own workspace index exists,
	 *    fall over to `<workspacePath>/.autorag/fsearch/fsearch.db` and its short `/tmp` socket.
	 */
	function resolveTarget(binaryPath: string): Promise<FsearchTarget | undefined> {
		if (targetResolved) return Promise.resolve(target);
		targetInFlight ??= (async () => {
			const workspace = workspaceFsearchTarget(env);
			const xdg = xdgFsearchTarget(env);
			const xdgTimeout = workspace !== undefined ? FAST_XDG_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS * 2;
			const xdgArgs = xdg !== undefined ? ["stats", "--db", xdg.dbPath, "--socket", xdg.socketPath] : ["stats"];
			const xdgStats = await run(binaryPath, xdgArgs, xdgTimeout);
			if (xdgStats.code === 0) {
				const parsed = parseStatsDb(xdgStats.stdout);
				const dbPath = parsed?.db ?? xdg?.dbPath;
				if (parsed !== undefined && dbPath !== undefined && (!parsed.empty || workspace === undefined)) {
					target = { dbPath, socketPath: `${dbPath}.sock` };
					targetResolved = true;
					return target;
				}
			}
			if (workspace !== undefined) {
				const wsStats = await run(binaryPath, ["stats", "--db", workspace.dbPath, "--socket", workspace.socketPath], PROBE_TIMEOUT_MS * 2);
				const parsed = wsStats.code === 0 ? parseStatsDb(wsStats.stdout) : undefined;
				if (parsed !== undefined && !parsed.empty) {
					target = workspace;
					targetResolved = true;
					return target;
				}
			}
			targetResolved = true;
			return undefined;
		})().finally(() => {
			targetInFlight = undefined;
		});
		return targetInFlight;
	}

	async function isLive(binaryPath: string, current: FsearchTarget): Promise<boolean> {
		const stats = await run(binaryPath, ["stats", "--db", current.dbPath, "--socket", current.socketPath], PROBE_TIMEOUT_MS * 2);
		if (stats.code !== 0) return false;
		return parseStatsDb(stats.stdout)?.live === true;
	}

	return {
		async search(query, scope) {
			const binaryPath = await resolveBinary();
			if (binaryPath === undefined) return null;
			const current = await resolveTarget(binaryPath);
			if (current === undefined) return null;
			const args = buildFSearchArgs(current.dbPath, current.socketPath, {
				query: fsearchRegexQuery(query),
				maxResults: SEARCH_MAX_RESULTS,
				...(scope === undefined ? {} : { path: scope }),
			});
			const result = await run(binaryPath, args, DEFAULT_TIMEOUT_MS);
			if (result.code !== 0) return null;
			try {
				const paths = parseFSearchPaths(result.stdout);
				const scoped =
					scope === undefined ? paths : paths.filter((path) => path === scope || path.startsWith(`${scope}/`));
				return scoped.slice(0, SEARCH_MAX_RESULTS);
			} catch {
				return null;
			}
		},
		async ensureDaemon() {
			try {
				const binaryPath = await resolveBinary();
				if (binaryPath === undefined) return;
				const current = await resolveTarget(binaryPath);
				if (current === undefined) return;
				if (await isLive(binaryPath, current)) return;
				// A tracked daemon that is still rescanning is not `live` yet;
				// spawning another would only lose the socket race, so adopt it.
				const tracked = readPid(pidPath);
				if (tracked !== undefined && isAlive(tracked)) return;
				const pid = launch(binaryPath, ["watch", "--db", current.dbPath, "--socket", current.socketPath, "--quiet"]);
				if (pid === undefined) return;
				spawnedPid = pid;
				mkdirSync(join(deps.userDataDir, "fsearch"), { recursive: true });
				writeFileSync(pidPath, String(pid));
				const deadline = Date.now() + STARTUP_TIMEOUT_MS;
				while (Date.now() < deadline) {
					if (await isLive(binaryPath, current)) return;
					await sleep(POLL_INTERVAL_MS);
				}
			} catch (error) {
				warn(`fsearch daemon failed to start: ${errorMessage(error)}`);
			}
		},
		async stop() {
			const pid = spawnedPid ?? readPid(pidPath);
			if (pid !== undefined && isAlive(pid)) {
				try {
					kill(pid);
				} catch (error) {
					warn(`fsearch daemon did not stop: ${errorMessage(error)}`);
				}
			}
			rmSync(pidPath, { force: true });
			spawnedPid = undefined;
		},
	};
}

function createEverythingBackend(deps: FileNameSearchDeps, warn: (message: string) => void): FileNameSearchBackend {
	let client: EverythingSearchClient | undefined;
	async function getClient(): Promise<EverythingSearchClient> {
		if (client === undefined) {
			const folders = (await deps.locations())
				.filter((location) => location.scanned && location.available && location.path !== RECENTS_PATH)
				.map((location) => location.path);
			if (deps.everythingFactory === undefined) {
				throw new Error("everythingFactory is required on win32");
			}
			client = deps.everythingFactory({ root: deps.userDataDir, folders });
		}
		return client;
	}
	return {
		async search(query, scope) {
			const request: EverythingSearchRequest = {
				query: everythingRegexQuery(query),
				maxResults: SEARCH_MAX_RESULTS,
				...(scope === undefined ? {} : { path: scope }),
			};
			const result = await (await getClient()).search(request);
			return result.ok ? result.results.map((entry) => entry.path) : null;
		},
		async ensureDaemon() {
			try {
				const outcome = await (await getClient()).index();
				if (!outcome.ok) warn(`everything index failed: ${outcome.message ?? outcome.reason ?? "unknown error"}`);
			} catch (error) {
				warn(`everything instance failed to start: ${errorMessage(error)}`);
			}
		},
		async stop() {
			try {
				await client?.stop();
			} catch (error) {
				warn(`everything instance did not stop: ${errorMessage(error)}`);
			}
		},
	};
}

function readPid(pidPath: string): number | undefined {
	try {
		const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

function runProcess(command: string, args: readonly string[], timeoutMs: number): Promise<FileNameRunResult> {
	let resolvePromise!: (result: FileNameRunResult) => void;
	const promise = new Promise<FileNameRunResult>((resolve) => {
		resolvePromise = resolve;
	});
	const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let bytes = 0;
	let overflow = false;
	const collect = (target: Buffer[]) => (chunk: Buffer) => {
		bytes += chunk.length;
		if (bytes > MAX_OUTPUT_BYTES) {
			overflow = true;
			child.kill();
			return;
		}
		target.push(chunk);
	};
	child.stdout.on("data", collect(stdout));
	child.stderr.on("data", collect(stderr));
	const timer = setTimeout(() => child.kill(), timeoutMs);
	child.on("error", (error) => {
		clearTimeout(timer);
		resolvePromise({ code: null, stdout: "", stderr: `${command}: ${error.message}` });
	});
	child.on("close", (code, signal) => {
		clearTimeout(timer);
		const text = Buffer.concat(stderr).toString("utf8");
		resolvePromise({
			code,
			stdout: Buffer.concat(stdout).toString("utf8"),
			stderr: overflow
				? `${text}\noutput exceeded ${MAX_OUTPUT_BYTES} bytes`
				: signal !== null
					? `${text}\nkilled by ${signal} after ${timeoutMs}ms`
					: text,
		});
	});
	return promise;
}

function launchDetached(command: string, args: readonly string[]): number | undefined {
	const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
	child.on("error", () => {
		// `stats` keeps reporting `live:false`; searches still load the database file.
	});
	child.unref();
	return child.pid;
}

function defaultIsProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
