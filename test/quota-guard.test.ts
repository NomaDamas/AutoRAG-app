import { describe, expect, it, vi } from "vitest";
import { quotaBlock } from "../src/main/quota-guard";
import type { AccountSnapshot, AccountStatus } from "../src/shared/account-contract";

function account(patch: Partial<AccountSnapshot> = {}): AccountSnapshot {
	return {
		email: "user@example.com",
		plan: "free",
		status: "active",
		trialing: false,
		cancelScheduled: false,
		periodEnd: null,
		creditsUsedCents: 10,
		creditsLimitCents: 50,
		creditPeriod: "2026-10-20T07:15:01.883Z",
		creditsResetsAt: "2026-10-27T07:15:01.883Z",
		embeddings: false,
		requestsPerMinute: 10,
		billing: { air: true, pro: true, max: true, portal: false },
		...patch,
	};
}

function status(patch: Partial<AccountStatus> & { account?: AccountSnapshot | null } = {}): AccountStatus {
	return { state: "signedIn", account: account(), offline: false, error: null, baseUrl: "https://example.test", ...patch };
}

const exhausted = account({ creditsUsedCents: 50.75, creditsLimitCents: 50 });
const NOW = new Date("2026-10-24T06:00:00Z");

function guard(options: { provider?: string | undefined; live: AccountStatus; cached?: AccountStatus }) {
	const refresh = vi.fn(async () => options.live);
	const current = vi.fn(async () => options.cached ?? options.live);
	const block = () =>
		quotaBlock({
			modelProvider: async () => ("provider" in options ? options.provider : "dazzi"),
			account: { status: current, refresh },
			now: () => NOW,
		});
	return { block, refresh, current };
}

describe("quotaBlock", () => {
	it("blocks a Dazzi run once the weekly credits are used up, with the server's reset time", async () => {
		const { block } = guard({ live: status({ account: exhausted }) });

		const blocked = await block();

		expect(blocked).not.toBeNull();
		expect(blocked?.resetsAt.toISOString()).toBe("2026-10-27T07:15:01.883Z");
	});

	it("also blocks when the credits are used up to the cent", async () => {
		const { block } = guard({ live: status({ account: account({ creditsUsedCents: 50, creditsLimitCents: 50 }) }) });
		expect(await block()).not.toBeNull();
	});

	it("lets the run through while credits remain, without asking the server", async () => {
		const { block, refresh } = guard({ live: status({ account: account({ creditsUsedCents: 49.9 }) }) });

		expect(await block()).toBeNull();
		expect(refresh).not.toHaveBeenCalled();
	});

	it("re-reads the account before refusing, so a reset or an upgrade since the last read is not held against the person", async () => {
		const { block, refresh } = guard({ cached: status({ account: exhausted }), live: status({ account: account({ creditsUsedCents: 0 }) }) });

		expect(await block()).toBeNull();
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("does not refuse on what it cannot confirm: offline, or an account the server did not return", async () => {
		const offline = guard({ cached: status({ account: exhausted }), live: status({ account: exhausted, offline: true }) });
		expect(await offline.block()).toBeNull();
		const unread = guard({ cached: status({ account: exhausted }), live: status({ account: null, error: "boom" }) });
		expect(await unread.block()).toBeNull();
	});

	it("only concerns a run on the Dazzi plan's own model, and only a signed-in account", async () => {
		expect(await guard({ provider: "openrouter", live: status({ account: exhausted }) }).block()).toBeNull();
		expect(await guard({ provider: undefined, live: status({ account: exhausted }) }).block()).toBeNull();
		expect(await guard({ live: status({ state: "signedOut", account: null }) }).block()).toBeNull();
	});

	it("ignores a plan with no credit limit to compare against", async () => {
		const { block } = guard({ live: status({ account: account({ creditsUsedCents: 99, creditsLimitCents: 0 }) }) });
		expect(await block()).toBeNull();
	});

	it("falls back to the next Monday 00:00 UTC when an older server sends no reset time", async () => {
		const { block } = guard({ live: status({ account: { ...exhausted, creditsResetsAt: null } }) });
		expect((await block())?.resetsAt.toISOString()).toBe("2026-10-26T00:00:00.000Z");
	});
});
