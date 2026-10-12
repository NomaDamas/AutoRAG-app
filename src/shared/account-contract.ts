/**
 * AutoRAG account contract shared by the main process, the preload bridge, and
 * the renderer (onboarding account/plan steps and Settings → 계정/플랜).
 *
 * The account backend is the hosted AutoRAG service (Better Auth sign-in, Creem
 * billing, plan entitlements, weekly credits, and the managed model gateway).
 * The main process owns every secret: the renderer only ever sees an
 * {@link AccountStatus}. Sign-in is OAuth 2.0 authorization code + PKCE through
 * the system browser (RFC 8252), so no password and no card number is typed
 * into this app; checkout and the billing portal are hosted pages opened in the
 * browser as well.
 */

export const ACCOUNT_CHANNELS = {
	status: "account:status",
	refresh: "account:refresh",
	signIn: "account:signIn",
	cancelSignIn: "account:cancelSignIn",
	signOut: "account:signOut",
	checkout: "account:checkout",
	portal: "account:portal",
	useManagedModel: "account:useManagedModel",
	/** main → renderer event carrying one {@link AccountStatus}. */
	changed: "account:changed",
} as const;

/** Plans the hosted service sells. BYOK is not an account plan: it needs no account. */
export type AccountPlanId = "free" | "air" | "pro";

/** Plans that need a checkout. */
export type PaidPlanId = "air" | "pro";

/** Environment variable the AutoRAG API key lives in (encrypted store, loaded into `process.env`). */
export const ACCOUNT_API_KEY_ENV = "AUTORAG_API_KEY";

/** Server root used when `AUTORAG_BASE_URL` is unset. */
export const DEFAULT_ACCOUNT_BASE_URL = "https://api.dazziapp.com";

export interface AccountSnapshot {
	readonly email: string;
	readonly plan: AccountPlanId;
	/** Subscription state as the server reports it (`active`, `trialing`, `past_due`, `scheduled_cancel`, `canceled`, `expired`). */
	readonly status: string;
	readonly trialing: boolean;
	/** Cancellation is scheduled: the paid plan stays until `periodEnd`. */
	readonly cancelScheduled: boolean;
	/** ISO 8601; null on the free plan. */
	readonly periodEnd: string | null;
	/** Weekly AI credit budget, in cents. */
	readonly creditsUsedCents: number;
	readonly creditsLimitCents: number;
	readonly creditPeriod: string;
	readonly requestsPerMinute: number;
	/** Which hosted actions the server has configured. */
	readonly billing: { readonly air: boolean; readonly pro: boolean; readonly portal: boolean };
}

export interface AccountStatus {
	/** `signingIn`: the browser sign-in is waiting for the callback. */
	readonly state: "signedOut" | "signingIn" | "signedIn";
	/**
	 * Where the key comes from. `env` (a headless `AUTORAG_API_KEY`) cannot be
	 * signed out from the app.
	 */
	readonly source: "stored" | "env" | null;
	/** Last account the server confirmed; kept while offline. */
	readonly account: AccountSnapshot | null;
	/** The server could not be reached, so `account` may be out of date. */
	readonly offline: boolean;
	/** The last failure, in the server's words; cleared by the next successful call. */
	readonly error: string | null;
	readonly baseUrl: string;
}

/** What `useManagedModel` wrote into the shared AutoRAG config. */
export interface ManagedModelResult {
	readonly modelId: string;
	readonly modelName: string;
}

export interface AccountBridge {
	/** Current status without a network call. */
	status(): Promise<AccountStatus>;
	/** Re-reads the account from the server. */
	refresh(): Promise<AccountStatus>;
	/** Opens the browser sign-in and resolves once it finished, was cancelled, or failed. */
	signIn(): Promise<AccountStatus>;
	cancelSignIn(): Promise<AccountStatus>;
	/** Removes the stored key; the key stays valid on the server until revoked from its dashboard. */
	signOut(): Promise<AccountStatus>;
	/** Opens the hosted checkout for the plan in the system browser. */
	checkout(plan: PaidPlanId): Promise<void>;
	/** Opens the hosted billing portal (cancel, refund, payment method). */
	portal(): Promise<void>;
	/** Points the AutoRAG agent at the managed models of this account. */
	useManagedModel(): Promise<ManagedModelResult>;
	onChanged(listener: (status: AccountStatus) => void): () => void;
}

const PLAN_RANK: Readonly<Record<AccountPlanId, number>> = { free: 0, air: 1, pro: 2 };

/** True when `have` already includes everything `want` offers. */
export function planCovers(have: AccountPlanId, want: AccountPlanId): boolean {
	return PLAN_RANK[have] >= PLAN_RANK[want];
}

/** Provider id the hosted plan registers under (the librarian's `autorag` provider). */
export const AUTORAG_PROVIDER_ID = "autorag";

/**
 * Stable partition that lists the AutoRAG plan before every other provider
 * (the plan is the product's own, prioritised choice). `keyOf` picks the
 * provider id off a row. Returns a new array.
 */
export function autoragFirst<T extends { readonly id: string }>(items: readonly T[]): T[];
export function autoragFirst<T>(items: readonly T[], keyOf: (item: T) => string): T[];
export function autoragFirst<T>(items: readonly T[], keyOf?: (item: T) => string): T[] {
	const isAutorag = (item: T): boolean => (keyOf === undefined ? hasProviderId(item) : keyOf(item) === AUTORAG_PROVIDER_ID);
	return [...items.filter(isAutorag), ...items.filter((item) => !isAutorag(item))];
}

function hasProviderId(item: unknown): boolean {
	return typeof item === "object" && item !== null && "id" in item && item.id === AUTORAG_PROVIDER_ID;
}

/**
 * Whether signing in may point the agent at the account's models: only when
 * the shared config names no model yet, or already names an AutoRAG one. A
 * model the user picked from another provider is never overridden, and a
 * malformed `model` value counts as theirs.
 */
export function shouldAdoptManagedModel(config: { readonly model?: unknown }): boolean {
	const model = config.model;
	if (model === undefined) return true;
	return typeof model === "object" && model !== null && "provider" in model && model.provider === AUTORAG_PROVIDER_ID;
}

/**
 * Where connecting or disconnecting a provider is handled. The AutoRAG plan is
 * signed in through the account service (encrypted key, adopted defaults,
 * Settings > 계정); signing in through the generic Pi flow would store the
 * token in plaintext and skip all of that. Every other provider uses Pi.
 */
export function providerConnectRoute(providerId: string): "account" | "provider" {
	return providerId === AUTORAG_PROVIDER_ID ? "account" : "provider";
}

/** The providers the generic Pi connect menu may offer: everything except the AutoRAG plan. */
export function withoutAutorag<T extends { readonly id: string }>(items: readonly T[]): T[] {
	return items.filter((item) => providerConnectRoute(item.id) === "provider");
}
