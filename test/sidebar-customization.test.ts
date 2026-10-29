import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsService } from "../src/main/settings-service";
import { navGroups } from "../src/renderer/src/data/places";
import type { FsLocation, FsTag } from "../src/shared/fs-contract";
import {
	DEFAULT_SIDEBAR_SETTINGS,
	isDefaultSidebarSettings,
	isLockedSidebarItemId,
	normalizeSidebarSettings,
	type SidebarSettings,
} from "../src/shared/sidebar-contract";

function place(name: string, section: FsLocation["section"], icon: FsLocation["icon"], path = `/${name}`): FsLocation {
	return {
		name,
		path,
		section,
		icon,
		available: true,
		scanned: false,
		ejectable: section === "locations" && path !== "/",
	};
}

const SAMPLE_LOCATIONS: readonly FsLocation[] = [
	place("Recents", "favorites", "recents", "recents://"),
	place("me", "favorites", "home", "/Users/me"),
	place("Applications", "favorites", "applications", "/Applications"),
	place("Desktop", "favorites", "desktop", "/Users/me/Desktop"),
	place("Documents", "favorites", "documents", "/Users/me/Documents"),
	place("Downloads", "favorites", "downloads", "/Users/me/Downloads"),
	place("Music", "favorites", "music", "/Users/me/Music"),
	place("Movies", "favorites", "movies", "/Users/me/Movies"),
	place("Pictures", "favorites", "pictures", "/Users/me/Pictures"),
	place("Trash", "favorites", "trash", "/Users/me/.Trash"),
	place("iCloud Drive", "cloud", "icloud", "/Users/me/Library/Mobile Documents/com~apple~CloudDocs"),
	place("Google Drive - me@x.com", "cloud", "google-drive", "/Users/me/Library/CloudStorage/GoogleDrive-me@x.com"),
	place("Macintosh HD", "locations", "disk", "/"),
	place("SSD1", "locations", "disk", "/Volumes/SSD1"),
];

const SAMPLE_TAGS: readonly FsTag[] = [
	{ name: "Work", color: 6, sidebar: true },
	{ name: "Archive", color: 1, sidebar: true },
];

describe("sidebar-contract normalization & locked items", () => {
	it("treats AI Search and Automations (including natural-language aliases) as locked and strips them from hiddenItems", () => {
		for (const locked of ["app:aiSearch", "aiSearch", "AI Search", "AI 검색", "app:automations", "automations", "자동화"]) {
			expect(isLockedSidebarItemId(locked), locked).toBe(true);
		}
		expect(isLockedSidebarItemId("place:music")).toBe(false);

		const normalized = normalizeSidebarSettings({
			hiddenItems: ["app:aiSearch", "AI 검색", "app:automations", "자동화", "music", "place:movies", "music"],
			hiddenSections: ["favorites", "cloud", "invalid"],
			favoritesOrder: ["app:aiSearch", "downloads", "documents"],
			sectionOrder: ["locations", "cloud"],
			customFavorites: [{ path: "/Users/me/Projects", label: "Projects" }, { path: "/Users/me/Projects" }, { path: "  " }],
		});

		expect(normalized.hiddenItems).toEqual(["place:music", "place:movies"]);
		expect(normalized.hiddenSections).toEqual(["cloud"]);
		expect(normalized.favoritesOrder).toEqual(["place:downloads", "place:documents"]);
		expect(normalized.sectionOrder).toEqual(["locations", "cloud", "favorites", "tags"]);
		expect(normalized.customFavorites).toEqual([{ path: "/Users/me/Projects", label: "Projects" }]);
		expect(isDefaultSidebarSettings(normalized)).toBe(false);
		expect(isDefaultSidebarSettings(DEFAULT_SIDEBAR_SETTINGS)).toBe(true);
	});
});

describe("navGroups with SidebarSettings", () => {
	it("hides selected favorite, cloud, location, and tag rows while ALWAYS keeping AI Search and Automations visible", () => {
		const settings: SidebarSettings = {
			...DEFAULT_SIDEBAR_SETTINGS,
			// Even if a caller passes locked ids in an unnormalized object, navGroups must never hide AI Search or Automations.
			hiddenItems: [
				"app:aiSearch",
				"app:automations",
				"place:applications",
				"place:music",
				"place:movies",
				"place:pictures",
				"cloud:/Users/me/Library/CloudStorage/GoogleDrive-me@x.com",
				"location:/Volumes/SSD1",
				"tag:Archive",
			],
		};

		const groups = navGroups(SAMPLE_LOCATIONS, SAMPLE_TAGS, settings);

		expect(groups.map((g) => [g.label, g.items.map((item) => item.label)])).toEqual([
			["Favorites", ["AI Search", "Automations", "Recents", "me", "Desktop", "Documents", "Downloads", "Trash"]],
			["Cloud", ["iCloud Drive"]],
			["Locations", ["Macintosh HD"]],
			["Tags", ["Work"]],
		]);
	});

	it("keeps Favorites with AI Search and Automations even when every OS favorite is hidden", () => {
		const settings = normalizeSidebarSettings({
			hiddenItems: [
				"recents",
				"home",
				"applications",
				"desktop",
				"documents",
				"downloads",
				"music",
				"movies",
				"pictures",
				"trash",
			],
			hiddenSections: ["cloud", "locations", "tags"],
		});

		const groups = navGroups(SAMPLE_LOCATIONS, SAMPLE_TAGS, settings);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.label).toBe("Favorites");
		expect(groups[0]?.items.map((item) => item.label)).toEqual(["AI Search", "Automations"]);
	});

	it("reorders customizable Favorites, pins custom folders, and reorders sections while keeping AI Search and Automations first", () => {
		const settings = normalizeSidebarSettings({
			favoritesOrder: ["custom:/Users/me/Projects", "place:downloads", "place:documents"],
			customFavorites: [{ path: "/Users/me/Projects", label: "Projects" }],
			sectionOrder: ["favorites", "tags", "locations", "cloud"],
			hiddenSections: ["cloud"],
		});

		const groups = navGroups(SAMPLE_LOCATIONS, SAMPLE_TAGS, settings);
		expect(groups.map((g) => g.label)).toEqual(["Favorites", "Tags", "Locations"]);
		expect(groups[0]?.items.slice(0, 6).map((item) => item.label)).toEqual([
			"AI Search",
			"Automations",
			"Projects",
			"Downloads",
			"Documents",
			"Recents",
		]);
		expect(groups[0]?.items[2]?.path).toBe("/Users/me/Projects");
	});
});

describe("settingsService sidebar persistence in settings-state.json", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		for (const fn of cleanups.splice(0)) await fn();
	});

	function createStubDeps(directory: string, onSettingsChanged?: (s: unknown) => void) {
		return {
			directory,
			dataSources: { list: vi.fn(), setEnabled: vi.fn(), setDescription: vi.fn(), sync: vi.fn() } as never,
			models: { resolve: vi.fn(), catalog: vi.fn() } as never,
			config: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), patch: vi.fn(), rename: vi.fn() } as never,
			refreshConfig: vi.fn() as never,
			credentials: { list: vi.fn(), set: vi.fn(), remove: vi.fn() } as never,
			onSettingsChanged: onSettingsChanged as never,
		};
	}

	it("persists sidebar settings to settings-state.json and sanitizes locked items on write and reload", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dazzi-sidebar-settings-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));

		const changed = vi.fn();
		const svc = createSettingsService(createStubDeps(dir, changed));

		const updated = await svc.set({
			sidebar: {
				hiddenItems: ["app:aiSearch", "app:automations", "place:music", "place:movies"],
				hiddenSections: ["tags"],
				favoritesOrder: ["place:downloads"],
				sectionOrder: ["favorites", "cloud", "locations", "tags"],
				customFavorites: [{ path: "/Users/me/Code", label: "Code" }],
			},
		});

		expect(updated.sidebar.hiddenItems).toEqual(["place:music", "place:movies"]);
		expect(updated.sidebar.hiddenSections).toEqual(["tags"]);
		expect(updated.sidebar.customFavorites).toEqual([{ path: "/Users/me/Code", label: "Code" }]);
		expect(changed).toHaveBeenCalledTimes(1);

		const disk = JSON.parse(await readFile(join(dir, "settings-state.json"), "utf8"));
		expect(disk.settings.sidebar.hiddenItems).toEqual(["place:music", "place:movies"]);

		// Simulate hand-editing settings-state.json to try hiding AI Search & Automations
		disk.settings.sidebar.hiddenItems = ["app:aiSearch", "app:automations", "place:trash"];
		await writeFile(join(dir, "settings-state.json"), JSON.stringify(disk, null, 2), "utf8");

		const reloaded = await createSettingsService(createStubDeps(dir)).get();
		expect(reloaded.sidebar.hiddenItems).toEqual(["place:trash"]);
	});
});
