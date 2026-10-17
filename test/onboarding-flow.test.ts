import { describe, expect, it } from "vitest";
import type { AccountStatus } from "../src/shared/account-contract";
import {
	buildFlow,
	bySourceOrder,
	canAdvance,
	canSelectCloudEmbedding,
	connectableLater,
	etaMinutes,
	formatSize,
	isPlanSelectable,
	phaseIndex,
	planHeld,
	primaryLabelKey,
	scanTotals,
	shouldSkipPlanStep,
	sourceDetail,
	type Translate,
} from "../src/renderer/src/onboarding/flow";
import type { FolderScan } from "../src/shared/onboarding-contract";

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

	it("allows selecting cloud embedding only when signed in to Dazzi", () => {
		expect(canSelectCloudEmbedding(null)).toBe(false);
		expect(
			canSelectCloudEmbedding({
				state: "signedOut",
				account: null,
				offline: false,
				error: null,
				baseUrl: "https://api.dazziapp.com",
			}),
		).toBe(false);
		expect(
			canSelectCloudEmbedding({
				state: "signedIn",
				account: null,
				offline: false,
				error: null,
				baseUrl: "https://api.dazziapp.com",
			}),
		).toBe(true);
	});

	it("restricts plan selection to Pro when cloud embedding is selected", () => {
		expect(isPlanSelectable("free", "local")).toBe(true);
		expect(isPlanSelectable("air", "local")).toBe(true);
		expect(isPlanSelectable("pro", "local")).toBe(true);
		expect(isPlanSelectable("byok", "local")).toBe(true);

		expect(isPlanSelectable("pro", "cloud")).toBe(true);
		expect(isPlanSelectable("free", "cloud")).toBe(false);
		expect(isPlanSelectable("air", "cloud")).toBe(false);
		expect(isPlanSelectable("byok", "cloud")).toBe(false);
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
		// Choosing BYOK on the account step is the sign-in-free path.
		expect(canAdvance({ ...base, stepId: "account", plan: "byok" })).toBe(true);
		// A managed plan needs an account; BYOK does not.
		expect(canAdvance({ ...base, stepId: "plan", plan: "air" })).toBe(false);
		expect(canAdvance({ ...base, stepId: "plan", plan: "air", signedIn: true })).toBe(true);
		expect(canAdvance({ ...base, stepId: "plan", plan: "byok" })).toBe(true);
		expect(canAdvance({ ...base, stepId: "folders" })).toBe(false);
		expect(canAdvance({ ...base, stepId: "folders", selectedFolders: 2 })).toBe(true);
		expect(canAdvance({ ...base, stepId: "embedding" })).toBe(true);
		expect(canAdvance({ ...base, stepId: "embedding", embed: "cloud", cloudConsent: false })).toBe(false);
		expect(canAdvance({ ...base, stepId: "embedding", embed: "cloud", cloudConsent: true })).toBe(true);
		expect(canAdvance({ ...base, stepId: "model", plan: "byok" })).toBe(false);
		expect(canAdvance({ ...base, stepId: "model", plan: "byok", modelVerified: true })).toBe(true);
		// Cloud embedding requires Pro on the plan step.
		expect(canAdvance({ ...base, stepId: "plan", embed: "cloud", plan: "air", signedIn: true })).toBe(false);
		expect(canAdvance({ ...base, stepId: "plan", embed: "cloud", plan: "free", signedIn: true })).toBe(false);
		expect(canAdvance({ ...base, stepId: "plan", embed: "cloud", plan: "byok", signedIn: true })).toBe(false);
		expect(canAdvance({ ...base, stepId: "plan", embed: "cloud", plan: "pro", signedIn: true })).toBe(true);
	});

	it("labels the plan primary button by what the account already holds", () => {
		expect(primaryLabelKey("welcome", "pro", false)).toBe("onboarding.stepLabel.welcome");
		expect(primaryLabelKey("plan", "free", false)).toBe("onboarding.plan.continue");
		expect(primaryLabelKey("plan", "byok", false)).toBe("onboarding.plan.continue");
		expect(primaryLabelKey("plan", "pro", true)).toBe("onboarding.plan.continue");
		expect(primaryLabelKey("plan", "pro", false)).toBe("onboarding.plan.checkoutPro");
		expect(primaryLabelKey("plan", "air", false)).toBe("onboarding.plan.checkoutAir");
	});
});

describe("planHeld", () => {
	const signedIn = (plan: "free" | "air" | "pro"): AccountStatus => ({
		state: "signedIn",
		offline: false,
		error: null,
		baseUrl: "https://example.test",
		account: {
			email: "user@example.com",
			plan,
			status: "active",
			trialing: false,
			cancelScheduled: false,
			periodEnd: null,
			creditsUsedCents: 0,
			creditsLimitCents: 50,
			creditPeriod: "2026-W41",
			requestsPerMinute: 10,
			billing: { air: true, pro: true, portal: false },
		},
	});

	it("holds a paid plan only when the signed-in account's plan covers it", () => {
		expect(planHeld("air", signedIn("free"))).toBe(false);
		expect(planHeld("air", signedIn("air"))).toBe(true);
		expect(planHeld("air", signedIn("pro"))).toBe(true);
		expect(planHeld("pro", signedIn("air"))).toBe(false);
		expect(planHeld("pro", signedIn("pro"))).toBe(true);
	});

	it("never holds a plan without a confirmed account, and free/BYOK are never held", () => {
		expect(planHeld("pro", null)).toBe(false);
		expect(planHeld("pro", { ...signedIn("pro"), state: "signedOut", account: null })).toBe(false);
		expect(planHeld("free", signedIn("pro"))).toBe(false);
		expect(planHeld("byok", signedIn("pro"))).toBe(false);
	});

	it("skips the plan step when already subscribed to Air or Pro (and Pro for cloud)", () => {
		expect(shouldSkipPlanStep(false, "local", null)).toBe(false);
		expect(shouldSkipPlanStep(false, "local", signedIn("free"))).toBe(false);
		expect(shouldSkipPlanStep(false, "local", signedIn("air"))).toBe(true);
		expect(shouldSkipPlanStep(false, "local", signedIn("pro"))).toBe(true);
		// Cloud embedding requires Pro, so Air must still visit the plan step to upgrade to Pro.
		expect(shouldSkipPlanStep(false, "cloud", signedIn("free"))).toBe(false);
		expect(shouldSkipPlanStep(false, "cloud", signedIn("air"))).toBe(false);
		expect(shouldSkipPlanStep(false, "cloud", signedIn("pro"))).toBe(true);
		expect(shouldSkipPlanStep(true, "cloud", signedIn("free"))).toBe(true);
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

describe("detected sources list", () => {
	it("keeps a stable order however the probes finish", () => {
		const arrival = [{ id: "github" }, { id: "mailcrawl" }, { id: "kakao" }, { id: "whatsapp" }] as const;
		expect([...arrival].sort(bySourceOrder).map((source) => source.id)).toEqual(["kakao", "whatsapp", "mailcrawl", "github"]);
	});

	it("offers later only what was not found, plus brands that cannot be probed", () => {
		const labels = (found: readonly { readonly id: "kakao" | "slack" }[]): string[] => connectableLater(found).map((chip) => chip.label);
		expect(labels([])).toContain("KakaoTalk");
		expect(labels([{ id: "kakao" }])).not.toContain("KakaoTalk");
		expect(labels([{ id: "kakao" }, { id: "slack" }])).toEqual(expect.arrayContaining(["Notion", "Google Drive"]));
		expect(labels([{ id: "slack" }])).not.toContain("Slack");
	});

	it("interpolates detected facts into the connector's detail line", () => {
		expect(sourceDetail("whatsapp", { chats: 24, messages: 16591 }, stubTranslate)).toContain('"chats":24');
		expect(sourceDetail("mailcrawl", { accounts: ["gmail", "khu"] }, stubTranslate)).toContain('"accounts":2');
		expect(sourceDetail("kakao", {}, stubTranslate)).toContain("onboarding.sources.detail.kakao");
	});
});

describe("indexing phases", () => {
	it("maps a local phase to its strip position", () => {
		expect(phaseIndex("parsed")).toBe(0);
		expect(phaseIndex("minsync")).toBe(1);
		expect(phaseIndex("finalizing")).toBe(2);
	});
});
