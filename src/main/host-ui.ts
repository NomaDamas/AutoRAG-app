import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	CHANGE_CATEGORIES,
	type ApprovalRequest,
	type ChangeCategory,
	type InteractionAnswer,
	type QuestionAnswer,
} from "../shared/interaction-contract";
import { t } from "../shared/i18n/core";
import type { RequestBody } from "./interaction-hub";

/**
 * The window as pi's extensions see it.
 *
 * The librarian's file-change gate and any other pi extension ask the person through `ctx.ui` (`select`,
 * `input`, `confirm`), a terminal surface the AutoRAG agent only gets when a TUI binds it. A search run in
 * the app has no terminal, so the app binds this object to the run's session
 * (`session.extensionRunner.setUIContext`, the way pi's own RPC mode does) and every dialog becomes a request
 * in the AI Search panel. `custom` yields `undefined` (a terminal component cannot be drawn in a window), which
 * is what pi documents for hosts without a TUI; everything else that only a terminal has is a no-op.
 */

/** One run's way to ask the person. */
export interface RunInteraction {
	open(body: RequestBody, signal?: AbortSignal): Promise<InteractionAnswer>;
}

// The gate's dialog (permission-gate.ts in the librarian): fixed choices in a fixed order.
const ALLOW_ONCE = "Allow once";
const DENY = "Deny";
const DENY_WITH_NOTE = "Deny and tell the model what to do instead";

const JEV_DECLINED = /^Jev declined to approve this automatically \((.*)\)\. Approve it yourself\?$/su;
const JEV_UNCLASSIFIED = /^Jev could not classify this call \((.*)\), so it needs your approval\. It may change your files\.$/su;
const ASK_HEADING = /^Approve this \S+ call\?$/u;
const CALL_PREFIX = "    $ ";
const SESSION_ALL = "Allow all such calls this session";
const SESSION_UNCLASSIFIED = "Allow all unclassified calls this session";

type ApprovalBody = Omit<ApprovalRequest, "id" | "searchId">;

function isCategory(word: string): word is ChangeCategory {
	return (CHANGE_CATEGORIES as readonly string[]).includes(word);
}

/**
 * Recognises the gate's approval dialog from its title and choices, or null for any other `select`. The
 * title is `heading`, an optional line naming the categories, then `    $ <call>` (the call may span lines).
 */
export function parseApprovalDialog(title: string, options: readonly string[]): ApprovalBody | null {
	if (options.length !== 4 || options[0] !== ALLOW_ONCE || options[2] !== DENY || options[3] !== DENY_WITH_NOTE) return null;
	const lines = title.split("\n");
	const callAt = lines.findIndex((line) => line.startsWith(CALL_PREFIX));
	if (callAt < 1) return null;
	const heading = lines[0] as string;
	const call = [lines[callAt]?.slice(CALL_PREFIX.length), ...lines.slice(callAt + 1)].join("\n");
	const categories = lines
		.slice(1, callAt)
		.flatMap((line) => line.trim().split(/,\s*/u))
		.filter(isCategory);
	const sessionChoice = options[1] as string;
	const sessionScope = sessionChoice === SESSION_ALL ? "all" : sessionChoice === SESSION_UNCLASSIFIED ? "unclassified" : "categories";
	const reason = JEV_DECLINED.exec(heading)?.[1] ?? JEV_UNCLASSIFIED.exec(heading)?.[1] ?? (ASK_HEADING.test(heading) ? "" : heading);
	return { kind: "approval", reason, categories, call, sessionScope };
}

const noop = (): void => undefined;

/** The person's selection for a single-choice question, or undefined when nothing was chosen. */
function pickedTitle(answer: InteractionAnswer): string | undefined {
	if (answer.kind !== "question") return undefined;
	const first: QuestionAnswer | null | undefined = answer.answers[0];
	return first?.kind === "selection" ? first.selections[0] : undefined;
}

function writtenText(answer: InteractionAnswer): string | undefined {
	if (answer.kind !== "question") return undefined;
	const first: QuestionAnswer | null | undefined = answer.answers[0];
	return first?.kind === "freeform" ? first.text : undefined;
}

/**
 * Builds the UI surface for one agent. `current` names the run a dialog belongs to at the moment it opens
 * (undefined between runs: there is nobody to ask, so a dialog comes back empty instead of waiting forever).
 */
export function createHostUi(current: () => RunInteraction | undefined): ExtensionUIContext {
	/** What the person typed for "Deny and tell the model": the gate asks for it in a follow-up `input`. */
	let denialNote: string | undefined;

	const ui = {
		select: async (title: string, options: string[], opts?: { signal?: AbortSignal }) => {
			denialNote = undefined;
			const run = current();
			if (run === undefined) return undefined;
			const approval = parseApprovalDialog(title, options);
			if (approval !== null) {
				const answer = await run.open(approval, opts?.signal);
				if (answer.kind !== "approval") return undefined;
				switch (answer.choice) {
					case "allow-once":
						return ALLOW_ONCE;
					case "allow-session":
						return options[1];
					case "deny":
						return DENY;
					case "deny-with-note":
						denialNote = answer.note ?? "";
						return DENY_WITH_NOTE;
				}
			}
			const answer = await run.open(
				{
					kind: "question",
					questions: [{ question: title, options: options.map((option) => ({ title: option })), allowMultiple: false, allowFreeform: false }],
				},
				opts?.signal,
			);
			return pickedTitle(answer);
		},
		input: async (title: string, _placeholder?: string, opts?: { signal?: AbortSignal }) => {
			if (denialNote !== undefined) {
				const note = denialNote;
				denialNote = undefined;
				return note;
			}
			const run = current();
			if (run === undefined) return undefined;
			const answer = await run.open(
				{ kind: "question", questions: [{ question: title, options: [], allowMultiple: false, allowFreeform: true }] },
				opts?.signal,
			);
			return writtenText(answer);
		},
		confirm: async (title: string, message: string, opts?: { signal?: AbortSignal }) => {
			const run = current();
			if (run === undefined) return false;
			const yes = t("main.interaction.yes");
			const answer = await run.open(
				{
					kind: "question",
					questions: [
						{
							question: title,
							...(message === "" ? {} : { context: message }),
							options: [{ title: yes }, { title: t("main.interaction.no") }],
							allowMultiple: false,
							allowFreeform: false,
						},
					],
				},
				opts?.signal,
			);
			return pickedTitle(answer) === yes;
		},
		editor: async () => undefined,
		custom: async () => undefined,
		notify: noop,
		onTerminalInput: () => noop,
		setStatus: noop,
		setWorkingMessage: noop,
		setWorkingVisible: noop,
		setWorkingIndicator: noop,
		setHiddenThinkingLabel: noop,
		setWidget: noop,
		setFooter: noop,
		setHeader: noop,
		setTitle: noop,
		pasteToEditor: noop,
		setEditorText: noop,
		getEditorText: () => "",
		addAutocompleteProvider: noop,
		setEditorComponent: noop,
		getEditorComponent: noop,
		// Extensions colour status text with it; there is no terminal to colour for.
		theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
		getAllThemes: () => [],
		getTheme: noop,
		setTheme: () => ({ success: false, error: "UI not available" }),
		getToolsExpanded: () => false,
		setToolsExpanded: noop,
	};
	// pi's `ExtensionUIContext` is a terminal surface typed with TUI classes (Component, Theme, ...) the window never has.
	return ui as unknown as ExtensionUIContext;
}
