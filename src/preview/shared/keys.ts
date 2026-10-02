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
 * Left/right stay with the page so a focused video can still seek.
 */
export function quickLookKeyAction(input: QuickLookKey): QuickLookAction | null {
	if (input.meta || input.control || input.alt) return null;
	switch (input.key) {
		case " ":
		case "Escape":
			return "close";
		case "ArrowDown":
			return "next";
		case "ArrowUp":
			return "previous";
		default:
			return null;
	}
}
