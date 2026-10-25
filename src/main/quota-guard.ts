import { AUTORAG_PROVIDER_ID, type AccountStatus, creditsResetAt } from "../shared/account-contract";

/**
 * Whether a search run on the Dazzi plan's model should not start because the account's weekly credits are used up.
 *
 * The server refuses such a run (`429 insufficient_quota`, "Weekly usage quota exceeded") and bills nothing, but the
 * agent does not know that: it fires its judgment-model calls and the model request, retries each 429 as though
 * it were a rate limit, and ends with the server's raw JSON in the answer. Asking the account first spares
 * those requests and lets the panel say what is wrong and when it ends.
 *
 * Only what the server confirmed blocks: the account is re-read before refusing (a reset or an upgrade since the
 * last read must not be held against the person), and an unreachable server or an account it did not return lets
 * the run go, since the server still has the last word.
 */

export interface QuotaGuardDeps {
	/** The provider of the model AI Search runs on (the shared config's `model.provider`). */
	readonly modelProvider: () => Promise<string | undefined>;
	readonly account: {
		/** The last account read, without a network call. */
		status(): Promise<AccountStatus>;
		/** Reads the account from the server (`GET /v1/account`, which costs no credits). */
		refresh(): Promise<AccountStatus>;
	};
	readonly now: () => Date;
}

export interface QuotaBlock {
	readonly usedCents: number;
	readonly limitCents: number;
	/** When the credits come back. */
	readonly resetsAt: Date;
}

function exhausted(status: AccountStatus, now: Date): QuotaBlock | null {
	const account = status.account;
	if (status.state !== "signedIn" || account === null || account.creditsLimitCents <= 0) return null;
	if (account.creditsUsedCents < account.creditsLimitCents) return null;
	return {
		usedCents: account.creditsUsedCents,
		limitCents: account.creditsLimitCents,
		resetsAt: creditsResetAt(account, now),
	};
}

/** The block that stops the run, or null when it may start. */
export async function quotaBlock(deps: QuotaGuardDeps): Promise<QuotaBlock | null> {
	if ((await deps.modelProvider()) !== AUTORAG_PROVIDER_ID) return null;
	if (exhausted(await deps.account.status(), deps.now()) === null) return null;
	const live = await deps.account.refresh();
	return live.offline ? null : exhausted(live, deps.now());
}
