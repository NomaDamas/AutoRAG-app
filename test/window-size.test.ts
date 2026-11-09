import { describe, expect, it } from "vitest";
import { appWindowSize } from "../src/main/window-size";

describe("appWindowSize", () => {
	it("fits the Finder default inside a small display and keeps short windows usable", () => {
		expect(appWindowSize({ width: 1024, height: 768 }, "finder")).toEqual({
			width: 1024,
			height: 768,
			minWidth: 1024,
			minHeight: 420,
		});
	});

	it("keeps the designed sizes on a large display", () => {
		expect(appWindowSize({ width: 2560, height: 1440 }, "finder")).toEqual({
			width: 1440,
			height: 900,
			minWidth: 1360,
			minHeight: 820,
		});
	});
});
