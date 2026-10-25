import { describe, expect, it } from "vitest";
import type { AccountStatus } from "../src/shared/account-contract";
import {
	buildFlow,
	bySourceOrder,
	canAdvance,
	canSelectCloudEmbedding,
	connectableLater,
	embedCards,
	etaMinutes,
	formatSize,
	indexingPhases,
	isPlanSelectable,
	phaseIndex,
	planHeld,
	errorReportsConsentOnLeaving,
	primaryLabelKey,
	resolveEmbed,
	scanTotals,
	shouldSkipPlanStep,
	sourceDetail,
	type Translate,
	usageConsentOnLeaving,
} from "../src/renderer/src/onboarding/flow";
import type { FolderScan } from "../src/shared/onboarding-contract";

const stubTranslate: Translate = (key, options) => (options === undefined ? key : `${key}:${JSON.stringify(options)}`);

describe("onboarding flow", () => {
	it("orders steps for a local, unconfirmed plan", () => {
		expect(buildFlow("pro", false, "local", false)).toEqual([
			"welcome",
			"permissions",
			"account",
			"folders",
			"smartScan",
			"smartScope",
			"embedding",
			"sources",
			"plan",
			"indexing",
		]);
	});

	it("drops the plan once confirmed and puts the plan before sources for cloud", () => {
		expect(buildFlow("pro", true, "local", false)).toEqual([
			"welcome",
			"permissions",
			"account",
			"folders",
			"smartScan",
			"smartScope",
			"embedding",
			"sources",
			"indexing",
		]);
		expect(buildFlow("pro", false, "cloud", false)).toEqual([
			"welcome",
			"permissions",
			"account",
			"folders",
			"smartScan",
			"smartScope",
			"embedding",
			"plan",
			"sources",
			"indexing",
		]);
	});

	it("treats the keyword-only mode like local embedding for ordering", () => {
		expect(buildFlow("pro", false, "none", false)).toEqual([
			"welcome",
			"permissions",
			"account",
			"folders",
			"smartScan",
			"smartScope",
			"embedding",
			"sources",
			"plan",
			"indexing",
		]);
		expect(buildFlow("byok", false, "none", false)).toEqual([
			"welcome",
			"permissions",
			"account",
			"model",
			"folders",
			"smartScan",
			"smartScope",
			"embedding",
			"sources",
			"plan",
			"roles",
			"indexing",
		]);
	});

	it("connects the BYOK model right after the account step, before the smart scan needs it", () => {
		const flow = buildFlow("byok", true, "local", false);
		expect(flow).toEqual([
			"welcome",
			"permissions",
			"account",
			"model",
			"folders",
			"smartScan",
			"smartScope",
			"embedding",
			"sources",
			"roles",
			"indexing",
		]);
		expect(flow.indexOf("model")).toBeLessThan(flow.indexOf("smartScan"));
	});

	it("keeps the model step after the plan for a signed-in user who picks BYOK there, because the scan already ran", () => {
		expect(buildFlow("byok", false, "local", true)).toEqual([
			"welcome",
			"permissions",
			"account",
			"folders",
			"smartScan",
			"smartScope",
			"embedding",
			"sources",
			"plan",
			"model",
			"roles",
			"indexing",
		]);
	});

	it("has no model or role step for managed plans", () => {
		for (const plan of ["free", "air", "pro"] as const) {
			for (const flow of [buildFlow(plan, false, "local", false), buildFlow(plan, true, "cloud", true)]) {
				expect(flow).not.toContain("model");
				expect(flow).not.toContain("roles");
			}
		}
	});

	it("lets a BYOK user pick the reranker and Jev right before indexing, however the flow is ordered", () => {
		for (const signedIn of [false, true]) {
			for (const embed of ["none", "local", "cloud"] as const) {
				const flow = buildFlow("byok", false, embed, signedIn);
				expect(flow.slice(-2)).toEqual(["roles", "indexing"]);
			}
		}
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

		// The keyword-only mode puts no constraint on the plan.
		expect(isPlanSelectable("free", "none")).toBe(true);
		expect(isPlanSelectable("air", "none")).toBe(true);
		expect(isPlanSelectable("pro", "none")).toBe(true);
		expect(isPlanSelectable("byok", "none")).toBe(true);
	});

	it("gates the advance per step", () => {
		const base = {
			stepId: "welcome",
			platform: "darwin",
			fullDiskAccess: false,
			signedIn: false,
			selectedFolders: 0,
			smartScanning: false,
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
		// The scan step waits for the agent; the folders before it are what it looks through.
		expect(canAdvance({ ...base, stepId: "smartScan", smartScanning: true })).toBe(false);
		expect(canAdvance({ ...base, stepId: "smartScan" })).toBe(true);
		// The scope screen is where folders are added and removed after the scan; it needs one to continue.
		expect(canAdvance({ ...base, stepId: "smartScope" })).toBe(false);
		expect(canAdvance({ ...base, stepId: "smartScope", selectedFolders: 1 })).toBe(true);
		expect(canAdvance({ ...base, stepId: "embedding" })).toBe(true);
		// The keyword-only mode embeds nothing, so it needs no cloud consent.
		expect(canAdvance({ ...base, stepId: "embedding", embed: "none" })).toBe(true);
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
			creditsResetsAt: null,
			embeddings: plan === "pro",
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
		// The keyword-only mode behaves like local: a held paid plan skips the step.
		expect(shouldSkipPlanStep(false, "none", signedIn("air"))).toBe(true);
		expect(shouldSkipPlanStep(false, "none", signedIn("free"))).toBe(false);
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

	it("floors the keyword-only ETA at the fixed walk-and-parse cost", () => {
		expect(etaMinutes(0, "none")).toBe(8);
		expect(etaMinutes(3_600, "none")).toBe(8);
		expect(etaMinutes(4_050, "none")).toBe(9);
	});

	it("resolves a stored mode against the account: only cloud collapses, never none", () => {
		// A draft saved before the modes existed reads as local (the pre-existing default).
		expect(resolveEmbed(undefined, false)).toBe("local");
		expect(resolveEmbed(undefined, true)).toBe("local");
		expect(resolveEmbed("none", false)).toBe("none");
		expect(resolveEmbed("none", true)).toBe("none");
		expect(resolveEmbed("local", false)).toBe("local");
		expect(resolveEmbed("cloud", false)).toBe("local");
		expect(resolveEmbed("cloud", true)).toBe("cloud");
	});

	it("never runs local embedding on a machine below the spec: local, and a draft from before the modes existed, fall back to keyword-only", () => {
		expect(resolveEmbed("local", false, false)).toBe("none");
		expect(resolveEmbed(undefined, false, false)).toBe("none");
		expect(resolveEmbed("local", true, false)).toBe("none");
		// cloud keeps its own rule, and a chosen keyword-only stays.
		expect(resolveEmbed("cloud", true, false)).toBe("cloud");
		expect(resolveEmbed("cloud", false, false)).toBe("none");
		expect(resolveEmbed("none", false, false)).toBe("none");
		// the default stays open: a machine that meets the spec behaves as before.
		expect(resolveEmbed("local", false, true)).toBe("local");
	});

	it("disables the local card, and only it, below the spec, and carries the verdict for the view to explain", () => {
		const blocked = { eligible: false, reason: "gpu-vram", vars: { gpu: "RTX 3050", vramGb: 6, minVramGb: 8 } } as const;
		const base = { files: 10, platform: "win32", cloudAvailable: true, modelBytes: 600_000_000, modelCached: false, localSpec: blocked } as const;
		const cards = embedCards(base);
		expect(cards.map((card) => card.disabled)).toEqual([false, true, false]);
		expect(cards.map((card) => card.blocked)).toEqual([null, blocked, null]);
		expect(embedCards({ ...base, localSpec: { eligible: true } }).map((card) => card.blocked)).toEqual([null, null, null]);
	});

	it("keeps the local card shut until the machine has been checked", () => {
		const base = { files: 10, platform: "darwin", cloudAvailable: true, modelBytes: null, modelCached: false } as const;
		const cards = embedCards({ ...base, localSpec: null });
		expect(cards.map((card) => card.disabled)).toEqual([false, true, false]);
		expect(cards.map((card) => card.blocked)).toEqual([null, null, null]);
	});

	it("compares the three embedding modes in the prototype's order", () => {
		const base = { files: 4_000, platform: "darwin", cloudAvailable: true, modelBytes: 600_000_000, modelCached: false, localSpec: { eligible: true } } as const;
		const cards = embedCards(base);
		expect(cards.map((card) => card.id)).toEqual(["none", "local", "cloud"]);
		expect(cards.map((card) => card.icon)).toEqual(["search", "cpu", "cloud"]);
		expect(cards.every((card) => card.disabled)).toBe(false);
		expect(cards.every((card) => card.foot === null || card.foot.kind === "size")).toBe(true);
	});

	it("fills each card's meters and ETA from its own mode", () => {
		const base = { files: 4_000, platform: "darwin", cloudAvailable: true, modelBytes: 600_000_000, modelCached: false, localSpec: { eligible: true } } as const;
		const [none, local, cloud] = embedCards(base);
		expect(none?.minutes).toBe(etaMinutes(4_000, "none"));
		expect(none?.meters.map((meter) => [meter.fill, meter.tone])).toEqual([
			[1, "good"],
			[2, "warn"],
		]);
		expect(none?.tag).toBeNull();
		expect(local?.minutes).toBe(etaMinutes(4_000, "local"));
		expect(local?.meters.map((meter) => [meter.fill, meter.tone])).toEqual([
			[4, "warn"],
			[4, "good"],
		]);
		expect(local?.foot).toEqual({ kind: "size", bytes: 600_000_000 });
		expect(cloud?.minutes).toBe(etaMinutes(4_000, "cloud"));
		expect(cloud?.meters.map((meter) => [meter.fill, meter.tone])).toEqual([
			[1, "good"],
			[4, "good"],
		]);
		expect(cloud?.tag?.tone).toBe("warn");
		// Only the local embedder downloads a model.
		expect(none?.foot).toBeNull();
		expect(cloud?.foot).toBeNull();
	});

	it("shows the cached or unknown wording when the local model size is not known", () => {
		const base = { files: 10, platform: "darwin", cloudAvailable: true, modelBytes: 600_000_000, modelCached: false, localSpec: { eligible: true } } as const;
		expect(embedCards({ ...base, modelCached: true })[1]?.foot).toEqual({ kind: "cached" });
		expect(embedCards({ ...base, modelBytes: null })[1]?.foot).toEqual({ kind: "unknown" });
	});

	it("disables the cloud card, and only that card, when the account cannot use it", () => {
		const base = { files: 10, platform: "darwin", cloudAvailable: false, modelBytes: null, modelCached: false, localSpec: { eligible: true } } as const;
		const cards = embedCards(base);
		expect(cards.map((card) => card.disabled)).toEqual([false, false, true]);
	});

	it("says PC instead of Mac for the local line on Windows", () => {
		const base = { files: 10, platform: "win32", cloudAvailable: true, modelBytes: null, modelCached: false, localSpec: { eligible: true } } as const;
		expect(embedCards(base)[1]?.lineKey).toContain("linePc");
		expect(embedCards({ ...base, platform: "darwin" })[1]?.lineKey).toContain("lineMac");
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
	it("drops the embedding phase on the keyword-only path", () => {
		expect(indexingPhases("none")).toEqual(["parsed", "finalizing"]);
		expect(indexingPhases("local")).toEqual(["parsed", "minsync", "finalizing"]);
		expect(indexingPhases("cloud")).toEqual(["parsed", "minsync", "finalizing"]);
	});

	it("maps a phase to its position in that run's strip", () => {
		expect(phaseIndex("local", "parsed")).toBe(0);
		expect(phaseIndex("local", "minsync")).toBe(1);
		expect(phaseIndex("local", "finalizing")).toBe(2);
		expect(phaseIndex("none", "parsed")).toBe(0);
		expect(phaseIndex("none", "finalizing")).toBe(1);
	});
});

describe("footer labels", () => {
	it("exist in every language for every step any flow can show", async () => {
		const steps = new Set(
			(["free", "pro", "byok"] as const).flatMap((plan) => [true, false].flatMap((signedIn) => (["none", "cloud"] as const).flatMap((embed) => buildFlow(plan, false, embed, signedIn)))),
		);
		for (const language of ["en", "ko", "ja", "zh"]) {
			const { default: locale } = (await import(`../src/shared/i18n/locales/${language}.json`)) as { default: { onboarding: { stepLabel: Record<string, string> } } };
			for (const step of steps) {
				const key = primaryLabelKey(step, "free", false);
				if (step === "plan") continue;
				expect(locale.onboarding.stepLabel[key.split(".").pop() ?? ""], `${language} ${key}`).toBeTruthy();
			}
		}
	});
});

describe("usage statistics consent", () => {
	it("is recorded when the user leaves the welcome step, with the checkbox's value", () => {
		expect(usageConsentOnLeaving("welcome", true)).toBe(true);
		expect(usageConsentOnLeaving("welcome", false)).toBe(false);
	});

	it("is not recorded by any other step, so only the step that shows the checkbox can consent", () => {
		for (const stepId of ["permissions", "account", "folders", "smartScan", "smartScope", "embedding", "sources", "model", "plan", "indexing"] as const) {
			expect(usageConsentOnLeaving(stepId, true)).toBeNull();
		}
	});
});

describe("error reports consent", () => {
	it("is recorded when the user leaves the welcome step, independent of the usage statistics checkbox", () => {
		expect(errorReportsConsentOnLeaving("welcome", true)).toBe(true);
		expect(errorReportsConsentOnLeaving("welcome", false)).toBe(false);
	});

	it("is not recorded by any other step", () => {
		for (const stepId of ["permissions", "account", "folders", "smartScan", "smartScope", "embedding", "sources", "model", "plan", "indexing"] as const) {
			expect(errorReportsConsentOnLeaving(stepId, true)).toBeNull();
		}
	});
});

describe("formatSize", () => {
	it("never rounds a small non-empty size down to zero", () => {
		expect(formatSize(0)).toBe("0 KB");
		expect(formatSize(1)).toBe("1 KB");
		expect(formatSize(400)).toBe("1 KB");
		expect(formatSize(1_499)).toBe("1 KB");
		expect(formatSize(1_500)).toBe("2 KB");
		expect(formatSize(2_400_000)).toBe("2 MB");
		expect(formatSize(1_200_000_000)).toBe("1.2 GB");
	});
});
