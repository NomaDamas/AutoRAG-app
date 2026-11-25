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
		["ko", "AI 에이전트"],
		["en", "AI Agent"],
		["ja", "AI エージェント"],
		["zh", "AI 智能体"],
	] as const)("names the AI Agent row in %s, with no Automations row beside it", async (language, expected) => {
		await act(() => setAppLanguage(language));
		renderSidebar(null);
		expect(labels()[0]).toBe(expected);
		expect(host.querySelectorAll(".sidebar__item")).toHaveLength(1);
	});

	it("marks the AI Agent row active on an Automations tab (the shell passes AI_SEARCH_PATH), and hands the row to the shell on click", () => {
		const onNavigate = renderSidebar(AI_SEARCH_PATH);
		const rows = [...host.querySelectorAll<HTMLElement>(".sidebar__item")];
		const active = rows.filter((row) => row.getAttribute("aria-current") === "true");
		expect(active).toHaveLength(1);
		expect(active[0]?.querySelector(".sidebar__item-label")?.textContent).toBe("AI 에이전트");
		act(() => rows[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ view: "aiSearch", path: AI_SEARCH_PATH }));
		expect(onNavigate).not.toHaveBeenCalledWith(expect.objectContaining({ path: AUTOMATIONS_PATH }));
	});
});

describe("Sidebar tag colours without Full Disk Access", () => {
	const TAGS = [
		{ name: "Research", color: 0 as const, sidebar: true },
		{ name: "Career", color: 0 as const, sidebar: true },
	];

	function renderTags(denied: boolean, onGrantTagColors = vi.fn()): ReturnType<typeof vi.fn> {
		const drop = { hovered: false, onDragOver: vi.fn(), onDragLeave: vi.fn(), onDrop: vi.fn() };
		act(() =>
			root.render(
				<Sidebar
					groups={navGroups([], TAGS)}
					activePath={null}
					settingsActive={false}
					showHotkeys={false}
					onNavigate={vi.fn()}
					onEject={vi.fn()}
					onHideSidebar={vi.fn()}
					onOpenIndexing={vi.fn()}
					tagColorsDenied={denied}
					onGrantTagColors={onGrantTagColors}
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
		return onGrantTagColors;
	}

	it.each([
		["ko", "태그 색상 보기"],
		["en", "Show tag colors"],
		["ja", "タグの色を表示"],
		["zh", "显示标签颜色"],
	] as const)("offers the Full Disk Access grant under the Tags group in %s, and hands the click to the shell", async (language, label) => {
		await act(() => setAppLanguage(language));
		const onGrant = renderTags(true);
		const button = host.querySelector<HTMLButtonElement>('[data-action="grant-tag-colors"]');
		expect(button?.textContent).toContain(label);
		// It sits inside the Tags group, after the tag rows.
		const group = button?.closest(".side-group");
		expect(group?.querySelectorAll(".tag-dot")).toHaveLength(2);
		act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(onGrant).toHaveBeenCalledTimes(1);
	});

	it("shows no grant row when the colours are readable", () => {
		renderTags(false);
		expect(host.querySelector('[data-action="grant-tag-colors"]')).toBeNull();
	});
});
