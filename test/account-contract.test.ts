import { describe, expect, it } from "vitest";
import { ACCOUNT_LEGAL_ROUTES, accountLegalUrl } from "../src/shared/account-contract";

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
