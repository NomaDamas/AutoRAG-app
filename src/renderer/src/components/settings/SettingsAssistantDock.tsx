/**
 * How Settings puts its AI customization assistant in the window's right sidebar.
 *
 * The window (App) owns the right sidebar; Settings owns the assistant. On a customizable section
 * (사이드바, 우클릭 메뉴, 단축키) Settings publishes a dock: the section's surface and one DOM node it keeps for its
 * whole life and renders its assistant panels into through a portal. While Settings is the focused tab and the right
 * sidebar is shown, the window mounts that node in the right sidebar instead of the Inspector. Moving the node (not
 * re-rendering into another container) keeps every conversation and running turn alive when the sidebar is hidden,
 * Settings loses focus, or the section changes.
 */

import { createContext, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { AppCustomizerSurface } from "../../../../shared/app-customizer-contract";

export interface SettingsAssistantDock {
	readonly surface: AppCustomizerSurface;
	readonly node: HTMLElement;
}

export interface SettingsAssistantHost {
	/** The assistant is in the right sidebar right now. */
	readonly shown: boolean;
	/** Show the right sidebar (and with it the assistant). */
	show(): void;
	/** Hide the right sidebar. */
	hide(): void;
	/** Settings' current dock; null on a section without an assistant. */
	publish(dock: SettingsAssistantDock | null): void;
}

/** Null outside a window that has a right sidebar: Settings then offers no assistant. */
export const SettingsAssistantContext = createContext<SettingsAssistantHost | null>(null);

/** The window side: `dock` is what the right sidebar shows instead of the Inspector, null to keep the Inspector. */
export function useSettingsAssistantHost({
	rightSidebarVisible,
	setRightSidebarVisible,
	settingsFocused,
}: {
	readonly rightSidebarVisible: boolean;
	readonly setRightSidebarVisible: (visible: boolean) => void;
	/** The focused tab is Settings; the right sidebar always follows the focused tab. */
	readonly settingsFocused: boolean;
}): { readonly host: SettingsAssistantHost; readonly dock: SettingsAssistantDock | null } {
	const [published, setPublished] = useState<SettingsAssistantDock | null>(null);
	const dock = settingsFocused ? published : null;
	const shown = rightSidebarVisible && dock !== null;
	const host = useMemo<SettingsAssistantHost>(
		() => ({
			shown,
			show: () => setRightSidebarVisible(true),
			hide: () => setRightSidebarVisible(false),
			publish: setPublished,
		}),
		[shown, setRightSidebarVisible],
	);
	return { host, dock };
}

/**
 * The right sidebar's content while it hosts the assistant. A layout effect moves the node in, so it is attached
 * before any passive effect (the composer's focus on open) runs.
 */
export function SettingsAssistantSlot({ dock }: { readonly dock: SettingsAssistantDock }): ReactElement {
	const slotRef = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		slotRef.current?.append(dock.node);
		return () => dock.node.remove();
	}, [dock.node]);
	return <div ref={slotRef} className="customizer-dock" data-testid="settings-assistant-slot" />;
}
