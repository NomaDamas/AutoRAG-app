/**
 * Smart indexing: during the first run, before the first index, an AI reads the
 * default folders and proposes the sub-folders that are not worth indexing
 * (system data, logs, code, recordings, caches). Every proposal is taken: the
 * paths go straight into the shared config's `excludePaths`.
 *
 * There is no renderer IPC any more — the first-run service in the main process
 * drives the run itself (`src/main/first-run-service.ts`). It runs the analysis
 * on a read-only pi agent session (`src/main/agents/`) and consumes these event
 * types; the service's own `send` callback carries them.
 */

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
	/** True leaves the folder out of the index. Proposals start excluded. */
	readonly excluded: boolean;
}

export type SmartIndexingEvent =
	/** Live phrase written by the agent before calling a tool. */
	| { readonly type: "progress"; readonly runId: string; readonly text: string }
	/** The agent is looking at `path` (a folder or file under a root). */
	| { readonly type: "exploring"; readonly runId: string; readonly path: string }
	| { readonly type: "result"; readonly runId: string; readonly exclusions: readonly SmartExclusion[] }
	/** The run could not finish (no model signed in or connected, a provider error, ...). */
	| { readonly type: "error"; readonly runId: string; readonly message: string }
	| { readonly type: "cancelled"; readonly runId: string };
