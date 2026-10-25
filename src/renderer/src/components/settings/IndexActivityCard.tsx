import type { TFunction } from "i18next";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { IndexActivityItem, IndexActivitySnapshot } from "../../../../shared/index-activity-contract";
import { dismissIndexProblem, retryIndexProblem, useIndexProblem } from "../../hooks/useIndexProblem";
import { describeIndexActivity, itemName, itemPhaseText } from "../../state/index-activity";
import { describeIndexProblem, type IndexProblemView } from "../../state/index-problem";
import { requestSettingsCategory } from "../../state/settings-navigation";
import { ProgressBar } from "../primitives/ProgressBar";
import { StatusDot } from "./SettingsKit";

const TONE_BY_STATE = { queued: "off", running: "run", done: "ok", failed: "warn" } as const;

function itemMeta(item: IndexActivityItem, t: TFunction): string {
	if (item.state === "failed") return item.error ?? t("indexActivity.failed");
	if (item.state === "running") return itemPhaseText(item, t) ?? t("indexActivity.syncing", { name: itemName(item, t) });
	if (item.counts !== null) return t("indexActivity.counts", { ...item.counts });
	return item.state === "done" ? t("indexActivity.done") : t("indexActivity.queued");
}

/**
 * What the last run left behind, in place of an idle card: one row about the
 * embedding or the folder, the two ways out, and a dismissal. The embedding
 * choice itself lives on Settings > AI, so the fix only takes the user there.
 */
function ProblemCard({ view }: { readonly view: IndexProblemView }): ReactElement {
	const { t } = useTranslation();
	const primary = view.primary;
	const secondary = view.secondary;
	const run = (kind: "retry" | "fixEmbedding"): void => {
		if (kind === "fixEmbedding") requestSettingsCategory("ai");
		else retryIndexProblem();
	};
	return (
		<div className="settings-activity" data-tone={view.cardTone}>
			<div className="settings-activity-head">
				<span className="settings-list-title">{view.cardTitle}</span>
			</div>
			<ProgressBar percent={view.retrying ? null : 100} tone={view.cardTone} label={view.cardTitle} />
			<ul className="settings-activity-items">
				<li className="settings-activity-item">
					<StatusDot tone={view.retrying ? "run" : "warn"} />
					<span className="settings-list-title">{view.itemTitle}</span>
					<span className="settings-list-meta" title={view.folderName ?? undefined}>
						{view.itemDetail}
					</span>
				</li>
			</ul>
			{primary === null ? null : (
				<div className="settings-problem-actions">
					<button type="button" className="linear-btn settings-btn-primary" onClick={() => run(primary.kind)}>
						{primary.label}
					</button>
					{secondary === null ? null : (
						<button type="button" className="linear-btn" onClick={() => run(secondary.kind)}>
							{secondary.label}
						</button>
					)}
					<button type="button" className="linear-btn settings-btn-quiet" onClick={() => dismissIndexProblem()}>
						{t("common.close")}
					</button>
				</div>
			)}
		</div>
	);
}

/**
 * Settings > Indexing, top: the same snapshot the sidebar block shows, with
 * every item of the run. Unlike the sidebar it stays when nothing runs, saying so
 * — and while nothing runs it says what the last run left behind, if anything.
 */
export function IndexActivityCard({ snapshot }: { readonly snapshot: IndexActivitySnapshot }): ReactElement {
	const { t } = useTranslation();
	const view = describeIndexActivity(snapshot, t);
	const problem = describeIndexProblem(useIndexProblem(), t);
	// A run in flight is the news; otherwise what the last run left behind outranks its own 15-second echo (which carries the raw error).
	if (problem !== null && (view === null || view.tone !== "run")) return <ProblemCard view={problem} />;
	if (view === null) {
		return <p className="settings-list-meta" data-testid="index-activity-idle">{t("indexActivity.idle")}</p>;
	}
	return (
		<div className="settings-activity" data-tone={view.tone}>
			<div className="settings-activity-head">
				<span className="settings-list-title">{view.origin === null ? view.headline : `${view.headline} · ${view.origin}`}</span>
				{view.percent !== null && view.tone === "run" ? <span className="settings-list-meta">{view.percent}%</span> : null}
			</div>
			<ProgressBar percent={view.percent} tone={view.tone} label={view.headline} />
			{snapshot.items.length > 0 ? (
				<ul className="settings-activity-items">
					{snapshot.items.map((item) => (
						<li key={item.key} className="settings-activity-item">
							<StatusDot tone={TONE_BY_STATE[item.state]} />
							<span className="settings-list-title">{itemName(item, t)}</span>
							<span className="settings-list-meta" title={item.error ?? undefined}>{itemMeta(item, t)}</span>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
