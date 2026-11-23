import { describe, expect, it } from "vitest";
import { closeDecision } from "../src/main/onboarding-window";

describe("closeDecision", () => {
	it("asks before the last window closes while the first index is still running, even after the first run was finished", () => {
		expect(closeDecision({ indexing: true, windowsOpen: 1 })).toBe("confirm");
	});

	it("never asks when no first index is running, or another window stays open", () => {
		expect(closeDecision({ indexing: false, windowsOpen: 1 })).toBe("allow");
		expect(closeDecision({ indexing: true, windowsOpen: 2 })).toBe("allow");
	});
});
