/**
 * What the Finder's persistent surfaces show for the record the main process
 * keeps (`window.autorag.indexProblem`): the sidebar block, the banner above the
 * file list, and the Settings > indexing card. Pure, so the three surfaces can
 * never disagree.
 *
 * The copy is the one agreed in `docs/prototypes/onboarding-failure` (the in-app
 * mock's `app` field): one short line per row. A failure always outranks the
 * skipped count, because the failure is why those files were left out.
 */

import type { TFunction } from "i18next";
import type { IndexFailure, IndexFailureReason } from "../../../shared/index-failure";
import { hasIndexProblem, type IndexProblem } from "../../../shared/index-problem-contract";
import { basename } from "./paths";

/** The two things a surface can do about a problem. */
export type IndexProblemActionKind = "retry" | "fixEmbedding";

export interface IndexProblemAction {
	readonly kind: IndexProblemActionKind;
	/** Already translated: the surfaces render it as the button's text. */
	readonly label: string;
}

export interface IndexProblemView {
	/** True while a retry started from a surface runs: one running line, no actions. */
	readonly retrying: boolean;
	/** The sidebar block's tone: a problem is the same error wash as a failed run. */
	readonly tone: "run" | "error";
	/** The banner's one line. */
	readonly title: string;
	/** The sidebar block's headline; shorter than the banner title, the column is fixed width. */
	readonly sideTitle: string;
	/** The sidebar block's second line; `null` while a retry runs. */
	readonly sideDetail: string | null;
	/** The Settings card's headline. */
	readonly cardTitle: string;
	/** The Settings card's tone: a finished run that left files out is not a failure. */
	readonly cardTone: "run" | "ok" | "error";
	/** The Settings card's one row: what it is about, and what it says. */
	readonly itemTitle: string;
	readonly itemDetail: string;
	/** The unreadable folder's name, for the row's tooltip; `null` for every other problem. */
	readonly folderName: string | null;
	/** The accent action; `null` while a retry runs. */
	readonly primary: IndexProblemAction | null;
	/** The quieter second action, `null` when the problem offers no alternative. */
	readonly secondary: IndexProblemAction | null;
}

/** The reasons that speak through a copy block; `folder-unreadable` names its own folder instead. */
type ReasonWithCopy = Exclude<IndexFailureReason, "folder-unreadable">;
type CopyKey =
	| "indexProblem.embedderConfig"
	| "indexProblem.embedderOffline"
	| "indexProblem.modelDownload"
	| "indexProblem.diskFull"
	| "indexProblem.unknown";

const COPY_KEY: Readonly<Record<ReasonWithCopy, CopyKey>> = {
	"embedder-config": "indexProblem.embedderConfig",
	"embedder-offline": "indexProblem.embedderOffline",
	"model-download": "indexProblem.modelDownload",
	"disk-full": "indexProblem.diskFull",
	unknown: "indexProblem.unknown",
};

/**
 * What the retry says: it resumes a download, rechecks a folder, or simply tries
 * the run again. `common.retry` already carries that last wording in every
 * language, so only the specific ones are this namespace's.
 */
type RetryKey = "common.retry" | "indexProblem.action.retryNow" | "indexProblem.action.resume" | "indexProblem.action.recheck";

const RETRY_KEY: Readonly<Record<IndexFailureReason, RetryKey>> = {
	"embedder-config": "common.retry",
	"embedder-offline": "indexProblem.action.retryNow",
	"model-download": "indexProblem.action.resume",
	"disk-full": "indexProblem.action.resume",
	"folder-unreadable": "indexProblem.action.recheck",
	unknown: "common.retry",
};

interface ActionPlan {
	readonly primary: IndexProblemActionKind;
	readonly secondary: IndexProblemActionKind | null;
}

/** Only a refused embedder leads with its setting; the rest retry first and keep the setting as the alternative. */
const PLAN: Readonly<Record<IndexFailureReason, ActionPlan>> = {
	"embedder-config": { primary: "fixEmbedding", secondary: "retry" },
	"embedder-offline": { primary: "retry", secondary: null },
	"model-download": { primary: "retry", secondary: "fixEmbedding" },
	"disk-full": { primary: "retry", secondary: "fixEmbedding" },
	"folder-unreadable": { primary: "retry", secondary: null },
	unknown: { primary: "retry", secondary: "fixEmbedding" },
};

function action(kind: IndexProblemActionKind, retryKey: RetryKey, t: TFunction): IndexProblemAction {
	return kind === "fixEmbedding" ? { kind, label: t("indexProblem.fixEmbedding") } : { kind, label: t(retryKey) };
}

/** The one row that says which folder cannot be read: its name, or how many there are. */
function folderRow(folders: readonly string[], t: TFunction): { readonly title: string; readonly detail: string; readonly name: string | null } {
	const [first] = folders;
	if (first !== undefined && folders.length > 1) {
		return { title: t("indexProblem.folderUnreadable.titleMany", { count: folders.length }), detail: t("indexProblem.folderUnreadable.sideDetailMany", { count: folders.length }), name: null };
	}
	if (first === undefined) return { title: t("indexProblem.folderUnreadable.side"), detail: t("indexProblem.folderUnreadable.side"), name: null };
	const name = basename(first);
	return { title: t("indexProblem.folderUnreadable.title", { folder: name }), detail: name, name };
}

function failureView(failure: IndexFailure, t: TFunction): IndexProblemView {
	const { reason } = failure;
	const plan = PLAN[reason];
	const retryKey = RETRY_KEY[reason];
	if (reason === "folder-unreadable") {
		const row = folderRow(failure.folders, t);
		return {
			retrying: false,
			tone: "error",
			title: row.title,
			sideTitle: t("indexProblem.folderUnreadable.side"),
			sideDetail: row.detail,
			cardTitle: t("indexProblem.card.failed"),
			cardTone: "error",
			itemTitle: t("indexProblem.item.folder"),
			itemDetail: row.detail,
			folderName: row.name,
			primary: action(plan.primary, retryKey, t),
			secondary: plan.secondary === null ? null : action(plan.secondary, retryKey, t),
		};
	}
	const copy = COPY_KEY[reason];
	return {
		retrying: false,
		tone: "error",
		title: t(`${copy}.title`),
		sideTitle: t(`${copy}.side`),
		sideDetail: t(`${copy}.sideDetail`),
		cardTitle: t("indexProblem.card.failed"),
		cardTone: "error",
		itemTitle: t("indexProblem.item.embedding"),
		itemDetail: t(`${copy}.detail`),
		folderName: null,
		primary: action(plan.primary, retryKey, t),
		secondary: plan.secondary === null ? null : action(plan.secondary, retryKey, t),
	};
}

/** A run that finished with files left out: nothing is broken, and the next refresh tries them again. */
function skippedView(skipped: number, t: TFunction): IndexProblemView {
	return {
		retrying: false,
		tone: "error",
		title: t("indexProblem.skipped.title", { count: skipped }),
		sideTitle: t("indexProblem.skipped.side", { count: skipped }),
		sideDetail: t("indexProblem.skipped.sideDetail"),
		cardTitle: t("indexActivity.done"),
		cardTone: "ok",
		itemTitle: t("indexProblem.item.skipped"),
		itemDetail: t("indexProblem.skipped.row", { count: skipped }),
		folderName: null,
		primary: { kind: "retry", label: t("indexProblem.action.retryNow") },
		secondary: null,
	};
}

/**
 * The problem as the surfaces show it, or `null` when there is nothing to show.
 * While a retry runs the problem's own line is replaced by the running one and
 * every action disappears: the run in flight is the answer to them.
 */
export function describeIndexProblem(problem: IndexProblem, t: TFunction): IndexProblemView | null {
	if (!hasIndexProblem(problem)) return null;
	const view = problem.failure === null ? skippedView(problem.skipped, t) : failureView(problem.failure, t);
	if (!problem.retrying) return view;
	const retrying = t("indexProblem.retrying");
	return {
		...view,
		retrying: true,
		tone: "run",
		title: retrying,
		sideTitle: retrying,
		sideDetail: null,
		cardTitle: retrying,
		cardTone: "run",
		primary: null,
		secondary: null,
	};
}
