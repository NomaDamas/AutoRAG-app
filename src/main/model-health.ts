import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ModelCheckResult } from "../shared/onboarding-contract";

/**
 * Proves the model a user just chose can actually be called, the same way the
 * smart scan and AI Search will call it: it resolves the configured answer model
 * with its credentials and asks it for a few tokens. A provider being reachable
 * is not enough (a key can be wrong, a model retired, a plan restricted), so the
 * onboarding model step stays closed until this passes.
 */

export interface ModelHealthDeps {
	/** The answer model in the shared config with its credentials; rejects when none is configured. */
	readonly resolveModel: () => Promise<{
		readonly model: Model<Api>;
		readonly apiKey?: string;
		readonly providerApiKeys?: Readonly<Record<string, string>>;
	}>;
	readonly complete: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => Promise<AssistantMessage>;
	/** Longest the check may wait for an answer. */
	readonly timeoutMs: number;
	readonly now: () => number;
}

const PROBE_PROMPT = "Reply with OK.";
/** A few tokens are enough to prove the call works. */
const PROBE_MAX_TOKENS = 16;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function checkModelHealth(deps: ModelHealthDeps): Promise<ModelCheckResult> {
	const signal = AbortSignal.timeout(deps.timeoutMs);
	try {
		const resolved = await deps.resolveModel();
		const apiKey = resolved.apiKey ?? resolved.providerApiKeys?.[resolved.model.provider];
		const startedAt = deps.now();
		const reply = await deps.complete(
			resolved.model,
			{ messages: [{ role: "user", content: PROBE_PROMPT, timestamp: startedAt }] },
			{ ...(apiKey === undefined ? {} : { apiKey }), maxTokens: PROBE_MAX_TOKENS, signal },
		);
		// `length` is an answer: reasoning models spend the whole small budget thinking.
		if (reply.stopReason === "error" || reply.stopReason === "aborted") {
			return { ok: false, error: signal.aborted ? `The model did not respond within ${Math.round(deps.timeoutMs / 1000)}s.` : (reply.errorMessage ?? "The model call failed.") };
		}
		return { ok: true, latencyMs: deps.now() - startedAt };
	} catch (error) {
		return { ok: false, error: signal.aborted ? `The model did not respond within ${Math.round(deps.timeoutMs / 1000)}s.` : errorText(error) };
	}
}
