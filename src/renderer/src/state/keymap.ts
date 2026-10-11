/**
 * Keyboard routing for the window, resolved against the focus zone.
 *
 * Reference: handoff README "Keyboard shortcuts". The zone model is `finder`
 * or `evidence`; `typing` is true whenever the event target is a text input,
 * which is what keeps `space` out of composed text.
 */

import { type ViewMode, viewModeForKey } from "./view-mode";
import type { NewFileFormatId } from "../../../shared/new-file-contract";

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
	| { readonly type: "rename" }
	| { readonly type: "parentFolder" }
	| { readonly type: "copy" }
	| { readonly type: "cut" }
	| { readonly type: "paste"; readonly move: boolean }
	| { readonly type: "undo" }
	| { readonly type: "redo" }
	| { readonly type: "moveSelection"; readonly delta: 1 | -1 }
	| { readonly type: "moveSelectionSideways"; readonly delta: 1 | -1 }
	| { readonly type: "moveEvidence"; readonly delta: 1 | -1 }
	| { readonly type: "setViewMode"; readonly mode: ViewMode }
	| { readonly type: "disclose"; readonly direction: "expand" | "collapse" }
	| { readonly type: "dismiss" }
	| { readonly type: "focusSearch" }
	| { readonly type: "focusComposer" }
	| { readonly type: "newTab" }
	| { readonly type: "reopenTab" }
	| { readonly type: "closeTab" }
	| { readonly type: "newFolder" }
	| { readonly type: "newFile"; readonly format: NewFileFormatId }
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
			// ⇧⌘T brings back the tab ⌘W closed, as in a browser.
			case "t":
				return event.shift ? { type: "reopenTab" } : { type: "newTab" };
			case "w":
				return { type: "closeTab" };
			case ",":
				return { type: "openSettings" };
			// ⇧⌘N is Finder's New Folder; ⌥⌘N is this app's New File.
			case "n":
				return context.typing || context.zone !== "finder" || !event.shift ? null : { type: "newFolder" };
			// The file clipboard is the Finder zone's; a text field keeps its own
			// native copy/cut/paste, so these are never swallowed while typing.
			case "c":
				return context.typing || context.zone !== "finder" ? null : { type: "copy" };
			case "x":
				return context.typing || context.zone !== "finder" ? null : { type: "cut" };
			case "v":
				return context.typing || context.zone !== "finder" ? null : { type: "paste", move: false };
			case "r":
				// ⌘R renames the selected row, as Finder's Return does.
				return context.typing || context.zone !== "finder" ? null : { type: "rename" };
			case "z":
				// ⌘Z undoes the newest file operation; ⇧⌘Z redoes the one it took back.
				if (context.typing || context.zone !== "finder") return null;
				return event.shift ? { type: "redo" } : { type: "undo" };
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
	// ⌥⌘N creates a new text file.
	if ((event.meta || event.ctrl === true) && event.alt && event.key.toLowerCase() === "n") {
		return context.typing || context.zone !== "finder" ? null : { type: "newFile", format: "text" };
	}
	if (context.typing) {
		return null;
	}
	// ⌥↑ goes up to the enclosing folder; it must not fall through to the plain ↑ row move.
	if (event.alt && !event.meta && event.key === "ArrowUp") {
		return context.zone === "finder" ? { type: "parentFolder" } : null;
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
