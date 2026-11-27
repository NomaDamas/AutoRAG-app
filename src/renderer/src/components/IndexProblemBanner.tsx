import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { dismissIndexProblem, retryIndexProblem, useIndexProblem } from "../hooks/useIndexProblem";
import { describeIndexProblem, type IndexProblemActionKind } from "../state/index-problem";
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
	if (view === null || view.retrying || (problem.at !== null && problem.at === dismissedAt)) return null;
	const { banner } = view;
	const { primary, secondary } = banner;
	if (primary === null) return null;
	const run = (kind: IndexProblemActionKind): void => (kind === "fixEmbedding" ? onFixEmbedding() : retryIndexProblem());
	const dismiss = (): void => {
		setDismissedAt(problem.at);
		dismissIndexProblem();
	};
	// Figma 548:14204: the shared notice card over the list — an error when nothing works, a warning when search still does (430:8644).
	return (
		<NoticeCard
			className="mx-8 mt-8 flex-none"
			clipBelow={400}
			floating
			tone={banner.tone}
			title={view.title}
			onClose={dismiss}
			actions={[
				secondary === null ? { label: t("common.later"), onClick: dismiss } : { label: secondary.label, onClick: () => run(secondary.kind) },
				{ label: primary.label, primary: true, onClick: () => run(primary.kind) },
			]}
		>
			{banner.detail}
		</NoticeCard>
	);
}
