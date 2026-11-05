import { describe, expect, it } from "vitest";
import { paintTerritory, type TerritoryGrid } from "../src/renderer/src/components/settings/index-map/territory";
import { INDEX_MAP_STATES } from "../src/shared/index-map-contract";

const ownerAt = (grid: TerritoryGrid, x: number, y: number): string | null => {
	const owner = grid.owner[y * grid.width + x] ?? -1;
	return owner < 0 ? null : (INDEX_MAP_STATES[owner] ?? null);
};
const alphaAt = (grid: TerritoryGrid, x: number, y: number): number => grid.pixels[(y * grid.width + x) * 4 + 3] ?? 0;

describe("paintTerritory", () => {
	it("raises an island around a lone node and leaves the rest sea", () => {
		const grid = paintTerritory(40, 40, [{ x: 20, y: 20, radius: 6, state: "indexed" }]);

		expect(ownerAt(grid, 20, 20)).toBe("indexed");
		expect(alphaAt(grid, 20, 20)).toBeGreaterThan(200);
		expect(ownerAt(grid, 2, 2)).toBeNull();
		expect(alphaAt(grid, 2, 2)).toBe(0);
	});

	it("joins nearby claims of one state into one land mass where each alone would leave sea", () => {
		const left = { x: 9.5, y: 10.5, radius: 8, state: "indexed" as const };
		const right = { x: 21.5, y: 10.5, radius: 8, state: "indexed" as const };

		expect(ownerAt(paintTerritory(32, 21, [left]), 15, 10)).toBeNull();
		expect(ownerAt(paintTerritory(32, 21, [left, right]), 15, 10)).toBe("indexed");
	});

	it("gives contested ground to the stronger claim and draws a border where the owner changes", () => {
		const grid = paintTerritory(60, 30, [
			{ x: 20, y: 15, radius: 14, state: "indexed" },
			{ x: 36, y: 15, radius: 9, state: "unindexed" },
		]);

		expect(ownerAt(grid, 20, 15)).toBe("indexed");
		expect(ownerAt(grid, 36, 15)).toBe("unindexed");
		let changes = 0;
		for (let x = 20; x < 36; x += 1) if (ownerAt(grid, x, 15) !== ownerAt(grid, x + 1, 15)) changes += 1;
		expect(changes).toBe(1);
		// The border is darker than the land on either side of it.
		const row = Array.from({ length: 16 }, (_, index) => 20 + index);
		const borderX = row.find((x) => ownerAt(grid, x, 15) !== ownerAt(grid, x + 1, 15)) ?? 0;
		const red = (x: number): number => grid.pixels[(15 * grid.width + x) * 4] ?? 0;
		expect(red(borderX)).toBeLessThan(red(borderX - 2));
	});

	it("draws left-out ground translucent next to indexed ground", () => {
		const grid = paintTerritory(60, 30, [
			{ x: 15, y: 15, radius: 10, state: "indexed" },
			{ x: 45, y: 15, radius: 10, state: "excluded" },
		]);

		expect(ownerAt(grid, 45, 15)).toBe("excluded");
		expect(alphaAt(grid, 45, 15)).toBeLessThan(alphaAt(grid, 15, 15) * 0.6);
	});
});
