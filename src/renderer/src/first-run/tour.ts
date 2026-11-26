/**
 * Pure first-run logic: which screen opens, which tour steps the data
 * supports, where a coach bubble sits, and the window the tour arranges. The React layer (`FirstRun.tsx`) only renders it.
 */

import type { SetupStatus } from "../../../shared/onboarding-contract";
import { AI_SEARCH_PATH, openOrSelectFolderTab, openTabAt, showAiSearchInActiveTab } from "../state/tabs";
import { allTabs, focusPane, moveTab, updatePaneTabs, type Workspace } from "../state/workspace";

/** The visible AI Search panel (one AI host per tab; hidden ones carry `.hidden`). */
export const AI_HOST = "[data-ai-tab]:not(.hidden)";

export type FirstRunScreen = "folders" | "setup" | "ready" | "tour" | "signin";

/** The folder screen before a run starts; the setup run once one is under way (it may already have finished before a relaunch). */
export function initialScreen(status: SetupStatus): FirstRunScreen {
	if (status.stage === "ready") return "ready";
	return status.stage === "idle" ? "folders" : "setup";
}

/**
 * Whether the person may start the app while the first index is still being read: a question the real AI Search
 * already answered from its own document exists (the tour has something confident to show). Once the files are read
 * (`preparing`, then `ready`) the ordinary screens take over.
 */
export function canStartEarly(status: SetupStatus | null): boolean {
	return status !== null && status.demo !== null && status.stage === "indexing";
}

/** One thing, shown well: ask about your own files, get an answer, open what it rests on. */
export type TourStepId = "ask" | "cite" | "evidence";

/** Steps that only make sense once the demo question produced a cited answer. */
const CITED_STEPS: Readonly<Partial<Record<TourStepId, true>>> = { evidence: true };

/** Steps where the user acts on the real Finder controls rather than pressing a Next button. */
export const ACTION_REQUIRED_STEPS: Readonly<Partial<Record<TourStepId, true>>> = {
	ask: true,
	cite: true,
};

/**
 * The tour the data supports: the verified demo question, or nothing. The
 * window already shows the AI 에이전트 tab alone when the tour starts, so
 * nothing asks the person to arrange panes. Duplicates and versions are left
 * for later, where the person meets a stacked row.
 */
export function tourSteps(input: { readonly demo: boolean }): readonly TourStepId[] {
	return input.demo ? ["ask", "cite", "evidence"] : [];
}

/** The step after `current`; an answer without citations skips the citation steps. Null ends the tour. */
export function nextStep(steps: readonly TourStepId[], current: TourStepId, options: { readonly cited: boolean }): TourStepId | null {
	for (let index = steps.indexOf(current) + 1; index < steps.length; index += 1) {
		const step = steps[index] as TourStepId;
		if (!options.cited && CITED_STEPS[step] === true) continue;
		return step;
	}
	return null;
}

/**
 * The tour's window: the focused pane's tab becomes the AI 에이전트 tab, as the
 * sidebar's AI 에이전트 does (Back returns to the folder), so the chat is the
 * only thing on screen. A pane already showing it is focused instead.
 */
export function showAiSearchAlone(ws: Workspace): Workspace {
	const shown = ws.panes.find((pane) => pane.tabs.find((tab) => tab.id === pane.activeId)?.path === AI_SEARCH_PATH);
	if (shown !== undefined) return focusPane(ws, shown.id);
	return updatePaneTabs(ws, ws.focusedPaneId, showAiSearchInActiveTab);
}

/**
 * Two folders side by side: `left` in the focused pane and `right` in a new pane beside it, so a file can be dragged
 * from one to the other. A single pane is split; with two or more panes, the first two take the folders. The right
 * pane is focused, since it is the one the person works in first.
 */
export function splitTwoFolders(ws: Workspace, left: string, right: string): Workspace {
	const [first, second] = ws.panes;
	if (first !== undefined && second !== undefined) {
		const withLeft = updatePaneTabs(ws, first.id, (state) => openOrSelectFolderTab(state, left));
		return focusPane(updatePaneTabs(withLeft, second.id, (state) => openOrSelectFolderTab(state, right)), second.id);
	}
	const leftPaneId = ws.focusedPaneId;
	const withLeft = updatePaneTabs(ws, leftPaneId, (state) => openOrSelectFolderTab(state, left));
	const opened = updatePaneTabs(withLeft, leftPaneId, (state) => openTabAt(state, right));
	const tab = allTabs(opened).findLast((candidate) => candidate.path === right);
	if (tab === undefined) return withLeft;
	return moveTab(opened, tab.id, { kind: "split", paneId: leftPaneId, edge: "right" });
}

/** The pane the tour treats as "the folder side": the first one not showing AI Search, or the single merged pane. */
export function folderPaneId(ws: Workspace): number | null {
	const pane = ws.panes.find((candidate) => candidate.tabs.find((tab) => tab.id === candidate.activeId)?.path !== AI_SEARCH_PATH);
	return (pane ?? ws.panes[0])?.id ?? null;
}

export interface Rect {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

export type BubbleSide = "left" | "right" | "above" | "below" | "center";

/** Gap between the anchor and the bubble, and the margin the bubble keeps from the window edge. */
const GAP = 16;
const MARGIN = 14;

/**
 * Where a coach bubble of `size` goes next to `anchor`: beside it on the side
 * with room (a wide anchor puts it below or above), centred on the window when
 * there is no anchor or the anchor fills the window. Always inside the window.
 */
export function placeBubble(
	anchor: Rect | null,
	viewport: { readonly width: number; readonly height: number },
	size: { readonly width: number; readonly height: number },
	prefer?: "bottom-right" | "below",
): { readonly left: number; readonly top: number; readonly side: BubbleSide } {
	const clampX = (x: number): number => Math.min(Math.max(x, MARGIN), Math.max(MARGIN, viewport.width - size.width - MARGIN));
	const clampY = (y: number): number => Math.min(Math.max(y, MARGIN), Math.max(MARGIN, viewport.height - size.height - MARGIN));
	if (prefer === "bottom-right" && anchor !== null) {
		return {
			left: clampX(anchor.left + anchor.width - size.width - 18),
			top: clampY(anchor.top + anchor.height - size.height - 18),
			side: "center",
		};
	}
	if (prefer === "below" && anchor !== null && viewport.height - (anchor.top + anchor.height) - GAP - MARGIN >= size.height) {
		return {
			left: clampX(anchor.left + anchor.width / 2 - size.width / 2),
			top: anchor.top + anchor.height + GAP,
			side: "below",
		};
	}
	const fills = anchor !== null && anchor.width >= viewport.width * 0.8 && anchor.height >= viewport.height * 0.6;
	if (anchor === null || fills) {
		return { left: clampX((viewport.width - size.width) / 2), top: clampY(viewport.height * 0.62 - size.height / 2), side: "center" };
	}
	const room = {
		left: anchor.left - GAP - MARGIN,
		right: viewport.width - (anchor.left + anchor.width) - GAP - MARGIN,
		above: anchor.top - GAP - MARGIN,
		below: viewport.height - (anchor.top + anchor.height) - GAP - MARGIN,
	};
	const midY = anchor.top + anchor.height / 2 - size.height / 2;
	const midX = anchor.left + anchor.width / 2 - size.width / 2;
	if (room.left >= size.width && room.left >= room.right) return { left: anchor.left - GAP - size.width, top: clampY(midY), side: "left" };
	if (room.right >= size.width) return { left: anchor.left + anchor.width + GAP, top: clampY(midY), side: "right" };
	if (room.above >= size.height && room.above >= room.below) return { left: clampX(midX), top: anchor.top - GAP - size.height, side: "above" };
	if (room.below >= size.height) return { left: clampX(midX), top: anchor.top + anchor.height + GAP, side: "below" };
	return { left: clampX(midX), top: clampY(anchor.top + anchor.height - size.height - GAP), side: "center" };
}
