// @vitest-environment happy-dom
import { act, createRef, type ReactElement, type SyntheticEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextMenu } from "../src/renderer/src/components/primitives/ContextMenu";
import { Sidebar } from "../src/renderer/src/components/Sidebar";
import { navGroups } from "../src/renderer/src/data/places";
import { SidebarSettingsContext } from "../src/renderer/src/hooks/useSidebarSettings";
import { useSidebarPins } from "../src/renderer/src/hooks/useSidebarPins";
import { useSidebarRowMenu } from "../src/renderer/src/hooks/useSidebarRowMenu";
import { FINDER_DRAG_TYPE } from "../src/renderer/src/state/attachments";
import { shownFavoriteIds, SIDEBAR_ITEM_DRAG_TYPE } from "../src/renderer/src/state/sidebar-pins";
import { setAppLanguage } from "../src/shared/i18n";
import type { FsLocation } from "../src/shared/fs-contract";
import { DEFAULT_SIDEBAR_SETTINGS, type SidebarSettings } from "../src/shared/sidebar-contract";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function place(name: string, icon: FsLocation["icon"], path: string): FsLocation {
	return { name, path, section: "favorites", icon, available: true, scanned: false, ejectable: false };
}

const LOCATIONS: readonly FsLocation[] = [
	place("me", "home", "/Users/me"),
	place("Desktop", "desktop", "/Users/me/Desktop"),
	place("Documents", "documents", "/Users/me/Documents"),
	place("Downloads", "downloads", "/Users/me/Downloads"),
];

const WITH_PIN: SidebarSettings = { ...DEFAULT_SIDEBAR_SETTINGS, customFavorites: [{ path: "/Users/me/Work" }] };

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
	vi.restoreAllMocks();
	Reflect.deleteProperty(globalThis, "autorag");
	await setAppLanguage("ko");
});

interface Handlers {
	readonly onPin: ReturnType<typeof vi.fn>;
	readonly onMove: ReturnType<typeof vi.fn>;
	readonly onRowMenu: ReturnType<typeof vi.fn>;
	readonly aiSearchDragOver: ReturnType<typeof vi.fn>;
	readonly aiSearchDrop: ReturnType<typeof vi.fn>;
}

function renderSidebar(sidebar: SidebarSettings, withFavorites = true): Handlers {
	const onPin = vi.fn();
	const onMove = vi.fn();
	const onRowMenu = vi.fn();
	// The AI Search item claims a Finder drag, over and on drop, the way App's handlers do: preventDefault.
	const aiSearchDragOver = vi.fn((event: SyntheticEvent) => event.preventDefault());
	const aiSearchDrop = vi.fn((event: SyntheticEvent) => event.preventDefault());
	const drop = { hovered: false, onDragOver: aiSearchDragOver, onDragLeave: vi.fn(), onDrop: aiSearchDrop };
	act(() =>
		root.render(
			<Sidebar
				groups={navGroups(LOCATIONS, [], sidebar)}
				activePath={null}
				settingsActive={false}
				showHotkeys={false}
				onNavigate={vi.fn()}
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
				{...(withFavorites
					? { favorites: { shownIds: shownFavoriteIds(sidebar, LOCATIONS), onPin, onMove, onRowMenu, pathForFile: () => "" } }
					: {})}
			/>,
		),
	);
	return { onPin, onMove, onRowMenu, aiSearchDragOver, aiSearchDrop };
}

/** One 28px row per Favorites entry, stacked from y = 100: Recents-less, so Desktop is the 2nd customizable row. */
function layoutRows(): void {
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		const rows = [...host.querySelectorAll<HTMLElement>("[data-favorite-id]")];
		const index = rows.indexOf(this);
		const top = index < 0 ? 0 : 100 + index * 29;
		return { top, bottom: top + 28, left: 0, right: 200, width: 200, height: 28, x: 0, y: top, toJSON: () => ({}) };
	});
}

const rowIds = (): string[] => [...host.querySelectorAll<HTMLElement>("[data-favorite-id]")].map((row) => row.dataset.favoriteId ?? "");
const rowOf = (id: string): HTMLElement => {
	const row = host.querySelector<HTMLElement>(`[data-favorite-id="${CSS.escape(id)}"]`);
	if (row === null) throw new Error(`no row ${id}`);
	return row;
};
const lines = (): { readonly edge: string | null; readonly id: string | null }[] =>
	[...host.querySelectorAll<HTMLElement>("[data-drop-line]")].map((line) => ({
		edge: line.dataset.dropLine ?? null,
		id: line.closest<HTMLElement>("[data-favorite-id]")?.dataset.favoriteId ?? null,
	}));

/** A DataTransfer that stores what is set and lets a test read it back at any time. */
function transfer(payload: Record<string, string> = {}, extraTypes: string[] = []) {
	const store = new Map(Object.entries(payload));
	return {
		effectAllowed: "uninitialized",
		dropEffect: "none",
		get types() {
			return [...store.keys(), ...extraTypes];
		},
		items: [] as unknown[],
		getData: (format: string) => store.get(format) ?? "",
		setData: (format: string, data: string) => void store.set(format, data),
	};
}

function fire(type: string, target: Element, init: { y?: number; data?: ReturnType<typeof transfer>; related?: Element | null } = {}): Event {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, "dataTransfer", { value: init.data ?? transfer() });
	Object.defineProperty(event, "clientY", { value: init.y ?? 0 });
	Object.defineProperty(event, "clientX", { value: 10 });
	Object.defineProperty(event, "relatedTarget", { value: init.related ?? null });
	act(() => void target.dispatchEvent(event));
	return event;
}

const folderDrag = (...paths: string[]) =>
	transfer({ [FINDER_DRAG_TYPE]: JSON.stringify(paths.map((path) => ({ path, name: path.split("/").pop(), kind: "folder" }))) });

describe("Favorites: dropping a folder between rows", () => {
	it("draws an insertion line between the two rows and pins there on drop", () => {
		const { onPin } = renderSidebar(DEFAULT_SIDEBAR_SETTINGS);
		layoutRows();
		expect(rowIds()).toEqual(["place:home", "place:desktop", "place:documents", "place:downloads"]);
		const data = folderDrag("/Users/me/Projects");
		// Rows sit at y 100, 129, 158, 187 (28px tall): y 150 is below Desktop's middle, above Documents'.
		const over = fire("dragover", rowOf("place:desktop"), { y: 150, data });
		expect(over.defaultPrevented).toBe(true);
		expect(lines()).toEqual([{ edge: "top", id: "place:documents" }]);
		fire("drop", rowOf("place:documents"), { y: 150, data });
		expect(onPin).toHaveBeenCalledWith(["/Users/me/Projects"], 2);
		expect(lines()).toEqual([]);
	});

	it("draws the line under the last row for the last gap, and above the first for gap 0", () => {
		const { onPin } = renderSidebar(DEFAULT_SIDEBAR_SETTINGS);
		layoutRows();
		const data = folderDrag("/x/A");
		fire("dragover", rowOf("place:downloads"), { y: 210, data });
		expect(lines()).toEqual([{ edge: "bottom", id: "place:downloads" }]);
		fire("drop", rowOf("place:downloads"), { y: 210, data });
		expect(onPin).toHaveBeenLastCalledWith(["/x/A"], 4);
		fire("dragover", rowOf("place:home"), { y: 90, data });
		expect(lines()).toEqual([{ edge: "top", id: "place:home" }]);
		fire("drop", rowOf("place:home"), { y: 90, data });
		expect(onPin).toHaveBeenLastCalledWith(["/x/A"], 0);
	});

	it("finds the gap from the pointer, so the space between two rows works too", () => {
		const { onPin } = renderSidebar(DEFAULT_SIDEBAR_SETTINGS);
		layoutRows();
		const group = host.querySelector<HTMLElement>(".side-group");
		const data = folderDrag("/x/A");
		const over = fire("dragover", group as Element, { y: 128.5, data });
		expect(over.defaultPrevented).toBe(true);
		fire("drop", group as Element, { y: 128.5, data });
		expect(onPin).toHaveBeenCalledWith(["/x/A"], 1);
	});

	it("pins only the folders of a mixed drop", () => {
		const { onPin } = renderSidebar(DEFAULT_SIDEBAR_SETTINGS);
		layoutRows();
		const data = transfer({
			[FINDER_DRAG_TYPE]: JSON.stringify([
				{ path: "/a/notes.txt", name: "notes.txt", kind: "file" },
				{ path: "/a/Docs", name: "Docs", kind: "folder" },
			]),
		});
		fire("dragover", rowOf("place:documents"), { y: 160, data });
		fire("drop", rowOf("place:documents"), { y: 160, data });
		expect(onPin).toHaveBeenCalledWith(["/a/Docs"], 2);
	});

	it("does not take files: no line, no accept, no pin", () => {
		const { onPin } = renderSidebar(DEFAULT_SIDEBAR_SETTINGS);
		layoutRows();
		const data = transfer({ [FINDER_DRAG_TYPE]: JSON.stringify([{ path: "/a/x.txt", name: "x.txt", kind: "file" }]) });
		const over = fire("dragover", rowOf("place:documents"), { y: 160, data });
		expect(over.defaultPrevented).toBe(false);
		expect(lines()).toEqual([]);
		fire("drop", rowOf("place:documents"), { y: 160, data });
		expect(onPin).not.toHaveBeenCalled();
	});

	it("ignores an OS file drop that holds no folder", () => {
		const { onPin } = renderSidebar(DEFAULT_SIDEBAR_SETTINGS);
		layoutRows();
		const data = transfer({}, ["Files"]);
		data.items = [{ kind: "file", getAsFile: () => ({ name: "x.txt" }), webkitGetAsEntry: () => ({ isDirectory: false }) }];
		fire("dragover", rowOf("place:documents"), { y: 160, data });
		fire("drop", rowOf("place:documents"), { y: 160, data });
		expect(onPin).not.toHaveBeenCalled();
	});

	it("leaves a drop on the AI Search item to AI Search", () => {
		const { onPin, aiSearchDragOver, aiSearchDrop } = renderSidebar(DEFAULT_SIDEBAR_SETTINGS);
		layoutRows();
		const aiSearch = [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "AI Search");
		const data = folderDrag("/x/A");
		fire("dragover", aiSearch as Element, { y: 90, data });
		expect(aiSearchDragOver).toHaveBeenCalled();
		expect(lines()).toEqual([]);
		fire("drop", aiSearch as Element, { y: 90, data });
		expect(aiSearchDrop).toHaveBeenCalled();
		expect(onPin).not.toHaveBeenCalled();
	});

	it("clears the line when the pointer leaves the group or the drag ends", () => {
		renderSidebar(DEFAULT_SIDEBAR_SETTINGS);
		layoutRows();
		const data = folderDrag("/x/A");
		fire("dragover", rowOf("place:desktop"), { y: 150, data });
		expect(lines()).toHaveLength(1);
		fire("dragleave", rowOf("place:desktop"), { y: 150, data, related: rowOf("place:documents") });
		expect(lines()).toHaveLength(1);
		fire("dragleave", rowOf("place:desktop"), { y: 150, data, related: host });
		expect(lines()).toEqual([]);
	});

	it("keeps the insertion line apart from the AI Search ring, which marks a drop ON an item", () => {
		renderSidebar(DEFAULT_SIDEBAR_SETTINGS);
		layoutRows();
		fire("dragover", rowOf("place:desktop"), { y: 150, data: folderDrag("/x/A") });
		const line = host.querySelector<HTMLElement>("[data-drop-line]");
		expect(line?.tagName).toBe("SPAN");
		expect(line?.getAttribute("aria-hidden")).toBe("true");
		expect(line?.closest("button")).toBeNull();
		expect(host.querySelector(".shadow-\\[inset_0_0_0_1\\.5px_var\\(--accent\\)\\]")).toBeNull();
	});

	it("does nothing without the favorites prop", () => {
		renderSidebar(DEFAULT_SIDEBAR_SETTINGS, false);
		expect(host.querySelector("[data-favorite-id]")).toBeNull();
		expect(host.querySelector("[draggable]")).toBeNull();
	});
});

describe("Favorites: reordering by drag", () => {
	it("makes the customizable rows draggable and the two app rows not", () => {
		renderSidebar(WITH_PIN);
		expect(rowIds()).toEqual(["place:home", "place:desktop", "place:documents", "place:downloads", "custom:/Users/me/Work"]);
		for (const id of rowIds()) expect(rowOf(id).getAttribute("draggable")).toBe("true");
		const appRows = [...host.querySelectorAll<HTMLElement>(".side-group > .relative")].slice(0, 2);
		expect(appRows).toHaveLength(2);
		for (const row of appRows) expect(row.getAttribute("draggable")).toBeNull();
	});

	it("carries the row's id on dragstart, shows the line at the gap, and moves on drop", () => {
		const { onMove } = renderSidebar(WITH_PIN);
		layoutRows();
		const data = transfer();
		fire("dragstart", rowOf("custom:/Users/me/Work"), { data });
		expect(data.getData(SIDEBAR_ITEM_DRAG_TYPE)).toBe("custom:/Users/me/Work");
		expect(data.effectAllowed).toBe("move");
		const over = fire("dragover", rowOf("place:desktop"), { y: 150, data });
		expect(over.defaultPrevented).toBe(true);
		expect(lines()).toEqual([{ edge: "top", id: "place:documents" }]);
		fire("drop", rowOf("place:documents"), { y: 150, data });
		expect(onMove).toHaveBeenCalledWith("custom:/Users/me/Work", 2);
		fire("dragend", rowOf("custom:/Users/me/Work"), { data });
		expect(lines()).toEqual([]);
	});

	it("shows no line where the row already sits", () => {
		renderSidebar(WITH_PIN);
		layoutRows();
		const data = transfer();
		fire("dragstart", rowOf("place:desktop"), { data });
		// Above Desktop (gap 1) and below it (gap 2) are both where it already is.
		fire("dragover", rowOf("place:desktop"), { y: 120, data });
		expect(lines()).toEqual([]);
		fire("dragover", rowOf("place:desktop"), { y: 140, data });
		expect(lines()).toEqual([]);
		fire("dragover", rowOf("place:desktop"), { y: 175, data });
		expect(lines()).toEqual([{ edge: "top", id: "place:downloads" }]);
	});

	it("moves a row to the very end", () => {
		const { onMove } = renderSidebar(WITH_PIN);
		layoutRows();
		const data = transfer();
		fire("dragstart", rowOf("place:home"), { data });
		fire("dragover", rowOf("custom:/Users/me/Work"), { y: 240, data });
		expect(lines()).toEqual([{ edge: "bottom", id: "custom:/Users/me/Work" }]);
		fire("drop", rowOf("custom:/Users/me/Work"), { y: 240, data });
		expect(onMove).toHaveBeenCalledWith("place:home", 5);
	});
});

describe("Favorites: the pinned row's menu", () => {
	it("opens on right-click of a pin, and not on an OS place", () => {
		const { onRowMenu } = renderSidebar(WITH_PIN);
		const pinned = fire("contextmenu", rowOf("custom:/Users/me/Work"));
		expect(pinned.defaultPrevented).toBe(true);
		expect(onRowMenu).toHaveBeenCalledTimes(1);
		expect(onRowMenu.mock.calls[0]?.[0]).toMatchObject({ sidebarId: "custom:/Users/me/Work", path: "/Users/me/Work" });
		const os = fire("contextmenu", rowOf("place:documents"));
		expect(os.defaultPrevented).toBe(false);
		expect(onRowMenu).toHaveBeenCalledTimes(1);
	});
});

function Menu({ onUnpin }: { readonly onUnpin: (id: string) => void }): ReactElement {
	const rowMenu = useSidebarRowMenu(onUnpin);
	const pinned = navGroups(LOCATIONS, [], WITH_PIN)[0]?.items.find((item) => item.sidebarId?.startsWith("custom:"));
	return (
		<>
			<button
				type="button"
				data-open
				onContextMenu={(event) => {
					if (pinned !== undefined) rowMenu.open(pinned, event);
				}}
			/>
			{rowMenu.menu === null ? null : (
				<ContextMenu cursor={rowMenu.menu.cursor} entries={rowMenu.menu.entries} onSelect={rowMenu.select} onClose={rowMenu.close} />
			)}
		</>
	);
}

describe("sidebar row menu", () => {
	const open = () => fire("contextmenu", host.querySelector("[data-open]") as Element);

	it("offers 사이드바에서 제거 and unpins the row it opened on", () => {
		const onUnpin = vi.fn();
		act(() => root.render(<Menu onUnpin={onUnpin} />));
		open();
		const item = [...host.querySelectorAll<HTMLElement>('[role="menuitem"], .menu__item')].find((entry) => entry.textContent?.includes("사이드바에서 제거"));
		expect(item).toBeDefined();
		act(() => item?.click());
		expect(onUnpin).toHaveBeenCalledWith("custom:/Users/me/Work");
		expect(host.querySelector(".menu__item")).toBeNull();
	});

	it("is translated", async () => {
		await act(() => setAppLanguage("en"));
		act(() => root.render(<Menu onUnpin={vi.fn()} />));
		open();
		expect(host.textContent).toContain("Remove from Sidebar");
	});

	it("spends Escape on itself: the window keymap's own Esc handling (dismiss) does not also run", () => {
		const dismiss = vi.fn();
		// useFinderKeyboard listens on window in the bubble phase; the key press starts on an element.
		window.addEventListener("keydown", dismiss);
		try {
			act(() => root.render(<Menu onUnpin={vi.fn()} />));
			open();
			const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
			act(() => void host.dispatchEvent(escape));
			expect(host.querySelector(".menu__item")).toBeNull();
			expect(escape.defaultPrevented).toBe(true);
			expect(dismiss).not.toHaveBeenCalled();
			// With the menu gone Escape is the keymap's again.
			act(() => void host.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
			expect(dismiss).toHaveBeenCalledTimes(1);
		} finally {
			window.removeEventListener("keydown", dismiss);
		}
	});

	it("leaves other keys to the keymap while the menu is open", () => {
		const keymap = vi.fn();
		window.addEventListener("keydown", keymap);
		try {
			act(() => root.render(<Menu onUnpin={vi.fn()} />));
			open();
			act(() => void host.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
			expect(keymap).toHaveBeenCalledTimes(1);
			expect(host.querySelector(".menu__item")).not.toBeNull();
		} finally {
			window.removeEventListener("keydown", keymap);
		}
	});

	it("closes on Escape without unpinning", () => {
		const onUnpin = vi.fn();
		act(() => root.render(<Menu onUnpin={onUnpin} />));
		open();
		expect(host.querySelector(".menu__item")).not.toBeNull();
		act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(host.querySelector(".menu__item")).toBeNull();
		expect(onUnpin).not.toHaveBeenCalled();
	});
});

describe("useSidebarPins writes the settings the Settings page writes", () => {
	let pins: ReturnType<typeof useSidebarPins> | null = null;
	const onError = vi.fn();

	function Probe(): ReactElement {
		pins = useSidebarPins(LOCATIONS, onError);
		return <span />;
	}

	function mount(sidebar: SidebarSettings, set = vi.fn().mockResolvedValue({})): ReturnType<typeof vi.fn> {
		Reflect.set(globalThis, "autorag", { settings: { set } });
		Reflect.set(window, "autorag", { settings: { set } });
		act(() =>
			root.render(
				<SidebarSettingsContext value={sidebar}>
					<Probe />
				</SidebarSettingsContext>,
			),
		);
		return set;
	}

	it("pins at the end of Favorites and stores the folder in customFavorites", () => {
		const set = mount(DEFAULT_SIDEBAR_SETTINGS);
		pins?.pin(["/Users/me/Work"], null);
		expect(set).toHaveBeenCalledTimes(1);
		const written = set.mock.calls[0]?.[0] as { sidebar: SidebarSettings };
		expect(written.sidebar.customFavorites).toEqual([{ path: "/Users/me/Work" }]);
		expect(shownFavoriteIds(written.sidebar, LOCATIONS).at(-1)).toBe("custom:/Users/me/Work");
	});

	it("writes nothing when the folder is already pinned", () => {
		const set = mount(WITH_PIN);
		pins?.pin(["/Users/me/Work"], 0);
		expect(set).not.toHaveBeenCalled();
	});

	it("unpins and reorders through the same write", () => {
		const set = mount(WITH_PIN);
		pins?.unpin("custom:/Users/me/Work");
		expect((set.mock.calls[0]?.[0] as { sidebar: SidebarSettings }).sidebar.customFavorites).toEqual([]);
		pins?.move("custom:/Users/me/Work", 0);
		expect(shownFavoriteIds((set.mock.calls[1]?.[0] as { sidebar: SidebarSettings }).sidebar, LOCATIONS)[0]).toBe("custom:/Users/me/Work");
	});

	it("reports a failed write instead of dropping it", async () => {
		const set = mount(DEFAULT_SIDEBAR_SETTINGS, vi.fn().mockRejectedValue(new Error("disk full")));
		pins?.pin(["/Users/me/Work"], null);
		await act(async () => {
			await Promise.resolve();
		});
		expect(set).toHaveBeenCalled();
		expect(onError).toHaveBeenCalledWith("disk full");
	});
});
