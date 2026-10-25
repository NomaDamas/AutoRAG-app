import { TriangleAlert, X } from "lucide-react";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { dismissIndexProblem, retryIndexProblem, useIndexProblem } from "../hooks/useIndexProblem";
import { describeIndexProblem } from "../state/index-problem";
import { iconButtonClass } from "./primitives/icon-button";

/** The one button: the accent fill, at the height of the toolbar's pill controls. */
const PRIMARY_CLASS =
	"flex-none h-pill px-10 border-0 rounded-6 bg-accent text-on-accent text-meta whitespace-nowrap cursor-pointer transition-colors duration-(--dur-color) ease-[ease] hover:bg-accent-hover";

/**
 * The persistent "needs attention" line above the file list (issue #283): one
 * icon, one title, one button, and a dismiss. Unlike the run's own activity it
 * survives a relaunch, so a user who opened the app anyway always has the way
 * out in front of them.
 *
 * It stays out of the way while a retry from a surface runs — the sidebar block
 * and the Settings card carry that state — and it does not come back for a
 * problem the user just dismissed; only a run that leaves a new one does.
 */
export function IndexProblemBanner({ onFixEmbedding }: { readonly onFixEmbedding: () => void }): ReactElement | null {
	const { t } = useTranslation();
	const problem = useIndexProblem();
	const view = describeIndexProblem(problem, t);
	// The dismissed record, so the banner leaves with the click instead of after the main process
	// pushes the cleared record back. A later run leaves its own `at`.
	const [dismissedAt, setDismissedAt] = useState<string | null>(null);
	if (view === null || view.retrying || view.primary === null || (problem.at !== null && problem.at === dismissedAt)) return null;
	const primary = view.primary;
	return (
		<div
			className="flex flex-none items-center gap-8 mx-8 mt-8 px-10 py-8 border border-error-orange-dot rounded-8 bg-error-orange-bg text-meta"
			role="alert"
		>
			<TriangleAlert className="flex-none text-error-orange-text" size={16} strokeWidth={1.8} aria-hidden="true" />
			<span className="flex-1 min-w-0 truncate text-ink" title={view.title}>
				{view.title}
			</span>
			<button
				type="button"
				className={PRIMARY_CLASS}
				onClick={() => (primary.kind === "fixEmbedding" ? onFixEmbedding() : retryIndexProblem())}
			>
				{primary.label}
			</button>
			<button
				type="button"
				className={iconButtonClass({ size: "size-icon-sm", tone: "text-ink-muted" })}
				aria-label={t("common.close")}
				title={t("common.close")}
				onClick={() => {
					setDismissedAt(problem.at);
					dismissIndexProblem();
				}}
			>
				<X size={14} strokeWidth={1.8} />
			</button>
		</div>
	);
}
