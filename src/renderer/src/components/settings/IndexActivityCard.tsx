import type { TFunction } from "i18next";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { IndexActivityItem, IndexActivitySnapshot } from "../../../../shared/index-activity-contract";
import { describeIndexActivity, itemName, itemPhaseText } from "../../state/index-activity";
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
 * Settings > Indexing, top: the same snapshot the sidebar block shows, with
 * every item of the run. Unlike the sidebar it stays when nothing runs, saying so.
 */
export function IndexActivityCard({ snapshot }: { readonly snapshot: IndexActivitySnapshot }): ReactElement {
	const { t } = useTranslation();
	const view = describeIndexActivity(snapshot, t);
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
