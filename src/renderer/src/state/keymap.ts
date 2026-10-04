/**
 * Keyboard routing for the window, resolved against the focus zone.
 *
 * Reference: handoff README "Keyboard shortcuts". The zone model is `finder`
 * or `evidence`; `typing` is true whenever the event target is a text input,
 * which is what keeps `space` out of composed text.
 */

import { type ViewMode, viewModeForKey } from "./view-mode";

export type FocusZone = "finder" | "evidence";

export interface KeyEventLike {
	readonly key: string;
	/** Command on macOS (or Control elsewhere). */
	readonly meta: boolean;
	/** Control on Windows/Linux; optional for existing event adapters. */
	readonly ctrl?: boolean;
	readonly shift: boolean;
	readonly alt: boolean;
}

export interface KeyContext {
	readonly zone: FocusZone;
	readonly typing: boolean;
	/** Left / right move between tiles or panes outside the list view. Defaults to list. */
	readonly viewMode?: ViewMode;
}

export type KeyAction =
	| { readonly type: "quickLook" }
	| { readonly type: "open" }
	| { readonly type: "trash" }
	| { readonly type: "copy" }
	| { readonly type: "cut" }
	| { readonly type: "paste"; readonly move: boolean }
	| { readonly type: "undo" }
	| { readonly type: "moveSelection"; readonly delta: 1 | -1 }
	| { readonly type: "moveSelectionSideways"; readonly delta: 1 | -1 }
	| { readonly type: "moveEvidence"; readonly delta: 1 | -1 }
	| { readonly type: "setViewMode"; readonly mode: ViewMode }
	| { readonly type: "disclose"; readonly direction: "expand" | "collapse" }
	| { readonly type: "dismiss" }
	| { readonly type: "focusSearch" }
	| { readonly type: "focusComposer" }
	| { readonly type: "newTab" }
	| { readonly type: "closeTab" }
	| { readonly type: "openSettings" };
export function resolveKeyAction(event: KeyEventLike, context: KeyContext): KeyAction | null {
	if (event.key === "Escape") {
		return { type: "dismiss" };
	}
	if ((event.meta || event.ctrl === true) && !event.alt) {
		switch (event.key.toLowerCase()) {
			case "f":
				return { type: "focusSearch" };
			case "k":
				return { type: "focusComposer" };
			case "t":
				return { type: "newTab" };
			case "w":
				return { type: "closeTab" };
			case ",":
				return { type: "openSettings" };
			// The file clipboard is the Finder zone's; a text field keeps its own
			// native copy/cut/paste, so these are never swallowed while typing.
			case "c":
				return context.typing || context.zone !== "finder" ? null : { type: "copy" };
			case "x":
				return context.typing || context.zone !== "finder" ? null : { type: "cut" };
			case "v":
				return context.typing || context.zone !== "finder" ? null : { type: "paste", move: false };
			case "z":
				// ⌘Z undoes the last file transfer; ⇧⌘Z stays free for redo.
				return context.typing || context.zone !== "finder" || event.shift ? null : { type: "undo" };
			default: {
				const mode = viewModeForKey(event.key);
				return mode === null ? null : { type: "setViewMode", mode };
			}
		}
	}
	// ⌥⌘V (Finder's "Move Item Here"): paste the clipboard as a move, whatever
	// the clipboard was cut or copied with.
	if ((event.meta || event.ctrl === true) && event.alt && event.key.toLowerCase() === "v") {
		return context.typing || context.zone !== "finder" ? null : { type: "paste", move: true };
	}
	if (context.typing) {
		return null;
	}
	if (event.key === " ") {
		return { type: "quickLook" };
	}
	if (event.key === "ArrowDown" || event.key === "ArrowUp") {
		const delta = event.key === "ArrowDown" ? 1 : -1;
		return context.zone === "evidence" ? { type: "moveEvidence", delta } : { type: "moveSelection", delta };
	}
	if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
		const delta = event.key === "ArrowRight" ? 1 : -1;
		if (context.zone === "evidence") {
			return { type: "moveEvidence", delta };
		}
		if ((context.viewMode ?? "list") === "list") {
			return { type: "disclose", direction: event.key === "ArrowRight" ? "expand" : "collapse" };
		}
		return { type: "moveSelectionSideways", delta };
	}
	if (event.key === "Enter" && context.zone === "finder") {
		return { type: "open" };
	}
	if ((event.key === "Delete" || event.key === "Backspace") && context.zone === "finder") {
		return { type: "trash" };
	}
	return null;
}
