import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { IndexNotice } from "../../../shared/search-contract";
import { NoticeCard } from "./primitives/NoticeCard";

export interface IndexNoticeBannerProps {
	readonly notice: IndexNotice;
	/** Goes to Settings → Indexing, where the folders and sources are refreshed and the run is followed. */
	readonly onOpenIndexing: () => void;
	/** The × on the card: hides it for this run. */
	readonly onClose?: () => void;
}

/**
 * Under the question of a run that is searching the person's own documents while the index is unfinished, stopped,
 * empty or small: says the search may fall short, with a button to the page that manages the index. It warns and
 * does not stop anything: the answer arrives below it as usual.
 */
export function IndexNoticeBanner({ notice, onOpenIndexing, onClose }: IndexNoticeBannerProps): ReactElement {
	const { t } = useTranslation();
	// Figma 641:13722 (the 인덱스 안내 card, in the flow): the compact warning card; the answer still arrives below it.
	return (
		<NoticeCard
			compact
			role="status"
			tone="warning"
			{...(onClose === undefined ? {} : { onClose })}
			title={t(`aiSearch.indexNotice.${notice.reason}`, { count: notice.documents ?? 0 })}
			actions={[{ label: t("aiSearch.indexNotice.manage"), onClick: onOpenIndexing }]}
		/>
	);
}
