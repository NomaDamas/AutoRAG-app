import { chordFromKeyEvent } from "../../shared/shortcuts-contract";
import type { QuickLookAction } from "./contract";

/** The modifier-aware key shape both Electron `Input` and DOM events reduce to. */
export interface QuickLookKey {
	readonly key: string;
	readonly code?: string | undefined;
	readonly meta: boolean;
	readonly control: boolean;
	readonly alt: boolean;
	readonly shift: boolean;
}

/**
 * Keys the Quick Look window owns regardless of which element has focus.
 * Left/right stay with the page so a focused video can still seek. While a
 * text field has focus (`typing`: the password prompt) Space and the arrows
 * belong to it; Escape still closes, and a customized `toggleChord` (such as
 * `Alt+P` in the Windows File Explorer preset) toggles it closed too.
 */
export function quickLookKeyAction(
	input: QuickLookKey,
	typing = false,
	toggleChord?: string,
	platform = "darwin",
): QuickLookAction | null {
	if (input.key === "Escape") return "close";
	if (toggleChord !== undefined && toggleChord !== "Space" && !typing) {
		const recorded = chordFromKeyEvent(
			{
				key: input.key,
				code: input.code,
				meta: input.meta,
				ctrl: input.control,
				alt: input.alt,
				shift: input.shift,
			},
			platform,
		);
		if (recorded.kind === "valid" && recorded.chord === toggleChord) {
			return "close";
		}
	}
	if (input.meta || input.control || input.alt) return null;
	switch (input.key) {
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
