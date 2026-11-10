import { readDazziLoginToken, resolveBaseUrl } from "@autorag/librarian";
import { z } from "zod";

/**
 * Jev's verdict on the tour's example question: would the person who owns the document recognise the question as
 * theirs and be struck by it? The tour only shows a question Jev puts at {@link DEMO_MIN_SCORE} or above, so a
 * generic or title-only question never reaches the first screen of AI Search.
 *
 * The call is Jev's native `noul` dialect against the hosted Dazzi plan (`POST <root>/v1/jev`), the same endpoint
 * the librarian's own Jev client uses. The librarian does not export that client, so the one request this feature
 * needs is made here. The document excerpt leaves the machine only for the Dazzi plan and only when a Dazzi
 * credential exists; with none, nothing is judged and the tour shows no question.
 */

/** A question counts as tour material at this P(yes) or above. */
export const DEMO_MIN_SCORE = 0.9;

const JEV_PATH = "/v1/jev";
const DEFAULT_JEV_MODEL = "jev-1.13";
const JEV_TIMEOUT_MS = 15_000;
const QUESTION_KEY = "quality";

const INSTRUCTIONS =
	"The document excerpt belongs to a real person, and the proposed question is shown to them as an example of what they can ask about their own files. " +
	"Is it a high-quality example: concrete, natural, clearly about this document's content, and plausible to ask?";
const CRITERIA = {
	true: "yes, concrete and natural and clearly about the document",
	false: "no, vague, generic, title-only, noisy, or implausible",
} as const;

export interface DemoQuestionCandidate {
	readonly question: string;
	/** The head of the document the question was written from. */
	readonly excerpt: string;
}

/** P(yes) per candidate in input order; null where Jev could not be asked or gave no usable answer. */
export type DemoQuestionJudge = (candidates: readonly DemoQuestionCandidate[]) => Promise<readonly (number | null)[]>;

export interface DemoQuestionJudgeOptions {
	readonly env: NodeJS.ProcessEnv;
	/** Pi's agent home, where the Dazzi credential lives. */
	readonly agentDir: string;
	/** The Jev model id the config names for the Dazzi backend; absent: the plan's default. */
	readonly model?: () => string | undefined;
	readonly fetchImpl?: typeof fetch;
}

/** The one field of Jev's native response this feature reads: `answers.quality.noul`, a probability. */
const JevResponse = z.object({ answers: z.object({ [QUESTION_KEY]: z.object({ noul: z.number().min(0).max(1) }) }) });

/** P(yes) of one Jev response, or null when the body is not the shape Jev answers a `noul` question with. */
export function readNoulScore(body: unknown): number | null {
	const parsed = JevResponse.safeParse(body);
	return parsed.success ? parsed.data.answers[QUESTION_KEY].noul : null;
}

export function createDemoQuestionJudge(options: DemoQuestionJudgeOptions): DemoQuestionJudge {
	const doFetch = options.fetchImpl ?? fetch;
	return async (candidates) => {
		const token = readDazziLoginToken(options.agentDir);
		if (token === undefined || token.trim() === "") return candidates.map(() => null);
		const url = `${resolveBaseUrl(options.env)}${JEV_PATH}`;
		const model = options.model?.() ?? DEFAULT_JEV_MODEL;
		return Promise.all(
			candidates.map(async (candidate): Promise<number | null> => {
				try {
					const response = await doFetch(url, {
						method: "POST",
						headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
						body: JSON.stringify({
							model,
							state: JSON.stringify({ documentExcerpt: candidate.excerpt, proposedQuestion: candidate.question }),
							questions: { [QUESTION_KEY]: { type: "noul", instructions: INSTRUCTIONS, criteria: CRITERIA } },
						}),
						signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
					});
					return response.ok ? readNoulScore(await response.json()) : null;
				} catch {
					return null;
				}
			}),
		);
	};
}
