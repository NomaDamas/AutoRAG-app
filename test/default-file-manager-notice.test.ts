import { describe, expect, it } from "vitest";
import { shouldPromptDefaultFileManager } from "../src/renderer/src/state/default-file-manager-notice";
import type { DefaultFileManagerStatus } from "../src/shared/default-file-manager-contract";

const baseStatus: DefaultFileManagerStatus = {
	supported: true,
	platform: "darwin",
	enabled: false,
	osRegistered: false,
	interceptReveal: false,
	interceptRevealActive: false,
	macRevealHookLoaded: true,
	requiresPackagedApp: false,
	error: null,
};

describe("shouldPromptDefaultFileManager", () => {
	it("prompts only after onboarding is complete and the user is signed in, when supported and not yet enabled", () => {
		expect(
			shouldPromptDefaultFileManager({
				onboardingPending: false,
				signedIn: true,
				status: baseStatus,
			}),
		).toBe(true);
	});

	it("does not prompt while onboarding is pending", () => {
		expect(
			shouldPromptDefaultFileManager({
				onboardingPending: true,
				signedIn: true,
				status: baseStatus,
			}),
		).toBe(false);
	});

	it("does not prompt before the user has signed in", () => {
		expect(
			shouldPromptDefaultFileManager({
				onboardingPending: false,
				signedIn: false,
				status: baseStatus,
			}),
		).toBe(false);
	});

	it("prompts when setting is enabled by default but OS has not registered Dazzi yet, and hides once OS-registered", () => {
		expect(
			shouldPromptDefaultFileManager({
				onboardingPending: false,
				signedIn: true,
				status: { ...baseStatus, enabled: true, osRegistered: false },
			}),
		).toBe(true);
		expect(
			shouldPromptDefaultFileManager({
				onboardingPending: false,
				signedIn: true,
				status: { ...baseStatus, enabled: true, osRegistered: true },
			}),
		).toBe(false);
		expect(
			shouldPromptDefaultFileManager({
				onboardingPending: false,
				signedIn: true,
				status: { ...baseStatus, enabled: false, osRegistered: true },
			}),
		).toBe(false);
	});

	it("does not prompt on unsupported platforms or when status has not loaded", () => {
		expect(
			shouldPromptDefaultFileManager({
				onboardingPending: false,
				signedIn: true,
				status: { ...baseStatus, supported: false, platform: "unsupported" },
			}),
		).toBe(false);
		expect(
			shouldPromptDefaultFileManager({
				onboardingPending: false,
				signedIn: true,
				status: null,
			}),
		).toBe(false);
	});
});
