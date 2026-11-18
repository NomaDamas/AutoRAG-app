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
 * turns in the customization panel in Settings' right sidebar remember earlier turns until reset.
 */

import type { AppSettings } from "./settings-contract";

export const APP_CUSTOMIZER_CHANNELS = {
	send: "appCustomizer:send",
	cancel: "appCustomizer:cancel",
	reset: "appCustomizer:reset",
	/** main → renderer event carrying one {@link AppCustomizerEvent}. */
	event: "appCustomizer:event",
	/** renderer → main: the person's answer to one {@link AppCustomizerPrompt}. */
	answer: "appCustomizer:answer",
} as const;

/**
 * Something the assistant needs the person to do in the panel, outside the chat: type a secret into a masked field, or
 * confirm an action. The model only learns the outcome (`stored`, `confirmed`, `cancelled`), never what was typed: a secret
 * goes from the field straight to the main process (`answer`) and into the encrypted credential store.
 */
export type AppCustomizerPrompt =
	| {
			readonly kind: "secret";
			readonly id: string;
			/** What is being asked for, in the interface language ("API key for Anthropic"). */
			readonly title: string;
			/** One line that says where the value goes ("Stored encrypted on this computer; the AI never sees it."). */
			readonly detail: string;
			/** Where to get the value, shown as plain text next to the field. */
			readonly hint?: string;
	  }
	| {
			readonly kind: "confirm";
			readonly id: string;
			readonly title: string;
			/** What will happen, one item per line (a command that will run, a server that will be added). */
			readonly lines: readonly string[];
	  };

export type AppCustomizerPromptAnswer =
	| { readonly kind: "secret"; readonly value: string }
	| { readonly kind: "confirm"; readonly confirmed: boolean }
	| { readonly kind: "cancelled" };

export function isAppCustomizerPromptAnswer(value: unknown): value is AppCustomizerPromptAnswer {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	if (candidate.kind === "cancelled") return true;
	if (candidate.kind === "confirm") return typeof candidate.confirmed === "boolean";
	return candidate.kind === "secret" && typeof candidate.value === "string";
}

/**
 * Every Settings section with an AI assistant in the window's right sidebar. `sidebar`, `contextMenu` and `shortcuts`
 * edit Dazzi's own look; the rest are one section each of the shared AutoRAG config and the app preferences:
 * `general` (app preferences and the document languages), `ai` and `web` (models and web search), `indexing` and `duplicates` (what
 * is searched and how), `mcp` and `apps` (connected tools and apps).
 */
export const APP_CUSTOMIZER_SURFACES = [
	"sidebar",
	"contextMenu",
	"shortcuts",
	"general",
	"ai",
	"web",
	"indexing",
	"duplicates",
	"mcp",
	"apps",
] as const;

export type AppCustomizerSurface = (typeof APP_CUSTOMIZER_SURFACES)[number];

/** The surfaces that edit the shared AutoRAG config or the app preferences (every one but Dazzi's own sidebar, menu and shortcuts). */
export type ConfigAssistantSurface = Exclude<AppCustomizerSurface, "sidebar" | "contextMenu" | "shortcuts">;

export function isAppCustomizerSurface(value: unknown): value is AppCustomizerSurface {
	return typeof value === "string" && (APP_CUSTOMIZER_SURFACES as readonly string[]).includes(value);
}

export interface AppCustomizerRequest {
	readonly sessionId: string;
	readonly message: string;
	/** Which customization profile handles the session; defaults to `"sidebar"`. */
	readonly surface?: AppCustomizerSurface;
}

export function isAppCustomizerRequest(value: unknown): value is AppCustomizerRequest {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	const validSurface = candidate.surface === undefined || isAppCustomizerSurface(candidate.surface);
	return (
		validSurface &&
		typeof candidate.sessionId === "string" &&
		candidate.sessionId.trim().length > 0 &&
		typeof candidate.message === "string" &&
		candidate.message.trim().length > 0
	);
}

/** One setting mutation performed by a tool call during a turn. */
export interface AppCustomizerChange {
	readonly kind: "sidebar" | "contextMenu" | "shortcuts" | "general" | "ai" | "search" | "connections";
	/** Short human-readable description of the change. */
	readonly summary: string;
	/** Settings keys modified (e.g. `["sidebar.hiddenItems"]`, `["appearance"]`). */
	readonly fields: readonly string[];
	/** Any locked-item warnings triggered during the tool call (e.g. attempting to hide AI Search or Automations). */
	readonly warnings?: readonly string[];
}

export type AppCustomizerEvent =
	| {
			readonly type: "prompt";
			readonly runId: string;
			readonly sessionId: string;
			readonly prompt: AppCustomizerPrompt;
	  }
	| {
			/** The prompt is gone: answered, the run was stopped, or it timed out. The panel removes its card. */
			readonly type: "prompt-closed";
			readonly runId: string;
			readonly sessionId: string;
			readonly promptId: string;
	  }
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
			/** Streamed assistant text draft for the active step. */
			readonly text: string;
	  }
	| {
			readonly type: "assistant-message";
			readonly runId: string;
			readonly sessionId: string;
			/** Completed assistant message from an intermediate step before tool execution continues. */
			readonly text: string;
	  }
	| {
			readonly type: "turn-done";
			readonly runId: string;
			readonly sessionId: string;
			readonly messages: readonly string[];
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
	/** The person's answer to a prompt card. A secret is sent here once and never kept by the renderer. */
	answer(promptId: string, answer: AppCustomizerPromptAnswer): Promise<void>;
	onEvent(listener: (event: AppCustomizerEvent) => void): () => void;
}
