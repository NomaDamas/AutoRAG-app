import { describe, expect, it } from "vitest";
import { DEFAULT_SIDEBAR_SETTINGS, normalizeSidebarSettings, type SidebarSettings } from "../src/shared/sidebar-contract";
import {
	sortByFavoritesOrder,
	withCustomFavorite,
	withFavoriteMoved,
	withoutCustomFavorite,
} from "../src/shared/sidebar-favorites";

const settings = (patch: Partial<SidebarSettings>): SidebarSettings => ({ ...DEFAULT_SIDEBAR_SETTINGS, ...patch });

describe("sortByFavoritesOrder", () => {
	const rows = ["a", "b", "c", "d"].map((id) => ({ id }));

	it("puts listed ids first in the listed order and keeps the rest in their own order", () => {
		expect(sortByFavoritesOrder(rows, ["c", "a"]).map((row) => row.id)).toEqual(["c", "a", "b", "d"]);
	});

	it("ignores listed ids that have no row and leaves an unlisted set untouched", () => {
		expect(sortByFavoritesOrder(rows, ["gone", "d"]).map((row) => row.id)).toEqual(["d", "a", "b", "c"]);
		expect(sortByFavoritesOrder(rows, []).map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
	});
});

describe("withCustomFavorite", () => {
	it("appends the folder and un-hides its row", () => {
		const next = withCustomFavorite(
			settings({ customFavorites: [{ path: "/a" }], hiddenItems: ["custom:/b", "place:music"] }),
			"/b",
		);
		expect(next.customFavorites).toEqual([{ path: "/a" }, { path: "/b" }]);
		expect(next.hiddenItems).toEqual(["place:music"]);
	});

	it("does not repeat a folder that is already pinned", () => {
		const next = withCustomFavorite(settings({ customFavorites: [{ path: "/a" }, { path: "/b" }] }), "/a");
		expect(next.customFavorites.map((entry) => entry.path)).toEqual(["/b", "/a"]);
	});

	it("does not touch the input", () => {
		const input = settings({ customFavorites: [{ path: "/a" }] });
		withCustomFavorite(input, "/b");
		expect(input.customFavorites).toEqual([{ path: "/a" }]);
	});
});

describe("withoutCustomFavorite", () => {
	it("drops the folder together with its order and hidden entries", () => {
		const next = withoutCustomFavorite(
			settings({
				customFavorites: [{ path: "/a" }, { path: "/b" }],
				favoritesOrder: ["custom:/b", "place:music", "custom:/a"],
				hiddenItems: ["custom:/b", "place:movies"],
			}),
			"/b",
		);
		expect(next.customFavorites).toEqual([{ path: "/a" }]);
		expect(next.favoritesOrder).toEqual(["place:music", "custom:/a"]);
		expect(next.hiddenItems).toEqual(["place:movies"]);
	});
});

describe("withFavoriteMoved", () => {
	const ids = ["place:home", "place:desktop", "custom:/a"];

	it("writes the whole list with the Favorite moved", () => {
		expect(withFavoriteMoved(DEFAULT_SIDEBAR_SETTINGS, ids, 2, 0).favoritesOrder).toEqual([
			"custom:/a",
			"place:home",
			"place:desktop",
		]);
		expect(withFavoriteMoved(DEFAULT_SIDEBAR_SETTINGS, ids, 0, 1).favoritesOrder).toEqual([
			"place:desktop",
			"place:home",
			"custom:/a",
		]);
	});

	it("returns the same settings object when the target is out of range", () => {
		expect(withFavoriteMoved(DEFAULT_SIDEBAR_SETTINGS, ids, 0, -1)).toBe(DEFAULT_SIDEBAR_SETTINGS);
		expect(withFavoriteMoved(DEFAULT_SIDEBAR_SETTINGS, ids, 2, 3)).toBe(DEFAULT_SIDEBAR_SETTINGS);
	});

	it("produces settings that survive normalization", () => {
		const next = withFavoriteMoved(DEFAULT_SIDEBAR_SETTINGS, ids, 2, 0);
		expect(normalizeSidebarSettings(next).favoritesOrder).toEqual(next.favoritesOrder);
	});
});
