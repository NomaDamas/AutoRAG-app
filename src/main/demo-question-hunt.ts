import type { FirstRunDemo } from "../shared/onboarding-contract";
import type { DemoQuestionJudge } from "./demo-question-judge";

/**
 * The search for the one question the tour shows. It runs while the first index is still being built and again
 * once it ends, and takes a question only when all three of these hold:
 *
 *  1. a model wrote it from one of the person's own documents;
 *  2. keyword retrieval over the index returns that document in its top results (the tour's answer will cite it);
 *  3. Jev puts "a real person would recognise this as theirs and want to ask it" at `minScore` or above.
 *
 * A document is looked at once: whatever its question scored, it is never written for again. A question whose
 * document is not in the index yet waits for a later round instead of being thrown away.
 */

export interface DemoDoc {
	readonly sourcePath: string;
	readonly realSourcePath: string;
	/** The head of the document's parsed text. */
	readonly excerpt: string;
}

export interface WrittenQuestion {
	/** 1-based position in the list of documents the model was given. */
	readonly doc: number;
	readonly question: string;
}

export interface DemoHuntDeps {
	/** Documents worth writing a question for that are not in `seen`, best first. */
	readonly collect: (seen: ReadonlySet<string>) => readonly DemoDoc[];
	/** One model call: a question per document. */
	readonly write: (docs: readonly DemoDoc[]) => Promise<readonly WrittenQuestion[]>;
	readonly retrieve: (query: string, options: { readonly topK: number }) => Promise<readonly { readonly source: string }[]>;
	readonly judge: DemoQuestionJudge;
	/** Canonical form of a path the retrieval reports, to compare with {@link DemoDoc.realSourcePath}. */
	readonly realpath: (path: string) => string;
	/** P(yes) a question needs from Jev. */
	readonly minScore: number;
	/** Most documents the model is ever shown in one hunt. */
	readonly maxDocs: number;
	/** Documents per model call. */
	readonly batchSize: number;
	readonly now: () => number;
}

export interface HuntRound {
	/** The best question at or above `minScore` this round, if any. */
	readonly demo: FirstRunDemo | null;
	/** Nothing is left to try: no document waits for the index, none is new, or Jev cannot be asked. */
	readonly exhausted: boolean;
}

export interface DemoHunt {
	/** One pass over what is new. `indexingDone` says no more documents will reach the index, so a question still missing from it is dropped. */
	round(indexingDone: boolean): Promise<HuntRound>;
}

/** A model that fails this many calls in a row is not going to write the question; the hunt stops asking it. */
const MAX_WRITE_FAILURES = 2;

interface Waiting {
	readonly doc: DemoDoc;
	readonly question: string;
}

export function createDemoHunt(deps: DemoHuntDeps): DemoHunt {
	/** Every document the model has been shown (or will be this round). */
	const seen = new Set<string>();
	/** Questions written but not yet verified, because their document may not be searchable yet. */
	const waiting = new Map<string, Waiting>();
	let judgeUnavailable = false;
	/** Model calls that failed one after another; the model is taken as unavailable at {@link MAX_WRITE_FAILURES}. */
	let writeFailures = 0;

	async function writeFor(fresh: readonly DemoDoc[]): Promise<void> {
		for (const doc of fresh) seen.add(doc.sourcePath);
		let written: readonly WrittenQuestion[];
		try {
			written = await deps.write(fresh);
		} catch {
			// Not the documents' fault: they stay unseen for the next round.
			for (const doc of fresh) seen.delete(doc.sourcePath);
			writeFailures += 1;
			return;
		}
		writeFailures = 0;
		for (const { doc, question } of written) {
			const candidate = fresh[doc - 1];
			if (candidate !== undefined && !waiting.has(candidate.sourcePath)) waiting.set(candidate.sourcePath, { doc: candidate, question });
		}
	}

	return {
		async round(indexingDone) {
			if (judgeUnavailable) return { demo: null, exhausted: true };
			let fresh: readonly DemoDoc[] = [];
			const room = deps.maxDocs - seen.size;
			if (room > 0 && writeFailures < MAX_WRITE_FAILURES) {
				fresh = deps.collect(seen).slice(0, Math.min(room, deps.batchSize));
				if (fresh.length > 0) await writeFor(fresh);
			}

			const verified: { readonly entry: Waiting; readonly rank: number; readonly latencyMs: number }[] = [];
			for (const [path, entry] of [...waiting]) {
				const askedAt = deps.now();
				let results: readonly { readonly source: string }[];
				try {
					results = await deps.retrieve(entry.question, { topK: 5 });
				} catch {
					if (indexingDone) waiting.delete(path);
					continue;
				}
				const latencyMs = deps.now() - askedAt;
				const rank = results.findIndex((result) => deps.realpath(result.source) === entry.doc.realSourcePath);
				if (rank < 0) {
					if (indexingDone) waiting.delete(path);
					continue;
				}
				waiting.delete(path);
				verified.push({ entry, rank, latencyMs });
			}

			let demo: FirstRunDemo | null = null;
			if (verified.length > 0) {
				const scores = await deps.judge(verified.map(({ entry }) => ({ question: entry.question, excerpt: entry.doc.excerpt })));
				if (scores.every((score) => score === null)) {
					judgeUnavailable = true;
					return { demo: null, exhausted: true };
				}
				let best: { score: number; rank: number; latencyMs: number } | null = null;
				for (const [index, { entry, rank, latencyMs }] of verified.entries()) {
					const score = scores[index] ?? null;
					if (score === null || score < deps.minScore) continue;
					const better = best === null || score > best.score || (score === best.score && (rank < best.rank || (rank === best.rank && latencyMs < best.latencyMs)));
					if (!better) continue;
					best = { score, rank, latencyMs };
					demo = { question: entry.question, sourcePath: entry.doc.sourcePath, latencyMs };
				}
			}
			return { demo, exhausted: demo === null && indexingDone && waiting.size === 0 && fresh.length === 0 };
		},
	};
}
