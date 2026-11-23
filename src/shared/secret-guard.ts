/**
 * What keeps a credential out of a model's context.
 *
 * A Settings assistant is a model: whatever it reads or is told goes to a remote provider. So a secret must never be in its
 * prompt, its tool results or its shell output. Three rules, all enforced here and not by asking the model to behave:
 *
 * - A secret the person types goes to a masked field in the panel and straight to the credential store (the model only learns
 *   that it was stored, and the masked tail {@link maskSecret} returns).
 * - A secret found in another program's files is read and stored by the app, never printed (see `coding-agent-credentials`).
 * - Anything a tool returns, and anything the person pastes into the chat box, passes through {@link redactSecrets} first.
 */

export const SECRET_PLACEHOLDER = "[secret removed]";

/** A value shorter than this is not treated as a secret to hunt for: removing "a" would mangle every sentence. */
const MIN_KNOWN_SECRET = 8;

/** The last four characters of a long secret, so the person can tell two keys apart; short values show nothing. */
export function maskSecret(secret: string): string {
	if (secret.length < 12) return "••••";
	return `••••${secret.slice(-4)}`;
}

const PATTERNS: readonly RegExp[] = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
	/\bsk-ant-[A-Za-z0-9_-]{16,}/gu,
	/\bsk-(?:proj-|svcacct-|or-v1-)?[A-Za-z0-9_-]{20,}/gu,
	/\bgh[pousr]_[A-Za-z0-9]{30,}/gu,
	/\bgithub_pat_[A-Za-z0-9_]{30,}/gu,
	/\bAIza[A-Za-z0-9_-]{30,}/gu,
	/\bxox[abposr]-[A-Za-z0-9-]{10,}/gu,
	/\bglpat-[A-Za-z0-9_-]{16,}/gu,
	/\bnpm_[A-Za-z0-9]{30,}/gu,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
	/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/giu,
	// `api_key = "…"`, `"apiKey": "…"`, `TOKEN=…`: the value after a secret-looking name.
	/\b(?:[A-Za-z0-9_]*(?:api[-_]?key|secret|token|passw(?:or)?d|credential)[A-Za-z0-9_]*)["']?\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{12,})["']?/giu,
];

/** How many places in `text` look like a credential. */
export function findSecrets(text: string): number {
	let count = 0;
	for (const pattern of PATTERNS) count += [...text.matchAll(new RegExp(pattern.source, pattern.flags))].length;
	return count;
}

/** `text` with every credential-looking value, and every exact value in `known`, replaced by {@link SECRET_PLACEHOLDER}. */
export function redactSecrets(text: string, known: readonly string[] = []): string {
	let clean = text;
	for (const secret of known) {
		if (secret.length >= MIN_KNOWN_SECRET) clean = clean.split(secret).join(SECRET_PLACEHOLDER);
	}
	for (const pattern of PATTERNS) {
		clean = clean.replace(new RegExp(pattern.source, pattern.flags), (match, group: unknown) => {
			// For `name = value` keep the name so the line stays readable; the value alone goes.
			if (typeof group === "string" && group.length > 0 && !/^(Bearer|Basic)$/iu.test(group)) return match.replace(group, SECRET_PLACEHOLDER);
			if (/^(Bearer|Basic)\s/iu.test(match)) return `${match.split(/\s/u)[0]} ${SECRET_PLACEHOLDER}`;
			return SECRET_PLACEHOLDER;
		});
	}
	return clean;
}
