import type { QuickLookAction } from "./contract";

/** The modifier-aware key shape both Electron `Input` and DOM events reduce to. */
export interface QuickLookKey {
	readonly key: string;
	readonly meta: boolean;
	readonly control: boolean;
	readonly alt: boolean;
	readonly shift: boolean;
}

/**
 * Keys the Quick Look window owns regardless of which element has focus.
 * Left/right stay with the page so a focused video can still seek. While a
 * text field has focus (`typing`: the password prompt) Space and the arrows
 * belong to it; Escape still closes.
 */
export function quickLookKeyAction(input: QuickLookKey, typing = false): QuickLookAction | null {
	if (input.meta || input.control || input.alt) return null;
	switch (input.key) {
		case "Escape":
			return "close";
		case " ":
			return typing ? null : "close";
		case "ArrowDown":
			return typing ? null : "next";
		case "ArrowUp":
			return typing ? null : "previous";
		default:
			return null;
	}
}
