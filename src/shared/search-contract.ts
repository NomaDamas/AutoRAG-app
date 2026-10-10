/**
 * Search/chat contract shared by the Electron main process and the renderer.
 *
 * The main process owns one AutoRAGAgent instance (the "main search agent")
 * and streams `searchDocumentsStream` events to the renderer over IPC.
 * Quick = the stream's `preliminary` event (emit_fast_answer fast phase);
 * Deep = the stream's `complete` event (full SearchDocumentsResponse).
 * While a phase runs, the main process also forwards the agent's live model
 * stream: `thinking` signals (once per phase) that the model started
 * reasoning — the reasoning text itself never crosses IPC — and
 * `quick-draft` / `deep-draft` carry the answer text streamed so far (a full
 * snapshot, not a delta). The following `quick` / `deep` event carries the
 * authoritative full answer and supersedes the draft. `done` closes every run
 * that was not cancelled, after any `deep` or `error` event.
 * All payloads crossing IPC are plain serializable shapes defined here —
 * never pi/librarian class instances.
 */

export const SEARCH_CHANNELS = {
	start: "search:start",
	cancel: "search:cancel",
	event: "search:event",
	historyList: "search:historyList",
	historyGet: "search:historyGet",
	historySearch: "search:historySearch",
	historyClear: "search:historyClear",
} as const;

/**
 * Something attached to a chat message: a local file or folder, or a web link.
 * Files and folders dropped on AI Search (from the Finder rows or from
 * another app) and dropped links reach the agent as context: the path or URL
 * always, and file content when it can be read.
 */
export interface ChatAttachment {
	readonly kind: "file" | "folder" | "url";
	/** Absolute path for files and folders; the URL for links. */
	readonly id: string;
	/** Display name. */
	readonly name: string;
}

export interface CitationEvidence {
	readonly number: number;
	readonly title: string;
	readonly summary: string;
	/** Real source path (local files) or datasource virtual id. */
	readonly source: string | null;
	readonly excerpts: readonly string[];
	readonly confidence: number;
}

/** One assistant answer phase mapped for the UI. */
export interface AnswerPhase {
	readonly answer: string;
	readonly evidence: readonly CitationEvidence[];
}

export type AnswerPhaseName = "quick" | "deep";

export type SearchStreamEvent =
	| { readonly type: "progress"; readonly searchId: string; readonly text: string }
	| { readonly type: "thinking"; readonly searchId: string; readonly phase: AnswerPhaseName }
	| { readonly type: "quick-draft"; readonly searchId: string; readonly text: string }
	| { readonly type: "deep-draft"; readonly searchId: string; readonly text: string }
	| { readonly type: "quick"; readonly searchId: string; readonly sessionId: string; readonly phase: AnswerPhase }
	| { readonly type: "deep"; readonly searchId: string; readonly sessionId: string; readonly phase: AnswerPhase }
	| { readonly type: "error"; readonly searchId: string; readonly message: string }
	| { readonly type: "cancelled"; readonly searchId: string }
	| { readonly type: "done"; readonly searchId: string };

export interface ChatMessageUser {
	readonly role: "user";
	readonly text: string;
	readonly attachments: readonly ChatAttachment[];
	readonly at: string;
}

export interface ChatMessageAssistant {
	readonly role: "assistant";
	readonly sessionId: string;
	readonly quick: AnswerPhase | null;
	readonly deep: AnswerPhase | null;
	readonly stopped: boolean;
	readonly at: string;
}

export type ChatMessage = ChatMessageUser | ChatMessageAssistant;

export interface ChatSummary {
	readonly id: string;
	readonly title: string;
	/** First Quick answer with markup stripped. */
	readonly snippet: string;
	readonly updatedAt: string;
}

export interface ChatRecord extends ChatSummary {
	readonly messages: readonly ChatMessage[];
}

export interface SearchBridge {
	/** Start a Quick+Deep search. Events stream to the sender via SEARCH_CHANNELS.event. */
	start(searchId: string, chatId: string, query: string, attachments: readonly ChatAttachment[]): Promise<void>;
	cancel(searchId: string): Promise<void>;
	historyList(): Promise<readonly ChatSummary[]>;
	historyGet(chatId: string): Promise<ChatRecord | null>;
	historySearch(query: string): Promise<readonly ChatSummary[]>;
	historyClear(): Promise<void>;
	readonly onEvent?: (listener: (event: SearchStreamEvent) => void) => () => void;
}
