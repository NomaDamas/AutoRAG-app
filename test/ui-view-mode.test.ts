import { describe, expect, it } from "vitest";
import { DEFAULT_VIEW_MODE, parseViewMode, viewModeForKey } from "../src/renderer/src/state/view-mode";

describe("view modes", () => {
	it("maps 1, 2, 3 to icons, list, columns", () => {
		expect(viewModeForKey("1")).toBe("icons");
		expect(viewModeForKey("2")).toBe("list");
		expect(viewModeForKey("3")).toBe("columns");
		expect(viewModeForKey("0")).toBeNull();
	});

	it("restores a stored mode and falls back to the list for anything else", () => {
		expect(parseViewMode("columns")).toBe("columns");
		expect(parseViewMode("icons")).toBe("icons");
		expect(DEFAULT_VIEW_MODE).toBe("list");
		expect(parseViewMode(null)).toBe("list");
		expect(parseViewMode("gallery")).toBe("list");
	});
});
