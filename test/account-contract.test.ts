import { describe, expect, it } from "vitest";
import { ACCOUNT_LEGAL_ROUTES, accountDashboardUrl, accountLegalUrl, creditsResetAt, isAccountSignInOptions, isPaidPlanId, nextWeeklyReset, parsePromoCode, splitRemaining } from "../src/shared/account-contract";

describe("accountLegalUrl", () => {
	it("serves the server's legal routes", () => {
		expect(ACCOUNT_LEGAL_ROUTES.terms).toBe("/terms");
		expect(ACCOUNT_LEGAL_ROUTES.privacy).toBe("/privacy");
		expect(ACCOUNT_LEGAL_ROUTES.acceptableUse).toBe("/acceptable-use");
		expect(ACCOUNT_LEGAL_ROUTES.subprocessors).toBe("/subprocessors");
	});

	it("builds an absolute URL on the account server", () => {
		expect(accountLegalUrl("https://api.dazziapp.com", "acceptableUse")).toBe("https://api.dazziapp.com/acceptable-use");
		expect(accountLegalUrl("https://api.dazziapp.com", "privacyModels")).toBe("https://api.dazziapp.com/privacy#models");
	});

	it("follows a configured override and strips trailing slashes", () => {
		expect(accountLegalUrl("https://staging.example/", "terms")).toBe("https://staging.example/terms");
	});

	it("falls back to the default server for an absent or blank root", () => {
		expect(accountLegalUrl(undefined, "privacy")).toBe("https://api.dazziapp.com/privacy");
		expect(accountLegalUrl(null, "subprocessors")).toBe("https://api.dazziapp.com/subprocessors");
		expect(accountLegalUrl("   ", "privacy")).toBe("https://api.dazziapp.com/privacy");
	});
});

describe("accountDashboardUrl", () => {
	it("points at the dashboard of the account server", () => {
		expect(accountDashboardUrl("https://api.dazziapp.com")).toBe("https://api.dazziapp.com/dashboard");
		expect(accountDashboardUrl("https://staging.example/")).toBe("https://staging.example/dashboard");
		expect(accountDashboardUrl(undefined)).toBe("https://api.dazziapp.com/dashboard");
	});
});

describe("nextWeeklyReset", () => {
	it("is the next Monday 00:00 UTC, never the current instant", () => {
		expect(nextWeeklyReset(new Date("2026-10-23T09:30:00Z")).toISOString()).toBe("2026-10-26T00:00:00.000Z");
		expect(nextWeeklyReset(new Date("2026-10-25T23:59:59Z")).toISOString()).toBe("2026-10-26T00:00:00.000Z");
		expect(nextWeeklyReset(new Date("2026-10-26T00:00:00Z")).toISOString()).toBe("2026-11-02T00:00:00.000Z");
		expect(nextWeeklyReset(new Date("2026-12-30T12:00:00Z")).toISOString()).toBe("2027-01-04T00:00:00.000Z");
	});
});

describe("creditsResetAt", () => {
	const now = new Date("2026-10-24T06:00:00Z");

	it("is the instant the server reports, which is not a fixed weekday", () => {
		// The server's week runs from the account's own period start (a Tuesday 07:15 UTC here), not Monday 00:00.
		expect(creditsResetAt({ creditsResetsAt: "2026-10-27T07:15:01.883Z" }, now).toISOString()).toBe("2026-10-27T07:15:01.883Z");
	});

	it("falls back to the next Monday 00:00 UTC when the server sent none, or something unreadable, or there is no account", () => {
		expect(creditsResetAt({ creditsResetsAt: null }, now).toISOString()).toBe("2026-10-26T00:00:00.000Z");
		expect(creditsResetAt({ creditsResetsAt: "soon" }, now).toISOString()).toBe("2026-10-26T00:00:00.000Z");
		expect(creditsResetAt(null, now).toISOString()).toBe("2026-10-26T00:00:00.000Z");
	});
});

describe("splitRemaining", () => {
	it("splits into days, hours and minutes, rounding a partial minute up", () => {
		expect(splitRemaining(2 * 86_400_000 + 3 * 3_600_000 + 4 * 60_000)).toEqual({ days: 2, hours: 3, minutes: 4 });
		expect(splitRemaining(30_000)).toEqual({ days: 0, hours: 0, minutes: 1 });
		expect(splitRemaining(-5)).toEqual({ days: 0, hours: 0, minutes: 0 });
	});
});

describe("isAccountSignInOptions", () => {
	it("accepts the supported providers and an optional string email", () => {
		expect(isAccountSignInOptions({ provider: "google" })).toBe(true);
		expect(isAccountSignInOptions({ provider: "github" })).toBe(true);
		expect(isAccountSignInOptions({ provider: "email", email: "person@example.com" })).toBe(true);
	});

	it("rejects unsupported providers and malformed IPC payloads", () => {
		for (const value of [null, undefined, "google", {}, { provider: "apple" }, { provider: "google", email: 3 }, { provider: "email", email: undefined }]) {
			expect(isAccountSignInOptions(value), JSON.stringify(value)).toBe(false);
		}
	});
});

describe("isPaidPlanId", () => {
	it("accepts exactly the plans the hosted checkout sells", () => {
		expect(["air", "pro", "max"].every(isPaidPlanId)).toBe(true);
		expect(["free", "byok", "", "PRO", null, undefined, 3].some(isPaidPlanId)).toBe(false);
	});
});

describe("parsePromoCode", () => {
	it("treats an absent or blank code as no code", () => {
		expect(parsePromoCode(undefined)).toEqual({ ok: true, code: null });
		expect(parsePromoCode("")).toEqual({ ok: true, code: null });
		expect(parsePromoCode("   ")).toEqual({ ok: true, code: null });
	});

	it("trims a well-formed code and keeps its case", () => {
		expect(parsePromoCode("  Dazzi-2026_X ")).toEqual({ ok: true, code: "Dazzi-2026_X" });
		expect(parsePromoCode("A".repeat(64))).toEqual({ ok: true, code: "A".repeat(64) });
	});

	it("rejects what the server would reject before anything is sent", () => {
		expect(parsePromoCode("A".repeat(65))).toEqual({ ok: false });
		expect(parsePromoCode("two words")).toEqual({ ok: false });
		expect(parsePromoCode("café")).toEqual({ ok: false });
		expect(parsePromoCode("a/b?c=d")).toEqual({ ok: false });
		expect(parsePromoCode(42)).toEqual({ ok: false });
	});
});
