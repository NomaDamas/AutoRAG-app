import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useIndexActivity } from "../hooks/useIndexActivity";
import { describeIndexActivity } from "../state/index-activity";
import { cn } from "../lib/cn";
import { ProgressBar } from "./primitives/ProgressBar";

/**
 * Sidebar footer block, above Settings: what is indexing right now — folders
 * and every datasource, started here, by the scheduled job, or outside the app.
 * It shows the finished state for a few seconds, then disappears (the main
 * process clears the snapshot); clicking opens Settings > Indexing.
 */
export function SidebarIndexActivity({ onOpen }: { readonly onOpen: () => void }): ReactElement | null {
	const { t } = useTranslation();
	const snapshot = useIndexActivity();
	const view = describeIndexActivity(snapshot, t);
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
