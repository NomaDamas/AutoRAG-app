import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { IndexProgressSnapshot } from "../../../shared/index-progress-contract";
import { useNow } from "../hooks/useNow";
import { describeIndexProgress, progressTranslate } from "../state/index-progress";
import { StalledWarning } from "./StalledWarning";

/**
 * The stage-by-stage account of a running index: which stage, how many files of how many, how much of the
 * bytes, how long it will take at the pace of the last few minutes, and whether anything is still finishing.
 * Settings > Indexing shows it under the progress bar; the first-run screen words the same view itself.
 */
export function IndexProgressDetail({ detail }: { readonly detail: IndexProgressSnapshot }): ReactElement {
	const { t } = useTranslation();
	const view = describeIndexProgress(detail, useNow(true), progressTranslate(t));
	const lines = [view.countLine, view.extraLine, view.bytesLine, view.etaLine, view.activityLine].filter((line): line is string => line !== null);
	return (
		<div className="settings-activity-detail" data-testid="index-progress-detail">
			<ol className="settings-activity-stages" aria-label={view.stageName ?? undefined}>
				{view.stages.map((stage) => (
					<li key={stage.id} className="settings-list-meta" data-state={stage.state} aria-current={stage.state === "running" ? "step" : undefined}>
						{stage.label}
					</li>
				))}
			</ol>
			{lines.map((line) => (
				<p key={line} className="settings-list-meta">
					{line}
				</p>
			))}
			<StalledWarning view={view} className="settings-list-meta settings-activity-warning" testId="index-progress-stalled" />
		</div>
	);
}
