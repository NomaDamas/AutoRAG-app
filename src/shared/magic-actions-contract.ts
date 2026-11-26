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

import type { AutomationRun } from "./automation-contract";
import { normalizeMagicAction, type MagicAction } from "./context-menu-contract";

export const MAGIC_ACTION_CHANNELS = {
	start: "magicAction:start",
	cancel: "magicAction:cancel",
	/** Runs a candidate Magic Action inside a temporary sandbox folder to verify it works before saving. */
	verify: "magicAction:verify",
	/** Keeps a finished run in AI 에이전트's 대화 기록 as a chat of its own; resolves to that chat's id. */
	saveToHistory: "magicAction:saveToHistory",
	/** An action's finished runs, newest first, in an automation rule's run shape (the 자동화 tab's dot and 실행 기록). */
	history: "magicAction:history",
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

/** What 대화 기록에 저장 keeps of a finished run: the action's name as the question, its files, its output as the answer. */
export interface MagicActionSaveRequest {
	readonly actionLabel: string;
	readonly paths: readonly string[];
	readonly output: string;
}

export function isMagicActionSaveRequest(value: unknown): value is MagicActionSaveRequest {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.actionLabel === "string" &&
		candidate.actionLabel.trim().length > 0 &&
		typeof candidate.output === "string" &&
		Array.isArray(candidate.paths) &&
		candidate.paths.every((p) => typeof p === "string")
	);
}

export interface MagicActionVerifyRequest {
	readonly action: MagicAction;
}

export function isMagicActionVerifyRequest(value: unknown): value is MagicActionVerifyRequest {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return normalizeMagicAction(candidate.action) !== null;
}

export interface MagicActionSandboxFileSnapshot {
	readonly path: string;
	readonly kind: "file" | "folder";
	readonly size?: number;
	readonly contentPreview?: string;
}

export interface MagicActionSandboxDiff {
	readonly created: readonly MagicActionSandboxFileSnapshot[];
	readonly modified: readonly MagicActionSandboxFileSnapshot[];
	readonly deleted: readonly string[];
	readonly unchanged: readonly string[];
}

export interface MagicActionVerifyResult {
	readonly ok: boolean;
	readonly executionKind: "script" | "agent";
	readonly exitCode?: number | null;
	readonly timedOut: boolean;
	readonly durationMs: number;
	readonly output: string;
	readonly stderr?: string;
	readonly error?: string;
	readonly targetPaths: readonly string[];
	readonly diff: MagicActionSandboxDiff;
}

export interface MagicActionBridge {
	start(runId: string, request: MagicActionRunRequest): Promise<void>;
	cancel(runId: string): Promise<void>;
	verify(request: MagicActionVerifyRequest): Promise<MagicActionVerifyResult>;
	saveToHistory(request: MagicActionSaveRequest): Promise<string>;
	history(actionId: string): Promise<readonly AutomationRun[]>;
	onEvent(listener: (event: MagicActionEvent) => void): () => void;
}
