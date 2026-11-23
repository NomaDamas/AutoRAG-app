import { Jev, type Question, type Verdict } from "jev-use";
import type { ResolvedDecisionBackends } from "../decision-model";
import type { WriteJudge } from "./write-gate";

/**
 * Jev for the write gate: the same decision backends the search relevance gate uses (the hosted Jev, then the small chat model as a
 * fallback), resolved from the shared AutoRAG config. The backends are resolved once and kept; a primary that fails is skipped for a
 * minute so a down backend does not add its timeout to every command.
 */

const PRIMARY_COOLDOWN_MS = 60_000;

export interface WriteJudgeDeps {
	readonly resolveBackends: () => Promise<ResolvedDecisionBackends>;
}

export function createWriteJudge(deps: WriteJudgeDeps): WriteJudge {
	let resolved: Promise<{ readonly primary: Jev | undefined; readonly fallback: Jev | undefined }> | undefined;
	let primaryBrokenUntil = 0;
	const clients = (): NonNullable<typeof resolved> => {
		resolved ??= deps.resolveBackends().then((backends) => ({
			primary: backends.primary === undefined ? undefined : new Jev({ backend: backends.primary }),
			fallback: backends.fallback === undefined ? undefined : new Jev({ backend: backends.fallback }),
		}));
		return resolved;
	};
	return async (state: string, questions: Question[]) => {
		const { primary, fallback } = await clients();
		if (primary === undefined && fallback === undefined) throw new Error("no decision model is configured");
		const answered = (verdicts: readonly Verdict[]): boolean => verdicts.some((verdict) => verdict.answer !== null);
		if (primary !== undefined && (Date.now() >= primaryBrokenUntil || fallback === undefined)) {
			try {
				const result = await primary.judge(state, questions);
				if (answered(result.verdicts)) return result;
			} catch {
				// Fall through to the small model.
			}
			primaryBrokenUntil = Date.now() + PRIMARY_COOLDOWN_MS;
		}
		if (fallback !== undefined) {
			const result = await fallback.judge(state, questions);
			if (answered(result.verdicts)) return result;
		}
		throw new Error("the decision model gave no answer");
	};
}
