import { describe, expect, it } from "vitest";
import { NAV_GROUPS, connectedNavGroups, type NavLocation } from "../src/renderer/src/data/places";

const location = (name: string, available = true): NavLocation => ({ name, available });

function cloudLabels(locations: readonly NavLocation[]): string[] {
	const cloud = connectedNavGroups(locations).find((group) => group.label === "Cloud");
	return (cloud?.items ?? []).map((item) => item.label);
}

function favoriteLabels(locations: readonly NavLocation[]): string[] {
	const favorites = connectedNavGroups(locations).find((group) => group.label === "Favorites");
	return (favorites?.items ?? []).map((item) => item.label);
}

describe("connectedNavGroups", () => {
	it("offers every connected cloud drive", () => {
		expect(cloudLabels([location("iCloud Drive"), location("Google Drive"), location("Dropbox")])).toEqual([
			"iCloud Drive",
			"Google Drive",
			"Dropbox",
		]);
	});

	it("drops an available-but-unmounted drive so Windows never shows iCloud Drive", () => {
		// Given a Windows-like listing with no iCloud (platform-absent) but a mounted Google Drive
		const labels = cloudLabels([location("Google Drive")]);

		// Then only the connected drive survives
		expect(labels).toEqual(["Google Drive"]);
	});

	it("hides a disconnected drive", () => {
		expect(cloudLabels([location("Google Drive", false), location("Dropbox")])).toEqual(["Dropbox"]);
	});

	it("drops the Cloud group entirely when nothing is connected", () => {
		expect(connectedNavGroups([]).some((group) => group.label === "Cloud")).toBe(false);
		expect(cloudLabels([])).toEqual([]);
	});

	it("leaves the Favorites group untouched", () => {
		const expected = NAV_GROUPS.find((group) => group.label === "Favorites")?.items.map((item) => item.label);
		expect(favoriteLabels([location("Desktop"), location("Documents")])).toEqual(expected);
	});
});
