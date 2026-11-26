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
	create: "automations:create",
	update: "automations:update",
	history: "automations:history",
	changed: "automations:changed",
} as const;

export type AutomationEventType = "create" | "update" | "delete";

/** One run of a rule: a line of its `automations/logs/<id>.jsonl` (`lastRun` is the last one). */
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
	/**
	 * The files the run worked on, when the log knows them: a right-click action's run keeps them, a folder rule's
	 * log only counts them (`eventCount`). Rows name the run by its first file.
	 */
	readonly files?: readonly string[];
}

/**
 * What an agent rule runs: a profile the librarian registers in code (`file-triage` only reads,
 * `file-organizer` may change files) and the instruction it gets for each batch of changes.
 * The rules file carries only the profile's id, so a rule cannot grant an agent more than its profile allows.
 */
export interface AutomationAgent {
	readonly profile: string;
	readonly task: string;
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
	/** The command's argv, run without a shell. Empty for a rule that runs an agent instead. */
	readonly run: readonly string[];
	/** Set when the rule starts an AI agent profile on each batch of changes instead of running a command. */
	readonly agent?: AutomationAgent;
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

/** How many of a rule's runs the 자동화 tab shows: its run log keeps every one. */
export const AUTOMATION_HISTORY_LIMIT = 50;

export const IDLE_AUTOMATIONS: AutomationsSnapshot = {
	ready: false,
	rules: [],
	daemon: null,
	configPath: "",
	configError: null,
	error: null,
};

/**
 * A new rule from the 자동화 tab's 새 자동화 card (Figma 611:3601): the folder, which files, which changes, and either
 * an instruction for an agent profile or a command. The main process gives it an id and writes it to the rules file.
 */
export interface AutomationDraft {
	readonly paths: readonly string[];
	readonly events: readonly AutomationEventType[];
	/** Globs relative to the watched folder; empty takes every file. */
	readonly include: readonly string[];
	readonly agent?: { readonly profile: string; readonly task: string };
	/** The command's argv, for a rule that runs a program instead of an agent. */
	readonly run?: readonly string[];
}

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
	/** Add a rule; `id` is the one it was given. Rejected when the librarian would refuse the file it leaves. */
	create(draft: AutomationDraft): Promise<{ readonly snapshot: AutomationsSnapshot; readonly id: string }>;
	/** Rewrite rule `id` from the card; the fields the card does not manage stay as written. */
	update(id: string, draft: AutomationDraft): Promise<AutomationsSnapshot>;
	/** Rule `id`'s runs, newest first, at most {@link AUTOMATION_HISTORY_LIMIT}; empty when it never ran. */
	history(id: string): Promise<readonly AutomationRun[]>;
	/** Pushed whenever the rules file, a run log, or the daemon changes, whoever changed it. */
	onChange(listener: (snapshot: AutomationsSnapshot) => void): () => void;
}
