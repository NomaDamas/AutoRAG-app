import { cliFailureReason, LibrarianCliMissingError, type AutomationCliResult } from "./automation-service";
import {
	EMPTY_LTR_SNAPSHOT,
	LTR_MODEL_ID_PATTERN,
	type LtrHoldout,
	type LtrModel,
	type LtrServing,
	type LtrSnapshot,
	type LtrTrainOutcome,
	type LtrTrainStatus,
} from "../shared/ltr-contract";
import { isJsonObject } from "../shared/settings-contract";
import { t } from "../shared/i18n/core";

/**
 * Learning to rank, as the app sees it. The librarian owns the ranking log, the models and the numbers; none of that is
 * part of its package exports, so the app goes through `autorag ltr ... --json`. That also keeps training out of the
 * app's own process: fitting a model is a few seconds of unbroken CPU work, and in the Electron main process it would
 * freeze the window for as long.
 */

/**
 * Searches the log needs before a model can be fitted. Matches the librarian's `MIN_TRAINING_RUNS`
 * (raised to 300 in librarian v2.15 / AutoRAG#2224); `status` does not report it, so the window's
 * progress bar reads it here. The reason a training attempt returns is the librarian's own sentence
 * and always has the last word.
 */
export const MIN_TRAINING_RUNS = 300;

/** Fitting a model on a large log is far slower than reading a status, so it gets a leash of its own. */
const TRAIN_TIMEOUT_MS = 10 * 60_000;

export interface LtrCliOptions {
	readonly timeoutMs?: number;
}

export interface LtrServiceDeps {
	/** Runs `autorag <args>` and never rejects for a command that started; may reject when the CLI is not installed. */
	readonly run: (args: readonly string[], options?: LtrCliOptions) => Promise<AutomationCliResult>;
	/** Whether a rejection from `run` means the librarian CLI is not on disk. */
	readonly isMissing?: (error: unknown) => boolean;
	/** Called with `true` when a training run starts and `false` when it ends, whoever asked for it. */
	readonly onTraining?: (running: boolean) => void;
}

export interface LtrService {
	get(): Promise<LtrSnapshot>;
	/** Fit a model now. Overlapping callers share one run. */
	train(): Promise<LtrTrainOutcome>;
	deleteModel(id: string): Promise<LtrSnapshot>;
	/** Train when the config asks for automatic training and enough searches were logged since the last attempt. Never throws. */
	autoTrainIfDue(): Promise<LtrTrainOutcome | null>;
}

const SERVING_STATUSES = new Set(["disabled", "active", "no-model", "unusable"]);
const TRAIN_STATUSES = new Set<string>(["trained", "rejected", "insufficient-data", "failed"] satisfies LtrTrainStatus[]);

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

function numberPair(value: unknown): readonly [number, number] | null {
	if (!Array.isArray(value) || value.length !== 2) return null;
	const [low, high] = value as unknown[];
	return typeof low === "number" && typeof high === "number" ? [low, high] : null;
}

function scores(value: unknown): { readonly ndcg10: number; readonly mrr: number } | null {
	if (!isJsonObject(value) || typeof value.ndcg10 !== "number" || typeof value.mrr !== "number") return null;
	return { ndcg10: value.ndcg10, mrr: value.mrr };
}

function holdoutOf(value: unknown): LtrHoldout | null {
	if (!isJsonObject(value) || typeof value.queries !== "number") return null;
	const baseline = scores(value.baseline);
	const model = scores(value.model);
	const interval = numberPair(value.deltaMrrCi95);
	if (baseline === null || model === null || interval === null) return null;
	const ndcgInterval = numberPair(value.deltaNdcg10Ci95);
	return {
		queries: value.queries,
		baseline,
		model,
		deltaMrrCi95: interval,
		...(ndcgInterval === null ? {} : { deltaNdcg10Ci95: ndcgInterval }),
	};
}

/** A model the window can show; null for an entry the librarian wrote in a shape this app does not know. */
function modelOf(value: unknown): LtrModel | null {
	if (!isJsonObject(value) || typeof value.id !== "string" || typeof value.createdAt !== "number") return null;
	const holdout = holdoutOf(value.holdout);
	if (holdout === null || typeof value.trainedOnRuns !== "number" || typeof value.loggedRunsAtTraining !== "number") return null;
	return {
		id: value.id,
		createdAt: value.createdAt,
		trainedOnRuns: value.trainedOnRuns,
		loggedRunsAtTraining: value.loggedRunsAtTraining,
		holdout,
		// A model with no verdict is not one `latest` may pick, so it shows as not passed.
		passedGate: value.passedGate === true,
		...(typeof value.seeds === "number" ? { seeds: value.seeds } : {}),
	};
}

function servingOf(value: unknown): LtrServing | null {
	if (!isJsonObject(value) || typeof value.status !== "string" || !SERVING_STATUSES.has(value.status)) return null;
	switch (value.status) {
		case "disabled":
			return { status: "disabled" };
		case "active":
			return typeof value.modelId === "string" ? { status: "active", modelId: value.modelId } : null;
		case "no-model":
			return typeof value.reason === "string" ? { status: "no-model", reason: value.reason } : null;
		default:
			return typeof value.modelId === "string" && typeof value.reason === "string" ? { status: "unusable", modelId: value.modelId, reason: value.reason } : null;
	}
}

function snapshotOf(value: unknown): LtrSnapshot | null {
	if (!isJsonObject(value)) return null;
	const serving = servingOf(value.serving);
	const auto = value.autoTrain;
	if (
		typeof value.enabled !== "boolean" ||
		typeof value.selection !== "string" ||
		serving === null ||
		typeof value.loggedRuns !== "number" ||
		!Array.isArray(value.models) ||
		!isJsonObject(auto) ||
		typeof auto.enabled !== "boolean" ||
		typeof auto.minNewRuns !== "number" ||
		typeof auto.due !== "boolean"
	) {
		return null;
	}
	const state = isJsonObject(value.state) ? value.state : {};
	const attempted = typeof state.lastAttemptRuns === "number" || typeof state.lastAttemptAt === "number";
	return {
		enabled: value.enabled,
		selection: value.selection,
		serving,
		loggedRuns: value.loggedRuns,
		models: value.models.map(modelOf).filter((model): model is LtrModel => model !== null),
		lastAttempt: attempted
			? {
					runs: typeof state.lastAttemptRuns === "number" ? state.lastAttemptRuns : 0,
					at: typeof state.lastAttemptAt === "number" ? state.lastAttemptAt : null,
					result: typeof state.lastAttemptResult === "string" ? state.lastAttemptResult : null,
				}
			: null,
		autoTrain: { enabled: auto.enabled, minNewRuns: auto.minNewRuns, due: auto.due },
		minTrainingRuns: MIN_TRAINING_RUNS,
		training: false,
	};
}

/** The librarian's own words for a failed command: its `{ok:false,error}` envelope when it printed one, else the exit and output. */
function failureText(result: AutomationCliResult): string {
	for (const text of [result.stderr, result.stdout]) {
		const parsed = parseJson(text.trim());
		if (isJsonObject(parsed) && typeof parsed.error === "string" && parsed.error.length > 0) return parsed.error;
	}
	return cliFailureReason(result);
}

export function createLtrService(deps: LtrServiceDeps): LtrService {
	const isMissing = deps.isMissing ?? ((error: unknown): boolean => error instanceof LibrarianCliMissingError);
	let inflight: Promise<LtrTrainOutcome> | null = null;

	async function readSnapshot(): Promise<LtrSnapshot> {
		const result = await deps.run(["ltr", "status", "--json"]);
		if (result.code !== 0) throw new Error(failureText(result));
		const snapshot = snapshotOf(parseJson(result.stdout));
		if (snapshot === null) throw new Error(t("main.errors.ltr.statusUnreadable"));
		return { ...snapshot, training: inflight !== null };
	}

	async function fitModel(): Promise<LtrTrainOutcome> {
		const result = await deps.run(["ltr", "train", "--json"], { timeoutMs: TRAIN_TIMEOUT_MS });
		// A rejected or too-small attempt exits 1 and still prints its verdict: the verdict is the answer, not an error.
		const verdict = parseJson(result.stdout.trim());
		if (!isJsonObject(verdict) || typeof verdict.status !== "string" || !TRAIN_STATUSES.has(verdict.status)) {
			throw new Error(failureText(result));
		}
		// The run is finishing: the snapshot that comes back with its verdict must not say it is still going.
		const snapshot: LtrSnapshot = { ...(await readSnapshot()), training: false };
		return {
			status: verdict.status as LtrTrainStatus,
			reason: typeof verdict.reason === "string" ? verdict.reason : null,
			model: modelOf(verdict.model),
			eligibleRuns: typeof verdict.eligibleRuns === "number" ? verdict.eligibleRuns : 0,
			loggedRuns: typeof verdict.loggedRuns === "number" ? verdict.loggedRuns : snapshot.loggedRuns,
			snapshot,
		};
	}

	function train(): Promise<LtrTrainOutcome> {
		if (inflight !== null) return inflight;
		deps.onTraining?.(true);
		const run = fitModel().finally(() => {
			inflight = null;
			deps.onTraining?.(false);
		});
		inflight = run;
		return run;
	}

	return {
		async get() {
			try {
				return await readSnapshot();
			} catch (error) {
				if (isMissing(error)) return EMPTY_LTR_SNAPSHOT;
				throw error;
			}
		},
		train,
		async deleteModel(id) {
			if (!LTR_MODEL_ID_PATTERN.test(id)) throw new Error(`invalid model id: ${JSON.stringify(id)}`);
			const result = await deps.run(["ltr", "delete", id, "--json"]);
			if (result.code !== 0) throw new Error(failureText(result));
			return readSnapshot();
		},
		async autoTrainIfDue() {
			// One attempt at a time: a run already going (a click, or an earlier search) is the one that counts.
			if (inflight !== null) return null;
			try {
				const snapshot = await readSnapshot();
				if (!snapshot.autoTrain.enabled || !snapshot.autoTrain.due || inflight !== null) return null;
				return await train();
			} catch {
				// The librarian records a failed attempt in its own state; a search that finished must not fail because of it.
				return null;
			}
		},
	};
}

/**
 * The agent's options without automatic training. The librarian's agent retrains inside its own process once the log has
 * grown; in the app that process is the Electron main process, which a few seconds of unbroken CPU work would freeze.
 * The app trains through {@link LtrService.autoTrainIfDue} instead, in a child process, and reads the same `ltr.autoTrain`
 * setting to decide when.
 */
export function withoutAgentAutoTrain<T extends object>(options: T): T {
	const ltr = (options as { readonly ltr?: Readonly<Record<string, unknown>> }).ltr;
	if (ltr === undefined || !("autoTrain" in ltr)) return options;
	const { autoTrain: _autoTrain, ...rest } = ltr;
	return { ...options, ltr: rest } as T;
}
