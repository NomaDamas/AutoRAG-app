/**
 * Keyboard routing for the window, resolved against the focus zone and
 * user-customized shortcut settings (`src/shared/shortcuts-contract.ts`).
 */

import type { NewFileFormatId } from "../../../shared/new-file-contract";
import {
	chordFromKeyEvent,
	DEFAULT_SHORTCUT_SETTINGS,
	decomposeShortcutChord,
	resolveEffectiveShortcuts,
	SHORTCUT_BY_ID,
	SHORTCUT_CATALOG,
	type ShortcutId,
	type ShortcutSettings,
} from "../../../shared/shortcuts-contract";
import type { ViewMode } from "./view-mode";

export type FocusZone = "finder" | "evidence";

export interface KeyEventLike {
	readonly key: string;
	/** Physical key code (`KeyP`, `Digit1`, …) when available from a DOM KeyboardEvent. */
	readonly code?: string | undefined;
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
	| { readonly type: "editPath" }
	| { readonly type: "duplicate" }
	| { readonly type: "focusComposer" }
	| { readonly type: "newTab" }
	| { readonly type: "reopenTab" }
	| { readonly type: "closeTab" }
	| { readonly type: "newFolder" }
	| { readonly type: "newFile"; readonly format: NewFileFormatId }
	| { readonly type: "openSettings" };

const FINDER_ZONE_ONLY: Readonly<Partial<Record<ShortcutId, true>>> = {
	parentFolder: true,
	openItem: true,
	newFolder: true,
	newFile: true,
	rename: true,
	duplicate: true,
	copy: true,
	cut: true,
	paste: true,
	pasteMove: true,
	trash: true,
	undo: true,
	redo: true,
};

function actionForShortcutId(id: ShortcutId): KeyAction | null {
	switch (id) {
		case "focusSearch":
			return { type: "focusSearch" };
		case "focusComposer":
			return { type: "focusComposer" };
		case "openSettings":
			return { type: "openSettings" };
		case "newTab":
			return { type: "newTab" };
		case "reopenTab":
			return { type: "reopenTab" };
		case "closeTab":
			return { type: "closeTab" };
		case "editPath":
			return { type: "editPath" };
		case "parentFolder":
			return { type: "parentFolder" };
		case "viewIcons":
			return { type: "setViewMode", mode: "icons" };
		case "viewList":
			return { type: "setViewMode", mode: "list" };
		case "viewColumns":
			return { type: "setViewMode", mode: "columns" };
		case "quickLook":
			return { type: "quickLook" };
		case "openItem":
			return { type: "open" };
		case "newFolder":
			return { type: "newFolder" };
		case "newFile":
			return { type: "newFile", format: "text" };
		case "rename":
			return { type: "rename" };
		case "duplicate":
			return { type: "duplicate" };
		case "copy":
			return { type: "copy" };
		case "cut":
			return { type: "cut" };
		case "paste":
			return { type: "paste", move: false };
		case "pasteMove":
			return { type: "paste", move: true };
		case "trash":
			return { type: "trash" };
		case "undo":
			return { type: "undo" };
		case "redo":
			return { type: "redo" };
		case "aiNewChat":
		case "aiToggleHistory":
			// Handled inside AiSearchPanel when an AI Search tab is active.
			return null;
	}
}

export function resolveKeyAction(
	event: KeyEventLike,
	context: KeyContext,
	shortcuts: ShortcutSettings = DEFAULT_SHORTCUT_SETTINGS,
): KeyAction | null {
	if (event.key === "Escape") {
		return { type: "dismiss" };
	}

	const recorded = chordFromKeyEvent(event);
	if (recorded.kind === "valid") {
		const effective = resolveEffectiveShortcuts(shortcuts);
		const eventParts = decomposeShortcutChord(recorded.chord);
		const hasMod = eventParts?.mod === true;

		for (const item of SHORTCUT_CATALOG) {
			if (item.scope === "aiSearch") continue;
			const targetChord = effective[item.id];
			const matchesExact = targetChord === recorded.chord;
			const matchesSecondaryDelete =
				!matchesExact &&
				item.id === "trash" &&
				targetChord === "Backspace" &&
				recorded.chord === "Delete" &&
				!Object.entries(effective).some(
					([otherId, otherChord]) =>
						otherId !== "trash" &&
						SHORTCUT_BY_ID[otherId as ShortcutId].scope !== "aiSearch" &&
						otherChord === "Delete",
				);

			if (!matchesExact && !matchesSecondaryDelete) continue;

			// While typing in an input, only Mod-modified chords that explicitly opt in may fire.
			if (context.typing && (!item.allowWhileTyping || !hasMod)) {
				return null;
			}
			if (FINDER_ZONE_ONLY[item.id] === true && context.zone !== "finder") {
				return null;
			}
			return actionForShortcutId(item.id);
		}
	}

	if (context.typing) {
		return null;
	}

	const mod = event.meta || event.ctrl === true;
	if (!mod && !event.alt && !event.shift) {
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
	}

	return null;
}

/**
 * The history step a mouse button asks for: the side buttons are DOM buttons
 * 3 (back) and 4 (forward). Anything else is not navigation.
 */
export function mouseNavDirection(button: number): "back" | "forward" | null {
	if (button === 3) return "back";
	if (button === 4) return "forward";
	return null;
}
