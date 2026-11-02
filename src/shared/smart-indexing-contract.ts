/**
 * Smart indexing: before the first index, an AI reads the chosen folders and
 * proposes the sub-folders that are not worth indexing (system data, logs,
 * code, recordings, caches). The proposal is advice: the user toggles each
 * entry, and only the entries left excluded reach the shared config's
 * `excludePaths`
 * (design reference: docs/design-reference/onboarding/onboarding-prototype.html).
 *
 * The analysis runs in the main process on a read-only pi agent session
 * (`src/main/agents/`); the renderer starts a run, watches which folder the
 * agent is looking at, and receives one terminal event per run.
 */

export const SMART_INDEXING_CHANNELS = {
	analyze: "smartIndexing:analyze",
	cancel: "smartIndexing:cancel",
	/** main → renderer event carrying one {@link SmartIndexingEvent}. */
	event: "smartIndexing:event",
} as const;

/** One sub-folder the AI proposes to leave out of the index. */
export interface SmartExclusion {
	/** Absolute path of the proposed folder. */
	readonly path: string;
	/** The selected folder this one lies under (an entry of the run's `roots`). */
	readonly root: string;
	/** One sentence from the model saying why; model output, never translated. */
	readonly reason: string;
	/** Supported, size-capped files the index would otherwise take from this folder (the pre-scan's own measure). */
	readonly files: number;
	readonly bytes: number;
	/** The user's current choice: true leaves the folder out of the index. Proposals start excluded. */
	readonly excluded: boolean;
}

export type SmartIndexingEvent =
	/** Live phrase written by the agent before calling a tool, shown with text shimmer. */
	| { readonly type: "progress"; readonly runId: string; readonly text: string }
	/** The agent is looking at `path` (a folder or file under a root). */
	| { readonly type: "exploring"; readonly runId: string; readonly path: string }
	| { readonly type: "result"; readonly runId: string; readonly exclusions: readonly SmartExclusion[] }
	/** The run could not finish (no model signed in or connected, a provider error, ...). */
	| { readonly type: "error"; readonly runId: string; readonly message: string }
	| { readonly type: "cancelled"; readonly runId: string };

export interface SmartIndexingBridge {
	/** Runs one analysis of `roots`; resolves after its terminal event was sent. */
	analyze(runId: string, roots: readonly string[]): Promise<void>;
	cancel(runId: string): Promise<void>;
	onEvent(listener: (event: SmartIndexingEvent) => void): () => void;
}
