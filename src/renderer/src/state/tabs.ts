/**
 * Finder tab model: one path + its own back/forward history and selection.
 *
 * Reference: handoff README §2 "Tab strip" and the state sketch's `Tab`.
 */

import { isTagPath, tagNameOf } from "../../../shared/fs-contract";
import { t } from "../../../shared/i18n/core";
import { EMPTY_SELECTION, type SelectionState } from "./selection";
import { basename, parentPrefix } from "./paths";

export interface FinderTab {
	readonly id: number;
	readonly path: string;
	readonly back: readonly string[];
	readonly fwd: readonly string[];
	readonly selection: SelectionState;
	/** Reveal flash dot, held for --time-flash. */
	readonly flash: boolean;
	/** Column view: folders opened pane by pane, each the parent of the next (state/columns.ts). */
	readonly chain: readonly string[];
}

export interface TabsState {
	readonly tabs: readonly FinderTab[];
	readonly activeId: number;
	readonly nextId: number;
}

function blankTab(id: number, path: string): FinderTab {
	return { id, path, back: [], fwd: [], selection: EMPTY_SELECTION, flash: false, chain: [] };
}

export function createTabsState(path: string): TabsState {
	return { tabs: [blankTab(1, path)], activeId: 1, nextId: 2 };
}

export function activeTab(state: TabsState): FinderTab {
	const tab = state.tabs.find((t) => t.id === state.activeId) ?? state.tabs[0];
	if (tab === undefined) {
		throw new Error("TabsState must always hold at least one tab");
	}
	return tab;
}

export function patchActiveTab(state: TabsState, patch: (tab: FinderTab) => FinderTab): TabsState {
	return { ...state, tabs: state.tabs.map((tab) => (tab.id === state.activeId ? patch(tab) : tab)) };
}

/**
 * ⌘T / "+": a new tab on the active tab's folder. A Settings or AI Search tab
 * has no folder, so the new tab takes the last folder that tab showed, else
 * the folder of the nearest other tab.
 */
export function openTab(state: TabsState): TabsState {
	return openTabAt(state, folderOf(state) ?? activeTab(state).path);
}

/**
 * A filename search from a Settings or AI Search tab: the tab returns to the
 * folder it showed last (Back undoes it). Unchanged when there is no folder.
 */
export function exitVirtualTab(state: TabsState): TabsState {
	const folder = folderOf(state);
	return folder === null || folder === activeTab(state).path ? state : navigateTab(state, folder);
}

/** The active tab's folder; for a virtual tab, the last folder it showed, else the nearest folder tab's. */
function folderOf(state: TabsState): string | null {
	const current = activeTab(state);
	if (!isVirtualTabPath(current.path)) {
		return current.path;
	}
	return (
		current.back.findLast((path) => !isVirtualTabPath(path)) ??
		nearestTab(state, (tab) => !isVirtualTabPath(tab.path))?.path ??
		null
	);
}

/** A new tab on an explicit path, e.g. the folder that encloses a Recents row. */
export function openTabAt(state: TabsState, path: string): TabsState {
	const id = state.nextId;
	return {
		tabs: [...state.tabs, blankTab(id, path)],
		activeId: id,
		nextId: id + 1,
	};
}

export function canCloseTab(state: TabsState): boolean {
	return state.tabs.length > 1;
}

export function closeTab(state: TabsState, id: number): TabsState {
	if (!canCloseTab(state)) {
		return state;
	}
	const index = state.tabs.findIndex((tab) => tab.id === id);
	if (index < 0) {
		return state;
	}
	const tabs = state.tabs.filter((tab) => tab.id !== id);
	const fallback = tabs[Math.max(0, index - 1)];
	return {
		...state,
		tabs,
		activeId: state.activeId === id && fallback !== undefined ? fallback.id : state.activeId,
	};
}

export function selectTab(state: TabsState, id: number): TabsState {
	return state.tabs.some((tab) => tab.id === id) ? { ...state, activeId: id } : state;
}

export function navigateTab(state: TabsState, path: string): TabsState {
	return patchActiveTab(state, (tab) =>
		tab.path === path
			? { ...tab, selection: EMPTY_SELECTION }
			: { ...tab, path, back: [...tab.back, tab.path], fwd: [], selection: EMPTY_SELECTION },
	);
}

export function goBack(state: TabsState): TabsState {
	const tab = activeTab(state);
	const previous = tab.back[tab.back.length - 1];
	if (previous === undefined) {
		return state;
	}
	return patchActiveTab(state, (t) => ({
		...t,
		path: previous,
		back: t.back.slice(0, -1),
		fwd: [t.path, ...t.fwd],
		selection: EMPTY_SELECTION,
	}));
}

export function goForward(state: TabsState): TabsState {
	const tab = activeTab(state);
	const next = tab.fwd[0];
	if (next === undefined) {
		return state;
	}
	return patchActiveTab(state, (t) => ({
		...t,
		path: next,
		back: [...t.back, t.path],
		fwd: t.fwd.slice(1),
		selection: EMPTY_SELECTION,
	}));
}

/**
 * A volume is about to unmount: every tab inside it moves to `fallback`, and
 * history entries inside it are dropped so Back/Forward never land on a dead
 * mount. Tabs elsewhere keep their state; with none inside, `state` is returned.
 */
export function evacuateTabs(state: TabsState, volume: string, fallback: string): TabsState {
	const prefix = parentPrefix(volume);
	const inside = (path: string): boolean => path === volume || path.startsWith(prefix);
	if (!state.tabs.some((tab) => inside(tab.path))) return state;
	return {
		...state,
		tabs: state.tabs.map((tab) =>
			inside(tab.path)
				? { ...blankTab(tab.id, fallback), back: tab.back.filter((path) => !inside(path)) }
				: tab,
		),
	};
}

/**
 * A column-view pick: the tab adopts the new chain and selection. When the
 * panes slid (the choice moved the current folder) the move is a navigation,
 * so Back returns to the previous panes.
 */
export function applyColumnChoice(
	state: TabsState,
	choice: { readonly path: string; readonly chain: readonly string[] },
	selection: SelectionState,
): TabsState {
	return patchActiveTab(state, (tab) =>
		choice.path === tab.path
			? { ...tab, chain: choice.chain, selection }
			: { ...tab, path: choice.path, back: [...tab.back, tab.path], fwd: [], chain: choice.chain, selection },
	);
}

export const SETTINGS_PATH = "Settings";

/**
 * The AI Search conversation, shown as a tab like Settings. Each tab on this
 * path holds its own chat; the path is never a folder.
 */
export const AI_SEARCH_PATH = "AI Search";

/** Paths a tab shows that are app views, not folders: never listed, watched, or dropped into. */
export function isVirtualTabPath(path: string): boolean {
	return path === SETTINGS_PATH || path === AI_SEARCH_PATH;
}

export function openOrSelectSettingsTab(state: TabsState): TabsState {
	const existing = state.tabs.find((tab) => tab.path === SETTINGS_PATH);
	if (existing !== undefined) {
		return selectTab(state, existing.id);
	}
	return openTabAt(state, SETTINGS_PATH);
}

/** Sidebar "AI Search": the focused tab becomes AI Search; Back returns to where it was. */
export function showAiSearchInActiveTab(state: TabsState): TabsState {
	return activeTab(state).path === AI_SEARCH_PATH ? state : navigateTab(state, AI_SEARCH_PATH);
}

/** "AI 요약" and other fresh questions: a new AI Search tab with an empty chat. */
export function openAiSearchTab(state: TabsState): TabsState {
	return openTabAt(state, AI_SEARCH_PATH);
}

/**
 * ⌘K: stay on the active AI Search tab, else adopt the open AI Search tab
 * nearest the focused one, else open a new one.
 */
export function focusAiSearchTab(state: TabsState): TabsState {
	if (activeTab(state).path === AI_SEARCH_PATH) {
		return state;
	}
	const nearest = nearestTab(state, (tab) => tab.path === AI_SEARCH_PATH);
	return nearest === null ? openAiSearchTab(state) : selectTab(state, nearest.id);
}

/** The tab matching `test` closest to the active tab in strip order (ties go left). */
function nearestTab(state: TabsState, test: (tab: FinderTab) => boolean): FinderTab | null {
	const here = state.tabs.findIndex((tab) => tab.id === state.activeId);
	let nearest: FinderTab | null = null;
	let distance = Number.POSITIVE_INFINITY;
	for (const [index, tab] of state.tabs.entries()) {
		const gap = Math.abs(index - here);
		if (test(tab) && gap < distance) {
			nearest = tab;
			distance = gap;
		}
	}
	return nearest;
}

/**
 * The tabs whose AI Search panel stays mounted: every tab showing AI Search,
 * plus any that showed it earlier and is still open — its chat survives a
 * navigation to a folder and back. Returns `mounted` itself when unchanged.
 */
export function aiPanelTabs(
	mounted: readonly number[],
	tabs: readonly { readonly id: number; readonly aiSearch: boolean }[],
): readonly number[] {
	const open = new Set(tabs.map((tab) => tab.id));
	const kept = mounted.filter((id) => open.has(id));
	const added = tabs.filter((tab) => tab.aiSearch && !kept.includes(tab.id)).map((tab) => tab.id);
	return kept.length === mounted.length && added.length === 0 ? mounted : [...kept, ...added];
}

export function tabTitle(tab: { readonly path: string }, view: { readonly isActive: boolean; readonly query: string }): string {
	if (tab.path === SETTINGS_PATH) {
		return t("places.settings");
	}
	if (tab.path === AI_SEARCH_PATH) {
		return t("places.aiSearch");
	}
	const query = view.query.trim();
	if (view.isActive && query !== "") {
		return t("finderComponents.searchTitle", { query });
	}
	return isTagPath(tab.path) ? tagNameOf(tab.path) : basename(tab.path) || tab.path;
}
