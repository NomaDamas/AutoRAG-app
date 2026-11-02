import type { TFunction } from "i18next";
import type { IndexActivitySnapshot } from "../../../shared/index-activity-contract";
import type { IndexProblem } from "../../../shared/index-problem-contract";
import type { ModelDownloadStatus } from "../../../shared/model-download-contract";
import { formatByteSize } from "../../../shared/size-reduction";
import type { BackgroundTaskItem } from "../hooks/useBackgroundTasks";
import { describeSidebarErrorFixEntries, type ErrorFixStore } from "./error-fix";
import { describeIndexActivity, itemName, itemPhaseText } from "./index-activity";
import { describeIndexProblem } from "./index-problem";
import { downloadPercent } from "./model-download";

export type SidebarActivityTone = "run" | "queued" | "ok" | "error";

export interface SidebarActivityEntry {
	readonly id: string;
	readonly tone: SidebarActivityTone;
	readonly percent: number | null;
	readonly headline: string;
	readonly detail: string | null;
	readonly ariaLabel: string;
	readonly title: string;
	readonly className?: string | undefined;
	readonly sparkle?: boolean | undefined;
	readonly shimmerDetail?: boolean | undefined;
	readonly onSelect?: (() => void) | undefined;
}

export interface CollectSidebarActivitiesInput {
	readonly indexActivity: IndexActivitySnapshot;
	readonly indexProblem: IndexProblem;
	readonly errorFix: ErrorFixStore;
	readonly backgroundTasks: readonly BackgroundTaskItem[];
	readonly modelDownload: ModelDownloadStatus;
	readonly t: TFunction;
	readonly onOpenIndexing: () => void;
	readonly onOpenErrorFix: (id: string) => void;
	readonly onOpenAiSettings?: (() => void) | undefined;
}

const TONE_PRIORITY: Readonly<Record<SidebarActivityTone, number>> = {
	run: 0,
	queued: 1,
	error: 2,
	ok: 3,
};

function indexEntries(
	snapshot: IndexActivitySnapshot,
	t: TFunction,
	onOpenIndexing: () => void,
): readonly SidebarActivityEntry[] {
	if (snapshot.state === "idle") return [];
	const origin =
		snapshot.origin === "scheduled" || snapshot.origin === "external"
			? t(`indexActivity.origin.${snapshot.origin}`)
			: null;
	const ariaLabel = t("indexActivity.open");
	const title = origin === null ? ariaLabel : `${origin} — ${ariaLabel}`;

	if (snapshot.state === "running" && snapshot.items.length > 1) {
		const finishedCount = snapshot.items.filter((item) => item.state === "done" || item.state === "failed").length;
		const localPartialPercent =
			snapshot.fraction === null
				? null
				: Math.min(99, Math.max(0, Math.floor((snapshot.fraction * snapshot.items.length - finishedCount) * 100)));

		const multi: SidebarActivityEntry[] = [];
		for (const item of snapshot.items) {
			if (item.state === "done") continue;
			const name = itemName(item, t);
			if (item.state === "running") {
				const phase = itemPhaseText(item, t);
				const detail =
					item.kind === "local"
						? [name, phase].filter((part): part is string => part !== null).join(" · ")
						: t("indexActivity.syncing", { name });
				multi.push({
					id: `index:${item.key}`,
					tone: "run",
					percent: item.kind === "local" ? localPartialPercent : null,
					headline: item.kind === "local" ? t("indexActivity.running") : name,
					detail: detail || null,
					ariaLabel,
					title,
					onSelect: onOpenIndexing,
				});
			} else if (item.state === "queued") {
				multi.push({
					id: `index:${item.key}`,
					tone: "queued",
					percent: 0,
					headline: name,
					detail: null,
					ariaLabel,
					title,
					onSelect: onOpenIndexing,
				});
			} else if (item.state === "failed") {
				multi.push({
					id: `index:${item.key}`,
					tone: "error",
					percent: 100,
					headline: `${t("indexActivity.failed")} · ${name}`,
					detail: item.error,
					ariaLabel,
					title,
					onSelect: onOpenIndexing,
				});
			}
		}
		if (multi.length > 0) return multi;
	}

	const view = describeIndexActivity(snapshot, t);
	if (view === null) return [];
	return [
		{
			id: `index:${snapshot.state}`,
			tone: view.tone,
			percent: view.percent,
			headline: view.headline,
			detail: view.detail,
			ariaLabel,
			title,
			onSelect: onOpenIndexing,
		},
	];
}

function backgroundTaskEntry(task: BackgroundTaskItem, t: TFunction): SidebarActivityEntry {
	const ariaLabel = task.ariaLabel ?? task.headline;
	if (task.state === "queued") {
		return {
			id: `task:${task.id}`,
			tone: "queued",
			percent: 0,
			headline: task.queuedHeadline ?? task.headline,
			detail: task.detail ?? t("indexActivity.queued"),
			ariaLabel,
			title: ariaLabel,
			onSelect: task.onSelect,
		};
	}
	if (task.state === "running") {
		return {
			id: `task:${task.id}`,
			tone: "run",
			percent: task.percent,
			headline: task.headline,
			detail: task.detail,
			ariaLabel,
			title: ariaLabel,
			onSelect: task.onSelect,
		};
	}
	if (task.state === "done") {
		return {
			id: `task:${task.id}`,
			tone: "ok",
			percent: 100,
			headline: task.doneHeadline,
			detail: task.detail,
			ariaLabel,
			title: ariaLabel,
			onSelect: task.onSelect,
		};
	}
	return {
		id: `task:${task.id}`,
		tone: "error",
		percent: 100,
		headline: task.failedHeadline,
		detail: task.error ?? task.detail,
		ariaLabel,
		title: ariaLabel,
		onSelect: task.onSelect,
	};
}

/**
 * Pure aggregator for the unified bottom-left sidebar queue: gathers every
 * active, queued, and recently settled task across Indexing, Datasource Sync,
 * Index Problems, AI Error Fixes, Background File Tasks, and Model Downloads
 * without letting any producer overwrite another.
 */
export function collectSidebarActivities(input: CollectSidebarActivitiesInput): readonly SidebarActivityEntry[] {
	const { t } = input;
	const raw: SidebarActivityEntry[] = [];

	// 1. AI Error Fix sessions (running, queued, or finished in background awaiting review)
	const fixAria = t("appError.fix.sidebar.open");
	for (const entry of describeSidebarErrorFixEntries(input.errorFix, t)) {
		raw.push({
			id: `error-fix:${entry.id}`,
			tone: entry.tone,
			percent: entry.percent,
			headline: entry.headline,
			detail: entry.detail,
			ariaLabel: fixAria,
			title: fixAria,
			className: "sidebar__error-fix",
			sparkle: true,
			shimmerDetail: entry.tone === "run",
			onSelect: () => input.onOpenErrorFix(entry.id),
		});
	}

	// 2. Indexing & datasource sync items
	raw.push(...indexEntries(input.indexActivity, t, input.onOpenIndexing));

	// 3. Persistent local index problem: suppressed ONLY while a local refresh is actively running/queued to answer it,
	//    or while the just-finished failed snapshot already carries the failure echo for a single local run.
	const problem = describeIndexProblem(input.indexProblem, t);
	if (problem !== null) {
		const localAnswering =
			input.indexActivity.state === "running" &&
			(input.indexActivity.items.length === 0 ||
				input.indexActivity.items.some((item) => item.kind === "local" && (item.state === "running" || item.state === "queued")));
		const localEchoingSameFailure =
			input.indexActivity.state === "failed" &&
			input.indexActivity.items.some((item) => item.kind === "local" && item.state === "failed");
		if (!localAnswering && !localEchoingSameFailure) {
			const openLabel = t("indexActivity.open");
			raw.push({
				id: "index-problem",
				tone: problem.tone,
				percent: problem.retrying ? null : 100,
				headline: problem.sideTitle,
				detail: problem.sideDetail,
				ariaLabel: openLabel,
				title: openLabel,
				onSelect: input.onOpenIndexing,
			});
		}
	}

	// 4. Background file tasks (Reduce Size, Format Conversion, etc.)
	for (const task of input.backgroundTasks) {
		raw.push(backgroundTaskEntry(task, t));
	}

	// 5. On-device embedding model download (live progress when downloading in background)
	if (input.modelDownload.state === "downloading") {
		const percent = downloadPercent(input.modelDownload);
		const modelOpen = t("sidebarActivity.modelDownloadOpen");
		const amount =
			input.modelDownload.bytesTotal > 0
				? t("modelDownload.amount", {
						done: formatByteSize(input.modelDownload.bytesDone),
						total: formatByteSize(input.modelDownload.bytesTotal),
					})
				: null;
		raw.push({
			id: "model-download",
			tone: "run",
			percent,
			headline: t("modelDownload.title"),
			detail: amount,
			ariaLabel: modelOpen,
			title: modelOpen,
			onSelect: input.onOpenAiSettings,
		});
	}

	// Stable priority sort: actively running tasks always lead the collapsed view, then queued, then errors, then done.
	return raw
		.map((entry, order) => ({ entry, order }))
		.sort((a, b) => TONE_PRIORITY[a.entry.tone] - TONE_PRIORITY[b.entry.tone] || a.order - b.order)
		.map(({ entry }) => entry);
}
