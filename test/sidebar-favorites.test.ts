import { describe, expect, it } from "vitest";
import { DEFAULT_SIDEBAR_SETTINGS, normalizeSidebarSettings, type SidebarSettings } from "../src/shared/sidebar-contract";
import {
	favoriteIdsInOrder,
	placeFavoriteAtGap,
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

describe("favoriteIdsInOrder", () => {
	it("lists the standard places then the pins, hidden or not, in favoritesOrder", () => {
		const ids = favoriteIdsInOrder(settings({ customFavorites: [{ path: "/a" }], hiddenItems: ["place:music"] }));
		expect(ids.slice(0, 3)).toEqual(["place:recents", "place:home", "place:applications"]);
		expect(ids).toContain("place:music");
		expect(ids.at(-1)).toBe("custom:/a");
	});

	it("follows favoritesOrder for the ids it lists", () => {
		const ids = favoriteIdsInOrder(settings({ customFavorites: [{ path: "/a" }], favoritesOrder: ["custom:/a", "place:trash"] }));
		expect(ids.slice(0, 2)).toEqual(["custom:/a", "place:trash"]);
	});
});

describe("placeFavoriteAtGap", () => {
	const order = ["a", "b", "c", "d"];

	it("puts a new id above the row at the gap", () => {
		expect(placeFavoriteAtGap(order, ["a", "b", "c", "d"], "new", 0)).toEqual(["new", "a", "b", "c", "d"]);
		expect(placeFavoriteAtGap(order, ["a", "b", "c", "d"], "new", 2)).toEqual(["a", "b", "new", "c", "d"]);
	});

	it("puts a new id below the last drawn row for the last gap", () => {
		expect(placeFavoriteAtGap(order, ["a", "b", "c", "d"], "new", 4)).toEqual(["a", "b", "c", "d", "new"]);
	});

	it("moves a drawn row, counting the gap in the rows as drawn", () => {
		expect(placeFavoriteAtGap(order, ["a", "b", "c", "d"], "d", 1)).toEqual(["a", "d", "b", "c"]);
		expect(placeFavoriteAtGap(order, ["a", "b", "c", "d"], "a", 3)).toEqual(["b", "c", "a", "d"]);
		expect(placeFavoriteAtGap(order, ["a", "b", "c", "d"], "a", 4)).toEqual(["b", "c", "d", "a"]);
	});

	it("leaves the order alone when the row lands in the gap it already fills", () => {
		expect(placeFavoriteAtGap(order, ["a", "b", "c", "d"], "b", 1)).toEqual(order);
		expect(placeFavoriteAtGap(order, ["a", "b", "c", "d"], "b", 2)).toEqual(order);
	});

	it("keeps a hidden id where it was relative to the rows around it", () => {
		// "b" is hidden: the drawn rows are a, c, d. Dropping "d" above "c" must not drag "b" along.
		expect(placeFavoriteAtGap(order, ["a", "c", "d"], "d", 1)).toEqual(["a", "b", "d", "c"]);
		// A new row below the last drawn one goes right after it, ahead of anything hidden further down.
		expect(placeFavoriteAtGap(["a", "b", "c"], ["a", "b"], "new", 2)).toEqual(["a", "b", "new", "c"]);
	});

	it("adds drawn rows the order does not list", () => {
		expect(placeFavoriteAtGap(["a"], ["a", "x"], "new", 1)).toEqual(["a", "new", "x"]);
	});

	it("clamps a gap past the end", () => {
		expect(placeFavoriteAtGap(order, ["a", "b", "c", "d"], "new", 99)).toEqual(["a", "b", "c", "d", "new"]);
	});
});
