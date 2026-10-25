/**
 * What the AI Search agent asks the person, and how the person answers, shared by the
 * Electron main process and the renderer.
 *
 * Two things reach the person mid-run (librarian v2.12):
 *
 * - An **approval** from the librarian's file-change gate: the agent is about to
 *   delete, move, rename, overwrite or edit an existing file. Which calls ask is the
 *   {@link ApprovalMode}: `ask` puts every file-capable call to the person, `auto`
 *   lets Jev (the judgment model) approve what the request clearly covers and asks
 *   only about the rest, `full` never asks. The default is `auto`.
 * - A **question** from the `ask_user` tool: the agent needs a decision or a fact
 *   it cannot find out itself. It is multiple choice, free text, or 2-4 independent
 *   questions together.
 *
 * Both are requests tied to one running search (`searchId`). The panel of that search
 * shows the open request in place of its message box and sends the answer back with
 * {@link InteractionBridge.answer}; the run waits for it. Stop, or the run ending,
 * closes the request. All payloads are plain serializable shapes, never pi or
 * librarian class instances.
 */

export type ApprovalMode = "ask" | "auto" | "full";

/** Order the mode menu lists them, strictest first. */
export const APPROVAL_MODES: readonly ApprovalMode[] = ["ask", "auto", "full"];

export const DEFAULT_APPROVAL_MODE: ApprovalMode = "auto";

export function isApprovalMode(value: unknown): value is ApprovalMode {
	return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);
}

export const INTERACTION_CHANNELS = {
	getMode: "interaction:getMode",
	setMode: "interaction:setMode",
	modeChanged: "interaction:modeChanged",
	pending: "interaction:pending",
	request: "interaction:request",
	closed: "interaction:closed",
	answer: "interaction:answer",
} as const;

/** What a flagged call does to a file that existed before it ran (the librarian's categories). */
export type ChangeCategory = "delete" | "move" | "rename" | "overwrite" | "edit" | "unclear";

export const CHANGE_CATEGORIES: readonly ChangeCategory[] = ["delete", "move", "rename", "overwrite", "edit", "unclear"];

/** One choice of a question. `title` is also what the model receives back as the selection. */
export interface QuestionOption {
	readonly title: string;
	readonly description?: string;
}

export interface Question {
	readonly question: string;
	/** What the agent found out so far; shown with the question. */
	readonly context?: string;
	/** Empty: a text answer only. */
	readonly options: readonly QuestionOption[];
	/** Several options may be picked. */
	readonly allowMultiple: boolean;
	/** The person may write an answer instead of picking (always true when there are no options). */
	readonly allowFreeform: boolean;
}

interface RequestBase {
	/** Unique per request; the key of the answer. */
	readonly id: string;
	/** The search run this request belongs to. */
	readonly searchId: string;
}

/** `ask_user`: one question, or 2-4 shown together under an optional `heading`. */
export interface QuestionRequest extends RequestBase {
	readonly kind: "question";
	readonly heading?: string;
	readonly questions: readonly Question[];
}

/** The file-change gate asks whether one call may run. */
export interface ApprovalRequest extends RequestBase {
	readonly kind: "approval";
	/**
	 * Why the person is asked, in the gate's own words (English): Jev's reason for not approving a call it
	 * flagged, or why it could not classify one. Empty in `ask`, where every call is asked and there is nothing to
	 * add; the panel's headline is translated and this is only ever shown beneath it.
	 */
	readonly reason: string;
	/** What the call does to existing files; empty in `ask` (nothing was classified) and for a call Jev could not classify. */
	readonly categories: readonly ChangeCategory[];
	/** The call: a shell command, or `write <path>` / `edit <path>`. */
	readonly call: string;
	/**
	 * What "allow for this session" covers: `categories` (those kinds of change), `unclassified`
	 * (every call Jev could not read) or `all` (every call, in `ask`).
	 */
	readonly sessionScope: "categories" | "unclassified" | "all";
}

export type InteractionRequest = QuestionRequest | ApprovalRequest;

export type ApprovalChoice = "allow-once" | "allow-session" | "deny" | "deny-with-note";

/** The person's answer to one question. */
export type QuestionAnswer =
	| { readonly kind: "selection"; readonly selections: readonly string[]; readonly comment?: string }
	| { readonly kind: "freeform"; readonly text: string };

export type InteractionAnswer =
	/** `note` goes with `deny-with-note`: what the model should do instead (may be empty). */
	| { readonly kind: "approval"; readonly choice: ApprovalChoice; readonly note?: string }
	/** One entry per question of the request, in order; `null` skips that question. */
	| { readonly kind: "question"; readonly answers: readonly (QuestionAnswer | null)[] }
	/** The person dismissed the request (Esc, Skip). The model is told nothing was answered. */
	| { readonly kind: "cancel" };

export interface InteractionClosed {
	readonly id: string;
	readonly searchId: string;
	/** `answered`: this window's answer arrived; `cancelled`: Stop or the person's dismissal; `ended`: the run finished first. */
	readonly reason: "answered" | "cancelled" | "ended";
}

export interface InteractionBridge {
	getMode(): Promise<ApprovalMode>;
	/** Persists the mode and applies it to every running and later agent; resolves to the mode now in force. */
	setMode(mode: ApprovalMode): Promise<ApprovalMode>;
	/** Requests still open: a panel that mounts after a request opened (tab switch, reload) reads them here. */
	pending(): Promise<readonly InteractionRequest[]>;
	/** Resolves false when no open request has this id (already answered, cancelled, or ended). */
	answer(id: string, answer: InteractionAnswer): Promise<boolean>;
	onMode(listener: (mode: ApprovalMode) => void): () => void;
	onRequest(listener: (request: InteractionRequest) => void): () => void;
	onClosed(listener: (event: InteractionClosed) => void): () => void;
}
