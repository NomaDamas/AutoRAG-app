// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navGroups } from "../src/renderer/src/data/places";
import { Sidebar } from "../src/renderer/src/components/Sidebar";
import { AI_SEARCH_PATH, AUTOMATIONS_PATH } from "../src/renderer/src/state/tabs";
import { setAppLanguage } from "../src/shared/i18n";

// The index-activity block subscribes to the preload bridge; a browser-only run has none, and neither do these tests.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	act(() => root.unmount());
	host.remove();
	await setAppLanguage("ko");
});

function renderSidebar(activePath: string | null, onNavigate = vi.fn()): ReturnType<typeof vi.fn> {
	const drop = { hovered: false, onDragOver: vi.fn(), onDragLeave: vi.fn(), onDrop: vi.fn() };
	act(() =>
		root.render(
			<Sidebar
				groups={navGroups([])}
				activePath={activePath}
				settingsActive={false}
				showHotkeys={false}
				onNavigate={onNavigate}
				onEject={vi.fn()}
				onHideSidebar={vi.fn()}
				onOpenIndexing={vi.fn()}
				searchQuery=""
				searchRef={createRef()}
				searchFocused={false}
				onSearchFocus={vi.fn()}
				onSearchBlur={vi.fn()}
				onSubmitSearch={vi.fn()}
				aiSearchDrop={drop}
			/>,
		),
	);
	return onNavigate;
}

const labels = (): string[] => [...host.querySelectorAll(".sidebar__item-label")].map((label) => label.textContent ?? "");

describe("Sidebar app rows", () => {
	it.each([
		["ko", ["AI 검색", "자동화"]],
		["en", ["AI Search", "Automations"]],
		["ja", ["AI 検索", "自動化"]],
		["zh", ["AI 搜索", "自动化"]],
	] as const)("names AI Search and Automations in %s", async (language, expected) => {
		await act(() => setAppLanguage(language));
		renderSidebar(null);
		expect(labels().slice(0, 2)).toEqual(expected);
	});

	it("marks only the Automations row active on the Automations tab, and hands the row to the shell on click", () => {
		const onNavigate = renderSidebar(AUTOMATIONS_PATH);
		const rows = [...host.querySelectorAll<HTMLElement>(".sidebar__item")];
		const active = rows.filter((row) => row.getAttribute("aria-current") === "true");
		expect(active).toHaveLength(1);
		expect(active[0]?.querySelector(".sidebar__item-label")?.textContent).toBe("자동화");
		act(() => rows[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ view: "automations", path: AUTOMATIONS_PATH }));
		expect(onNavigate).not.toHaveBeenCalledWith(expect.objectContaining({ path: AI_SEARCH_PATH }));
	});
});
