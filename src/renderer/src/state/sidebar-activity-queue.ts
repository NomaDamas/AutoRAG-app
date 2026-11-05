import type { TFunction } from "i18next";
import type { IndexActivitySnapshot } from "../../../shared/index-activity-contract";
import type { IndexProblem } from "../../../shared/index-problem-contract";
import type { ModelDownloadStatus } from "../../../shared/model-download-contract";
import { formatByteSize } from "../../../shared/size-reduction";
import type { BackgroundTaskItem } from "../hooks/useBackgroundTasks";
import { describeSidebarErrorFixEntries, type ErrorFixStore } from "./error-fix";
import { describeIndexActivity, itemName, itemPhaseText, localProgressText } from "./index-activity";
import { describeIndexProblem } from "./index-problem";
import { describeSidebarMagicActionEntries, initialMagicActionStore, type MagicActionStore } from "./magic-action";
import { downloadPercent } from "./model-download";
export type SidebarActivityTone = "run" | "queued" | "ok" | "error";

export interface SidebarActivityEntry {
	readonly id: string;
	readonly tone: SidebarActivityTone;
	readonly percent: number | null;
	readonly headline: string;
	readonly ariaLabel: string;
	readonly title: string;
	readonly className?: string | undefined;
	readonly sparkle?: boolean | undefined;
	readonly shimmerHeadline?: boolean | undefined;
	readonly onSelect?: (() => void) | undefined;
}

function joinTooltip(parts: readonly (string | null | undefined)[]): string {
	return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" — ");
}

export interface CollectSidebarActivitiesInput {
	readonly indexActivity: IndexActivitySnapshot;
	readonly indexProblem: IndexProblem;
	readonly errorFix: ErrorFixStore;
	readonly magicAction?: MagicActionStore | undefined;
	readonly backgroundTasks: readonly BackgroundTaskItem[];
	readonly modelDownload: ModelDownloadStatus;
	readonly t: TFunction;
	readonly onOpenIndexing: () => void;
	readonly onOpenErrorFix: (id: string) => void;
	readonly onOpenMagicAction?: ((id: string) => void) | undefined;
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
				const phase = (item.kind === "local" ? localProgressText(snapshot, t) : null) ?? itemPhaseText(item, t);
				multi.push({
					id: `index:${item.key}`,
					tone: "run",
					percent: item.kind === "local" ? localPartialPercent : null,
					headline: name,
					ariaLabel,
					title: joinTooltip([origin, name, phase, ariaLabel]),
					onSelect: onOpenIndexing,
				});
			} else if (item.state === "queued") {
				multi.push({
					id: `index:${item.key}`,
					tone: "queued",
					percent: 0,
					headline: name,
					ariaLabel,
					title: joinTooltip([name, t("indexActivity.queued"), ariaLabel]),
					onSelect: onOpenIndexing,
				});
			} else if (item.state === "failed") {
				multi.push({
					id: `index:${item.key}`,
					tone: "error",
					percent: 100,
					headline: name,
					ariaLabel,
					title: joinTooltip([name, item.error, ariaLabel]),
					onSelect: onOpenIndexing,
				});
			}
		}
		if (multi.length > 0) return multi;
	}

	const view = describeIndexActivity(snapshot, t);
	if (view === null) return [];
	const loneSource = snapshot.state === "running" && snapshot.items.length === 1 && snapshot.items[0]?.kind === "source" ? snapshot.items[0] : undefined;
	const headline = loneSource === undefined ? view.headline : itemName(loneSource, t);
	return [
		{
			id: `index:${snapshot.state}`,
			tone: view.tone,
			percent: view.percent,
			headline,
			ariaLabel,
			title: joinTooltip([origin, view.detail, title]),
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
			ariaLabel,
			title: joinTooltip([task.detail, t("indexActivity.queued"), ariaLabel]),
			onSelect: task.onSelect,
		};
	}
	if (task.state === "running") {
		return {
			id: `task:${task.id}`,
			tone: "run",
			percent: task.percent,
			headline: task.headline,
			ariaLabel,
			title: joinTooltip([task.detail, ariaLabel]),
			onSelect: task.onSelect,
		};
	}
	if (task.state === "done") {
		return {
			id: `task:${task.id}`,
			tone: "ok",
			percent: 100,
			headline: task.doneHeadline,
			ariaLabel,
			title: joinTooltip([task.detail, ariaLabel]),
			onSelect: task.onSelect,
		};
	}
	return {
		id: `task:${task.id}`,
		tone: "error",
		percent: 100,
		headline: task.failedHeadline,
		ariaLabel,
		title: joinTooltip([task.error ?? task.detail, ariaLabel]),
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
	for (const session of input.errorFix.sessions) {
		const view = describeSidebarErrorFixEntries({ sessions: [session], activeId: input.errorFix.activeId }, t)[0];
		if (view === undefined) continue;
		const firstRunningIndex = input.errorFix.sessions.findIndex((entry) => entry.run.status === "running");
		const thisIndex = input.errorFix.sessions.indexOf(session);
		const isQueued = session.run.status === "running" && firstRunningIndex >= 0 && thisIndex > firstRunningIndex && session.run.progress === null;
		const liveText =
			isQueued
				? t("appError.fix.title")
				: session.run.status === "running"
					? (session.run.progress ?? view.headline)
					: view.headline;
		raw.push({
			id: `error-fix:${session.id}`,
			tone: isQueued ? "queued" : view.tone,
			percent: isQueued ? 0 : view.percent,
			headline: liveText,
			ariaLabel: fixAria,
			title: joinTooltip([view.detail, fixAria]),
			className: "sidebar__error-fix",
			sparkle: true,
			shimmerHeadline: !isQueued && view.tone === "run",
			onSelect: () => input.onOpenErrorFix(session.id),
		});
	}

	// 1b. Magic Action sessions (running or completed in background awaiting review)
	const magicAria = t("magicAction.sidebarOpen");
	for (const entry of describeSidebarMagicActionEntries(input.magicAction ?? initialMagicActionStore, t)) {
		raw.push({
			id: `magic-action:${entry.id}`,
			tone: entry.tone,
			percent: entry.percent,
			headline: entry.headline,
			ariaLabel: magicAria,
			title: joinTooltip([entry.detail, magicAria]),
			className: "sidebar__magic-action",
			sparkle: true,
			shimmerHeadline: entry.tone === "run",
			onSelect: () => input.onOpenMagicAction?.(entry.id),
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
				ariaLabel: openLabel,
				title: joinTooltip([problem.sideDetail, openLabel]),
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
			ariaLabel: modelOpen,
			title: joinTooltip([amount, modelOpen]),
			onSelect: input.onOpenAiSettings,
		});
	}

	// Stable priority sort: actively running tasks always lead the collapsed view, then queued, then errors, then done.
	return raw
		.map((entry, order) => ({ entry, order }))
		.sort((a, b) => TONE_PRIORITY[a.entry.tone] - TONE_PRIORITY[b.entry.tone] || a.order - b.order)
		.map(({ entry }) => entry);
}
