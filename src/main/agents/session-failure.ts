import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** The provider's error when the last model request of a helper session failed; pi reports it on the message instead of throwing. */
export function modelFailure(session: AgentSession): string | null {
	for (let index = session.messages.length - 1; index >= 0; index -= 1) {
		const message = session.messages[index];
		if (message?.role !== "assistant") continue;
		return message.stopReason === "error" ? (message.errorMessage ?? "The model request failed.") : null;
	}
	return null;
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
