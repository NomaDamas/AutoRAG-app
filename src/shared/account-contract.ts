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
	useManagedModel: "account:useManagedModel",
	/** main → renderer event carrying one {@link AccountStatus}. */
	changed: "account:changed",
} as const;

/** Plans the hosted service sells. BYOK is not an account plan: it needs no account. */
export type AccountPlanId = "free" | "air" | "pro" | "max";

/** Plans that need a checkout, cheapest first. */
export const PAID_PLAN_IDS = ["air", "pro", "max"] as const;
export type PaidPlanId = (typeof PAID_PLAN_IDS)[number];

export function isPaidPlanId(value: unknown): value is PaidPlanId {
	return typeof value === "string" && (PAID_PLAN_IDS as readonly string[]).includes(value);
}

export type PromoCodeInput = { readonly ok: true; readonly code: string | null } | { readonly ok: false };

/**
 * A promo code as the hosted checkout accepts it: a short token of letters,
 * digits, `_` and `-`. An absent or blank code means none; anything else is
 * refused here so a malformed one never leaves the app.
 */
export function parsePromoCode(value: unknown): PromoCodeInput {
	if (value === undefined || value === null) return { ok: true, code: null };
	if (typeof value !== "string") return { ok: false };
	const code = value.trim();
	if (code.length === 0) return { ok: true, code: null };
	return /^[A-Za-z0-9_-]{1,64}$/u.test(code) ? { ok: true, code } : { ok: false };
}

/** Server root used when `AUTORAG_BASE_URL` is unset. */
export const DEFAULT_ACCOUNT_BASE_URL = "https://api.dazziapp.com";

/**
 * Legal pages the hosted service serves. The web sign-in shows the first three
 * as an agreement note; the account surfaces link them (and Subprocessors) too.
 */
export const ACCOUNT_LEGAL_ROUTES = {
	terms: "/terms",
	privacy: "/privacy",
	acceptableUse: "/acceptable-use",
	subprocessors: "/subprocessors",
	/** The per-model retention table inside the Privacy Policy. */
	privacyModels: "/privacy#models",
} as const;

export type AccountLegalRoute = keyof typeof ACCOUNT_LEGAL_ROUTES;

/** Absolute URL of one legal page on the account server; empty or unknown roots fall back to the default. */
export function accountLegalUrl(baseUrl: string | null | undefined, route: AccountLegalRoute): string {
	const configured = typeof baseUrl === "string" ? baseUrl.trim() : "";
	const root = (configured.length > 0 ? configured : DEFAULT_ACCOUNT_BASE_URL).replace(/\/+$/u, "");
	return `${root}${ACCOUNT_LEGAL_ROUTES[route]}`;
}

/** The hosted dashboard: plan changes, billing, receipts and API keys. */
export function accountDashboardUrl(baseUrl: string | null | undefined): string {
	const configured = typeof baseUrl === "string" ? baseUrl.trim() : "";
	return `${(configured.length > 0 ? configured : DEFAULT_ACCOUNT_BASE_URL).replace(/\/+$/u, "")}/dashboard`;
}

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
	/** The plan includes cloud embeddings (Pro and Max), as the server reports it. */
	readonly embeddings: boolean;
	readonly requestsPerMinute: number;
	/** Which hosted actions the server has configured. */
	readonly billing: { readonly air: boolean; readonly pro: boolean; readonly max: boolean; readonly portal: boolean };
}

export interface AccountStatus {
	/** `signingIn`: the browser sign-in is waiting for the callback. */
	readonly state: "signedOut" | "signingIn" | "signedIn";
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
	/** Opens the hosted checkout for the plan in the system browser, with a promo code when one is given. */
	checkout(plan: PaidPlanId, promoCode?: string): Promise<void>;
	/** Points the AutoRAG agent at the managed models of this account. */
	useManagedModel(): Promise<ManagedModelResult>;
	onChanged(listener: (status: AccountStatus) => void): () => void;
}

const PLAN_RANK: Readonly<Record<AccountPlanId, number>> = { free: 0, air: 1, pro: 2, max: 3 };

/** True when `have` already includes everything `want` offers. */
export function planCovers(have: AccountPlanId, want: AccountPlanId): boolean {
	return PLAN_RANK[have] >= PLAN_RANK[want];
}

/** Weekly credits reset on Monday 00:00 UTC (the server's ISO-week bucket); the first such instant after `now`. */
export function nextWeeklyReset(now: Date): Date {
	const day = now.getUTCDay();
	const daysUntilMonday = (8 - day) % 7 || 7;
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday));
}

/** A duration split for display; minutes round up so the last minute never reads "0". */
export function splitRemaining(ms: number): { readonly days: number; readonly hours: number; readonly minutes: number } {
	const total = Math.max(0, Math.ceil(ms / 60_000));
	return { days: Math.floor(total / 1440), hours: Math.floor((total % 1440) / 60), minutes: total % 60 };
}

/** Provider id the hosted plan registers under (the librarian's `dazzi` provider). */
export const AUTORAG_PROVIDER_ID = "dazzi";

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
 * the shared config names no model yet, or already names an AutoRAG one. A model the user
 * picked from another provider is never overridden, and a malformed `model`
 * value counts as theirs.
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
