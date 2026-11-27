import type { TFunction } from "i18next";
import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { IndexActivitySnapshot } from "../../../../shared/index-activity-contract";
import type { ScheduledRunPause } from "../../../../shared/settings-contract";
import { dismissIndexProblem, retryIndexProblem, useIndexProblem } from "../../hooks/useIndexProblem";
import { itemName, itemPhaseText } from "../../state/index-activity";
import { describeIndexProblem } from "../../state/index-problem";
import { describeIndexProgress, formatAgo, formatDuration, progressTranslate } from "../../state/index-progress";
import { requestSettingsCategory } from "../../state/settings-navigation";
import { StalledWarning } from "../StalledWarning";

const PAUSE_NOTE = {
	battery: "indexStatus.paused.battery",
	"outside-window": "indexStatus.paused.window",
	"outside-day": "indexStatus.paused.day",
} as const;

/** What the running local refresh is doing, as the banner's title: 파일을 찾는 중, 문서 읽는 중, …. */
function runningTitle(snapshot: IndexActivitySnapshot, t: TFunction): string {
	const stage = snapshot.progress?.stage ?? null;
	if (stage === "discover") return t("indexProgress.line.discover");
	if (stage === "parse") return t("indexActivity.phases.parsed");
	if (stage === "embed" || stage === "keyword") return t("indexActivity.phases.minsync");
	if (stage === "finalize") return t("indexProgress.line.finalize");
	const running = snapshot.items.find((item) => item.state === "running");
	if (running === undefined) return t("indexActivity.running");
	if (running.kind === "source") return t("indexActivity.syncing", { name: itemName(running, t) });
	return itemPhaseText(running, t) ?? t("indexActivity.running");
}

/** The remaining time, or the stalled warning, beside the running title. */
function runningNote(snapshot: IndexActivitySnapshot, t: TFunction): ReactNode {
	const detail = snapshot.progress;
	if (detail === null) return null;
	const view = describeIndexProgress(detail, Date.now(), progressTranslate(t));
	if (view.warning !== null) return <StalledWarning view={view} testId="index-progress-stalled" />;
	if (detail.etaState === "estimated" && detail.etaMinutes !== null) return t("indexStatus.eta", { duration: formatDuration(detail.etaMinutes, progressTranslate(t)) });
	if (detail.etaState === "calculating") return t("indexStatus.etaCalculating");
	return null;
}

/**
 * 진행 상황 on Settings → 인덱싱 (Figma 596:18346, 601:4495, 601:4870): one grey banner whose first line says what
 * indexing is doing (파일을 찾는 중 · 예상 소요 시간, 인덱싱 완료 · 방금 전, or 인덱싱 중지됨 in red with why) and whose second
 * line counts the files read so far against the whole scope. The folders above show only a bar; the counts live here
 * and under the folder picked in the map.
 */
export function IndexStatusBanner({
	snapshot,
	totals,
	paused,
	lastRunAt,
}: {
	readonly snapshot: IndexActivitySnapshot;
	/** Files indexed in the whole scope, from the map; `null` until it has read the scope. */
	readonly totals: { readonly indexed: number; readonly targets: number } | null;
	/** Why the background job held due work back (on battery, outside its hours or days); `null` when it did not. */
	readonly paused: ScheduledRunPause | null;
	/** When indexing last finished, for 방금 전 / n분 전 after 인덱싱 완료. */
	readonly lastRunAt: string | null;
}): ReactElement {
	const { t, i18n } = useTranslation();
	const problem = describeIndexProblem(useIndexProblem(), t);
	const number = new Intl.NumberFormat(i18n.language);
	const running = snapshot.state === "running";
	const complete = totals !== null && totals.indexed >= totals.targets;
	// Before the map has read the scope, only a finished run says 인덱싱 완료; a profile that never indexed is waiting.
	const done = totals === null ? lastRunAt !== null : complete;

	let tone: "run" | "ok" | "stop";
	let title: string;
	let note: ReactNode = null;
	if (problem !== null && !running) {
		tone = "stop";
		title = problem.cardTitle;
		note = problem.itemDetail;
	} else if (running) {
		tone = "run";
		title = runningTitle(snapshot, t);
		note = runningNote(snapshot, t);
	} else if (snapshot.state === "failed") {
		tone = "stop";
		title = t("indexActivity.failed");
		note = snapshot.error;
	} else if (paused !== null && !complete) {
		tone = "stop";
		title = t("indexStatus.stopped");
		note = t(PAUSE_NOTE[paused.reason]);
	} else if (done) {
		tone = "ok";
		title = t("indexActivity.done");
		if (lastRunAt !== null) {
			note = Date.now() - Date.parse(lastRunAt) < 60_000 ? t("indexStatus.justNow") : formatAgo(lastRunAt, Date.now(), progressTranslate(t));
		}
	} else {
		tone = "ok";
		title = t("indexStatus.waiting");
	}

	const actions = problem !== null && !running ? [problem.primary, problem.secondary].filter((action) => action !== null) : [];
	return (
		<div className="index-status" data-tone={tone} data-testid="index-status">
			<div className="index-status-line">
				<span className="index-status-title">{title}</span>
				{note === null || note === "" ? null : <span className="index-status-note">{note}</span>}
			</div>
			{totals === null ? null : (
				<span className="index-status-count">{t("indexStatus.count", { done: number.format(totals.indexed), total: number.format(totals.targets) })}</span>
			)}
			{actions.length === 0 ? null : (
				<div className="index-status-actions">
					{actions.map((action) => (
						<button
							key={action.kind}
							type="button"
							className={action === problem?.primary ? "linear-btn settings-btn-primary" : "linear-btn"}
							onClick={() => (action.kind === "fixEmbedding" ? requestSettingsCategory("ai") : retryIndexProblem())}
						>
							{action.label}
						</button>
					))}
					<button type="button" className="linear-btn settings-btn-quiet" onClick={() => dismissIndexProblem()}>
						{t("common.close")}
					</button>
				</div>
			)}
		</div>
	);
}
