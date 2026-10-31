import type { IndexActivitySnapshot } from "../shared/index-activity-contract";
import type { IndexProblem } from "../shared/index-problem-contract";
import type { IndexNotice } from "../shared/search-contract";
import type { DataSourcesSnapshot } from "../shared/settings-contract";

/**
 * Whether the documents an AI Search is about to search are all there. A search that Jev routes to the local branch
 * reads only what the index holds, so an index that is still being built, stopped half way, or holds a handful of
 * documents answers from less than the person has. This judges that from what the app already tracks (the activity
 * of the index runs, the last run's problem, and the counts Settings → Indexing shows) and reads nothing of its own.
 */

/** An index with fewer documents than this is called small: a search over it has little to find. */
export const FEW_INDEXED_DOCUMENTS = 10;

export interface IndexReadinessInput {
	/** An index run (the folders or a datasource) is going, whoever started it. */
	readonly running: boolean;
	/** The last run stopped before it finished and nothing has made it right since. */
	readonly failed: boolean;
	/** Documents indexed across the folders and the enabled sources; `null` when that could not be read. */
	readonly documents: number | null;
}

/**
 * The notice the person should see, or `null` for an index that is ready. A run in progress is the news, then a
 * stopped run, then how much the index holds; an unreadable size is never called small.
 */
export function judgeIndexReadiness(input: IndexReadinessInput): IndexNotice | null {
	if (input.running) return { reason: "indexing", documents: input.documents };
	if (input.failed) return { reason: "failed", documents: input.documents };
	if (input.documents === null) return null;
	if (input.documents === 0) return { reason: "empty", documents: 0 };
	if (input.documents < FEW_INDEXED_DOCUMENTS) return { reason: "few", documents: input.documents };
	return null;
}

export interface IndexReadinessDeps {
	readonly activity: () => Promise<IndexActivitySnapshot>;
	readonly problem: () => IndexProblem;
	/** The same listing Settings → Indexing reads. */
	readonly sources: () => Promise<DataSourcesSnapshot>;
}

/**
 * Documents the search can reach: the folder index plus every enabled source that holds an index. A source that is
 * off, answers live, or was never indexed adds nothing. `null` when the listing could not be read.
 */
function indexedDocuments(snapshot: DataSourcesSnapshot): number | null {
	if (snapshot.error !== null) return null;
	const fromSources = snapshot.sources.reduce((sum, source) => sum + (source.enabled && source.index.state === "indexed" ? (source.index.chunkCount ?? 0) : 0), 0);
	return (snapshot.local.documentCount ?? 0) + fromSources;
}

export function createIndexReadiness(deps: IndexReadinessDeps): () => Promise<IndexNotice | null> {
	return async () => {
		const [activity, snapshot] = await Promise.all([deps.activity(), deps.sources().catch(() => null)]);
		return judgeIndexReadiness({
			running: activity.state === "running",
			failed: deps.problem().failure !== null,
			documents: snapshot === null ? null : indexedDocuments(snapshot),
		});
	};
}
