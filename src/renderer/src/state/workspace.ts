/**
 * Split-pane workspace: the window's Finder area is a tree of splits whose
 * leaves are panes, and every pane owns a strip of tabs (`state/tabs.ts`).
 *
 * Tabs move between panes by dragging: onto another strip (merge at an
 * index), onto a pane's body (merge at the end), or onto a pane's edge (split
 * that pane and put the tab in the new half). A pane whose last tab leaves or
 * closes disappears and its share goes to its neighbor, so the panes always
 * tile the whole area. Tab ids are unique across panes.
 *
 * `recentTabs` remembers which tab the user focused last, most recent first:
 * closing a focused tab or pane returns to it, and a reveal (evidence title)
 * opens in the pane of the last focused folder tab.
 */

import {
	AI_SEARCH_PATH,
	createTabsState,
	evacuateTabs,
	focusAiSearchTab,
	isVirtualTabPath,
	openAiSearchTab,
	openTabAt,
	SETTINGS_PATH,
	type FinderTab,
	type TabsState,
} from "./tabs";

export interface Pane {
	readonly id: number;
	readonly tabs: readonly FinderTab[];
	readonly activeId: number;
}

/** A folder tab that was closed, kept so ⇧⌘T can bring it back. */
export interface ClosedTab {
	/** The tab as it was: path, back/forward history, selection, column chain. Its id is not reused. */
	readonly tab: FinderTab;
	/** The pane and strip slot it left, so a restore into that same pane lands where it was. */
	readonly paneId: number;
	readonly index: number;
}

/** How many closed tabs ⇧⌘T can walk back through. */
export const CLOSED_TAB_LIMIT = 20;

/** "row" lays children left to right, "column" top to bottom. */
export type SplitDirection = "row" | "column";

export type PaneLayout =
	| { readonly kind: "pane"; readonly paneId: number }
	| {
			readonly kind: "split";
			readonly id: number;
			readonly direction: SplitDirection;
			readonly children: readonly PaneLayout[];
			/** Each child's share of the split, summing to 1. */
			readonly sizes: readonly number[];
	  };

export interface Workspace {
	readonly panes: readonly Pane[];
	readonly layout: PaneLayout;
	readonly focusedPaneId: number;
	/** Tab ids by most recent focus, newest first; only open tabs. */
	readonly recentTabs: readonly number[];
	readonly nextTabId: number;
	readonly nextPaneId: number;
	readonly nextSplitId: number;
	/** Closed folder tabs, newest first, at most `CLOSED_TAB_LIMIT`. */
	readonly closedTabs: readonly ClosedTab[];
}

export type PaneEdge = "left" | "right" | "top" | "bottom";

export type TabDropTarget =
	/** Split `paneId` at `edge`; the tab becomes the new pane. */
	| { readonly kind: "split"; readonly paneId: number; readonly edge: PaneEdge }
	/** Merge into `paneId`, after its last tab (a drop on the pane body). */
	| { readonly kind: "pane"; readonly paneId: number }
	/** Merge into `paneId`'s strip so the tab ends up at `index`. */
	| { readonly kind: "strip"; readonly paneId: number; readonly index: number };

/** A pane's place in the workspace, as fractions of the whole area. */
export interface UnitRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** A draggable boundary between `children[index]` and `children[index + 1]` of a split. */
export interface SplitHandle {
	readonly splitId: number;
	readonly index: number;
	readonly direction: SplitDirection;
	/** Start of the boundary line, as fractions of the whole area. */
	readonly x: number;
	readonly y: number;
	/** The line's length across the split direction. */
	readonly length: number;
	/** The split's own extent along its direction (converts pixels to shares). */
	readonly extent: number;
}

export function createWorkspace(path: string): Workspace {
	const { tabs, activeId, nextId } = createTabsState(path);
	return {
		panes: [{ id: 1, tabs, activeId }],
		layout: { kind: "pane", paneId: 1 },
		focusedPaneId: 1,
		recentTabs: [activeId],
		nextTabId: nextId,
		nextPaneId: 2,
		nextSplitId: 1,
		closedTabs: [],
	};
}

export function paneOf(ws: Workspace, paneId: number): Pane {
	const pane = ws.panes.find((candidate) => candidate.id === paneId);
	if (pane === undefined) throw new Error(`Workspace has no pane ${paneId}`);
	return pane;
}

export function focusedPane(ws: Workspace): Pane {
	return paneOf(ws, ws.focusedPaneId);
}

function paneHolding(ws: Workspace, tabId: number): Pane | undefined {
	return ws.panes.find((pane) => pane.tabs.some((tab) => tab.id === tabId));
}

export function allTabs(ws: Workspace): readonly FinderTab[] {
	return ws.panes.flatMap((pane) => pane.tabs);
}

/** The window keeps at least one tab: a pane may close, the last tab may not. */
export function canCloseWorkspaceTab(ws: Workspace): boolean {
	return ws.panes.length > 1 || (ws.panes[0]?.tabs.length ?? 0) > 1;
}

/**
 * Record the focused pane's active tab as the most recent and drop closed
 * tabs from the memory. Returns `ws` itself when nothing changed.
 */
function remember(ws: Workspace): Workspace {
	const open = new Set(allTabs(ws).map((tab) => tab.id));
	const current = ws.panes.find((pane) => pane.id === ws.focusedPaneId)?.activeId;
	const recent = [
		...(current === undefined ? [] : [current]),
		...ws.recentTabs.filter((id) => id !== current && open.has(id)),
	];
	const same = recent.length === ws.recentTabs.length && recent.every((id, index) => id === ws.recentTabs[index]);
	return same ? ws : { ...ws, recentTabs: recent };
}

function replacePane(ws: Workspace, next: Pane): Workspace {
	return { ...ws, panes: ws.panes.map((pane) => (pane.id === next.id ? next : pane)) };
}

/**
 * Run a `state/tabs.ts` transition on one pane's strip. Ids it hands out come
 * from the workspace counter, so they never collide with another pane's.
 * A pane that no longer exists (a late async reveal) leaves `ws` unchanged.
 */
export function updatePaneTabs(ws: Workspace, paneId: number, update: (state: TabsState) => TabsState): Workspace {
	const pane = ws.panes.find((candidate) => candidate.id === paneId);
	if (pane === undefined) return ws;
	const state: TabsState = { tabs: pane.tabs, activeId: pane.activeId, nextId: ws.nextTabId };
	const next = update(state);
	if (next === state || next.tabs.length === 0) return ws;
	return remember({
		...replacePane(ws, { id: pane.id, tabs: next.tabs, activeId: next.activeId }),
		nextTabId: Math.max(ws.nextTabId, next.nextId),
	});
}

export function focusPane(ws: Workspace, paneId: number): Workspace {
	if (ws.focusedPaneId === paneId || !ws.panes.some((pane) => pane.id === paneId)) return ws;
	return remember({ ...ws, focusedPaneId: paneId });
}

/** Focus `tabId` wherever it lives: its pane gains focus and shows it. */
export function focusTab(ws: Workspace, tabId: number): Workspace {
	const pane = paneHolding(ws, tabId);
	if (pane === undefined) return ws;
	const shown = pane.activeId === tabId ? ws : replacePane(ws, { ...pane, activeId: tabId });
	return remember({ ...shown, focusedPaneId: pane.id });
}

/** The tab a pane shows after `removed` leaves it: the one focused most recently, else its strip neighbor. */
function fallbackActive(ws: Workspace, pane: Pane, removed: number): number {
	const left = pane.tabs.filter((tab) => tab.id !== removed);
	if (pane.activeId !== removed) return pane.activeId;
	const recent = ws.recentTabs.find((id) => id !== removed && left.some((tab) => tab.id === id));
	if (recent !== undefined) return recent;
	const index = pane.tabs.findIndex((tab) => tab.id === removed);
	return (left[Math.max(0, index - 1)] ?? left[0])?.id ?? pane.activeId;
}

/** Take `tabId` out of its pane; an emptied pane leaves the layout. Focus is not touched. */
function detachTab(ws: Workspace, tabId: number): { readonly ws: Workspace; readonly tab: FinderTab } | null {
	const pane = paneHolding(ws, tabId);
	const tab = pane?.tabs.find((candidate) => candidate.id === tabId);
	if (pane === undefined || tab === undefined) return null;
	if (pane.tabs.length === 1) {
		return {
			tab,
			ws: {
				...ws,
				panes: ws.panes.filter((candidate) => candidate.id !== pane.id),
				layout: removeLeaf(ws.layout, pane.id) ?? ws.layout,
			},
		};
	}
	return {
		tab,
		ws: replacePane(ws, {
			id: pane.id,
			tabs: pane.tabs.filter((candidate) => candidate.id !== tabId),
			activeId: fallbackActive(ws, pane, tabId),
		}),
	};
}

/** The pane of the most recently focused open tab that `accept`s, else the first pane. */
function recentPane(ws: Workspace, accept: (tab: FinderTab) => boolean = () => true): number {
	for (const id of ws.recentTabs) {
		const pane = paneHolding(ws, id);
		const tab = pane?.tabs.find((candidate) => candidate.id === id);
		if (pane !== undefined && tab !== undefined && accept(tab)) return pane.id;
	}
	return ws.panes[0]?.id ?? ws.focusedPaneId;
}

/**
 * Close a tab. A pane left empty closes and focus returns to the pane of the
 * tab focused before; a closed active tab hands over to the pane's most
 * recently focused tab. The window's last tab never closes.
 */
export function closeWorkspaceTab(ws: Workspace, tabId: number): Workspace {
	if (!canCloseWorkspaceTab(ws)) return ws;
	const from = paneHolding(ws, tabId);
	const closing = from?.tabs.find((tab) => tab.id === tabId);
	const detached = detachTab(ws, tabId);
	if (from === undefined || closing === undefined || detached === null) return ws;
	const next = detached.ws;
	const recentTabs = next.recentTabs.filter((id) => id !== tabId);
	const paneGone = !next.panes.some((pane) => pane.id === from.id);
	const focusedPaneId = paneGone && next.focusedPaneId === from.id ? recentPane({ ...next, recentTabs }) : next.focusedPaneId;
	// Settings, AI Search, and temporary Evidence Folders do not outlive their tab: nothing for ⇧⌘T to bring back.
	const closedTabs = isVirtualTabPath(closing.path) || closing.evidenceFolder !== undefined
		? next.closedTabs
		: [{ tab: closing, paneId: from.id, index: from.tabs.indexOf(closing) }, ...next.closedTabs].slice(0, CLOSED_TAB_LIMIT);
	return remember({ ...next, recentTabs, focusedPaneId, closedTabs });
}

/**
 * ⇧⌘T: reopen the most recently closed folder tab in the focused pane, active,
 * with its folder, history, selection and column chain. It takes its old strip
 * slot when that pane is the one it was closed in, else it goes last. Unchanged
 * when nothing was closed.
 */
export function reopenClosedTab(ws: Workspace): Workspace {
	const [closed, ...rest] = ws.closedTabs;
	if (closed === undefined) return ws;
	const pane = paneOf(ws, ws.focusedPaneId);
	const id = ws.nextTabId;
	const index = closed.paneId === pane.id ? Math.min(closed.index, pane.tabs.length) : pane.tabs.length;
	const tab: FinderTab = { ...closed.tab, id, flash: false };
	const tabs = [...pane.tabs.slice(0, index), tab, ...pane.tabs.slice(index)];
	return remember({
		...replacePane(ws, { id: pane.id, tabs, activeId: id }),
		nextTabId: id + 1,
		closedTabs: rest,
	});
}

/** Whether dropping `tabId` on `target` is a real move that leaves no pane empty-handed. */
export function canDropTab(ws: Workspace, tabId: number, target: TabDropTarget): boolean {
	const from = paneHolding(ws, tabId);
	if (from === undefined || !ws.panes.some((pane) => pane.id === target.paneId)) return false;
	switch (target.kind) {
		case "strip":
			return true;
		case "pane":
			return target.paneId !== from.id;
		case "split":
			return target.paneId !== from.id || from.tabs.length > 1;
	}
}

/**
 * Drop a dragged tab. The tab keeps its history and selection, becomes the
 * active tab where it lands, and that pane takes focus.
 */
export function moveTab(ws: Workspace, tabId: number, target: TabDropTarget): Workspace {
	if (!canDropTab(ws, tabId, target)) return ws;
	const from = paneHolding(ws, tabId);
	if (target.kind === "strip" && from?.id === target.paneId) {
		// A reorder inside one strip: the pane stays, even with a single tab.
		const tab = from.tabs.find((candidate) => candidate.id === tabId) as FinderTab;
		const rest = from.tabs.filter((candidate) => candidate.id !== tabId);
		const index = Math.max(0, Math.min(target.index, rest.length));
		const tabs = [...rest.slice(0, index), tab, ...rest.slice(index)];
		return remember({ ...replacePane(ws, { id: from.id, tabs, activeId: tabId }), focusedPaneId: from.id });
	}
	const detached = detachTab(ws, tabId);
	if (detached === null) return ws;
	const { tab } = detached;
	let next = detached.ws;
	if (target.kind === "split") {
		const paneId = next.nextPaneId;
		const direction: SplitDirection = target.edge === "left" || target.edge === "right" ? "row" : "column";
		const before = target.edge === "left" || target.edge === "top";
		next = {
			...next,
			panes: [...next.panes, { id: paneId, tabs: [tab], activeId: tab.id }],
			layout: insertBeside(next.layout, target.paneId, { kind: "pane", paneId }, direction, before, next.nextSplitId),
			nextPaneId: paneId + 1,
			nextSplitId: next.nextSplitId + 1,
			focusedPaneId: paneId,
		};
		return remember(next);
	}
	const pane = paneOf(next, target.paneId);
	const index = target.kind === "pane" ? pane.tabs.length : Math.max(0, Math.min(target.index, pane.tabs.length));
	const tabs = [...pane.tabs.slice(0, index), tab, ...pane.tabs.slice(index)];
	return remember({ ...replacePane(next, { id: pane.id, tabs, activeId: tab.id }), focusedPaneId: pane.id });
}

/**
 * The strip index a tab dropped in gap `gap` (0 = before the first tab) ends
 * up at: within its own strip the tab's old slot closes first.
 */
export function stripDropIndex(gap: number, fromIndex: number | null): number {
	return fromIndex !== null && gap > fromIndex ? gap - 1 : gap;
}

/** The strip gap under pointer x: past a tab's midpoint the gap is after it. */
export function stripGapAt(x: number, tabs: readonly { readonly left: number; readonly width: number }[]): number {
	const index = tabs.findIndex((tab) => x < tab.left + tab.width / 2);
	return index < 0 ? tabs.length : index;
}

/**
 * Where a drop at (rx, ry) — fractions of a pane's body — lands: the outer
 * band near an edge splits there, the middle merges into the pane.
 */
export function dropZoneAt(rx: number, ry: number, band = 0.3): PaneEdge | "center" {
	const edges: readonly (readonly [PaneEdge, number])[] = [
		["left", rx],
		["right", 1 - rx],
		["top", ry],
		["bottom", 1 - ry],
	];
	let nearest: readonly [PaneEdge, number] = edges[0] as readonly [PaneEdge, number];
	for (const edge of edges) if (edge[1] < nearest[1]) nearest = edge;
	return nearest[1] < band ? nearest[0] : "center";
}

/** The part of `rect` a drop zone will occupy, for the drag preview. */
export function dropPreviewRect<R extends { readonly x: number; readonly y: number; readonly width: number; readonly height: number }>(
	zone: PaneEdge | "center",
	rect: R,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
	const halfW = rect.width / 2;
	const halfH = rect.height / 2;
	switch (zone) {
		case "left":
			return { x: rect.x, y: rect.y, width: halfW, height: rect.height };
		case "right":
			return { x: rect.x + halfW, y: rect.y, width: halfW, height: rect.height };
		case "top":
			return { x: rect.x, y: rect.y, width: rect.width, height: halfH };
		case "bottom":
			return { x: rect.x, y: rect.y + halfH, width: rect.width, height: halfH };
		case "center":
			return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
	}
}

/* ------------------------------------------------------------ layout tree */

/** Remove a pane's leaf; a split left with one child collapses into it. Null when the tree empties. */
function removeLeaf(layout: PaneLayout, paneId: number): PaneLayout | null {
	if (layout.kind === "pane") return layout.paneId === paneId ? null : layout;
	const index = layout.children.findIndex((child) => containsPane(child, paneId));
	if (index < 0) return layout;
	const child = layout.children[index] as PaneLayout;
	const replaced = removeLeaf(child, paneId);
	if (replaced !== null) {
		return normalize({ ...layout, children: layout.children.map((current, at) => (at === index ? replaced : current)) });
	}
	const share = layout.sizes[index] ?? 0;
	// The removed share goes to the neighbor before it (after it for the first child).
	const heir = index > 0 ? index - 1 : 1;
	const sizes = layout.sizes.map((size, at) => (at === heir ? size + share : size)).filter((_, at) => at !== index);
	const children = layout.children.filter((_, at) => at !== index);
	return normalize({ ...layout, children, sizes });
}

function containsPane(layout: PaneLayout, paneId: number): boolean {
	return layout.kind === "pane" ? layout.paneId === paneId : layout.children.some((child) => containsPane(child, paneId));
}

/** A one-child split becomes its child; a child split running the same way merges into its parent. */
function normalize(layout: PaneLayout): PaneLayout {
	if (layout.kind === "pane") return layout;
	if (layout.children.length === 1) return layout.children[0] as PaneLayout;
	const children: PaneLayout[] = [];
	const sizes: number[] = [];
	layout.children.forEach((child, index) => {
		const share = layout.sizes[index] ?? 0;
		if (child.kind === "split" && child.direction === layout.direction) {
			child.children.forEach((grandchild, at) => {
				children.push(grandchild);
				sizes.push(share * (child.sizes[at] ?? 0));
			});
			return;
		}
		children.push(child);
		sizes.push(share);
	});
	return { ...layout, children, sizes };
}

/**
 * Put `leaf` beside pane `targetId`. Inside a split already running in
 * `direction` it becomes a sibling taking half the target's share; otherwise
 * the target's cell splits in two.
 */
function insertBeside(
	layout: PaneLayout,
	targetId: number,
	leaf: PaneLayout,
	direction: SplitDirection,
	before: boolean,
	splitId: number,
): PaneLayout {
	if (layout.kind === "pane") {
		if (layout.paneId !== targetId) return layout;
		return { kind: "split", id: splitId, direction, children: before ? [leaf, layout] : [layout, leaf], sizes: [0.5, 0.5] };
	}
	const index = layout.children.findIndex((child) => child.kind === "pane" && child.paneId === targetId);
	if (index >= 0 && layout.direction === direction) {
		const half = (layout.sizes[index] ?? 0) / 2;
		const at = before ? index : index + 1;
		const sizes = layout.sizes.map((size, position) => (position === index ? half : size));
		return {
			...layout,
			children: [...layout.children.slice(0, at), leaf, ...layout.children.slice(at)],
			sizes: [...sizes.slice(0, at), half, ...sizes.slice(at)],
		};
	}
	return { ...layout, children: layout.children.map((child) => insertBeside(child, targetId, leaf, direction, before, splitId)) };
}

/** Every pane's rectangle, as fractions of the workspace area. */
export function paneRects(layout: PaneLayout): ReadonlyMap<number, UnitRect> {
	const rects = new Map<number, UnitRect>();
	walk(layout, { x: 0, y: 0, width: 1, height: 1 }, (paneId, rect) => rects.set(paneId, rect), () => undefined);
	return rects;
}

/** Every draggable boundary between neighboring panes. */
export function splitHandles(layout: PaneLayout): readonly SplitHandle[] {
	const handles: SplitHandle[] = [];
	walk(layout, { x: 0, y: 0, width: 1, height: 1 }, () => undefined, (handle) => handles.push(handle));
	return handles;
}

function walk(
	layout: PaneLayout,
	rect: UnitRect,
	onPane: (paneId: number, rect: UnitRect) => void,
	onHandle: (handle: SplitHandle) => void,
): void {
	if (layout.kind === "pane") {
		onPane(layout.paneId, rect);
		return;
	}
	const row = layout.direction === "row";
	let offset = row ? rect.x : rect.y;
	layout.children.forEach((child, index) => {
		const extent = (row ? rect.width : rect.height) * (layout.sizes[index] ?? 0);
		const childRect: UnitRect = row
			? { x: offset, y: rect.y, width: extent, height: rect.height }
			: { x: rect.x, y: offset, width: rect.width, height: extent };
		walk(child, childRect, onPane, onHandle);
		offset += extent;
		if (index < layout.children.length - 1) {
			onHandle({
				splitId: layout.id,
				index,
				direction: layout.direction,
				x: row ? offset : rect.x,
				y: row ? rect.y : offset,
				length: row ? rect.height : rect.width,
				extent: row ? rect.width : rect.height,
			});
		}
	});
}

/**
 * Drag a boundary: `delta` and `minShare` are shares of that split's extent.
 * Both neighbors stay at least `minShare` wide.
 */
export function resizeSplit(ws: Workspace, splitId: number, index: number, delta: number, minShare: number): Workspace {
	const resize = (layout: PaneLayout): PaneLayout => {
		if (layout.kind === "pane") return layout;
		if (layout.id !== splitId) {
			const children = layout.children.map(resize);
			return children.every((child, at) => child === layout.children[at]) ? layout : { ...layout, children };
		}
		const a = layout.sizes[index];
		const b = layout.sizes[index + 1];
		if (a === undefined || b === undefined) return layout;
		const total = a + b;
		const nextA = Math.min(total - minShare, Math.max(minShare, a + delta));
		if (nextA === a) return layout;
		const sizes = layout.sizes.map((size, at) => (at === index ? nextA : at === index + 1 ? total - nextA : size));
		return { ...layout, sizes };
	};
	const layout = resize(ws.layout);
	return layout === ws.layout ? ws : { ...ws, layout };
}

/* ---------------------------------------------------- workspace commands */

/** ⌘, / the sidebar gear: the open Settings tab wherever it is, else a new one in the focused pane. */
export function openOrSelectSettingsInWorkspace(ws: Workspace): Workspace {
	const existing = allTabs(ws).find((tab) => tab.path === SETTINGS_PATH);
	if (existing !== undefined) return focusTab(ws, existing.id);
	return updatePaneTabs(ws, ws.focusedPaneId, (state) => openTabAt(state, SETTINGS_PATH));
}

/**
 * ⌘K: the focused AI Search tab stays; else one already on screen in another
 * pane; else the nearest in the focused pane; else one hidden in another
 * pane; else a new one in the focused pane.
 */
export function focusAiSearchInWorkspace(ws: Workspace): Workspace {
	const isAi = (tab: FinderTab): boolean => tab.path === AI_SEARCH_PATH;
	const focused = focusedPane(ws);
	if (focused.tabs.some((tab) => tab.id === focused.activeId && isAi(tab))) return ws;
	const visible = ws.recentTabs
		.map((id) => ws.panes.find((pane) => pane.activeId === id))
		.concat(ws.panes)
		.find((pane) => pane !== undefined && pane.tabs.some((tab) => tab.id === pane.activeId && isAi(tab)));
	if (visible !== undefined) return focusPane(ws, visible.id);
	if (focused.tabs.some(isAi)) return updatePaneTabs(ws, focused.id, focusAiSearchTab);
	const hidden = allTabs(ws).find(isAi);
	if (hidden !== undefined) return focusTab(ws, hidden.id);
	return updatePaneTabs(ws, focused.id, openAiSearchTab);
}

/** A volume is about to unmount: every pane's tabs inside it move to `fallback`. */
export function evacuateWorkspace(ws: Workspace, volume: string, fallback: string): Workspace {
	let changed = false;
	const panes = ws.panes.map((pane) => {
		const state: TabsState = { tabs: pane.tabs, activeId: pane.activeId, nextId: ws.nextTabId };
		const next = evacuateTabs(state, volume, fallback);
		if (next === state) return pane;
		changed = true;
		return { ...pane, tabs: next.tabs };
	});
	return changed ? { ...ws, panes } : ws;
}
