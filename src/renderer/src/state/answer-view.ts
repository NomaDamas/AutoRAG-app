/**
 * What an assistant turn shows while a search runs. The pending indicators — the shimmer before any Quick text, the
 * line that says what the agent is doing, and the "Thinking…" water-wave row between the Quick and Deep answers —
 * are gated on a live run. Once Stop clears the run they must go dark at once, even when no answer ever arrived:
 * a stopped chat must never keep animating as if it were still generating.
 *
 * A message that goes on to call a tool is a progress note, not the answer, so the streamed draft of it is
 * withdrawn the moment the tool call starts and the shimmer comes back. The note is not lost: it arrives as
 * progress, and `narration` keeps it on screen in place of silent shimmer until an answer starts.
 */

export interface AnswerViewInput {
	/** A search is in flight (the panel's searchId is set). */
	readonly pending: boolean;
	/** The Quick answer (or its streamed draft) has text. */
	readonly quickReady: boolean;
	/** The Deep answer (or its streamed draft) has text. */
	readonly deepReady: boolean;
	/** The agent reported what it is doing (the text it wrote before its last tool call). */
	readonly hasProgress?: boolean;
}

export interface AnswerViewState {
	/** The shimmer placeholder shown before any Quick text. */
	readonly skeleton: boolean;
	/** What the agent is doing, shown above the shimmer while no answer text exists yet. */
	readonly narration: boolean;
	/** The "Thinking…" row shown between the Quick and Deep answers. */
	readonly thinking: boolean;
}

export function answerViewState({ pending, quickReady, deepReady, hasProgress = false }: AnswerViewInput): AnswerViewState {
	return {
		skeleton: pending && !quickReady,
		narration: pending && !quickReady && hasProgress,
		thinking: pending && quickReady && !deepReady,
	};
}
