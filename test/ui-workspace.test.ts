import { describe, expect, it } from "vitest";
import { AI_SEARCH_PATH, AUTOMATIONS_PATH, navigateTab, openEvidenceFolderTab, openTabAt, SETTINGS_PATH } from "../src/renderer/src/state/tabs";
import {
	canCloseWorkspaceTab,
	canDropTab,
	CLOSED_TAB_LIMIT,
	closeWorkspaceTab,
	createWorkspace,
	dropZoneAt,
	evacuateWorkspace,
	focusAiSearchInWorkspace,
	focusPane,
	moveTab,
	openOrSelectAutomationsInWorkspace,
	openOrSelectSettingsInWorkspace,
	reopenClosedTab,
	paneOf,
	paneRects,
	resizeSplit,
	splitHandles,
	stripDropIndex,
	stripGapAt,
	updatePaneTabs,
	type Workspace,
} from "../src/renderer/src/state/workspace";

/** Open tabs on `paths` in pane `paneId`, the last one active. */
function withTabs(ws: Workspace, paneId: number, ...paths: string[]): Workspace {
	return paths.reduce((current, path) => updatePaneTabs(current, paneId, (state) => openTabAt(state, path)), ws);
}

function paths(ws: Workspace, paneId: number): string[] {
	return paneOf(ws, paneId).tabs.map((tab) => tab.path);
}

function activePath(ws: Workspace, paneId: number): string | undefined {
	const pane = paneOf(ws, paneId);
	return pane.tabs.find((tab) => tab.id === pane.activeId)?.path;
}

function tabId(ws: Workspace, paneId: number, path: string): number {
	const found = paneOf(ws, paneId).tabs.find((tab) => tab.path === path);
	if (found === undefined) throw new Error(`no tab ${path} in pane ${paneId}`);
	return found.id;
}

/** Two panes side by side: pane 1 holds /a, pane 2 (focused) holds /b. */
function sideBySide(): Workspace {
	const ws = withTabs(createWorkspace("/a"), 1, "/b");
	return moveTab(ws, tabId(ws, 1, "/b"), { kind: "split", paneId: 1, edge: "right" });
}

describe("workspace panes", () => {
	it("starts as one full-size focused pane", () => {
		const ws = createWorkspace("/a");
		expect(ws.panes.map((pane) => pane.id)).toEqual([1]);
		expect(ws.focusedPaneId).toBe(1);
		expect(paneRects(ws.layout).get(1)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
		expect(splitHandles(ws.layout)).toEqual([]);
	});

	it("keeps tab ids unique across panes", () => {
		const ws = withTabs(sideBySide(), 2, "/c");
		const ids = ws.panes.flatMap((pane) => pane.tabs.map((tab) => tab.id));
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("splits a tab off to the right: the new pane holds it, focused, beside the rest", () => {
		const ws = sideBySide();
		expect(ws.panes.map((pane) => pane.id)).toEqual([1, 2]);
		expect(paths(ws, 1)).toEqual(["/a"]);
		expect(paths(ws, 2)).toEqual(["/b"]);
		expect(ws.focusedPaneId).toBe(2);
		expect(activePath(ws, 2)).toBe("/b");
		const rects = paneRects(ws.layout);
		expect(rects.get(1)).toEqual({ x: 0, y: 0, width: 0.5, height: 1 });
		expect(rects.get(2)).toEqual({ x: 0.5, y: 0, width: 0.5, height: 1 });
	});

	it("splits to the left and top with the new pane first", () => {
		let ws = withTabs(createWorkspace("/a"), 1, "/b");
		ws = moveTab(ws, tabId(ws, 1, "/b"), { kind: "split", paneId: 1, edge: "top" });
		const rects = paneRects(ws.layout);
		expect(rects.get(2)).toEqual({ x: 0, y: 0, width: 1, height: 0.5 });
		expect(rects.get(1)).toEqual({ x: 0, y: 0.5, width: 1, height: 0.5 });
		ws = withTabs(ws, 1, "/c");
		ws = moveTab(ws, tabId(ws, 1, "/c"), { kind: "split", paneId: 1, edge: "left" });
		expect(paneRects(ws.layout).get(3)).toEqual({ x: 0, y: 0.5, width: 0.5, height: 0.5 });
		expect(paneRects(ws.layout).get(1)).toEqual({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 });
	});

	it("adds a sibling to a same-direction split instead of nesting, halving the target", () => {
		let ws = withTabs(sideBySide(), 2, "/c");
		ws = moveTab(ws, tabId(ws, 2, "/c"), { kind: "split", paneId: 2, edge: "right" });
		expect(ws.layout).toMatchObject({ kind: "split", direction: "row", sizes: [0.5, 0.25, 0.25] });
		expect(paneRects(ws.layout).get(3)).toEqual({ x: 0.75, y: 0, width: 0.25, height: 1 });
	});

	it("nests a perpendicular split inside the target's cell", () => {
		let ws = withTabs(sideBySide(), 2, "/c");
		ws = moveTab(ws, tabId(ws, 2, "/c"), { kind: "split", paneId: 2, edge: "bottom" });
		const rects = paneRects(ws.layout);
		expect(rects.get(1)).toEqual({ x: 0, y: 0, width: 0.5, height: 1 });
		expect(rects.get(2)).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.5 });
		expect(rects.get(3)).toEqual({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 });
		const handles = splitHandles(ws.layout);
		expect(handles).toHaveLength(2);
		expect(handles.find((handle) => handle.direction === "column")).toMatchObject({ x: 0.5, y: 0.5, length: 0.5 });
	});

	it("only accepts drops that leave every pane with a tab and change something", () => {
		const lone = withTabs(createWorkspace("/a"), 1);
		const only = tabId(lone, 1, "/a");
		expect(canDropTab(lone, only, { kind: "split", paneId: 1, edge: "right" })).toBe(false);
		expect(canDropTab(lone, only, { kind: "pane", paneId: 1 })).toBe(false);
		expect(canDropTab(lone, only, { kind: "strip", paneId: 1, index: 0 })).toBe(true);
		const two = withTabs(lone, 1, "/b");
		expect(canDropTab(two, only, { kind: "split", paneId: 1, edge: "bottom" })).toBe(true);
		const split = sideBySide();
		expect(canDropTab(split, tabId(split, 2, "/b"), { kind: "pane", paneId: 1 })).toBe(true);
		expect(canDropTab(split, 999, { kind: "pane", paneId: 1 })).toBe(false);
		expect(moveTab(lone, only, { kind: "pane", paneId: 1 })).toBe(lone);
	});

	it("merges a dragged-out last tab into another pane and closes its empty pane", () => {
		const ws = sideBySide();
		const merged = moveTab(ws, tabId(ws, 2, "/b"), { kind: "pane", paneId: 1 });
		expect(merged.panes.map((pane) => pane.id)).toEqual([1]);
		expect(paths(merged, 1)).toEqual(["/a", "/b"]);
		expect(activePath(merged, 1)).toBe("/b");
		expect(merged.focusedPaneId).toBe(1);
		expect(paneRects(merged.layout).get(1)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
	});

	it("inserts a tab dropped on a strip at the drop index, and reorders within a strip", () => {
		let ws = withTabs(sideBySide(), 1, "/c");
		ws = moveTab(ws, tabId(ws, 2, "/b"), { kind: "strip", paneId: 1, index: 1 });
		expect(paths(ws, 1)).toEqual(["/a", "/b", "/c"]);
		ws = moveTab(ws, tabId(ws, 1, "/a"), { kind: "strip", paneId: 1, index: 2 });
		expect(paths(ws, 1)).toEqual(["/b", "/c", "/a"]);
		expect(activePath(ws, 1)).toBe("/a");
	});

	it("moves a tab's history and selection with it", () => {
		let ws = createWorkspace("/a");
		ws = updatePaneTabs(ws, 1, (state) => navigateTab(state, "/a/deep"));
		ws = withTabs(ws, 1, "/b");
		const moved = moveTab(ws, tabId(ws, 1, "/a/deep"), { kind: "split", paneId: 1, edge: "right" });
		expect(paneOf(moved, 2).tabs[0]).toMatchObject({ path: "/a/deep", back: ["/a"] });
	});

	it("treats a lone tab dropped on its own strip as a reorder, keeping its pane", () => {
		const ws = sideBySide();
		const id = tabId(ws, 2, "/b");
		const same = moveTab(ws, id, { kind: "strip", paneId: 2, index: 0 });
		expect(same.panes.map((pane) => pane.id)).toEqual([1, 2]);
		expect(paths(same, 2)).toEqual(["/b"]);
		expect(same.layout).toEqual(ws.layout);
	});

	it("maps a pointer x to the strip gap by tab midpoints, and a gap to the landing index", () => {
		const tabs = [
			{ left: 0, width: 100 },
			{ left: 100, width: 100 },
			{ left: 200, width: 100 },
		];
		expect(stripGapAt(10, tabs)).toBe(0);
		expect(stripGapAt(60, tabs)).toBe(1);
		expect(stripGapAt(249, tabs)).toBe(2);
		expect(stripGapAt(400, tabs)).toBe(3);
		// Within its own strip the tab's old slot closes before it lands.
		expect(stripDropIndex(3, 0)).toBe(2);
		expect(stripDropIndex(0, 2)).toBe(0);
		expect(stripDropIndex(2, null)).toBe(2);
	});

	it("splits near an edge and merges in the middle of a pane body", () => {
		expect(dropZoneAt(0.05, 0.5)).toBe("left");
		expect(dropZoneAt(0.95, 0.4)).toBe("right");
		expect(dropZoneAt(0.5, 0.1)).toBe("top");
		expect(dropZoneAt(0.4, 0.9)).toBe("bottom");
		expect(dropZoneAt(0.5, 0.5)).toBe("center");
	});
});

describe("workspace focus memory", () => {
	it("records the focused pane's active tab as the most recent", () => {
		const ws = focusPane(sideBySide(), 1);
		expect(ws.focusedPaneId).toBe(1);
		expect(ws.recentTabs[0]).toBe(tabId(ws, 1, "/a"));
		expect(focusPane(ws, 1)).toBe(ws);
	});

	it("activating a tab in the focused pane makes it the most recent", () => {
		const ws = withTabs(sideBySide(), 2, "/c");
		expect(ws.recentTabs[0]).toBe(tabId(ws, 2, "/c"));
	});

	it("closing a pane's last tab closes the pane and returns focus to the last focused tab's pane", () => {
		// Three panes in a row: 1 | 2 | 3. Focus 1, then 3; closing 3 must go back to 1, not neighbor 2.
		let ws = withTabs(sideBySide(), 2, "/c");
		ws = moveTab(ws, tabId(ws, 2, "/c"), { kind: "split", paneId: 2, edge: "right" });
		ws = focusPane(ws, 1);
		ws = focusPane(ws, 3);
		const closed = closeWorkspaceTab(ws, tabId(ws, 3, "/c"));
		expect(closed.panes.map((pane) => pane.id)).toEqual([1, 2]);
		expect(closed.focusedPaneId).toBe(1);
		// The removed pane's share goes to its neighbor, so the panes still fill the row.
		expect(paneRects(closed.layout).get(2)).toEqual({ x: 0.5, y: 0, width: 0.5, height: 1 });
	});

	it("closing the active tab returns to the tab focused before it, not the strip neighbor", () => {
		let ws = withTabs(createWorkspace("/a"), 1, "/b", "/c");
		ws = updatePaneTabs(ws, 1, (state) => ({ ...state, activeId: tabId(ws, 1, "/a") }));
		ws = updatePaneTabs(ws, 1, (state) => openTabAt(state, "/evidence"));
		const closed = closeWorkspaceTab(ws, tabId(ws, 1, "/evidence"));
		expect(activePath(closed, 1)).toBe("/a");
		expect(closed.recentTabs).not.toContain(tabId(ws, 1, "/evidence"));
	});

	it("never closes the last tab of the window", () => {
		const ws = createWorkspace("/a");
		expect(canCloseWorkspaceTab(ws)).toBe(false);
		expect(closeWorkspaceTab(ws, tabId(ws, 1, "/a"))).toBe(ws);
		expect(canCloseWorkspaceTab(sideBySide())).toBe(true);
	});

	it("flattens a collapsed split into its same-direction parent", () => {
		// row[1, column[2, row[3, 4]]] — closing 2 leaves row[1, 3, 4].
		let ws = withTabs(sideBySide(), 2, "/c");
		ws = moveTab(ws, tabId(ws, 2, "/c"), { kind: "split", paneId: 2, edge: "bottom" });
		ws = withTabs(ws, 3, "/d");
		ws = moveTab(ws, tabId(ws, 3, "/d"), { kind: "split", paneId: 3, edge: "right" });
		const closed = closeWorkspaceTab(ws, tabId(ws, 2, "/b"));
		expect(closed.layout).toMatchObject({ kind: "split", direction: "row", sizes: [0.5, 0.25, 0.25] });
		expect(paneRects(closed.layout).get(4)).toEqual({ x: 0.75, y: 0, width: 0.25, height: 1 });
	});
});

describe("workspace-wide tab commands", () => {
	it("selects an open Settings tab in another pane instead of opening a second one", () => {
		let ws = withTabs(createWorkspace("/a"), 1, SETTINGS_PATH, "/b");
		ws = moveTab(ws, tabId(ws, 1, "/b"), { kind: "split", paneId: 1, edge: "right" });
		const next = openOrSelectSettingsInWorkspace(ws);
		expect(next.focusedPaneId).toBe(1);
		expect(activePath(next, 1)).toBe(SETTINGS_PATH);
		expect(next.panes.flatMap((pane) => pane.tabs).filter((tab) => tab.path === SETTINGS_PATH)).toHaveLength(1);
		const fresh = openOrSelectSettingsInWorkspace(sideBySide());
		expect(activePath(fresh, 2)).toBe(SETTINGS_PATH);
	});

	it("⌘K prefers an AI Search tab already on screen, then one in the focused pane, then opens one", () => {
		let ws = withTabs(createWorkspace("/a"), 1, AI_SEARCH_PATH);
		ws = moveTab(ws, tabId(ws, 1, AI_SEARCH_PATH), { kind: "split", paneId: 1, edge: "right" });
		ws = focusPane(ws, 1);
		const visible = focusAiSearchInWorkspace(ws);
		expect(visible.focusedPaneId).toBe(2);
		expect(focusAiSearchInWorkspace(visible)).toBe(visible);

		// Pane 2 (focused) holds an AI Search tab behind /c; pane 1 shows only /a.
		const hidden = withTabs(withTabs(sideBySide(), 2, AI_SEARCH_PATH), 2, "/c");
		const local = focusAiSearchInWorkspace(hidden);
		expect(local.focusedPaneId).toBe(2);
		expect(activePath(local, 2)).toBe(AI_SEARCH_PATH);
		expect(paths(local, 2)).toEqual(["/b", AI_SEARCH_PATH, "/c"]);
		// A hidden AI tab in another pane is brought forward there, not duplicated.
		const elsewhere = focusAiSearchInWorkspace(focusPane(hidden, 1));
		expect(elsewhere.focusedPaneId).toBe(2);
		expect(activePath(elsewhere, 2)).toBe(AI_SEARCH_PATH);

		const none = focusAiSearchInWorkspace(sideBySide());
		expect(none.focusedPaneId).toBe(2);
		expect(paths(none, 2)).toEqual(["/b", AI_SEARCH_PATH]);
	});

	it("evacuates tabs inside an ejected volume in every pane", () => {
		let ws = withTabs(createWorkspace("/Volumes/USB/a"), 1, "/Volumes/USB/b");
		ws = moveTab(ws, tabId(ws, 1, "/Volumes/USB/b"), { kind: "split", paneId: 1, edge: "right" });
		const next = evacuateWorkspace(ws, "/Volumes/USB", "/Users/me");
		expect(paths(next, 1)).toEqual(["/Users/me"]);
		expect(paths(next, 2)).toEqual(["/Users/me"]);
	});

	it("resizes a split within the minimum pane share", () => {
		const ws = sideBySide();
		const handle = splitHandles(ws.layout)[0]!;
		const wider = resizeSplit(ws, handle.splitId, handle.index, 0.2, 0.1);
		expect(paneRects(wider.layout).get(1)?.width).toBeCloseTo(0.7);
		const clamped = resizeSplit(ws, handle.splitId, handle.index, 0.9, 0.1);
		expect(paneRects(clamped.layout).get(2)?.width).toBeCloseTo(0.1);
	});
});

describe("reopening closed tabs", () => {
	it("brings back the closed tab with its folder, history and selection, in its old slot", () => {
		let ws = withTabs(createWorkspace("/a"), 1, "/b", "/c");
		ws = updatePaneTabs(ws, 1, (state) => {
			const moved = navigateTab(state, "/c/deeper");
			return {
				...moved,
				tabs: moved.tabs.map((tab) =>
					tab.path === "/c/deeper" ? { ...tab, selection: { keys: ["/c/deeper/x"], anchor: "/c/deeper/x", focus: "/c/deeper/x" } } : tab,
				),
			};
		});
		const closedId = tabId(ws, 1, "/c/deeper");
		ws = closeWorkspaceTab(withTabs(ws, 1, "/d"), tabId(ws, 1, "/b"));
		ws = closeWorkspaceTab(ws, closedId);
		expect(paths(ws, 1)).toEqual(["/a", "/d"]);

		const reopened = reopenClosedTab(ws);
		expect(paths(reopened, 1)).toEqual(["/a", "/c/deeper", "/d"]);
		const tab = paneOf(reopened, 1).tabs.find((candidate) => candidate.path === "/c/deeper")!;
		expect(paneOf(reopened, 1).activeId).toBe(tab.id);
		expect(tab.id).not.toBe(closedId);
		expect(tab.back).toEqual(["/c"]);
		expect(tab.selection.focus).toBe("/c/deeper/x");
		expect(reopened.closedTabs).toHaveLength(1);
	});

	it("reopens most recent first, then the earlier ones", () => {
		let ws = withTabs(createWorkspace("/a"), 1, "/b", "/c");
		ws = closeWorkspaceTab(ws, tabId(ws, 1, "/b"));
		ws = closeWorkspaceTab(ws, tabId(ws, 1, "/c"));
		ws = reopenClosedTab(ws);
		expect(activePath(ws, 1)).toBe("/c");
		ws = reopenClosedTab(ws);
		expect(paths(ws, 1)).toEqual(["/a", "/b", "/c"]);
		expect(activePath(ws, 1)).toBe("/b");
		expect(reopenClosedTab(ws)).toBe(ws);
	});

	it("restores a tab whose pane was closed into the focused pane", () => {
		let ws = createWorkspace("/a");
		ws = withTabs(ws, 1, "/b");
		ws = moveTab(ws, tabId(ws, 1, "/b"), { kind: "split", paneId: 1, edge: "right" });
		ws = closeWorkspaceTab(ws, tabId(ws, 2, "/b"));
		expect(ws.panes).toHaveLength(1);
		const reopened = reopenClosedTab(ws);
		expect(paths(reopened, 1)).toEqual(["/a", "/b"]);
		expect(reopened.focusedPaneId).toBe(1);
	});

	it("never remembers Settings or AI Search tabs", () => {
		let ws = withTabs(createWorkspace("/a"), 1, SETTINGS_PATH, AI_SEARCH_PATH);
		ws = closeWorkspaceTab(ws, tabId(ws, 1, SETTINGS_PATH));
		ws = closeWorkspaceTab(ws, tabId(ws, 1, AI_SEARCH_PATH));
		expect(ws.closedTabs).toEqual([]);
		expect(reopenClosedTab(ws)).toBe(ws);
	});

	it("does not remember a refused close of the window's last tab", () => {
		const ws = createWorkspace("/a");
		expect(closeWorkspaceTab(ws, tabId(ws, 1, "/a")).closedTabs).toEqual([]);
	});

	it("keeps only the newest CLOSED_TAB_LIMIT closed tabs", () => {
		let ws = createWorkspace("/keep");
		for (let index = 0; index < CLOSED_TAB_LIMIT + 5; index += 1) {
			ws = withTabs(ws, 1, `/t${index}`);
			ws = closeWorkspaceTab(ws, tabId(ws, 1, `/t${index}`));
		}
		expect(ws.closedTabs).toHaveLength(CLOSED_TAB_LIMIT);
		expect(reopenClosedTab(ws).panes[0]?.tabs.at(-1)?.path).toBe(`/t${CLOSED_TAB_LIMIT + 4}`);
	});
});

describe("Evidence Folder workspace lifecycle", () => {
	it("does not remember a closed Evidence Folder tab in closedTabs (⇧⌘T)", () => {
		const evidenceRoot = "/tmp/dazzi-evidence-abc/Evidence Folder";
		let ws = createWorkspace("/a");
		ws = updatePaneTabs(ws, 1, (state) => openEvidenceFolderTab(state, evidenceRoot));
		const evTabId = tabId(ws, 1, evidenceRoot);
		ws = closeWorkspaceTab(ws, evTabId);
		expect(paths(ws, 1)).toEqual(["/a"]);
		expect(ws.closedTabs).toEqual([]);
		expect(reopenClosedTab(ws)).toBe(ws);
	});

	it("preserves evidenceFolder ownership when an Evidence Folder tab moves between split panes", () => {
		const evidenceRoot = "/tmp/dazzi-evidence-abc/Evidence Folder";
		let ws = createWorkspace("/a");
		ws = updatePaneTabs(ws, 1, (state) => openEvidenceFolderTab(state, evidenceRoot));
		const evTabId = tabId(ws, 1, evidenceRoot);
		ws = moveTab(ws, evTabId, { kind: "split", paneId: 1, edge: "right" });
		expect(paneOf(ws, 2).tabs[0]?.evidenceFolder).toBe(evidenceRoot);
	});
});

describe("the Automations tab in the workspace", () => {
	it("selects an open Automations tab in another pane instead of opening a second one", () => {
		let ws = withTabs(createWorkspace("/a"), 1, AUTOMATIONS_PATH, "/b");
		ws = moveTab(ws, tabId(ws, 1, "/b"), { kind: "split", paneId: 1, edge: "right" });
		const next = openOrSelectAutomationsInWorkspace(ws);
		expect(next.focusedPaneId).toBe(1);
		expect(activePath(next, 1)).toBe(AUTOMATIONS_PATH);
		expect(next.panes.flatMap((pane) => pane.tabs).filter((tab) => tab.path === AUTOMATIONS_PATH)).toHaveLength(1);
		expect(activePath(openOrSelectAutomationsInWorkspace(sideBySide()), 2)).toBe(AUTOMATIONS_PATH);
	});

	it("never remembers a closed Automations tab for ⇧⌘T", () => {
		let ws = withTabs(createWorkspace("/a"), 1, AUTOMATIONS_PATH);
		ws = closeWorkspaceTab(ws, tabId(ws, 1, AUTOMATIONS_PATH));
		expect(ws.closedTabs).toEqual([]);
		expect(reopenClosedTab(ws)).toBe(ws);
	});
});
