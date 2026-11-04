/**
 * Pure first-run logic: which screen opens, which tour steps the data
 * supports, the version family the tour shows, where a coach bubble sits, and
 * the split the tour arranges. The React layer (`FirstRun.tsx`) only renders it.
 */

import type { SetupStatus } from "../../../shared/onboarding-contract";
import type { VersionFamilyData } from "../state/version-family";
import { AI_SEARCH_PATH, openAiSearchTab } from "../state/tabs";
import { allTabs, focusPane, moveTab, updatePaneTabs, type Workspace } from "../state/workspace";

export type FirstRunScreen = "setup" | "ready" | "tour" | "plans";

/** The setup run first; it may already have finished before a relaunch. */
export function initialScreen(status: SetupStatus): FirstRunScreen {
	return status.stage === "ready" ? "ready" : "setup";
}

export type TourStepId = "welcome" | "question" | "ask" | "answer" | "cite" | "evidence" | "duplicates" | "versions";

/** Steps that only make sense once the demo question produced a cited answer. */
const CITED_STEPS: Readonly<Partial<Record<TourStepId, true>>> = { cite: true, evidence: true };

/** Steps where the user acts on the spotlighted control directly rather than pressing a Next button. */
const ACTION_REQUIRED_STEPS: Readonly<Partial<Record<TourStepId, true>>> = { ask: true, cite: true, duplicates: true };

export function stepRequiresUserAction(step: TourStepId): boolean {
	return ACTION_REQUIRED_STEPS[step] === true;
}

/**
 * The tour the data supports: the AI steps need the verified demo question,
 * the duplicate steps a version family.
 */
export function tourSteps(input: { readonly demo: boolean; readonly family: boolean }): readonly TourStepId[] {
	return [
		"welcome",
		...(input.demo ? (["question", "ask", "answer", "cite", "evidence"] as const) : []),
		...(input.family ? (["duplicates", "versions"] as const) : []),
	];
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
 * The family the duplicates step shows: one whose head the Finder can list
 * (its entry is known) and that really has another copy, preferring one inside
 * the folder the left pane already shows, then the largest.
 */
export function pickTourFamily(families: readonly VersionFamilyData[], preferDir: string | null): VersionFamilyData | null {
	const usable = families.filter((family) => family.members.length > 0 && family.entriesByPath[family.head] !== undefined);
	if (usable.length === 0) return null;
	const inside = (family: VersionFamilyData): boolean => preferDir !== null && preferDir !== "" && family.head.startsWith(`${preferDir.replace(/[\\/]+$/u, "")}/`);
	return [...usable].sort((a, b) => Number(inside(b)) - Number(inside(a)) || b.members.length - a.members.length)[0] ?? null;
}

/**
 * The tour's window: the folder the focused pane shows on the left and an AI
 * Search tab split off to its right, which takes focus. A workspace that
 * already shows AI Search in another pane is left as it is.
 */
export function splitWithAiSearch(ws: Workspace): Workspace {
	const shown = ws.panes.filter((pane) => pane.tabs.find((tab) => tab.id === pane.activeId)?.path === AI_SEARCH_PATH);
	if (shown.length > 0 && ws.panes.length > 1) return focusPane(ws, shown[0]?.id ?? ws.focusedPaneId);
	const paneId = ws.focusedPaneId;
	const opened = updatePaneTabs(ws, paneId, openAiSearchTab);
	const aiTab = allTabs(opened).findLast((tab) => tab.path === AI_SEARCH_PATH);
	if (aiTab === undefined) return ws;
	return moveTab(opened, aiTab.id, { kind: "split", paneId, edge: "right" });
}

/** The pane the tour treats as "the folder side": the first one not showing AI Search. */
export function folderPaneId(ws: Workspace): number | null {
	const pane = ws.panes.find((candidate) => candidate.tabs.find((tab) => tab.id === candidate.activeId)?.path !== AI_SEARCH_PATH);
	return pane?.id ?? null;
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
export function placeBubble(anchor: Rect | null, viewport: { readonly width: number; readonly height: number }, size: { readonly width: number; readonly height: number }): { readonly left: number; readonly top: number; readonly side: BubbleSide } {
	const clampX = (x: number): number => Math.min(Math.max(x, MARGIN), Math.max(MARGIN, viewport.width - size.width - MARGIN));
	const clampY = (y: number): number => Math.min(Math.max(y, MARGIN), Math.max(MARGIN, viewport.height - size.height - MARGIN));
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
