import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { dismissIndexProblem, retryIndexProblem, useIndexProblem } from "../hooks/useIndexProblem";
import { describeIndexProblem } from "../state/index-problem";
import { NoticeCard } from "./primitives/NoticeCard";

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
	const dismiss = (): void => {
		setDismissedAt(problem.at);
		dismissIndexProblem();
	};
	// Figma 548:14204: the shared notice card over the list — a skipped file is a warning, a stopped index an error.
	return (
		<NoticeCard
			className="mx-8 mt-8 flex-none"
			floating
			tone={view.cardTone === "error" ? "error" : "warning"}
			title={view.title}
			onClose={dismiss}
			actions={[
				{ label: t("common.later"), onClick: dismiss },
				{ label: primary.label, primary: true, onClick: () => (primary.kind === "fixEmbedding" ? onFixEmbedding() : retryIndexProblem()) },
			]}
		>
			{view.sideDetail}
		</NoticeCard>
	);
}
