import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { IDLE_AUTOMATIONS, type AutomationDaemon, type AutomationRemoval, type AutomationRule, type AutomationRun, type AutomationsSnapshot } from "../shared/automation-contract";
import { isJsonObject } from "../shared/settings-contract";
import { t } from "../shared/i18n/core";

/**
 * File automations. The librarian owns `<home>/automations.json`, the run logs and the
 * daemon, and none of that is part of its package exports, so the app goes through the
 * `autorag automate …` CLI: `status --json` is the one read — skipped when there is no
 * rules file at all, so an app with no automations never pays for the spawn — and
 * `install`/`uninstall` start and stop the daemon. Deleting a rule is not something that
 * CLI can do at all (the agent does it with its `manage_automations` tool), so the app
 * rewrites the file itself and puts every other entry back exactly as it was written.
 * The daemon re-reads the file on its own — it polls once a second — so nothing here has
 * to touch it.
 */

export interface AutomationCliResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface AutomationService {
	snapshot(): Promise<AutomationsSnapshot>;
	/** Delete rule `id` from the rules file; `removal` carries the entry back for `restore`. */
	remove(id: string): Promise<{ readonly snapshot: AutomationsSnapshot; readonly removal: AutomationRemoval }>;
	restore(removal: AutomationRemoval): Promise<AutomationsSnapshot>;
	/** Register (true) or remove (false) the daemon's login service. */
	setDaemon(enabled: boolean): Promise<AutomationsSnapshot>;
	/** Watch for changes; `onChange` fires only when something about the automations actually changed. Returns the stop function. */
	start(onChange: (snapshot: AutomationsSnapshot) => void): () => void;
}

export interface AutomationServiceDeps {
	/** `<AUTORAG_HOME>`; read on each call so a changed environment is honoured. */
	readonly home: () => string;
	/** Runs `autorag <args>`. */
	readonly run: (args: readonly string[]) => Promise<AutomationCliResult>;
	readonly pollMs?: number;
	/** Liveness probe for the pid in the daemon lock; `EPERM` counts as alive. */
	readonly pidAlive?: (pid: number) => boolean;
}

/** The librarian's operator home: `AUTORAG_HOME` when set, `<homeDir>/.autorag` otherwise. */
export function automationsHome(env: NodeJS.ProcessEnv, homeDir: string): string {
	const configured = env.AUTORAG_HOME?.trim();
	return configured === undefined || configured.length === 0 ? join(homeDir, ".autorag") : resolve(configured);
}

export interface LibrarianCommandDeps {
	/** Electron's `process.resourcesPath`: the bundle that carries `tools/node`. */
	readonly resourcesPath: string;
	readonly env: NodeJS.ProcessEnv;
	readonly platform: NodeJS.Platform;
	/** Defaults to `existsSync`; injected in tests so no real bundle is needed. */
	readonly exists?: (path: string) => boolean;
	/** Test seam for `createRequire`: what `@autorag/librarian` resolves to. */
	readonly resolvePackage?: (specifier: string) => string;
}

export interface LibrarianCommand {
	readonly command: string;
	readonly args: readonly string[];
}

/** The installed librarian CLI is not on disk: nothing can be read, and nothing must be spawned in its place. */
export class LibrarianCliMissingError extends Error {
	constructor() {
		super(t("main.automations.errors.cliMissing"));
		this.name = "LibrarianCliMissingError";
	}
}

/**
 * How to run the installed librarian CLI: a real Node binary plus the CLI's entry file.
 *
 * The app's own `process.execPath` is deliberately not used. `automate install` writes
 * the node binary of whatever process ran it into the login service, so registering from
 * Electron would define a service that starts a second copy of the app. The installer
 * carries Node at `<tools>/node` — the runtime the bundled tools already use.
 */
export function librarianCommand(deps: LibrarianCommandDeps): LibrarianCommand {
	const exists = deps.exists ?? existsSync;
	const resolvePackage = deps.resolvePackage ?? ((specifier: string) => createRequire(import.meta.url).resolve(specifier));
	let entry: string;
	try {
		entry = resolvePackage("@autorag/librarian");
	} catch {
		throw new LibrarianCliMissingError();
	}
	// The package's exports map only allows "." and "./core", so the CLI is found by path next to its entry.
	const cliEntry = join(dirname(entry), "cli", "index.js");
	if (!exists(cliEntry)) throw new LibrarianCliMissingError();

	const toolsRoot = deps.env.AUTORAG_TOOLS_DIR?.trim() || join(deps.resourcesPath, "tools");
	const bundledNode = join(toolsRoot, "node");
	const command = exists(bundledNode) ? join(bundledNode, deps.platform === "win32" ? "node.exe" : join("bin", "node")) : "node";
	return { command, args: [cliEntry] };
}

/** Installing or removing the login service waits for the daemon to take its lock, so it gets a longer leash. */
const SLOW_COMMANDS: readonly string[] = ["install", "uninstall"];
const SLOW_TIMEOUT_MS = 60_000;
const TIMEOUT_MS = 30_000;

/** Runs the librarian CLI without a shell. Never rejects: a command that could not start comes back as a non-zero code. */
export function runLibrarianCli(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<AutomationCliResult> {
	const timeout = args.some((arg) => SLOW_COMMANDS.includes(arg)) ? SLOW_TIMEOUT_MS : TIMEOUT_MS;
	const launched = Promise.withResolvers<AutomationCliResult>();
	execFile(command, [...args], { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env }, (error, stdout, stderr) => {
		const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
		launched.resolve({ code, stdout: String(stdout), stderr: String(stderr) || error?.message || "" });
	});
	return launched.promise;
}

/** One line saying why a CLI run failed, short enough to show in the window. */
export function cliFailureReason(result: AutomationCliResult, limit = 300): string {
	const detail = (result.stderr.trim() || result.stdout.trim()).replaceAll(/\s+/gu, " ");
	return `exit ${result.code}${detail.length === 0 ? "" : `: ${detail.slice(0, limit)}`}`;
}

function textArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function runOf(value: unknown): AutomationRun | null {
	if (!isJsonObject(value) || typeof value.startedAt !== "string") return null;
	const startedAt = Date.parse(value.startedAt);
	if (Number.isNaN(startedAt)) return null;
	return {
		startedAt,
		durationMs: typeof value.durationMs === "number" ? value.durationMs : 0,
		eventCount: typeof value.eventCount === "number" ? value.eventCount : 0,
		exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
		signal: typeof value.signal === "string" ? value.signal : null,
		timedOut: value.timedOut === true,
		...(typeof value.error === "string" && value.error.length > 0 ? { error: value.error } : {}),
	};
}

/** The `agent` a rule runs instead of a command; absent when the rule has none or it is not the shape the librarian writes. */
function agentOf(value: unknown): Pick<AutomationRule, "agent"> {
	if (!isJsonObject(value) || typeof value.profile !== "string" || typeof value.task !== "string") return {};
	return { agent: { profile: value.profile, task: value.task } };
}

function ruleOf(value: unknown): AutomationRule | null {
	if (!isJsonObject(value) || typeof value.id !== "string") return null;
	const events = textArray(value.events).filter((event): event is AutomationRule["events"][number] => event === "create" || event === "update" || event === "delete");
	return {
		id: value.id,
		paths: textArray(value.paths),
		events,
		include: textArray(value.include),
		exclude: textArray(value.exclude),
		run: textArray(value.run),
		...agentOf(value.agent),
		appendFiles: value.appendFiles === true,
		debounceMs: typeof value.debounceMs === "number" ? value.debounceMs : 0,
		timeoutMs: typeof value.timeoutMs === "number" ? value.timeoutMs : 0,
		lastRun: runOf(value.lastRun),
	};
}

/** One `automate status --json` line onto the contract; null when the output is not that report at all. */
function parseStatus(stdout: string): AutomationsSnapshot | null {
	const line = stdout
		.split("\n")
		.map((row) => row.trim())
		.filter((row) => row.length > 0)
		.at(-1);
	if (line === undefined) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isJsonObject(parsed) || !Array.isArray(parsed.automations)) return null;

	const service = isJsonObject(parsed.service) ? parsed.service : {};
	const daemon: AutomationDaemon = {
		platform: typeof service.platform === "string" ? service.platform : "",
		installed: service.installed === true,
		running: service.running === true,
	};
	const configError = typeof parsed.configError === "string" ? parsed.configError : null;
	return {
		ready: true,
		// A refused file yields no rules; say so even if some version ever reports both.
		rules: configError === null ? parsed.automations.map(ruleOf).filter((rule): rule is AutomationRule => rule !== null) : [],
		daemon,
		configPath: typeof parsed.configPath === "string" ? parsed.configPath : "",
		configError,
		error: null,
	};
}

function alivePid(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists, it is just not ours to signal.
		return isJsonObject(error) && error.code === "EPERM";
	}
}

export function createAutomationService(deps: AutomationServiceDeps): AutomationService {
	const rulesPath = (): string => join(deps.home(), "automations.json");
	const pidAlive = deps.pidAlive ?? alivePid;

	/** The last good read; a failed read is reported over it, so the window never loses the list it had. */
	let current: AutomationsSnapshot = IDLE_AUTOMATIONS;
	let inFlight: Promise<AutomationsSnapshot> | null = null;
	// Removing and restoring are read-modify-write on one file; running them one after another keeps a burst from losing edits.
	let queue: Promise<unknown> = Promise.resolve();
	const serialized = <T>(work: () => Promise<T>): Promise<T> => {
		const next = queue.then(work, work);
		queue = next.catch(() => undefined);
		return next;
	};

	/** False only when the rules file is really not there; anything else (a permission problem, say) goes to the CLI. */
	const rulesFilePresent = async (): Promise<boolean> => {
		try {
			await stat(rulesPath());
			return true;
		} catch (error) {
			return !(isJsonObject(error) && error.code === "ENOENT");
		}
	};

	/** Nobody ever automated anything here: no rules, no daemon, and nothing to ask the CLI about. */
	const emptySnapshot = (): AutomationsSnapshot => ({ ready: true, rules: [], daemon: null, configPath: rulesPath(), configError: null, error: null });

	const read = async (): Promise<AutomationsSnapshot> => {
		// The one read spawns a Node process (~1s), and this service is read at every app start: an absent
		// file answers itself. A file that exists — empty or broken — is the librarian's to judge, not ours.
		if (!(await rulesFilePresent())) {
			current = emptySnapshot();
			return current;
		}
		try {
			const result = await deps.run(["automate", "status", "--json"]);
			const snapshot = parseStatus(result.stdout);
			if (snapshot === null) throw new Error(cliFailureReason(result));
			current = snapshot;
			return snapshot;
		} catch (error) {
			if (error instanceof LibrarianCliMissingError) return { ...current, ready: true, error: error.message };
			return { ...current, ready: true, error: t("main.automations.errors.cliFailed", { reason: error instanceof Error ? error.message : String(error) }) };
		}
	};

	const snapshot = (): Promise<AutomationsSnapshot> => {
		inFlight ??= read().finally(() => {
			inFlight = null;
		});
		return inFlight;
	};

	/** After a write: a read already in flight may have started before it, so let that one settle first. */
	const freshSnapshot = async (): Promise<AutomationsSnapshot> => {
		await inFlight?.catch(() => undefined);
		return snapshot();
	};

	/** The rules file as the librarian wrote it, entries untouched. */
	const loadEntries = async (options: { readonly required: boolean }): Promise<Record<string, unknown>[]> => {
		const path = rulesPath();
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch (error) {
			if (!options.required && isJsonObject(error) && error.code === "ENOENT") return [];
			throw new Error(t("main.automations.errors.unreadable", { reason: error instanceof Error ? error.message : String(error) }));
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new Error(t("main.automations.errors.unreadable", { reason: `${path}: ${error instanceof Error ? error.message : String(error)}` }));
		}
		if (!isJsonObject(parsed) || !Array.isArray(parsed.automations)) throw new Error(t("main.automations.errors.unreadable", { reason: `${path}: no automations array` }));
		return parsed.automations.filter(isJsonObject);
	};

	/** Replace the whole file at once: the daemon must never reload a half-written rules file. */
	const saveEntries = async (entries: readonly Record<string, unknown>[]): Promise<void> => {
		const path = rulesPath();
		const temporary = `${path}.${process.pid}.tmp`;
		const mode = (await stat(path).catch(() => null))?.mode;
		try {
			await writeFile(temporary, `${JSON.stringify({ automations: entries }, null, 2)}\n`, mode === undefined ? undefined : { mode });
			await rename(temporary, path);
		} catch (error) {
			await rm(temporary, { force: true });
			throw error;
		}
	};

	return {
		snapshot,
		remove: (id) =>
			serialized(async () => {
				const entries = await loadEntries({ required: true });
				const index = entries.findIndex((entry) => entry.id === id);
				if (index === -1) throw new Error(t("main.automations.errors.unknownRule", { id }));
				const removal: AutomationRemoval = { entry: entries[index] as Record<string, unknown>, index };
				await saveEntries(entries.filter((_entry, at) => at !== index));
				return { snapshot: await freshSnapshot(), removal };
			}),
		restore: (removal) =>
			serialized(async () => {
				const { entry } = removal;
				if (!isJsonObject(entry) || typeof entry.id !== "string" || entry.id.length === 0) throw new Error(t("main.automations.errors.invalidRemoval"));
				const entries = await loadEntries({ required: false });
				if (entries.some((existing) => existing.id === entry.id)) throw new Error(t("main.automations.errors.duplicateRule", { id: entry.id }));
				const index = Math.max(0, Math.min(removal.index, entries.length));
				await saveEntries([...entries.slice(0, index), entry, ...entries.slice(index)]);
				return freshSnapshot();
			}),
		setDaemon: async (enabled) => {
			const result = await deps.run(["automate", enabled ? "install" : "uninstall", "--json"]);
			if (result.code !== 0) throw new Error(t("main.automations.errors.cliFailed", { reason: cliFailureReason(result) }));
			return freshSnapshot();
		},
		start: (onChange) => {
			/** Whether the daemon holds its lock (a directory with `owner-<token>.json`), by probing that pid. */
			const lockState = (): string => {
				const lock = join(deps.home(), "automations", "daemon.lock");
				let names: string[];
				try {
					names = readdirSync(lock).filter((name) => name.startsWith("owner-") && name.endsWith(".json"));
				} catch {
					return "none";
				}
				for (const name of names) {
					try {
						const owner: unknown = JSON.parse(readFileSync(join(lock, name), "utf8"));
						if (isJsonObject(owner) && typeof owner.pid === "number" && pidAlive(owner.pid)) return "up";
					} catch {
						continue;
					}
				}
				return "down";
			};

			/** Everything the app shows without asking the CLI: the rules file, the run logs, the daemon. */
			const signature = async (): Promise<string> => {
				const rules = await stat(rulesPath()).catch(() => null);
				const parts = [`rules:${rules === null ? "missing" : `${rules.mtimeMs}:${rules.size}`}`];
				const logsDir = join(deps.home(), "automations", "logs");
				const names = (await readdir(logsDir).catch(() => [] as string[])).filter((name) => name.endsWith(".jsonl")).sort();
				for (const name of names) {
					const log = await stat(join(logsDir, name)).catch(() => null);
					parts.push(`log:${name}:${log === null ? "gone" : `${log.mtimeMs}:${log.size}`}`);
				}
				parts.push(`lock:${lockState()}`);
				return parts.join("|");
			};

			let lastSignature: string | null = null;
			let lastEmitted = JSON.stringify(current);
			let busy = false;
			const timer = setInterval(() => {
				if (busy) return;
				busy = true;
				void (async () => {
					const next = await signature();
					// The first poll only learns where things stand: the renderer already asked for the snapshot.
					if (lastSignature === null) {
						lastSignature = next;
						return;
					}
					if (next === lastSignature) return;
					lastSignature = next;
					const changed = await snapshot();
					const serializedChanged = JSON.stringify(changed);
					if (serializedChanged === lastEmitted) return;
					lastEmitted = serializedChanged;
					onChange(changed);
				})()
					.catch(() => undefined)
					.finally(() => {
						busy = false;
					});
			}, deps.pollMs ?? 2_000);
			timer.unref();
			return () => clearInterval(timer);
		},
	};
}
