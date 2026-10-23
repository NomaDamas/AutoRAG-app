/**
 * File automations: the rules the librarian keeps in `<AUTORAG_HOME>/automations.json`
 * (a folder to watch, a trigger, a command) and the background daemon that runs them.
 * The librarian owns the file format and the daemon; the app lists the rules, deletes
 * one (and undoes it), and starts or stops the daemon. Editing and adding go through
 * an AI Search conversation, where the librarian agent's `manage_automations` tool
 * writes the file.
 */

export const AUTOMATION_CHANNELS = {
	get: "automations:get",
	remove: "automations:remove",
	restore: "automations:restore",
	setDaemon: "automations:setDaemon",
	changed: "automations:changed",
} as const;

export type AutomationEventType = "create" | "update" | "delete";

/** One run of a rule: the last line of its `automations/logs/<id>.jsonl`. */
export interface AutomationRun {
	/** Epoch milliseconds. */
	readonly startedAt: number;
	readonly durationMs: number;
	/** How many file changes the run handled. */
	readonly eventCount: number;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly timedOut: boolean;
	/** The command could not start (`spawn x ENOENT`) or failed before exiting. */
	readonly error?: string;
}

/** A rule as the librarian parses it (`~` expanded, defaults filled) plus its last run. */
export interface AutomationRule {
	readonly id: string;
	/** Absolute folders watched recursively. */
	readonly paths: readonly string[];
	readonly events: readonly AutomationEventType[];
	/** Globs relative to a watched folder. */
	readonly include: readonly string[];
	readonly exclude: readonly string[];
	/** The command's argv, run without a shell. */
	readonly run: readonly string[];
	readonly appendFiles: boolean;
	readonly debounceMs: number;
	readonly timeoutMs: number;
	readonly lastRun: AutomationRun | null;
}

/** The OS login service that runs the daemon (launchd, systemd --user, Task Scheduler). */
export interface AutomationDaemon {
	readonly platform: string;
	/** The service definition is registered with the OS. */
	readonly installed: boolean;
	/** The daemon process is running right now. */
	readonly running: boolean;
}

export interface AutomationsSnapshot {
	/** False only before the main process answered the first read. */
	readonly ready: boolean;
	readonly rules: readonly AutomationRule[];
	/** Null when the librarian could not report it. */
	readonly daemon: AutomationDaemon | null;
	readonly configPath: string;
	/** The rules file exists but the librarian refuses it; `rules` is then empty. */
	readonly configError: string | null;
	/** Reading failed outright (the librarian CLI did not run); `rules` keeps the last good list. */
	readonly error: string | null;
}

export const IDLE_AUTOMATIONS: AutomationsSnapshot = {
	ready: false,
	rules: [],
	daemon: null,
	configPath: "",
	configError: null,
	error: null,
};

/** What `remove` took out of the rules file, exactly as written, so `restore` can put it back. */
export interface AutomationRemoval {
	readonly entry: Readonly<Record<string, unknown>>;
	/** Position the entry had in the file's `automations` array. */
	readonly index: number;
}

export interface AutomationBridge {
	get(): Promise<AutomationsSnapshot>;
	/** Delete rule `id` from the rules file. The folder and its files are untouched. */
	remove(id: string): Promise<{ readonly snapshot: AutomationsSnapshot; readonly removal: AutomationRemoval }>;
	/** Put a removed rule back where it was. */
	restore(removal: AutomationRemoval): Promise<AutomationsSnapshot>;
	/** Register (true) or remove (false) the daemon's login service. */
	setDaemon(enabled: boolean): Promise<AutomationsSnapshot>;
	/** Pushed whenever the rules file, a run log, or the daemon changes, whoever changed it. */
	onChange(listener: (snapshot: AutomationsSnapshot) => void): () => void;
}
