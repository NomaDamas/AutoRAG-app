/**
 * Search/chat contract shared by the Electron main process and the renderer.
 *
 * The main process owns one AutoRAGAgent instance (the "main search agent")
 * and streams `searchDocumentsStream` events to the renderer over IPC.
 * Quick = the stream's `preliminary` event (the fast phase's plain-text answer);
 * Deep = the stream's `complete` event (full SearchDocumentsResponse). A run
 * that ends without verification (Jev judged the fast answer final, or routed
 * to a direct answer) streams only `complete`; that single answer is sent as
 * `quick`, never as `deep`, so the panel does not show the same text twice.
 * While a phase runs, the main process also forwards the agent's live model
 * stream: `thinking` signals (once per phase) that the model started
 * reasoning — the reasoning text itself never crosses IPC — and
 * `quick-draft` / `deep-draft` carry the answer text streamed so far (a full
 * snapshot, not a delta). The following `quick` / `deep` event carries the
 * authoritative full answer and supersedes the draft. `done` closes every run
 * that was not cancelled, after any `deep` or `error` event.
 *
 * A message sent while a run streams steers that run instead of starting a
 * new one (`steer`): the librarian delivers it before the run's next model
 * request, cuts in-flight retrieval short, and always verifies, so the Deep
 * answer follows the correction. `steer-delivered` reports the moment a model
 * request took the run's pending steers.
 *
 * All payloads crossing IPC are plain serializable shapes defined here —
 * never pi/librarian class instances.
 */

export const SEARCH_CHANNELS = {
	start: "search:start",
	steer: "search:steer",
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
	/** Relevance 0..1 when the librarian measured one; absent for results derived from the answer's citations. */
	readonly confidence?: number;
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
	/** A model request of the run took every steer sent so far. */
	| { readonly type: "steer-delivered"; readonly searchId: string }
	| { readonly type: "done"; readonly searchId: string };

/** When a steer reached the run: before or after its Quick answer was shown. */
export type SteerTiming = "before-quick" | "after-quick";

export interface ChatMessageUser {
	readonly role: "user";
	readonly text: string;
	readonly attachments: readonly ChatAttachment[];
	readonly at: string;
	/** Sent while the run streamed, to correct it; absent on the question that started the run. */
	readonly steer?: SteerTiming;
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
	/**
	 * Steer the running search `searchId` with a correction. Resolves true when
	 * the run took it, false when that run is not running (finished, stopped,
	 * past its last model request, or unknown): the caller then asks the text
	 * as a new question.
	 */
	steer(searchId: string, text: string): Promise<boolean>;
	cancel(searchId: string): Promise<void>;
	historyList(): Promise<readonly ChatSummary[]>;
	historyGet(chatId: string): Promise<ChatRecord | null>;
	historySearch(query: string): Promise<readonly ChatSummary[]>;
	historyClear(): Promise<void>;
	readonly onEvent?: (listener: (event: SearchStreamEvent) => void) => () => void;
}
