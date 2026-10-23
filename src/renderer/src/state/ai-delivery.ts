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
}

export interface AiDeliveryRequest {
	readonly attach?: readonly ChatAttachment[];
	readonly query?: string;
	readonly summarize?: readonly ChatAttachment[];
	readonly draft?: string;
}

/** The slice of the panel's imperative handle a delivery drives. */
export interface AiDeliveryTarget {
	prefill(text: string): void;
	sendQuery(text: string): void;
	attach(atts: readonly ChatAttachment[]): void;
	summarize(atts: readonly ChatAttachment[]): void;
	focusComposer(): void;
}

export function mergeDelivery(pending: AiDelivery | null, request: AiDeliveryRequest): AiDelivery {
	return {
		attach: [...(pending?.attach ?? []), ...(request.attach ?? [])],
		query: request.query ?? pending?.query ?? null,
		summarize: [...(pending?.summarize ?? []), ...(request.summarize ?? [])],
		draft: request.draft ?? pending?.draft ?? null,
	};
}

/** Hand a folded delivery to the tab's panel. A summary run owns the turn; a query beats a draft. */
export function deliverToDock(dock: AiDeliveryTarget, delivery: AiDelivery): void {
	if (delivery.summarize.length > 0) {
		dock.summarize(delivery.summarize);
		return;
	}
	if (delivery.attach.length > 0) dock.attach(delivery.attach);
	if (delivery.query !== null) dock.sendQuery(delivery.query);
	else if (delivery.draft !== null) dock.prefill(delivery.draft);
	else dock.focusComposer();
}
