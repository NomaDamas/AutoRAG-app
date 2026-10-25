import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { SearchErrorAction } from "../../../shared/search-contract";

export interface RunErrorNoticeProps {
	readonly message: string;
	/** What the person can do about it, when the main process knows: a button that goes there. */
	readonly action: SearchErrorAction | null;
	/** The Settings page that shows the plan and its weekly usage. */
	readonly onOpenPlan: () => void;
}

/** A run's error, in the red box under the question; with a button when there is somewhere to go. */
export function RunErrorNotice({ message, action, onOpenPlan }: RunErrorNoticeProps): ReactElement {
	const { t } = useTranslation();
	return (
		<div className="flex flex-col items-start gap-8 rounded-10 border border-danger-border bg-danger-bg-soft px-14 py-10 text-body text-danger-text">
			<span>{message}</span>
			{action === "open-plan" ? (
				<button
					type="button"
					className="inline-flex h-28 flex-none cursor-pointer items-center justify-center rounded-8 border border-danger-border bg-window px-12 text-meta font-medium text-danger-text transition-colors duration-(--dur-color) ease-out hover:bg-hover"
					onClick={onOpenPlan}
				>
					{t("aiSearch.openPlan")}
				</button>
			) : null}
		</div>
	);
}
