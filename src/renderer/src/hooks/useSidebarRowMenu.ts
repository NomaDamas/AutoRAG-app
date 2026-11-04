import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { NavItem } from "../data/places";
import { buildSidebarPinMenu, type FinderMenuAction, type FinderMenuEntry } from "../state/context-menu";

export interface SidebarRowMenu {
	/** The open menu, or null. */
	readonly menu: { readonly cursor: { readonly x: number; readonly y: number }; readonly entries: readonly FinderMenuEntry[] } | null;
	/** Right-click on a pinned sidebar row. */
	open(item: NavItem, event: ReactMouseEvent<HTMLElement>): void;
	select(action: FinderMenuAction): void;
	close(): void;
}

/**
 * The right-click menu of a pinned sidebar row (사이드바에서 제거). It is the
 * app's own menu, not a native one, so it is dismissed here: a click outside
 * closes it through `ContextMenu`, and Escape closes it through this hook, which
 * keeps the keystroke from reaching the window keymap's own Esc handling.
 */
export function useSidebarRowMenu(onUnpin: (sidebarId: string) => void): SidebarRowMenu {
	const [state, setState] = useState<{ readonly cursor: { readonly x: number; readonly y: number }; readonly id: string } | null>(null);
	const close = useCallback(() => setState(null), []);

	useEffect(() => {
		if (state === null) return;
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			// Esc is spent on the menu: the window keymap's dismiss (close Quick Look or a rename, clear the search) must not also run.
			event.preventDefault();
			event.stopPropagation();
			setState(null);
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [state]);

	const open = useCallback((item: NavItem, event: ReactMouseEvent<HTMLElement>) => {
		if (item.sidebarId === undefined) return;
		setState({ cursor: { x: event.clientX, y: event.clientY }, id: item.sidebarId });
	}, []);

	const select = useCallback(
		(action: FinderMenuAction) => {
			const id = state?.id;
			setState(null);
			if (action === "unpinFromSidebar" && id !== undefined) onUnpin(id);
		},
		[onUnpin, state],
	);

	return { menu: state === null ? null : { cursor: state.cursor, entries: buildSidebarPinMenu() }, open, select, close };
}
