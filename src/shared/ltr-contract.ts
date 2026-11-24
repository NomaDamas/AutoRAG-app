/**
 * Learning to rank: the librarian logs every search's candidates and outcome (`rankingLog`, on by default), can fit a
 * ranking model on that log, and, only when the `ltr` config block says so, reorders the reranker's results with it.
 *
 * The settings (`rankingLog`, `ltr.enabled`, `ltr.model`, `ltr.autoTrain`) live in the shared AutoRAG config and are
 * written through the config bridge like every other setting. This bridge carries what the config cannot say: how many
 * searches are logged, which models exist and how they scored, whether the next search would use one, and the two
 * actions that are not settings (fit a model now, delete one). The librarian owns the files and the numbers; the app
 * reads them through its CLI (`autorag ltr ... --json`).
 */

export const LTR_CHANNELS = {
	get: "ltr:get",
	train: "ltr:train",
	deleteModel: "ltr:deleteModel",
	training: "ltr:training",
} as const;

/** What a search would do with the model right now, as the librarian's `autorag ltr status` reports it. */
export type LtrServing =
	| { readonly status: "disabled" }
	| { readonly status: "active"; readonly modelId: string }
	| { readonly status: "no-model"; readonly reason: string }
	| { readonly status: "unusable"; readonly modelId: string; readonly reason: string };

/** How a model scored on the newest searches it never saw, against the order it would replace. */
export interface LtrHoldout {
	/** Searches in the held-out set. */
	readonly queries: number;
	readonly baseline: { readonly ndcg10: number; readonly mrr: number };
	readonly model: { readonly ndcg10: number; readonly mrr: number };
	/** 95% bootstrap interval of the per-search MRR difference (model minus baseline). */
	readonly deltaMrrCi95: readonly [number, number];
}

export interface LtrModel {
	readonly id: string;
	/** Epoch milliseconds. */
	readonly createdAt: number;
	/** Labelled searches the model was fitted on. */
	readonly trainedOnRuns: number;
	/** Searches in the log when training started. */
	readonly loggedRunsAtTraining: number;
	readonly holdout: LtrHoldout;
	/** True when the model beat the reranker's order on the holdout; only these are picked by `latest`. */
	readonly passedGate: boolean;
	readonly seeds?: number;
}

export interface LtrSnapshot {
	/** `ltr.enabled` in the config. */
	readonly enabled: boolean;
	/** The configured model: an id or `latest`. */
	readonly selection: string;
	readonly serving: LtrServing;
	/** Searches in the ranking log. */
	readonly loggedRuns: number;
	/** Every readable model, newest first. */
	readonly models: readonly LtrModel[];
	/** The last training attempt, so a rejected or failed one is visible. */
	readonly lastAttempt: { readonly runs: number; readonly at: number | null; readonly result: string | null } | null;
	readonly autoTrain: { readonly enabled: boolean; readonly minNewRuns: number; readonly due: boolean };
	/** Labelled searches needed before a model can be fitted. */
	readonly minTrainingRuns: number;
	/** A training run is going right now (a click, or automatic training after a search). */
	readonly training: boolean;
}

export type LtrTrainStatus = "trained" | "rejected" | "insufficient-data" | "failed";

export interface LtrTrainOutcome {
	readonly status: LtrTrainStatus;
	/** Why the attempt did not produce a passing model; absent when it trained one. */
	readonly reason: string | null;
	/** The model that was stored (`trained`, or `rejected` with its scores). */
	readonly model: LtrModel | null;
	/** Searches that were usable for training when the attempt started. */
	readonly eligibleRuns: number;
	readonly loggedRuns: number;
	/** The snapshot after the attempt, so the page needs no second call. */
	readonly snapshot: LtrSnapshot;
}

export interface LtrBridge {
	get(): Promise<LtrSnapshot>;
	/** Fit a model on the ranking log now. Resolves with the verdict, including a rejected or failed attempt. */
	train(): Promise<LtrTrainOutcome>;
	/** Delete a stored model. Refused for the model the config pins. */
	deleteModel(id: string): Promise<LtrSnapshot>;
	/** Pushed when a training run starts (`true`) and ends (`false`), whoever started it: a click or automatic training. */
	onTraining(listener: (running: boolean) => void): () => void;
}

/** The ids the librarian accepts for a stored model (its `MODEL_ID_PATTERN`); anything else never reaches a command line. */
export const LTR_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export const EMPTY_LTR_SNAPSHOT: LtrSnapshot = {
	enabled: false,
	selection: "latest",
	serving: { status: "disabled" },
	loggedRuns: 0,
	models: [],
	lastAttempt: null,
	autoTrain: { enabled: false, minNewRuns: 200, due: false },
	minTrainingRuns: 100,
	training: false,
};
