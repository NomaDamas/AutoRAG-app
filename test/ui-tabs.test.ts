import { describe, expect, it } from "vitest";
import { setAppLanguage } from "../src/shared/i18n/core";
import {
	activeTab,
	AI_SEARCH_PATH,
	aiPanelTabs,
	applyColumnChoice,
	canCloseTab,
	closeTab,
	createTabsState,
	focusAiSearchTab,
	goBack,
	exitVirtualTab,
	goForward,
	isVirtualTabPath,
	navigateTab,
	openAiSearchTab,
	openEvidenceFolderTab,
	openTab,
	openTabAt,
	openOrSelectSettingsTab,
	selectTab,
	SETTINGS_PATH,
	showAiSearchInActiveTab,
	tabTitle,
	evacuateTabs,
} from "../src/renderer/src/state/tabs";

describe("evacuateTabs", () => {
	it("moves every tab inside an unmounted volume to the fallback and drops history into it", () => {
		// Given one tab deep inside /Volumes/USB with history that also visits it, and one tab elsewhere
		let state = navigateTab(createTabsState("/Users/me/Documents"), "/Volumes/USB");
		state = navigateTab(state, "/Volumes/USB/photos");
		state = openTabAt(state, "/Users/me/Desktop");
		state = navigateTab(state, "/Volumes/USB-backup");

		// When the volume is ejected
		const next = evacuateTabs(state, "/Volumes/USB", "/Users/me");

		// Then the inside tab lands on the fallback, keeping only history outside the volume
		expect(next.tabs[0]).toMatchObject({ path: "/Users/me", back: ["/Users/me/Documents"], fwd: [] });
		// And a sibling volume whose name merely shares the prefix is untouched
		expect(next.tabs[1]).toMatchObject({ path: "/Volumes/USB-backup", back: ["/Users/me/Desktop"] });
	});

	it("is a no-op when no tab is inside the volume", () => {
		const state = createTabsState("/Users/me");
		expect(evacuateTabs(state, "/Volumes/USB", "/")).toBe(state);
	});
});

describe("tab model", () => {
	it("starts with one tab on the given path", () => {
		const state = createTabsState("Recents");
		expect(state.tabs).toHaveLength(1);
		expect(activeTab(state).path).toBe("Recents");
		expect(activeTab(state).back).toEqual([]);
	});

	it("opens a new tab on the same path and activates it", () => {
		const state = openTab(navigateTab(createTabsState("Recents"), "Documents"));
		expect(state.tabs).toHaveLength(2);
		expect(activeTab(state).path).toBe("Documents");
		expect(activeTab(state).id).not.toBe(state.tabs[0]?.id);
	});

	it("opens a new tab on an explicit path and activates it, leaving the old tab alone", () => {
		const state = openTabAt(createTabsState("Recents"), "Documents/Finance");
		expect(state.tabs).toHaveLength(2);
		expect(activeTab(state).path).toBe("Documents/Finance");
		expect(activeTab(state).back).toEqual([]);
		expect(state.tabs[0]?.path).toBe("Recents");
	});

	it("blocks closing the last tab", () => {
		const state = createTabsState("Recents");
		expect(canCloseTab(state)).toBe(false);
		const id = activeTab(state).id;
		expect(closeTab(state, id)).toBe(state);
	});

	it("activates the previous tab after closing the active one", () => {
		const three = openTab(openTab(createTabsState("Recents")));
		expect(canCloseTab(three)).toBe(true);
		const middleId = three.tabs[1]?.id ?? -1;
		const closed = closeTab(three, middleId);
		expect(closed.tabs).toHaveLength(2);
		expect(closed.tabs.some((t) => t.id === middleId)).toBe(false);
	});

	it("keeps the active tab when another tab closes", () => {
		const two = openTab(createTabsState("Recents"));
		const firstId = two.tabs[0]?.id ?? -1;
		const closed = closeTab(two, firstId);
		expect(closed.activeId).toBe(two.activeId);
	});

	it("navigates, pushing history and dropping the forward stack", () => {
		let state = navigateTab(createTabsState("Documents"), "Documents/Finance");
		state = navigateTab(state, "Documents/Finance/2026 Q3");
		expect(activeTab(state).back).toEqual(["Documents", "Documents/Finance"]);
		expect(activeTab(state).fwd).toEqual([]);
	});

	it("ignores navigation to the current path", () => {
		const state = navigateTab(createTabsState("Documents"), "Documents");
		expect(activeTab(state).back).toEqual([]);
	});

	it("walks back and forward through history", () => {
		let state = navigateTab(createTabsState("Documents"), "Documents/Finance");
		state = goBack(state);
		expect(activeTab(state).path).toBe("Documents");
		expect(activeTab(state).fwd).toEqual(["Documents/Finance"]);
		state = goForward(state);
		expect(activeTab(state).path).toBe("Documents/Finance");
		expect(activeTab(state).back).toEqual(["Documents"]);
	});

	it("is a no-op at the ends of the history", () => {
		const state = createTabsState("Documents");
		expect(goBack(state)).toBe(state);
		expect(goForward(state)).toBe(state);
	});

	it("clears the selection when the path changes", () => {
		const state = createTabsState("Documents");
		const withSel = {
			...state,
			tabs: state.tabs.map((t) => ({ ...t, selection: { keys: ["Documents/a.pdf"], anchor: null, focus: null } })),
		};
		expect(activeTab(navigateTab(withSel, "Desktop")).selection.keys).toEqual([]);
	});

	it("switches the active tab", () => {
		const two = openTab(createTabsState("Recents"));
		const firstId = two.tabs[0]?.id ?? -1;
		expect(selectTab(two, firstId).activeId).toBe(firstId);
	});
});

describe("tabTitle", () => {
	const tab = { path: "Documents/Finance/2026 Q3" };

	it("shows the last path segment", () => {
		expect(tabTitle(tab, { isActive: false, query: "" })).toBe("2026 Q3");
	});

	it("shows the search query on the active tab", () => {
		expect(tabTitle(tab, { isActive: true, query: "예산" })).toBe('"예산" 검색');
	});

	it("ignores the query on inactive tabs", () => {
		expect(tabTitle(tab, { isActive: false, query: "예산" })).toBe("2026 Q3");
	});

	it("titles Settings in the Interface language and ignores the search query", async () => {
		expect(tabTitle({ path: SETTINGS_PATH }, { isActive: true, query: "model" })).toBe("설정");
		await setAppLanguage("en");
		try {
			expect(tabTitle({ path: SETTINGS_PATH }, { isActive: true, query: "model" })).toBe("Settings");
			expect(tabTitle(tab, { isActive: true, query: "budget" })).toBe('Search "budget"');
		} finally {
			await setAppLanguage("ko");
		}
	});
});

describe("openOrSelectSettingsTab", () => {
	it("opens a new Settings tab if none exists", () => {
		const state = createTabsState("Documents");
		const next = openOrSelectSettingsTab(state);
		expect(next.tabs).toHaveLength(2);
		expect(next.tabs[1]?.path).toBe(SETTINGS_PATH);
		expect(next.activeId).toBe(next.tabs[1]?.id);
	});

	it("selects existing Settings tab if already open", () => {
		const initial = createTabsState("Documents");
		const withSettings = openOrSelectSettingsTab(initial);
		const switchedToFirst = selectTab(withSettings, initial.tabs[0]!.id);
		expect(switchedToFirst.activeId).toBe(initial.tabs[0]!.id);
		const reopened = openOrSelectSettingsTab(switchedToFirst);
		expect(reopened.tabs).toHaveLength(2);
		expect(reopened.activeId).toBe(withSettings.tabs[1]!.id);
	});
});

describe("AI Search tabs", () => {
	it("titles an AI Search tab and ignores the search query", () => {
		expect(tabTitle({ path: AI_SEARCH_PATH }, { isActive: true, query: "budget" })).toBe("AI 검색");
	});

	it("treats Settings and AI Search as virtual paths, never folders", () => {
		expect(isVirtualTabPath(SETTINGS_PATH)).toBe(true);
		expect(isVirtualTabPath(AI_SEARCH_PATH)).toBe(true);
		expect(isVirtualTabPath("/Users/me/AI Search")).toBe(false);
		expect(isVirtualTabPath("Recents")).toBe(false);
	});

	it("turns the focused tab into AI Search, and Back returns to the folder", () => {
		const two = openTabAt(createTabsState("/Users/me/Documents"), "/Users/me/Desktop");
		const shown = showAiSearchInActiveTab(two);
		expect(shown.tabs).toHaveLength(2);
		expect(activeTab(shown).id).toBe(two.activeId);
		expect(activeTab(shown).path).toBe(AI_SEARCH_PATH);
		expect(shown.tabs[0]?.path).toBe("/Users/me/Documents");
		expect(activeTab(goBack(shown)).path).toBe("/Users/me/Desktop");
	});

	it("keeps an AI Search tab as it is when shown again", () => {
		const shown = showAiSearchInActiveTab(createTabsState("/Users/me/Documents"));
		expect(showAiSearchInActiveTab(shown)).toBe(shown);
	});

	it("opens a new AI Search tab even when one exists", () => {
		const first = openAiSearchTab(createTabsState("/Users/me/Documents"));
		const second = openAiSearchTab(selectTab(first, first.tabs[0]!.id));
		expect(second.tabs.map((tab) => tab.path)).toEqual(["/Users/me/Documents", AI_SEARCH_PATH, AI_SEARCH_PATH]);
		expect(second.activeId).toBe(second.tabs[2]?.id);
		expect(activeTab(second).back).toEqual([]);
	});

	it("focuses the active AI Search tab, else the nearest open one, else opens one", () => {
		const docs = createTabsState("/Users/me/Documents");
		const opened = focusAiSearchTab(docs);
		expect(opened.tabs).toHaveLength(2);
		expect(activeTab(opened).path).toBe(AI_SEARCH_PATH);

		expect(focusAiSearchTab(opened)).toBe(opened);

		const away = openTabAt(opened, "/Users/me/Desktop");
		const back = focusAiSearchTab(away);
		expect(back.tabs).toHaveLength(3);
		expect(back.activeId).toBe(opened.activeId);
	});

	it("prefers the AI Search tab closest to the focused tab", () => {
		let state = openAiSearchTab(createTabsState("/a"));
		const leftAi = state.activeId;
		state = openTabAt(state, "/b");
		state = openAiSearchTab(state);
		const rightAi = state.activeId;
		state = openTabAt(state, "/c");
		expect(focusAiSearchTab(state).activeId).toBe(rightAi);
		expect(focusAiSearchTab(selectTab(state, state.tabs[0]!.id)).activeId).toBe(leftAi);
	});

	it("keeps a tab's AI Search chat mounted after the tab navigates away, until it closes", () => {
		const tabs = [
			{ id: 1, aiSearch: false },
			{ id: 2, aiSearch: true },
		];
		const mounted = aiPanelTabs([], tabs);
		expect(mounted).toEqual([2]);
		expect(aiPanelTabs(mounted, tabs)).toBe(mounted);
		const away = aiPanelTabs(mounted, [
			{ id: 1, aiSearch: false },
			{ id: 2, aiSearch: false },
		]);
		expect(away).toBe(mounted);
		expect(aiPanelTabs(away, [{ id: 1, aiSearch: true }])).toEqual([1]);
	});

	it("opens a new tab from a virtual tab on the last folder the tabs showed", () => {
		let state = navigateTab(createTabsState("/Users/me/Documents"), "/Users/me/Desktop");
		state = navigateTab(state, SETTINGS_PATH);
		state = navigateTab(state, AI_SEARCH_PATH);
		expect(activeTab(openTab(state)).path).toBe("/Users/me/Desktop");
		const fresh = openAiSearchTab(createTabsState("/Users/me/Documents"));
		expect(activeTab(openTab(fresh)).path).toBe("/Users/me/Documents");
		expect(activeTab(openTab(createTabsState(AI_SEARCH_PATH))).path).toBe(AI_SEARCH_PATH);
	});

	it("leaves a virtual tab for its last folder, as a navigation Back can undo", () => {
		const docs = createTabsState("/Users/me/Documents");
		expect(exitVirtualTab(docs)).toBe(docs);
		const ai = showAiSearchInActiveTab(docs);
		const left = exitVirtualTab(ai);
		expect(activeTab(left).path).toBe("/Users/me/Documents");
		expect(activeTab(goBack(left)).path).toBe(AI_SEARCH_PATH);
		const lone = createTabsState(AI_SEARCH_PATH);
		expect(exitVirtualTab(lone)).toBe(lone);
	});
});

describe("Evidence Folder tabs", () => {
	const evidenceRoot = "/tmp/dazzi-evidence-123/Evidence Folder";

	it("opens a new tab marked with its evidenceFolder root", () => {
		const initial = openAiSearchTab(createTabsState("/Users/me/Documents"));
		const state = openEvidenceFolderTab(initial, evidenceRoot);
		expect(state.tabs).toHaveLength(3);
		expect(activeTab(state)).toMatchObject({
			path: evidenceRoot,
			evidenceFolder: evidenceRoot,
			back: [],
			fwd: [],
		});
	});

	it("keeps evidenceFolder while browsing inside a nested subfolder, and drops it + prunes history when navigating outside", () => {
		let state = openEvidenceFolderTab(createTabsState("/Users/me/Documents"), evidenceRoot);
		// Navigating into a subfolder inside the evidence folder retains ownership
		state = navigateTab(state, `${evidenceRoot}/sub`);
		expect(activeTab(state).evidenceFolder).toBe(evidenceRoot);
		expect(activeTab(state).back).toEqual([evidenceRoot]);

		// Navigating outside the evidence folder drops ownership and strips evidence paths from back/fwd/chain
		state = navigateTab(state, "/Users/me/Desktop");
		expect(activeTab(state).evidenceFolder).toBeUndefined();
		expect(activeTab(state).back).toEqual([]);
		expect(activeTab(state).fwd).toEqual([]);
	});

	it("drops evidenceFolder when switching the active tab to AI Search or choosing a column outside the root", () => {
		const state = openEvidenceFolderTab(createTabsState("/Users/me/Documents"), evidenceRoot);
		const toAi = showAiSearchInActiveTab(state);
		expect(activeTab(toAi).path).toBe(AI_SEARCH_PATH);
		expect(activeTab(toAi).evidenceFolder).toBeUndefined();
		expect(activeTab(toAi).back).toEqual([]);

		const toCol = applyColumnChoice(
			state,
			{ path: "/Users/me/Documents", chain: ["/Users/me/Documents"] },
			{ keys: [], anchor: null, focus: null },
		);
		expect(activeTab(toCol).evidenceFolder).toBeUndefined();
		expect(activeTab(toCol).back).toEqual([]);
	});
});
