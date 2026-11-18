import type { ChatAttachment } from "../../../shared/search-contract";

/**
 * Work the shell hands the AI Search tab that is (about to be) focused. The tab
 * switch and the panel mount land in the same render, so a request waits until the
 * tab's panel exists; several requests made in that gap fold into one.
 */
export interface AiDelivery {
	readonly attach: readonly ChatAttachment[];
	/** A question to ask now: it is sent, not left in the composer. */
	readonly query: string | null;
	/** "AI 요약" targets, sent with their own summary run, never as drafts. */
	readonly summarize: readonly ChatAttachment[];
	/**
	 * Text to leave in the composer unsent, so the person finishes the sentence and
	 * presses Enter: the automation view's edit and add open a tab this way.
	 */
	readonly draft: string | null;
	/** A stored chat to show (the inspector's ⤢): the tab loads it from history and continues it. */
	readonly chat: string | null;
	/** Open the 대화 기록 list (the inspector's "지난 대화" link). */
	readonly history: boolean;
}

export interface AiDeliveryRequest {
	readonly attach?: readonly ChatAttachment[];
	readonly query?: string;
	readonly summarize?: readonly ChatAttachment[];
	readonly draft?: string;
	readonly chat?: string;
	readonly history?: boolean;
}

/** The slice of the panel's imperative handle a delivery drives. */
export interface AiDeliveryTarget {
	prefill(text: string): void;
	/** Send `text` now, with `atts` folded into the drafts of the same run. */
	sendQuery(text: string, atts?: readonly ChatAttachment[]): void;
	attach(atts: readonly ChatAttachment[]): void;
	summarize(atts: readonly ChatAttachment[]): void;
	focusComposer(): void;
	/** Show the stored chat `id`, to continue it. */
	openChat(id: string): void;
	/** Open the 대화 기록 list. */
	showHistory(): void;
}

export function mergeDelivery(pending: AiDelivery | null, request: AiDeliveryRequest): AiDelivery {
	return {
		attach: [...(pending?.attach ?? []), ...(request.attach ?? [])],
		query: request.query ?? pending?.query ?? null,
		summarize: [...(pending?.summarize ?? []), ...(request.summarize ?? [])],
		draft: request.draft ?? pending?.draft ?? null,
		chat: request.chat ?? pending?.chat ?? null,
		history: request.history === true || pending?.history === true,
	};
}

/**
 * Hand a folded delivery to the tab's panel. A summary run owns the turn; a query beats a draft. A query
 * takes its attachments in the same call: `attach` only reaches the panel's state on the next render, so
 * attach-then-send would ask without them.
 */
export function deliverToDock(dock: AiDeliveryTarget, delivery: AiDelivery): void {
	if (delivery.chat !== null) {
		dock.openChat(delivery.chat);
		return;
	}
	if (delivery.history) {
		dock.showHistory();
		return;
	}
	if (delivery.summarize.length > 0) {
		dock.summarize(delivery.summarize);
		return;
	}
	if (delivery.query !== null) {
		dock.sendQuery(delivery.query, delivery.attach);
		return;
	}
	if (delivery.attach.length > 0) dock.attach(delivery.attach);
	if (delivery.draft !== null) dock.prefill(delivery.draft);
	else dock.focusComposer();
}
