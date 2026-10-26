import { describe, expect, it } from "vitest";
import { closeDecision, completesOnClose } from "../src/main/onboarding-window";

describe("closeDecision", () => {
	it("asks before the last window closes on a first index that is still running", () => {
		expect(closeDecision({ pending: true, indexing: true, windowsOpen: 1 })).toBe("confirm");
	});

	it("lets either window close while the other one keeps the app, and the index, alive", () => {
		expect(closeDecision({ pending: true, indexing: true, windowsOpen: 2 })).toBe("allow");
	});

	it("never asks once onboarding is over or no first index is running", () => {
		expect(closeDecision({ pending: false, indexing: true, windowsOpen: 1 })).toBe("allow");
		expect(closeDecision({ pending: true, indexing: false, windowsOpen: 1 })).toBe("allow");
	});
});

describe("completesOnClose", () => {
	it("ends onboarding when its window is closed on a first index that stopped", () => {
		expect(completesOnClose({ pending: true, state: "failed" })).toBe(true);
	});

	it("keeps onboarding for the next launch when it is closed before the index ran or while it runs", () => {
		for (const state of ["idle", "running"] as const) {
			expect(completesOnClose({ pending: true, state }), state).toBe(false);
		}
	});

	it("has nothing to end once onboarding is complete", () => {
		expect(completesOnClose({ pending: false, state: "failed" })).toBe(false);
		expect(completesOnClose({ pending: false, state: "success" })).toBe(false);
	});
});
