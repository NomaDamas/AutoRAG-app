import { describe, expect, it } from "vitest";
import { navGroups } from "../src/renderer/src/data/places";
import { AUTOMATIONS_PATH } from "../src/renderer/src/state/tabs";
import type { FsLocation } from "../src/shared/fs-contract";

function place(name: string, section: FsLocation["section"], overrides: Partial<FsLocation> = {}): FsLocation {
	return {
		name,
		path: `/${name}`,
		section,
		icon: section === "locations" ? "disk" : "documents",
		available: true,
		scanned: false,
		ejectable: false,
		...overrides,
	};
}

describe("navGroups", () => {
	it("groups the live locations into Favorites, Cloud, and Locations, keeping the OS order", () => {
		// Given locations as the main process reports them, sections interleaved
		const locations = [
			place("Recents", "favorites", { icon: "recents" }),
			place("Desktop", "favorites"),
			place("Google Drive - a@x.com", "cloud", { icon: "google-drive" }),
			place("Macintosh HD", "locations"),
			place("Google Drive - b@y.com", "cloud", { icon: "google-drive" }),
			place("SSD1", "locations", { ejectable: true }),
		];

		// When grouping
		const groups = navGroups(locations);

		// Then each section keeps its own order and carries the eject affordance
		expect(groups.map((group) => [group.label, group.items.map((item) => item.label)])).toEqual([
			["Favorites", ["AI Search", "Automations", "Recents", "Desktop"]],
			["Cloud", ["Google Drive - a@x.com", "Google Drive - b@y.com"]],
			["Locations", ["Macintosh HD", "SSD1"]],
		]);
		expect(groups[2]?.items.map((item) => [item.path, item.ejectable])).toEqual([
			["/Macintosh HD", false],
			["/SSD1", true],
		]);
	});

	it("omits a section with nothing connected", () => {
		// Given no cloud accounts
		const groups = navGroups([place("Desktop", "favorites"), place("Macintosh HD", "locations")]);

		// Then there is no empty Cloud header
		expect(groups.map((group) => group.label)).toEqual(["Favorites", "Locations"]);
	});

	it("always heads Favorites with the AI Search and Automations app rows", () => {
		// Given only a cloud row, so the OS contributes nothing to Favorites
		const groups = navGroups([place("Google Drive - a@x.com", "cloud", { icon: "google-drive" })]);

		// Then Favorites still renders, with the app rows as its only entries
		const favorites = groups[0];
		expect(favorites?.label).toBe("Favorites");
		expect(favorites?.items.map((item) => [item.label, item.view, item.kind])).toEqual([
			["AI Search", "aiSearch", undefined],
			["Automations", "automations", undefined],
		]);
	});
});

describe("the Automations app row", () => {
	it("sits right under AI Search in Favorites and turns the focused tab into the Automations view", () => {
		const favorites = navGroups([place("Recents", "favorites", { icon: "recents" }), place("Desktop", "favorites")])[0];
		expect(favorites?.items.map((item) => item.label)).toEqual(["AI Search", "Automations", "Recents", "Desktop"]);
		const row = favorites?.items[1];
		expect(row).toMatchObject({ view: "automations", path: AUTOMATIONS_PATH, available: true, ejectable: false });
		expect(row?.kind).toBeUndefined();
	});

	it("is present even when the OS reports no favorites", () => {
		const groups = navGroups([place("Google Drive - a@x.com", "cloud", { icon: "google-drive" })]);
		expect(groups[0]?.items.map((item) => item.view)).toEqual(["aiSearch", "automations"]);
	});
});
