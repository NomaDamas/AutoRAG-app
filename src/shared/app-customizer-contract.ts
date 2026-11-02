/**
 * Contract for the App Customizer helper agent (`agents/profiles/app-customizer.ts`),
 * shared by the Electron main process, the preload bridge, and the renderer.
 *
 * The agent runs on the AI Search model via `createProfileSession` from
 * `@autorag/librarian/profiles` and edits Dazzi's own `AppSettings`
 * (`settings-state.json` under `userData/settings`, separate from AutoRAG's
 * shared `config.json`) through structured tool calling.
 *
 * Conversation sessions stay in memory keyed by `sessionId` so follow-up
 * turns in the Settings customization modal remember earlier turns until reset.
 */

import type { AppSettings } from "./settings-contract";

export const APP_CUSTOMIZER_CHANNELS = {
	send: "appCustomizer:send",
	cancel: "appCustomizer:cancel",
	reset: "appCustomizer:reset",
	/** main → renderer event carrying one {@link AppCustomizerEvent}. */
	event: "appCustomizer:event",
} as const;

export interface AppCustomizerRequest {
	readonly sessionId: string;
	readonly message: string;
}

export function isAppCustomizerRequest(value: unknown): value is AppCustomizerRequest {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.sessionId === "string" &&
		candidate.sessionId.trim().length > 0 &&
		typeof candidate.message === "string" &&
		candidate.message.trim().length > 0
	);
}

/** One setting mutation performed by a tool call during a turn. */
export interface AppCustomizerChange {
	readonly kind: "sidebar" | "general";
	/** Short human-readable description of the change. */
	readonly summary: string;
	/** Settings keys modified (e.g. `["sidebar.hiddenItems"]`, `["appearance"]`). */
	readonly fields: readonly string[];
	/** Any locked-item warnings triggered during the tool call (e.g. attempting to hide AI Search or Automations). */
	readonly warnings?: readonly string[];
}

export type AppCustomizerEvent =
	| {
			readonly type: "progress";
			readonly runId: string;
			readonly sessionId: string;
			/** Live intent phrase from `i` parameter on tool calls. */
			readonly text: string;
	  }
	| {
			readonly type: "draft";
			readonly runId: string;
			readonly sessionId: string;
			/** Streamed assistant text draft for the current turn. */
			readonly text: string;
	  }
	| {
			readonly type: "turn-done";
			readonly runId: string;
			readonly sessionId: string;
			readonly reply: string;
			readonly changes: readonly AppCustomizerChange[];
			readonly settings: AppSettings;
	  }
	| {
			readonly type: "error";
			readonly runId: string;
			readonly sessionId: string;
			readonly message: string;
			readonly changes: readonly AppCustomizerChange[];
	  }
	| {
			readonly type: "cancelled";
			readonly runId: string;
			readonly sessionId: string;
			readonly changes: readonly AppCustomizerChange[];
	  };

export interface AppCustomizerBridge {
	send(runId: string, request: AppCustomizerRequest): Promise<void>;
	cancel(runId: string): Promise<void>;
	reset(sessionId: string): Promise<void>;
	onEvent(listener: (event: AppCustomizerEvent) => void): () => void;
}
