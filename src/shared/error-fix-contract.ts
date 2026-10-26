/**
 * Contract of the "AI로 고치기" run: the error-fix helper agent that diagnoses an
 * error the app showed and repairs what it can reach (the shared AutoRAG config,
 * the index), shared by the main process, the preload bridge and the renderer.
 * The run is a plain pi session on the AI Search model (`agents/profiles/error-fix.ts`);
 * it streams what it is looking at, then ends with exactly one terminal event.
 */

export const ERROR_FIX_CHANNELS = {
	start: "errorFix:start",
	cancel: "errorFix:cancel",
	/** main → renderer event carrying one {@link ErrorFixEvent}. */
	event: "errorFix:event",
} as const;

/** Where the error was shown; the agent is told, since the same message can mean different things. */
export type ErrorFixSurface = "ai-search";

export interface ErrorFixRequest {
	/** The message exactly as the person saw it. */
	readonly message: string;
	readonly surface: ErrorFixSurface;
}

export function isErrorFixRequest(value: unknown): value is ErrorFixRequest {
	return typeof value === "object" && value !== null && "message" in value && typeof value.message === "string" && "surface" in value && value.surface === "ai-search";
}

/** The tools whose use is announced while the agent works. */
export type ErrorFixTool = "diagnose" | "check_path" | "update_config" | "refresh_index";

/** One thing the agent is doing now; the renderer words it, `detail` (a path or a config key) is shown as it is. */
export interface ErrorFixStep {
	readonly tool: ErrorFixTool;
	readonly detail: string | null;
}

/** One config value the agent changed, as short JSON text (a secret is never writable, so none appears here). */
export interface ErrorFixChange {
	readonly path: string;
	readonly before: string | null;
	readonly after: string | null;
}

/** Settings pages the agent may point the person to; anything else it names is dropped. */
export const ERROR_FIX_SETTINGS_PAGES = ["ai", "account", "plan", "general", "web", "mcp", "indexing", "scope", "reading", "duplicates", "apps"] as const;
export type ErrorFixSettingsPage = (typeof ERROR_FIX_SETTINGS_PAGES)[number];

export type ErrorFixStatus =
	/** The agent changed something and says the cause is gone. */
	| "fixed"
	/** Only the person can act (sign in, pick a folder, ...); `nextSteps` says what. */
	| "needs-user"
	/** Nothing the agent can reach explains or repairs it. */
	| "cannot-fix";

/** What a run changed so far; every run that ends reports it, so a change made before a failure or a stop is never silent. */
export interface ErrorFixTrace {
	readonly changes: readonly ErrorFixChange[];
	/** Copy of the config taken before the first change, or null when nothing was changed. */
	readonly backupPath: string | null;
}

/**
 * A button the agent puts in its answer: where the app takes the person, and what the button says (the agent writes
 * the label, in the interface language). The agent only names a destination; the app checks it before it becomes a
 * button (a Settings page it has, a data source that is configured) and the renderer, not the agent, does the going.
 * There is no button to a folder: nothing that goes wrong in the app is cured by looking inside one.
 */
export type ErrorFixAction =
	/** A Settings page. */
	| { readonly kind: "settings"; readonly target: ErrorFixSettingsPage; readonly label: string }
	/** The Settings page of one configured data source (its alias). */
	| { readonly kind: "source"; readonly target: string; readonly label: string };

export type ErrorFixActionKind = ErrorFixAction["kind"];
/** The most buttons an answer carries. */
export const MAX_ERROR_FIX_ACTIONS = 3;
export const MAX_ERROR_FIX_LABEL_CHARS = 60;

export interface ErrorFixResult extends ErrorFixTrace {
	readonly status: ErrorFixStatus;
	/** The agent's own account, in the interface language. */
	readonly summary: string;
	/** Short steps for the person, in the interface language; empty when `fixed`. */
	readonly nextSteps: readonly string[];
	/** Where the person can go from here, in the agent's order; every destination was checked. */
	readonly actions: readonly ErrorFixAction[];
}

export type ErrorFixEvent =
	| { readonly type: "step"; readonly runId: string; readonly step: ErrorFixStep }
	| { readonly type: "result"; readonly runId: string; readonly result: ErrorFixResult }
	| ({ readonly type: "error"; readonly runId: string; readonly message: string } & ErrorFixTrace)
	| ({ readonly type: "cancelled"; readonly runId: string } & ErrorFixTrace);

export interface ErrorFixBridge {
	/** Runs one fix; resolves after its terminal event was sent. */
	start(runId: string, request: ErrorFixRequest): Promise<void>;
	cancel(runId: string): Promise<void>;
	onEvent(listener: (event: ErrorFixEvent) => void): () => void;
}
