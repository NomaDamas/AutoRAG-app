/**
 * What an assistant turn shows while a search runs: one indicator, the shimmering text line (what the agent is doing, or
 * "Thinking…" when it has said nothing yet). It shows from the question until the Deep answer starts to arrive, in the
 * same place whether or not Quick text exists: a Quick draft that is withdrawn (its message went on to call a tool) or a
 * run that is still reading files does not swap it for a different animation.
 *
 * It is gated on a live run: once Stop clears the run it must go dark at once, even when no answer ever arrived, so a
 * stopped chat never keeps animating as if it were still generating.
 */

export interface AnswerViewInput {
	/** A search is in flight (the panel's searchId is set). */
	readonly pending: boolean;
	/** The Deep answer (or its streamed draft) has text. */
	readonly deepReady: boolean;
}

export interface AnswerViewState {
	/** The shimmering "what it is doing" line. */
	readonly shimmer: boolean;
}

export function answerViewState({ pending, deepReady }: AnswerViewInput): AnswerViewState {
	return { shimmer: pending && !deepReady };
}
