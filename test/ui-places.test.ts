import { describe, expect, it } from "vitest";
import { navGroups } from "../src/renderer/src/data/places";
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
			["Favorites", ["Recents", "Desktop"]],
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
});
