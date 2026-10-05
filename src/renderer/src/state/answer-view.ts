/**
 * What an assistant turn shows while a search runs. Both pending indicators —
 * the shimmer before any Quick text and the "Thinking…" water-wave row between
 * the Quick and Deep answers — are gated on a live run. Once Stop clears the
 * run they must go dark at once, even when no answer ever arrived: a stopped
 * chat must never keep animating as if it were still generating.
 */

export interface AnswerViewInput {
	/** A search is in flight (the panel's searchId is set). */
	readonly pending: boolean;
	/** The Quick answer (or its streamed draft) has text. */
	readonly quickReady: boolean;
	/** The Deep answer (or its streamed draft) has text. */
	readonly deepReady: boolean;
}

export interface AnswerViewState {
	/** The shimmer placeholder shown before any Quick text. */
	readonly skeleton: boolean;
	/** The "Thinking…" row shown between the Quick and Deep answers. */
	readonly thinking: boolean;
}

export function answerViewState({ pending, quickReady, deepReady }: AnswerViewInput): AnswerViewState {
	return {
		skeleton: pending && !quickReady,
		thinking: pending && quickReady && !deepReady,
	};
}
