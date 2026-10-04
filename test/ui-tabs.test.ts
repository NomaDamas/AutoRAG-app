import { describe, expect, it } from "vitest";
import {
	activeTab,
	canCloseTab,
	closeTab,
	createTabsState,
	goBack,
	goForward,
	navigateTab,
	openTab,
	openTabAt,
	openOrSelectSettingsTab,
	selectTab,
	SETTINGS_PATH,
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
		expect(tabTitle(tab, { isActive: true, query: "예산" })).toBe('Search "예산"');
	});

	it("ignores the query on inactive tabs", () => {
		expect(tabTitle(tab, { isActive: false, query: "예산" })).toBe("2026 Q3");
	});

	it("keeps the Settings title and ignores search query", () => {
		expect(tabTitle({ path: SETTINGS_PATH }, { isActive: true, query: "model" })).toBe("Settings");
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
