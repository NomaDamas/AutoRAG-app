import { describe, expect, it } from "vitest";
import {
	buildFlow,
	canAdvance,
	draftDescription,
	etaMinutes,
	formatSize,
	phaseIndex,
	primaryLabelKey,
	scanTotals,
	sourceTag,
	type Translate,
} from "../src/renderer/src/onboarding/flow";
import type { FolderScan, SourceFacts } from "../src/shared/onboarding-contract";

const stubTranslate: Translate = (key, options) => (options === undefined ? key : `${key}:${JSON.stringify(options)}`);

describe("onboarding flow", () => {
	it("orders steps for a local, unconfirmed plan", () => {
		expect(buildFlow("pro", false, "local")).toEqual([
			"welcome",
			"permissions",
			"account",
			"folders",
			"embedding",
			"sources",
			"plan",
			"indexing",
		]);
	});

	it("drops the plan once confirmed and puts the plan before sources for cloud", () => {
		expect(buildFlow("pro", true, "local")).toEqual([
			"welcome",
			"permissions",
			"account",
			"folders",
			"embedding",
			"sources",
			"indexing",
		]);
		expect(buildFlow("pro", false, "cloud")).toEqual([
			"welcome",
			"permissions",
			"account",
			"folders",
			"embedding",
			"plan",
			"sources",
			"indexing",
		]);
	});

	it("adds the model step only for BYOK", () => {
		expect(buildFlow("byok", true, "local")).toEqual([
			"welcome",
			"permissions",
			"account",
			"folders",
			"embedding",
			"sources",
			"model",
			"indexing",
		]);
	});

	it("gates the advance per step", () => {
		const base = {
			stepId: "welcome",
			platform: "darwin",
			fullDiskAccess: false,
			signedIn: false,
			selectedFolders: 0,
			embed: "local",
			cloudConsent: false,
			plan: "pro",
			modelVerified: false,
		} as const;
		expect(canAdvance(base)).toBe(true);
		expect(canAdvance({ ...base, stepId: "permissions" })).toBe(false);
		expect(canAdvance({ ...base, stepId: "permissions", fullDiskAccess: true })).toBe(true);
		expect(canAdvance({ ...base, stepId: "permissions", platform: "win32" })).toBe(true);
		expect(canAdvance({ ...base, stepId: "account" })).toBe(false);
		expect(canAdvance({ ...base, stepId: "account", signedIn: true })).toBe(true);
		expect(canAdvance({ ...base, stepId: "folders" })).toBe(false);
		expect(canAdvance({ ...base, stepId: "folders", selectedFolders: 2 })).toBe(true);
		expect(canAdvance({ ...base, stepId: "embedding" })).toBe(true);
		expect(canAdvance({ ...base, stepId: "embedding", embed: "cloud", cloudConsent: false })).toBe(false);
		expect(canAdvance({ ...base, stepId: "embedding", embed: "cloud", cloudConsent: true })).toBe(true);
		expect(canAdvance({ ...base, stepId: "model", plan: "byok" })).toBe(false);
		expect(canAdvance({ ...base, stepId: "model", plan: "byok", modelVerified: true })).toBe(true);
	});

	it("labels the plan primary button", () => {
		expect(primaryLabelKey("welcome", "pro", null)).toBe("onboarding.stepLabel.welcome");
		expect(primaryLabelKey("plan", "free", null)).toBe("onboarding.plan.continue");
		expect(primaryLabelKey("plan", "byok", null)).toBe("onboarding.plan.continue");
		expect(primaryLabelKey("plan", "pro", "pro")).toBe("onboarding.plan.continue");
		expect(primaryLabelKey("plan", "pro", null)).toBe("onboarding.plan.startTrial");
		expect(primaryLabelKey("plan", "air", null)).toBe("onboarding.plan.subscribeAir");
	});
});

describe("onboarding ETA and formatting", () => {
	it("uses the two files-per-minute constants and never returns less than 1", () => {
		expect(etaMinutes(0, "local")).toBe(1);
		expect(etaMinutes(85, "local")).toBe(1);
		expect(etaMinutes(86, "local")).toBe(2);
		expect(etaMinutes(900, "cloud")).toBe(1);
		expect(etaMinutes(12_600, "cloud")).toBe(14);
	});

	it("formats bytes with decimal units", () => {
		expect(formatSize(0)).toBe("0 KB");
		expect(formatSize(1_500_000)).toBe("2 MB");
		expect(formatSize(2_900_000_000)).toBe("2.9 GB");
	});

	it("sums only the scans it has", () => {
		const scans = new Map<string, FolderScan>([
			["/a", { path: "/a", files: 3, bytes: 300, onlineOnly: 1, done: false, error: null }],
			["/b", { path: "/b", files: 5, bytes: 500, onlineOnly: 0, done: true, error: null }],
		]);
		expect(scanTotals(["/a", "/b", "/missing"], scans)).toEqual({ files: 8, bytes: 800, onlineOnly: 1 });
	});
});

describe("source description drafting", () => {
	it("cycles through the three templates", () => {
		const facts: SourceFacts = { repos: ["acme/app", "acme/lib"] };
		const first = draftDescription("github", facts, 0, stubTranslate);
		const second = draftDescription("github", facts, 1, stubTranslate);
		const third = draftDescription("github", facts, 2, stubTranslate);
		expect(first).toContain("onboarding.sources.desc.github.0");
		expect(first).toContain('"firstRepo":"acme/app"');
		expect(second).toContain("onboarding.sources.desc.github.1");
		expect(third).toContain('"repos":2');
	});

	it("wraps the variant index", () => {
		expect(draftDescription("slack", {}, 3, stubTranslate)).toContain("onboarding.sources.desc.slack.0");
		expect(draftDescription("slack", {}, -1, stubTranslate)).toContain("onboarding.sources.desc.slack.2");
	});

	it("maps connectors to their default access tag", () => {
		expect(sourceTag("spotlight")).toBe("spotlight");
		expect(sourceTag("github")).toBe("github");
		expect(sourceTag("obsidian")).toBe("obsidian");
		expect(sourceTag("slack")).toBe("slack");
		// Apple Mail indexes through Spotlight, so it inherits that tag.
		expect(sourceTag("mail")).toBe("mail");
	});
});

describe("indexing phases", () => {
	it("maps a phase to its strip position", () => {
		expect(phaseIndex("parsed")).toBe(0);
		expect(phaseIndex("minsync")).toBe(1);
		expect(phaseIndex("datasources")).toBe(2);
		expect(phaseIndex("finalizing")).toBe(3);
	});
});
