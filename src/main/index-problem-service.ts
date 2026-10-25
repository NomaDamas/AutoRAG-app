import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isIndexFailureReason, type IndexFailure } from "../shared/index-failure";
import { NO_INDEX_PROBLEM, type IndexProblem } from "../shared/index-problem-contract";
import { isJsonObject, type ConfigRefreshDiagnostic } from "../shared/settings-contract";
import { classifyIndexFailure, skippedFileCount } from "./index-failure";

/**
 * The durable half of a failed or partial index run: what the Finder surfaces
 * (sidebar block, banner, Settings card) show after onboarding is over. The
 * onboarding screen reads the run's own status; this keeps the same fact across
 * a relaunch until a run leaves the index working or the user dismisses it.
 */

/** What every caller knows about a finished run: the shape of `ConfigRefreshResult` that matters here. */
export interface RunOutcome {
	readonly ok: boolean;
	readonly error: string | null;
	readonly diagnostics: readonly ConfigRefreshDiagnostic[];
}

export interface IndexProblemDeps {
	/** The JSON file the problem is kept in (`<userData>/index-problem.json`). */
	readonly filePath: string;
	readonly send: (problem: IndexProblem) => void;
	/** The retry: download the on-device model when missing, then run the local index. `null` when another index run holds the lock, so nothing was learned. */
	readonly run: () => Promise<RunOutcome | null>;
	readonly now?: () => number;
}

export interface IndexProblemService {
	get(): IndexProblem;
	/** A run ended: a failure replaces the problem, a success clears it (keeping only what it left out). */
	record(outcome: RunOutcome): void;
	/** A run the app did not read the diagnostics of succeeded: the failure is over, what was skipped is not known to be. */
	clearFailure(): void;
	dismiss(): void;
	/** Runs `deps.run` once however many callers ask; resolves when it ends, never rejects. */
	retry(): Promise<void>;
	/** Resolves when every change so far is on disk. */
	flush(): Promise<void>;
}

type Persisted = Omit<IndexProblem, "retrying">;

function isIndexFailure(value: unknown): value is IndexFailure {
	return (
		isJsonObject(value) &&
		isIndexFailureReason(value.reason) &&
		Array.isArray(value.folders) &&
		value.folders.every((folder) => typeof folder === "string") &&
		(value.code === null || typeof value.code === "string")
	);
}

function readPersisted(filePath: string): Persisted {
	try {
		const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
		if (!isJsonObject(parsed)) return NO_INDEX_PROBLEM;
		const failure = parsed.failure === null ? null : isIndexFailure(parsed.failure) ? parsed.failure : undefined;
		const skipped = parsed.skipped;
		if (failure === undefined || typeof skipped !== "number" || !Number.isInteger(skipped) || skipped < 0) return NO_INDEX_PROBLEM;
		if (parsed.at !== null && typeof parsed.at !== "string") return NO_INDEX_PROBLEM;
		return failure === null && skipped === 0 ? NO_INDEX_PROBLEM : { failure, skipped, at: parsed.at };
	} catch {
		return NO_INDEX_PROBLEM;
	}
}

export function createIndexProblemService(deps: IndexProblemDeps): IndexProblemService {
	const now = deps.now ?? Date.now;
	let current: IndexProblem = { ...readPersisted(deps.filePath), retrying: false };
	let running: Promise<void> | null = null;
	let writes: Promise<void> = Promise.resolve();

	const persist = (): void => {
		const body: Persisted = { failure: current.failure, skipped: current.skipped, at: current.at };
		const write = async (): Promise<void> => {
			await mkdir(dirname(deps.filePath), { recursive: true });
			await writeFile(deps.filePath, `${JSON.stringify(body)}\n`, "utf8");
		};
		// A write that fails (folder removed, disk full) must not become an unhandled rejection; the in-memory state is still right.
		writes = writes.then(write, write).catch((error: unknown) => console.warn("[index-problem] could not save:", error));
	};

	const set = (next: IndexProblem): void => {
		if (next.failure === current.failure && next.skipped === current.skipped && next.at === current.at && next.retrying === current.retrying) return;
		const saved = next.failure !== current.failure || next.skipped !== current.skipped || next.at !== current.at;
		current = next;
		if (saved) persist();
		deps.send(current);
	};

	const outcomeToProblem = (outcome: RunOutcome): Persisted => {
		if (!outcome.ok) {
			const failure = classifyIndexFailure(outcome);
			// The cause stays in the log; the screens only show what the app could tell apart.
			console.warn(`[index-problem] the index run stopped (${failure.reason}${failure.code === null ? "" : `, ${failure.code}`}):`, outcome.error);
			return { failure, skipped: skippedFileCount(outcome.diagnostics), at: new Date(now()).toISOString() };
		}
		const skipped = skippedFileCount(outcome.diagnostics);
		return skipped === 0 ? NO_INDEX_PROBLEM : { failure: null, skipped, at: new Date(now()).toISOString() };
	};

	return {
		get: () => current,
		record: (outcome) => set({ ...outcomeToProblem(outcome), retrying: current.retrying }),
		clearFailure: () => {
			if (current.failure === null) return;
			set(current.skipped === 0 ? { ...NO_INDEX_PROBLEM, retrying: current.retrying } : { ...current, failure: null });
		},
		dismiss: () => set({ ...NO_INDEX_PROBLEM, retrying: current.retrying }),
		retry: () => {
			if (running !== null) return running;
			set({ ...current, retrying: true });
			running = (async (): Promise<void> => {
				let outcome: RunOutcome | null;
				try {
					outcome = await deps.run();
				} catch (error) {
					outcome = { ok: false, error: error instanceof Error ? error.message : String(error), diagnostics: [] };
				}
				set({ ...(outcome === null ? current : outcomeToProblem(outcome)), retrying: false });
			})().finally(() => {
				running = null;
			});
			return running;
		},
		flush: () => writes,
	};
}
