import { isJsonObject } from "../shared/settings-contract";
import { t } from "../shared/i18n/core";

/**
 * One real embedding request, sent before the first byte of a document is parsed.
 *
 * A remote embedder that cannot work (wrong base URL, key MinSync does not read,
 * empty balance) otherwise shows up only when the MinSync step starts, after the
 * whole parse phase: about an hour on 85k files. The request here is built the way
 * MinSync builds its own, so a pass means the first real batch can be sent, and a
 * failure carries the provider's own reason.
 *
 * Only `openai:` and `tei:` embedders are probed. A native embedder or a runtime
 * profile runs inside MinSync with nothing to reach over the network.
 */

/** The part of `minSync.embedder` the probe reads. */
export interface PreflightEmbedder {
	readonly id?: string;
	readonly baseUrl?: string;
	readonly dimension?: number;
	readonly apiKeyEnv?: string;
	readonly profile?: string;
}

export type PreflightOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

export interface PreflightDeps {
	/** The environment MinSync inherits: it reads `OPENAI_API_KEY` from here and nowhere else. */
	readonly env: NodeJS.ProcessEnv;
	readonly fetchImpl?: typeof fetch;
	readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** MinSync's default for `openai:` when `baseUrl` is not set. */
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com";
/** The only variable MinSync reads an `openai:` key from; `apiKeyEnv` does not change that. */
const OPENAI_KEY_ENV = "OPENAI_API_KEY";
const PING = "ping";
const DETAIL_LIMIT = 200;

/** The provider's own words: `error.message` of a JSON error, else the start of the body. */
function detailOf(body: string): string {
	try {
		const parsed: unknown = JSON.parse(body);
		const error = isJsonObject(parsed) ? parsed.error : undefined;
		if (isJsonObject(error) && typeof error.message === "string") return error.message.slice(0, DETAIL_LIMIT);
	} catch {
		// Not JSON: fall through to the raw text.
	}
	return body.trim().slice(0, DETAIL_LIMIT);
}

/** MinSync appends `/v1/embeddings` itself, so a base URL that already ends in `/v1` doubles it. */
function withoutV1(baseUrl: string): string | null {
	const trimmed = baseUrl.replace(/\/+$/u, "");
	return trimmed.endsWith("/v1") ? trimmed.slice(0, -"/v1".length) : null;
}

function vectorOf(parsed: unknown, kind: "openai" | "tei"): unknown {
	if (kind === "tei") return Array.isArray(parsed) ? parsed[0] : undefined;
	const data = isJsonObject(parsed) && Array.isArray(parsed.data) ? parsed.data[0] : undefined;
	return isJsonObject(data) ? data.embedding : undefined;
}

export async function preflightEmbedder(embedder: PreflightEmbedder | undefined, deps: PreflightDeps): Promise<PreflightOutcome> {
	const id = embedder?.id;
	const kind = id?.startsWith("openai:") ? "openai" : id?.startsWith("tei:") ? "tei" : null;
	if (embedder === undefined || id === undefined || kind === null) return { ok: true };

	const headers: Record<string, string> = { "content-type": "application/json" };
	let baseUrl: string;
	let url: string;
	let body: unknown;
	if (kind === "openai") {
		const key = deps.env[OPENAI_KEY_ENV];
		if (typeof key !== "string" || key.length === 0) {
			const configured = embedder.apiKeyEnv;
			return {
				ok: false,
				message:
					configured !== undefined && configured !== OPENAI_KEY_ENV
						? t("main.refresh.preflightKeyEnvIgnored", { id, configured, env: OPENAI_KEY_ENV })
						: t("main.refresh.preflightMissingKey", { id, env: OPENAI_KEY_ENV }),
			};
		}
		headers.authorization = `Bearer ${key}`;
		baseUrl = embedder.baseUrl ?? OPENAI_DEFAULT_BASE_URL;
		// MinSync does not trim an `openai:` base URL, so neither does the probe.
		url = `${baseUrl}/v1/embeddings`;
		body = { model: id.slice("openai:".length), input: [PING] };
	} else {
		baseUrl = (embedder.baseUrl ?? "http://localhost:8080").replace(/\/+$/u, "");
		url = `${baseUrl}/embed`;
		body = { inputs: [PING] };
	}

	const fetchImpl = deps.fetchImpl ?? fetch;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let response: Response;
	try {
		response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
	} catch (error) {
		if (error instanceof Error && error.name === "TimeoutError") {
			return { ok: false, message: t("main.refresh.preflightTimeout", { url: baseUrl, seconds: Math.round(timeoutMs / 1000) }) };
		}
		return { ok: false, message: t("main.refresh.preflightUnreachable", { url: baseUrl, reason: error instanceof Error ? error.message : String(error) }) };
	}

	if (!response.ok) {
		const suggested = response.status === 404 ? withoutV1(baseUrl) : null;
		if (suggested !== null) return { ok: false, message: t("main.refresh.preflightBaseUrlV1", { url: baseUrl, suggested }) };
		return { ok: false, message: t("main.refresh.preflightStatus", { url: baseUrl, status: response.status, detail: detailOf(await response.text().catch(() => "")) }) };
	}

	let parsed: unknown;
	try {
		parsed = await response.json();
	} catch {
		return { ok: false, message: t("main.refresh.preflightNoVector", { url: baseUrl }) };
	}
	const vector = vectorOf(parsed, kind);
	if (!Array.isArray(vector) || vector.length === 0 || vector.some((value) => typeof value !== "number")) {
		return { ok: false, message: t("main.refresh.preflightNoVector", { url: baseUrl }) };
	}
	if (embedder.dimension !== undefined && vector.length !== embedder.dimension) {
		return { ok: false, message: t("main.refresh.preflightDimension", { url: baseUrl, actual: vector.length, expected: embedder.dimension }) };
	}
	return { ok: true };
}
