import type { JevBackend } from "jev-use";
import type { BackendRequest, BackendResponse, RawAnswer } from "jev-use/dist/backends/types.js";

/**
 * The librarian requires a decision model (Jev) and checks it on a session's first question, so a test agent can no
 * longer pass `jev: false`. This backend answers every question the plain way, like the librarian's own
 * `test/helpers/baseline-jev.ts`: the local route, no decomposition, verification always, no datasource or web
 * search, every citation kept, nothing stored in memory, and no file change approved on its own.
 *
 * The question ids are the librarian's (`QUERY_ROUTE_QUESTION_ID`, `FOLLOW_UP_QUESTION_ID`,
 * `CITATION_QUESTION_ID_PREFIX`, `PERMISSION_GATE_QUESTION_ID`), which it does not export.
 */
type Question = BackendRequest["questions"][number];

function answer(question: Question): RawAnswer {
	switch (question.type) {
		case "noul":
			if (question.id === "follow_up" || question.id.startsWith("citation:")) return { answer: 1 };
			if (question.id.startsWith("permission_")) return { answer: 1 };
			return { answer: 0 };
		case "choice": {
			const labels = Array.isArray(question.options) ? question.options : Object.keys(question.options ?? {});
			const winner = question.id === "route" ? "local" : question.id === "permission_gate" ? "deny" : (labels[0] ?? "");
			return { answer: winner, distribution: { [winner]: 1 }, confidence: 1 };
		}
		case "score":
			return { answer: 0, confidence: 1 };
	}
}

class BaselineDecisionBackend implements JevBackend {
	readonly name = "baseline";

	async judge(request: BackendRequest): Promise<BackendResponse> {
		return { answers: request.questions.map(answer), model: "baseline-decision" };
	}
}

/** `jev` agent option for tests that are not about decision-model behavior. */
export function baselineJev(): { readonly backend: JevBackend } {
	return { backend: new BaselineDecisionBackend() };
}
