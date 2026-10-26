/**
 * What an error message from the main process means for the person reading it.
 *
 * Errors cross the process boundary as plain strings (pi, the librarian and the
 * provider SDKs throw them), so the kind is read back from the wording. The
 * question the UI asks is not "what exactly failed" but "what can be done next":
 *
 * - the model itself cannot be used (not chosen, wrong key, plan used up, gone):
 *   only the model settings or the subscription page help, and no AI run can,
 *   because the AI is the thing that is down;
 * - the model is only briefly out of reach (rate limit, network): wait or check
 *   the connection;
 * - anything else: a problem with the app's own setup that the fix agent may
 *   repair.
 *
 * Pure and dependency-free so the main process and the renderer read an error
 * the same way.
 */

export type AppErrorKind =
	/** No model is chosen or signed in. */
	| "model-missing"
	/** A key or sign-in is rejected or expired. */
	| "model-credentials"
	/** The plan, credits or billing no longer cover the call. */
	| "model-subscription"
	/** The chosen model does not exist (any more) on its provider. */
	| "model-not-found"
	/** Too many requests or an overloaded provider; passes by itself. */
	| "rate-limit"
	/** The provider could not be reached. */
	| "network"
	| "other";

/** Paths in a message are names the person chose, never a sign of what failed: "Billing/402.pdf" must not read as a payment error. */
const PATH = /(?<=^|[\s'"`(\[])(?:[A-Za-z]:\\|\/)[^\s'"`)\]]*/gu;

/** An HTTP status as the SDKs word it: leading, after "HTTP"/"status"/"code"/"error", or followed by its reason phrase. */
function status(code: number): RegExp {
	return new RegExp(
		String.raw`(?:^\s*|\b(?:https?|status(?:\s+code)?|code|error)\W{0,3})${code}(?!\w)|(?<![\w/.-])${code}\s+(?:status code|unauthorized|forbidden|payment required|too many requests|not found|overloaded|service unavailable)`,
		"iu",
	);
}

const MISSING = /\bno model (?:is )?(?:configured|selected)\b|\bno api key found\b|\bnot signed in\b|\bsign in and pick one\b/iu;

const SUBSCRIPTION = new RegExp(
	[
		String.raw`\binsufficient[_ ]?(?:quota|funds|credits?|balance)\b`,
		String.raw`\bexceeded\b[^.\n]{0,40}\bquota\b`,
		String.raw`\bquota[_ ](?:exceeded|exhausted|reached)\b`,
		String.raw`\busage[_ ]?limit(?![a-z])`,
		String.raw`\bcredit balance\b`,
		String.raw`\bout of credits\b`,
		String.raw`\bcredits? (?:are |is |have been )?(?:used up|exhausted|depleted)\b`,
		String.raw`\bpayment required\b`,
		String.raw`\bbilling\b`,
		String.raw`\bsubscription\b`,
		String.raw`\byour plan\b`,
		String.raw`\bplan (?:limit|does not|doesn't|has expired)\b`,
		String.raw`\bupgrade your plan\b`,
	].join("|"),
	"iu",
);

const CREDENTIALS = new RegExp(
	[
		String.raw`\bunauthori[sz]ed\b`,
		String.raw`\bincorrect api key\b`,
		String.raw`\binvalid[_ -]?(?:x-)?(?:api[_ -]?)?key\b`,
		String.raw`\bapi key (?:is )?(?:invalid|expired|revoked)\b`,
		String.raw`\bauthentication (?:failed|error)\b`,
		String.raw`\btoken (?:has )?expired\b|\bexpired token\b`,
		String.raw`\bsign in again\b`,
	].join("|"),
	"iu",
);

const NOT_FOUND = /\bunknown configured model\b|\bnot found for provider\b|\bmodel_not_found\b|\bno such model\b|(?<!embedding )(?<!embedder )(?<!local )\bmodel\b[^.\n]{0,80}?\b(?:not found|does not exist|is not available|not supported)\b/iu;

const RATE_LIMIT = /\brate[_ -]?limit|\btoo many requests\b|\boverloaded\b|\bservice unavailable\b|\btry again later\b/iu;

const NETWORK = /\bENOTFOUND\b|\bECONNREFUSED\b|\bECONNRESET\b|\bETIMEDOUT\b|\bESOCKETTIMEDOUT\b|\bEAI_AGAIN\b|\bENETUNREACH\b|\bEHOSTUNREACH\b|\bfetch failed\b|\bfailed to fetch\b|\bsocket hang up\b|\bgetaddrinfo\b|\brequest timed out\b|\bnetwork (?:error|request failed|is unreachable)\b|\bconnection (?:error|refused|reset)\b/iu;

const STATUS_402 = status(402);
const STATUS_401 = status(401);
const STATUS_403 = status(403);
const STATUS_429 = status(429);
const STATUS_5XX = new RegExp(`${status(503).source}|${status(529).source}`, "iu");

export function classifyAppError(message: string): AppErrorKind {
	const text = message.replace(PATH, " ");
	if (MISSING.test(text)) return "model-missing";
	if (SUBSCRIPTION.test(text) || STATUS_402.test(text)) return "model-subscription";
	if (CREDENTIALS.test(text) || STATUS_401.test(text) || STATUS_403.test(text)) return "model-credentials";
	if (NOT_FOUND.test(text)) return "model-not-found";
	if (RATE_LIMIT.test(text) || STATUS_429.test(text) || STATUS_5XX.test(text)) return "rate-limit";
	if (NETWORK.test(text)) return "network";
	return "other";
}

/** The model cannot be used at all: only Settings (or the subscription) can change that. */
export function isModelProblem(kind: AppErrorKind): boolean {
	return kind === "model-missing" || kind === "model-credentials" || kind === "model-subscription" || kind === "model-not-found";
}

/** The fix agent is worth offering: the model works, and the cause is the app's own setup. */
export function canFixWithAi(kind: AppErrorKind): boolean {
	return kind === "other";
}
