import type { TFunction } from "i18next";
import { isFileCountStage, type IndexProgressSnapshot, type IndexStageId, type IndexStageProgress, type IndexStageState } from "../../../shared/index-progress-contract";
import { formatByteSize } from "../../../shared/size-reduction";

/**
 * The words for an {@link IndexProgressSnapshot}. The first-run screen, the sidebar tooltip and the Settings
 * card all print their progress lines from here, so a number cannot read differently from one to the next.
 */

/** The shape of a translate function that both react-i18next's `t` and the onboarding's `Translate` fit. */
export type ProgressTranslate = (key: string, options?: Record<string, unknown>) => string;

/** react-i18next's `t` types every key, which a string-keyed translate cannot satisfy; the keys used here are all `indexProgress.*`. */
export function progressTranslate(t: TFunction): ProgressTranslate {
	return t as unknown as ProgressTranslate;
}

export interface IndexStageView {
	readonly id: IndexStageId;
	readonly label: string;
	readonly state: IndexStageState;
}

/** The heartbeat is still arriving (a large file may be taking long), or it stopped too. */
export type StalledKind = "alive" | "silent";

export interface IndexProgressView {
	readonly stages: readonly IndexStageView[];
	readonly stageName: string | null;
	/** Measured completion of the running stage, 0..100 (bytes once its sizes are known, files before); `null` when it cannot be measured. */
	readonly stagePercent: number | null;
	/** "Embedding 12,950 / 29,595 files (44%)": the running stage in its own unit. */
	readonly countLine: string | null;
	/** "3 skipped · 1 failed"; `null` when there are none. */
	readonly extraLine: string | null;
	/** "Size 4.0 GB / 17 GB (23%)"; `null` when the stage has no sizes. */
	readonly bytesLine: string | null;
	/** "Embedding: about 7 h left" or "...: calculating time left"; `null` when there is nothing to project. */
	readonly etaLine: string | null;
	/** "Last file finished 3 min ago · report.pdf · Last activity signal just now". */
	readonly activityLine: string | null;
	/** The "may be stalled" warning, if the snapshot carries one. Its minute count grows every minute. */
	readonly warning: string | null;
	/** Which warning it is; changes only when the situation does, not as the minutes grow. `null` without a warning. */
	readonly warningKind: StalledKind | null;
	/** Everything above in one line, for tooltips. */
	readonly summary: string;
}

const HEARTBEAT_FRESH_MS = 60_000;

export function stageLabel(id: IndexStageId, t: ProgressTranslate): string {
	return t(`indexProgress.stage.${id}`);
}

/** "12 min", "3 h 5 min", "2 days": whole minutes, rounded for the size of the span. */
export function formatDuration(minutes: number, t: ProgressTranslate): string {
	if (minutes < 60) return t("indexProgress.duration.minutes", { count: Math.max(1, Math.round(minutes)) });
	const hours = Math.floor(minutes / 60);
	if (hours >= 48) return t("indexProgress.duration.days", { count: Math.round(minutes / 1440) });
	const rest = Math.round(minutes - hours * 60);
	return rest === 0 ? t("indexProgress.duration.hours", { hours }) : t("indexProgress.duration.hoursMinutes", { hours, minutes: rest });
}

/** How long ago `iso` was, in the largest whole unit; "just now" under ten seconds. */
export function formatAgo(iso: string, now: number, t: ProgressTranslate): string {
	const elapsed = Math.max(0, now - Date.parse(iso));
	if (elapsed < 10_000) return t("indexProgress.ago.now");
	if (elapsed < 60_000) return t("indexProgress.ago.seconds", { count: Math.floor(elapsed / 1000) });
	if (elapsed < 3_600_000) return t("indexProgress.ago.minutes", { count: Math.floor(elapsed / 60_000) });
	return t("indexProgress.ago.hours", { count: Math.floor(elapsed / 3_600_000) });
}

/** Rounded, but never 100 before the work is all counted. */
function percentOf(fraction: number | null): number | null {
	if (fraction === null) return null;
	return fraction >= 1 ? 100 : Math.min(99, Math.round(fraction * 100));
}

function countLine(running: IndexStageProgress, name: string, t: ProgressTranslate): string | null {
	if (running.id === "discover") return t("indexProgress.line.discover");
	if (running.id === "finalize") return t("indexProgress.line.finalize");
	const counts = running.counts;
	if (counts === null) return null;
	const done = counts.done.toLocaleString();
	if (counts.total === null) return t("indexProgress.line.countsOpen", { stage: name, done });
	return t("indexProgress.line.counts", {
		stage: name,
		done,
		total: counts.total.toLocaleString(),
		// The files' own share: the stage's bar fraction is told in bytes once sizes are known, and has its own line.
		percent: percentOf(counts.total <= 0 ? 1 : (counts.done + counts.skipped + counts.failed) / counts.total) ?? 0,
	});
}

function extraLine(running: IndexStageProgress, t: ProgressTranslate): string | null {
	const counts = running.counts;
	if (counts === null) return null;
	const parts = [
		counts.skipped > 0 ? t("indexProgress.skipped", { count: counts.skipped.toLocaleString() }) : null,
		counts.failed > 0 ? t("indexProgress.failed", { count: counts.failed.toLocaleString() }) : null,
	].filter((part): part is string => part !== null);
	return parts.length === 0 ? null : parts.join(" · ");
}

function bytesLine(running: IndexStageProgress, t: ProgressTranslate): string | null {
	const bytes = running.bytes;
	if (bytes === null) return null;
	if (bytes.total === null || bytes.total <= 0) return t("indexProgress.bytesDone", { done: formatByteSize(bytes.done) });
	return t("indexProgress.bytes", {
		done: formatByteSize(bytes.done),
		total: formatByteSize(bytes.total),
		percent: percentOf(Math.min(1, bytes.done / bytes.total)) ?? 0,
	});
}

function activityLine(detail: IndexProgressSnapshot, now: number, t: ProgressTranslate): string | null {
	const { pulse } = detail;
	const parts: string[] = [];
	if (pulse.lastCompletedAt !== null) parts.push(t("indexProgress.activity.lastDone", { ago: formatAgo(pulse.lastCompletedAt, now, t) }));
	else if (isFileCountStage(detail.stage)) parts.push(t("indexProgress.activity.none"));
	if (pulse.lastFile !== null) parts.push(pulse.lastFile);
	if (pulse.heartbeatAt !== null && isFileCountStage(detail.stage)) {
		parts.push(t("indexProgress.activity.heartbeat", { ago: formatAgo(pulse.heartbeatAt, now, t) }));
	}
	return parts.length === 0 ? null : parts.join(" · ");
}

function warning(detail: IndexProgressSnapshot, now: number, t: ProgressTranslate): { readonly text: string; readonly kind: StalledKind } | null {
	const { pulse } = detail;
	if (!pulse.stalled) return null;
	const since = pulse.lastCompletedAt === null ? now : Date.parse(pulse.lastCompletedAt);
	const minutes = Math.max(10, Math.floor((now - since) / 60_000));
	const kind = pulse.heartbeatAt !== null && now - Date.parse(pulse.heartbeatAt) < HEARTBEAT_FRESH_MS ? "alive" : "silent";
	return { text: t(kind === "alive" ? "indexProgress.warn.stalledAlive" : "indexProgress.warn.stalledSilent", { minutes }), kind };
}

export function describeIndexProgress(detail: IndexProgressSnapshot, now: number, t: ProgressTranslate): IndexProgressView {
	const stages = detail.stages.map((stage) => ({ id: stage.id, label: stageLabel(stage.id, t), state: stage.state }));
	const running = detail.stage === null ? undefined : detail.stages.find((stage) => stage.id === detail.stage);
	const name = running === undefined ? null : stageLabel(running.id, t);
	let etaLine: string | null = null;
	// Discovery and the final tidy-up have no files to count, so there is no pace to project from.
	if (name !== null && isFileCountStage(detail.stage)) {
		if (detail.etaState === "estimated" && detail.etaMinutes !== null) {
			etaLine = t("indexProgress.eta.remaining", { stage: name, duration: formatDuration(detail.etaMinutes, t) });
		} else if (detail.etaState === "calculating") {
			etaLine = t("indexProgress.eta.calculating", { stage: name });
		}
	}
	const counts = running === undefined || name === null ? null : countLine(running, name, t);
	const stalled = warning(detail, now, t);
	const view = {
		stages,
		stageName: name,
		stagePercent: running === undefined || detail.indeterminate ? null : percentOf(running.fraction),
		countLine: counts,
		extraLine: running === undefined ? null : extraLine(running, t),
		bytesLine: running === undefined ? null : bytesLine(running, t),
		etaLine,
		activityLine: activityLine(detail, now, t),
		warning: stalled?.text ?? null,
		warningKind: stalled?.kind ?? null,
	};
	const summary = [view.countLine, view.extraLine, view.bytesLine, view.etaLine].filter((part): part is string => part !== null).join(" · ");
	return { ...view, summary };
}
