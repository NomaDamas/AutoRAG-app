import { describe, expect, it } from "vitest";
import { closeDecision } from "../src/main/onboarding-window";

describe("closeDecision", () => {
	it("asks before the last window closes on a first index that is still running", () => {
		expect(closeDecision({ pending: true, indexing: true, windowsOpen: 1 })).toBe("confirm");
	});

	it("never asks once the first run is over or no first index is running", () => {
		expect(closeDecision({ pending: false, indexing: true, windowsOpen: 1 })).toBe("allow");
		expect(closeDecision({ pending: true, indexing: false, windowsOpen: 1 })).toBe("allow");
	});
});
