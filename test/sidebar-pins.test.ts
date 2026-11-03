import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsService } from "../src/main/settings-service";
import { navGroups } from "../src/renderer/src/data/places";
import { FINDER_DRAG_TYPE } from "../src/renderer/src/state/attachments";
import {
	droppedFolders,
	folderPinState,
	gapAtPointer,
	isMoveInPlace,
	moveShownFavorite,
	pinFolders,
	shownFavoriteIds,
	SIDEBAR_ITEM_DRAG_TYPE,
	sidebarDragKind,
	unpinFavorite,
} from "../src/renderer/src/state/sidebar-pins";
import type { FsLocation } from "../src/shared/fs-contract";
import {
	DEFAULT_SIDEBAR_SETTINGS,
	normalizeSidebarSettings,
	type SidebarSettings,
} from "../src/shared/sidebar-contract";
import { withCustomFavorite, withoutCustomFavorite } from "../src/shared/sidebar-favorites";

function place(name: string, icon: FsLocation["icon"], path: string): FsLocation {
	return { name, path, section: "favorites", icon, available: true, scanned: false, ejectable: false };
}

const LOCATIONS: readonly FsLocation[] = [
	place("Recents", "recents", "recents://"),
	place("me", "home", "/Users/me"),
	place("Desktop", "desktop", "/Users/me/Desktop"),
	place("Documents", "documents", "/Users/me/Documents"),
	place("Downloads", "downloads", "/Users/me/Downloads"),
];

const settings = (patch: Partial<SidebarSettings> = {}): SidebarSettings => ({ ...DEFAULT_SIDEBAR_SETTINGS, ...patch });

/** The Favorites labels the sidebar draws for `sidebar`, app rows left out. */
function labels(sidebar: SidebarSettings): string[] {
	return navGroups(LOCATIONS, [], sidebar)[0]?.items.slice(2).map((item) => item.label) ?? [];
}

describe("shownFavoriteIds", () => {
	it("lists the customizable rows only, in drawn order", () => {
		expect(shownFavoriteIds(settings(), LOCATIONS)).toEqual([
			"place:recents",
			"place:home",
			"place:desktop",
			"place:documents",
			"place:downloads",
		]);
		expect(shownFavoriteIds(settings({ hiddenItems: ["place:home"], customFavorites: [{ path: "/w" }] }), LOCATIONS)).toEqual([
			"place:recents",
			"place:desktop",
			"place:documents",
			"place:downloads",
			"custom:/w",
		]);
	});
});

describe("pinFolders", () => {
	it("pins a folder between two rows and the sidebar draws it there", () => {
		const next = pinFolders(settings(), LOCATIONS, ["/Users/me/Work"], 3);
		expect(next.customFavorites).toEqual([{ path: "/Users/me/Work" }]);
		expect(labels(next)).toEqual(["Recents", "me", "Desktop", "Work", "Documents", "Downloads"]);
	});

	it("pins above the first row and below the last", () => {
		expect(labels(pinFolders(settings(), LOCATIONS, ["/x/Top"], 0))[0]).toBe("Top");
		expect(labels(pinFolders(settings(), LOCATIONS, ["/x/Bottom"], 5)).at(-1)).toBe("Bottom");
	});

	it("appends to Favorites when there is no gap, as the context menu does", () => {
		expect(labels(pinFolders(settings(), LOCATIONS, ["/x/End"], null)).at(-1)).toBe("End");
	});

	it("writes the same pin Settings > Sidebar writes", () => {
		const next = pinFolders(settings(), LOCATIONS, ["/Users/me/Work"], null);
		expect(next.customFavorites).toEqual(withCustomFavorite(settings(), "/Users/me/Work").customFavorites);
		expect(normalizeSidebarSettings(next)).toEqual(next);
	});

	it("does not pin a folder twice", () => {
		const once = pinFolders(settings(), LOCATIONS, ["/Users/me/Work"], 1);
		const twice = pinFolders(once, LOCATIONS, ["/Users/me/Work"], 4);
		expect(twice).toBe(once);
		expect(twice.customFavorites).toHaveLength(1);
		expect(pinFolders(once, LOCATIONS, ["/Users/me/Work/", "/Users/me/Work"], null)).toBe(once);
	});

	it("leaves an OS place the sidebar already draws alone", () => {
		const same = settings();
		expect(pinFolders(same, LOCATIONS, ["/Users/me/Documents"], 0)).toBe(same);
		expect(same.customFavorites).toEqual([]);
	});

	it("shows a hidden OS place again at the gap instead of adding a pin that could never show", () => {
		const hidden = settings({ hiddenItems: ["place:documents"] });
		const next = pinFolders(hidden, LOCATIONS, ["/Users/me/Documents"], 0);
		expect(next.customFavorites).toEqual([]);
		expect(next.hiddenItems).toEqual([]);
		expect(labels(next)[0]).toBe("Documents");
	});

	it("shows a hidden pin again instead of adding a second entry", () => {
		const hidden = settings({ customFavorites: [{ path: "/Users/me/Work" }], hiddenItems: ["custom:/Users/me/Work"] });
		const next = pinFolders(hidden, LOCATIONS, ["/Users/me/Work"], 1);
		expect(next.customFavorites).toEqual([{ path: "/Users/me/Work" }]);
		expect(labels(next)[1]).toBe("Work");
	});

	it("recognizes a pin typed with ~ as the same folder", () => {
		const typed = settings({ customFavorites: [{ path: "~/Work" }] });
		expect(pinFolders(typed, LOCATIONS, ["/Users/me/Work"], 0)).toBe(typed);
	});

	it("pins several folders in a row, in the order dropped", () => {
		const next = pinFolders(settings(), LOCATIONS, ["/x/A", "/x/B", "/x/C"], 2);
		expect(labels(next)).toEqual(["Recents", "me", "A", "B", "C", "Desktop", "Documents", "Downloads"]);
	});

	it("keeps a hidden row's place in the order while pinning around it", () => {
		const hidden = settings({ hiddenItems: ["place:desktop"] });
		const next = pinFolders(hidden, LOCATIONS, ["/x/Work"], 2);
		expect(labels(next)).toEqual(["Recents", "me", "Work", "Documents", "Downloads"]);
		// Showing Desktop again puts it back between me and Work, not at the end.
		const shown = { ...next, hiddenItems: [] };
		expect(labels(shown)).toEqual(["Recents", "me", "Desktop", "Work", "Documents", "Downloads"]);
	});

	it("ignores an empty path", () => {
		const same = settings();
		expect(pinFolders(same, LOCATIONS, ["", "  "], 0)).toBe(same);
	});
});

describe("unpinFavorite", () => {
	it("removes the pin the way Settings > Sidebar removes it", () => {
		const pinned = pinFolders(settings(), LOCATIONS, ["/Users/me/Work"], 1);
		const removed = unpinFavorite(pinned, "custom:/Users/me/Work");
		expect(removed).toEqual(withoutCustomFavorite(pinned, "/Users/me/Work"));
		expect(removed.customFavorites).toEqual([]);
		expect(removed.favoritesOrder).not.toContain("custom:/Users/me/Work");
		expect(labels(removed)).toEqual(["Recents", "me", "Desktop", "Documents", "Downloads"]);
	});

	it("does nothing for an OS place", () => {
		const same = settings();
		expect(unpinFavorite(same, "place:documents")).toBe(same);
	});
});

describe("moveShownFavorite", () => {
	it("moves a row between two others", () => {
		const next = moveShownFavorite(settings(), LOCATIONS, "place:downloads", 2);
		expect(labels(next)).toEqual(["Recents", "me", "Downloads", "Desktop", "Documents"]);
	});

	it("moves a pin and keeps it there", () => {
		const pinned = pinFolders(settings(), LOCATIONS, ["/x/Work"], null);
		const next = moveShownFavorite(pinned, LOCATIONS, "custom:/x/Work", 0);
		expect(labels(next)[0]).toBe("Work");
		expect(normalizeSidebarSettings(next).favoritesOrder).toEqual(next.favoritesOrder);
	});

	it("returns the same settings when the row would not move", () => {
		const same = settings();
		expect(moveShownFavorite(same, LOCATIONS, "place:desktop", 2)).toBe(same);
		expect(moveShownFavorite(same, LOCATIONS, "place:desktop", 3)).toBe(same);
		expect(moveShownFavorite(same, LOCATIONS, "place:unknown", 1)).toBe(same);
	});

	it("tells in-place gaps apart", () => {
		const shown = ["a", "b", "c"];
		expect(isMoveInPlace(shown, "b", 1)).toBe(true);
		expect(isMoveInPlace(shown, "b", 2)).toBe(true);
		expect(isMoveInPlace(shown, "b", 0)).toBe(false);
		expect(isMoveInPlace(shown, "b", 3)).toBe(false);
	});
});

describe("folderPinState", () => {
	it("tells a user pin from an OS place, and a shown row from a hidden one", () => {
		const sidebar = settings({ customFavorites: [{ path: "/w" }, { path: "/h" }], hiddenItems: ["custom:/h", "place:downloads"] });
		expect(folderPinState(sidebar, LOCATIONS, "/w")).toEqual({ id: "custom:/w", custom: true, shown: true });
		expect(folderPinState(sidebar, LOCATIONS, "/h")).toEqual({ id: "custom:/h", custom: true, shown: false });
		expect(folderPinState(sidebar, LOCATIONS, "/Users/me/Documents")).toEqual({ id: "place:documents", custom: false, shown: true });
		expect(folderPinState(sidebar, LOCATIONS, "/Users/me/Downloads")).toEqual({ id: "place:downloads", custom: false, shown: false });
		expect(folderPinState(sidebar, LOCATIONS, "/elsewhere")).toBeNull();
	});
});

describe("persistence", () => {
	const dirs: string[] = [];
	afterEach(async () => {
		for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
	});

	const deps = (directory: string) => ({
		directory,
		dataSources: { list: vi.fn(), setEnabled: vi.fn(), setDescription: vi.fn(), sync: vi.fn() } as never,
		models: { resolve: vi.fn(), catalog: vi.fn() } as never,
		config: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), patch: vi.fn(), rename: vi.fn() } as never,
		refreshConfig: vi.fn() as never,
		credentials: { list: vi.fn(), set: vi.fn(), remove: vi.fn() } as never,
	});

	it("keeps a pinned folder and its place across a restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "dazzi-sidebar-pin-"));
		dirs.push(directory);
		const before = await createSettingsService(deps(directory)).get();
		const pinned = pinFolders(before.sidebar, LOCATIONS, ["/Users/me/Work", "/Users/me/Notes"], 2);
		const saved = await createSettingsService(deps(directory)).set({ sidebar: pinned });
		expect(saved.sidebar.customFavorites).toEqual([{ path: "/Users/me/Work" }, { path: "/Users/me/Notes" }]);

		const reopened = await createSettingsService(deps(directory)).get();
		expect(reopened.sidebar).toEqual(saved.sidebar);
		expect(labels(reopened.sidebar)).toEqual(["Recents", "me", "Work", "Notes", "Desktop", "Documents", "Downloads"]);

		const moved = moveShownFavorite(reopened.sidebar, LOCATIONS, "custom:/Users/me/Notes", 0);
		await createSettingsService(deps(directory)).set({ sidebar: moved });
		const afterMove = await createSettingsService(deps(directory)).get();
		expect(labels(afterMove.sidebar)[0]).toBe("Notes");
	});
});

describe("gapAtPointer", () => {
	const rows = [
		{ top: 0, height: 28 },
		{ top: 29, height: 28 },
		{ top: 58, height: 28 },
	];

	it("counts the rows whose middle line the pointer has passed", () => {
		expect(gapAtPointer(rows, -5)).toBe(0);
		expect(gapAtPointer(rows, 13)).toBe(0);
		expect(gapAtPointer(rows, 15)).toBe(1);
		expect(gapAtPointer(rows, 57.5)).toBe(2);
		expect(gapAtPointer(rows, 200)).toBe(3);
	});

	it("is 0 for a group with no customizable rows", () => {
		expect(gapAtPointer([], 40)).toBe(0);
	});
});

describe("what a drag over Favorites does", () => {
	const data = (payload: Record<string, string>, extraTypes: string[] = []) => ({
		types: [...Object.keys(payload), ...extraTypes],
		getData: (format: string) => payload[format] ?? "",
		items: [],
	});
	const finder = (...entries: { path: string; kind: "file" | "folder" }[]) =>
		data({ [FINDER_DRAG_TYPE]: JSON.stringify(entries.map((entry) => ({ ...entry, name: entry.path.split("/").pop() }))) });

	it("reorders for a Favorites row of this sidebar", () => {
		expect(sidebarDragKind(data({ [SIDEBAR_ITEM_DRAG_TYPE]: "place:music" }))).toBe("reorder");
	});

	it("pins for Finder rows that include a folder, and ignores rows that are only files", () => {
		expect(sidebarDragKind(finder({ path: "/a/Docs", kind: "folder" }, { path: "/a/x.txt", kind: "file" }))).toBe("pin");
		expect(sidebarDragKind(finder({ path: "/a/x.txt", kind: "file" }))).toBeNull();
	});

	it("leaves an OS file drag open until the drop shows whether it holds a folder", () => {
		expect(sidebarDragKind(data({}, ["Files"]))).toBe("pin");
	});

	it("ignores text, links, and an empty drag", () => {
		expect(sidebarDragKind(data({ "text/plain": "hello" }))).toBeNull();
		expect(sidebarDragKind(data({ "text/uri-list": "https://example.com" }))).toBeNull();
		expect(sidebarDragKind(data({}))).toBeNull();
	});

	it("takes only the folders from a drop", () => {
		const drop = finder({ path: "/a/Docs", kind: "folder" }, { path: "/a/x.txt", kind: "file" }, { path: "/a/Pics", kind: "folder" });
		expect(droppedFolders(drop, () => "")).toEqual(["/a/Docs", "/a/Pics"]);
		expect(droppedFolders(finder({ path: "/a/x.txt", kind: "file" }), () => "")).toEqual([]);
	});

	it("takes a folder dragged in from another app and skips a file", () => {
		const file = { name: "Work" };
		const loose = { name: "x.txt" };
		const drop = {
			types: ["Files"],
			getData: () => "",
			items: [
				{ kind: "file", getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: true }) },
				{ kind: "file", getAsFile: () => loose, webkitGetAsEntry: () => ({ isDirectory: false }) },
			],
		};
		expect(droppedFolders(drop, (f) => (f === file ? "/Users/me/Work" : "/Users/me/x.txt"))).toEqual(["/Users/me/Work"]);
	});
});
