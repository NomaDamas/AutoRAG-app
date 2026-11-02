import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { IndexNotice } from "../../../shared/search-contract";
import { WarningIcon } from "./icons";

export interface IndexNoticeBannerProps {
	readonly notice: IndexNotice;
	/** Goes to Settings → Indexing, where the folders and sources are refreshed and the run is followed. */
	readonly onOpenIndexing: () => void;
}

/**
 * Under the question of a run that is searching the person's own documents while the index is unfinished, stopped,
 * empty or small: says the search may fall short, with a button to the page that manages the index. It warns and
 * does not stop anything: the answer arrives below it as usual.
 */
export function IndexNoticeBanner({ notice, onOpenIndexing }: IndexNoticeBannerProps): ReactElement {
	const { t } = useTranslation();
	return (
		<div role="status" className="flex flex-col items-start gap-8 rounded-10 bg-warn-bg px-14 py-10 text-body text-warn-text">
			<div className="flex items-start gap-8">
				<span className="mt-2 flex-none">
					<WarningIcon />
				</span>
				<span>{t(`aiSearch.indexNotice.${notice.reason}`, { count: notice.documents ?? 0 })}</span>
			</div>
			<button
				type="button"
				className="inline-flex h-28 flex-none cursor-pointer items-center justify-center rounded-8 border border-border bg-window px-12 text-meta font-medium text-ink transition-colors duration-(--dur-color) ease-out hover:bg-hover"
				onClick={onOpenIndexing}
			>
				{t("aiSearch.indexNotice.manage")}
			</button>
		</div>
	);
}
