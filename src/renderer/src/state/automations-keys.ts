/**
 * Keyboard for the 자동화 tab. The Finder keymap ignores every non-window shortcut on
 * a virtual tab, so the rule list answers its own keys: ↑/↓ select, Space looks,
 * Enter edits, Delete asks to delete, Esc closes whatever is open on top of the list.
 */

export type RuleKeyAction =
	| { readonly type: "step"; readonly direction: 1 | -1 }
	| { readonly type: "preview" }
	| { readonly type: "edit" }
	| { readonly type: "delete" }
	| { readonly type: "dismiss" };

export interface RuleKeyContext {
	/** A text field has the focus, so it keeps its keys. */
	readonly typing: boolean;
	/** The topmost layer: Quick Look follows the selection, a menu or the confirm freezes the list. */
	readonly overlay: "none" | "preview" | "menu" | "confirm";
	readonly hasSelection: boolean;
}

export interface RuleKeyEvent {
	readonly key: string;
	readonly meta: boolean;
	readonly shift: boolean;
	readonly alt: boolean;
}

export function ruleKeyAction(event: RuleKeyEvent, context: RuleKeyContext): RuleKeyAction | null {
	if (context.typing) return null;
	if (event.key === "Escape") return context.overlay === "none" ? null : { type: "dismiss" };
	if (context.overlay === "menu" || context.overlay === "confirm") return null;
	if (event.alt) return null;
	// ⌘⌫ is the Finder's delete; no other ⌘ chord is the list's.
	if (event.meta) return event.key === "Backspace" && context.hasSelection ? { type: "delete" } : null;
	switch (event.key) {
		case "ArrowDown":
			return { type: "step", direction: 1 };
		case "ArrowUp":
			return { type: "step", direction: -1 };
		case " ":
			return context.hasSelection ? { type: "preview" } : null;
		case "Enter":
			return context.hasSelection ? { type: "edit" } : null;
		case "Backspace":
		case "Delete":
			return context.hasSelection ? { type: "delete" } : null;
		default:
			return null;
	}
}
