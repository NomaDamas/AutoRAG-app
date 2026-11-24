import { readDazziLoginToken, resolveBaseUrl } from "@autorag/librarian";
import { z } from "zod";

/**
 * Jev's verdict on the tour's example question. Two typed questions are put together:
 *
 *  - `quality`: would the owner recognise it as about their own document, concrete and natural to ask;
 *  - `private`: is it something only that document can answer, not a web search or general knowledge. An example
 *    that the public web answers does not show what Dazzi is for.
 *
 * The tour only shows a question with `quality` at {@link DEMO_MIN_QUALITY} or above and `private` at
 * {@link DEMO_MIN_PRIVATE} or above, so a generic, title-only or publicly answerable question never reaches the
 * first screen of AI Search.
 *
 * The call is Jev's native `noul` dialect against the hosted Dazzi plan (`POST <root>/v1/jev`), the same endpoint
 * the librarian's own Jev client uses. The librarian does not export that client, so the one request this feature
 * needs is made here. The document excerpt leaves the machine only for the Dazzi plan and only when a Dazzi
 * credential exists; with none, nothing is judged and the tour shows no question.
 */

/** `quality` P(yes) a question needs from Jev. */
export const DEMO_MIN_QUALITY = 0.9;
/** `private` P(yes) a question needs from Jev: only the person's own document holds the answer. */
export const DEMO_MIN_PRIVATE = 0.7;

const JEV_PATH = "/v1/jev";
const DEFAULT_JEV_MODEL = "jev-1.13";
const JEV_TIMEOUT_MS = 15_000;

const QUESTIONS = {
	quality: {
		type: "noul",
		instructions:
			"The document excerpt belongs to a real person, and the proposed question is shown to them as an example of what they can ask about their own files. " +
			"Is it a high-quality example: concrete, natural, clearly about this document's content, and plausible to ask?",
		criteria: {
			true: "yes, concrete and natural and clearly about the document",
			false: "no, vague, generic, title-only, noisy, or implausible",
		},
	},
	private: {
		type: "noul",
		instructions: "Does answering this question require this person's own document, because a web search or general knowledge could not answer it?",
		criteria: {
			true: "yes: only this person's own document holds the answer (a private fact, number, name or decision in it)",
			false: "no: the public web or general knowledge answers it",
		},
	},
} as const;

export interface DemoQuestionCandidate {
	readonly question: string;
	/** The head of the document the question was written from. */
	readonly excerpt: string;
}

/** What Jev said of one candidate: each score is P(yes) in [0, 1]. */
export interface DemoQuestionVerdict {
	readonly quality: number;
	readonly private: number;
}

/** A verdict per candidate in input order; null where Jev could not be asked or gave no usable answer. */
export type DemoQuestionJudge = (candidates: readonly DemoQuestionCandidate[]) => Promise<readonly (DemoQuestionVerdict | null)[]>;

/** Whether a verdict clears both bars. */
export function passesDemoBar(verdict: DemoQuestionVerdict): boolean {
	return verdict.quality >= DEMO_MIN_QUALITY && verdict.private >= DEMO_MIN_PRIVATE;
}

export interface DemoQuestionJudgeOptions {
	readonly env: NodeJS.ProcessEnv;
	/** Pi's agent home, where the Dazzi credential lives. */
	readonly agentDir: string;
	/** The Jev model id the config names for the Dazzi backend; absent: the plan's default. */
	readonly model?: () => string | undefined;
	readonly fetchImpl?: typeof fetch;
}

/** The two fields of Jev's native response this feature reads: `answers.quality.noul` and `answers.private.noul`. */
const Score = z.object({ noul: z.number().min(0).max(1) });
const JevResponse = z.object({ answers: z.object({ quality: Score, private: Score }) });

/** Both scores of one Jev response, or null when the body is not the shape Jev answers these `noul` questions with. */
export function readVerdict(body: unknown): DemoQuestionVerdict | null {
	const parsed = JevResponse.safeParse(body);
	return parsed.success ? { quality: parsed.data.answers.quality.noul, private: parsed.data.answers.private.noul } : null;
}

export function createDemoQuestionJudge(options: DemoQuestionJudgeOptions): DemoQuestionJudge {
	const doFetch = options.fetchImpl ?? fetch;
	return async (candidates) => {
		const token = readDazziLoginToken(options.agentDir);
		if (token === undefined || token.trim() === "") return candidates.map(() => null);
		const url = `${resolveBaseUrl(options.env)}${JEV_PATH}`;
		const model = options.model?.() ?? DEFAULT_JEV_MODEL;
		return Promise.all(
			candidates.map(async (candidate): Promise<DemoQuestionVerdict | null> => {
				try {
					const response = await doFetch(url, {
						method: "POST",
						headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
						body: JSON.stringify({
							model,
							state: JSON.stringify({ documentExcerpt: candidate.excerpt, proposedQuestion: candidate.question }),
							questions: QUESTIONS,
						}),
						signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
					});
					return response.ok ? readVerdict(await response.json()) : null;
				} catch {
					return null;
				}
			}),
		);
	};
}
