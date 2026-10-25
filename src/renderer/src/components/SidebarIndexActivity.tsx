import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useIndexActivity } from "../hooks/useIndexActivity";
import { useIndexProblem } from "../hooks/useIndexProblem";
import { describeIndexActivity } from "../state/index-activity";
import { describeIndexProblem } from "../state/index-problem";
import { cn } from "../lib/cn";
import { ProgressBar } from "./primitives/ProgressBar";

/** The shape both sources are read as, so the block's markup stays single. */
interface SidebarActivityView {
	readonly tone: "run" | "ok" | "error";
	readonly percent: number | null;
	readonly headline: string;
	readonly origin: string | null;
	readonly detail: string | null;
}

/**
 * Sidebar footer block, above Settings: what is indexing right now — folders
 * and every datasource, started here, by the scheduled job, or outside the app.
 * It shows the finished state for a few seconds, then disappears (the main
 * process clears the snapshot); clicking opens Settings > Indexing.
 *
 * A problem the last run left behind outlasts that snapshot, so while nothing is
 * running it takes the block's place — in the same error tone a failed run wears
 * — and stays until the index works again or the user dismisses it.
 */
export function SidebarIndexActivity({ onOpen }: { readonly onOpen: () => void }): ReactElement | null {
	const { t } = useTranslation();
	const snapshot = useIndexActivity();
	const activity = describeIndexActivity(snapshot, t);
	const problem = describeIndexProblem(useIndexProblem(), t);
	const problemView: SidebarActivityView | null =
		problem === null
			? null
			: { tone: problem.tone, percent: problem.retrying ? null : 100, headline: problem.sideTitle, origin: null, detail: problem.sideDetail };
	// A run in flight is more useful than the record it is answering.
	const view: SidebarActivityView | null = activity?.tone === "run" ? activity : (problemView ?? activity);
	if (view === null) return null;
	return (
		<button
			type="button"
			className="sidebar__activity flex w-full flex-col gap-4 mb-6 px-8 py-6 border-0 rounded-6 bg-transparent text-left cursor-pointer transition-[background] duration-(--dur-color) ease-[ease] hover:bg-hover"
			aria-label={t("indexActivity.open")}
			title={view.origin === null ? t("indexActivity.open") : `${view.origin} — ${t("indexActivity.open")}`}
			data-tone={view.tone}
			onClick={onOpen}
		>
			<span className="flex items-baseline gap-6 min-w-0 text-meta text-ink-body">
				<span className="flex-1 min-w-0 truncate">{view.headline}</span>
				{view.percent !== null && view.tone === "run" ? (
					<span className="flex-none text-ink-muted tabular-nums">{view.percent}%</span>
				) : null}
			</span>
			<ProgressBar percent={view.percent} tone={view.tone} label={view.headline} />
			{view.detail !== null ? (
				<span className={cn("min-w-0 truncate text-badge", view.tone === "error" ? "text-(--error-orange-text)" : "text-ink-muted")}>{view.detail}</span>
			) : null}
		</button>
	);
}
