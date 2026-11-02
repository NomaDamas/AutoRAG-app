/**
 * Contract for executing user-defined right-click Magic Actions (`MagicAction`),
 * shared by the Electron main process, the preload bridge, remote bootstrap,
 * and the renderer.
 *
 * A Magic Action executes either:
 * - `"script"`: spawns a shell command with the selected file paths in `"$@"`,
 *   `DAZZI_FILES_JSON`, `DAZZI_FILE`, and `DAZZI_FILE_COUNT`, streaming live
 *   stdout/stderr drafts and final exit code.
 * - `"agent"`: runs a dedicated pi session (`createProfileSession` from
 *   `@autorag/librarian/profiles`) on the selected file paths, streaming live
 *   `i` intent progress and assistant markdown drafts.
 */

export const MAGIC_ACTION_CHANNELS = {
	start: "magicAction:start",
	cancel: "magicAction:cancel",
	/** main → renderer event carrying one {@link MagicActionEvent}. */
	event: "magicAction:event",
} as const;

export interface MagicActionRunRequest {
	readonly actionId: string;
	readonly paths: readonly string[];
}

export function isMagicActionRunRequest(value: unknown): value is MagicActionRunRequest {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.actionId === "string" &&
		candidate.actionId.trim().length > 0 &&
		Array.isArray(candidate.paths) &&
		candidate.paths.length > 0 &&
		candidate.paths.every((p) => typeof p === "string" && p.trim().length > 0)
	);
}

export interface MagicActionResult {
	readonly actionId: string;
	readonly actionLabel: string;
	readonly executionKind: "script" | "agent";
	readonly paths: readonly string[];
	readonly output: string;
	readonly stderr?: string;
	readonly exitCode?: number | null;
	readonly durationMs: number;
}

export type MagicActionEvent =
	| {
			readonly type: "started";
			readonly runId: string;
			readonly actionId: string;
			readonly actionLabel: string;
			readonly executionKind: "script" | "agent";
			readonly paths: readonly string[];
	  }
	| {
			readonly type: "progress";
			readonly runId: string;
			readonly text: string;
	  }
	| {
			readonly type: "draft";
			readonly runId: string;
			readonly text: string;
	  }
	| {
			readonly type: "done";
			readonly runId: string;
			readonly result: MagicActionResult;
	  }
	| {
			readonly type: "error";
			readonly runId: string;
			readonly actionLabel: string;
			readonly message: string;
			readonly stderr?: string;
	  }
	| {
			readonly type: "cancelled";
			readonly runId: string;
			readonly actionLabel: string;
	  };

export interface MagicActionBridge {
	start(runId: string, request: MagicActionRunRequest): Promise<void>;
	cancel(runId: string): Promise<void>;
	onEvent(listener: (event: MagicActionEvent) => void): () => void;
}
