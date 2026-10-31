import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { ContextNotice } from "../../../shared/search-contract";
import { CompactIcon, TrimIcon } from "./icons";

/**
 * The run's status line while pi summarises the chat's earlier turns (issue #389): it takes the place of the
 * "Thinking…" line, with the same shimmer, so the seconds the summary takes never read as a stalled run.
 */
export function CompactingStatus(): ReactElement {
	const { t } = useTranslation();
	return (
		<div className="context-compacting my-6 flex items-center gap-6 text-meta text-ink-muted" role="status" data-context="compacting">
			<CompactIcon className="flex-none text-accent" />
			<span className="shimmer min-w-0 truncate">{t("aiSearch.context.compacting")}</span>
		</div>
	);
}

/**
 * What a run did to the model's view of the chat, where it happened in the conversation.
 *
 * `compacted` divides the conversation: a hairline across the column with a centred pill, and one muted line under it
 * saying what that means (the model keeps only a summary of what is above). `trimmed` is a single quiet row whose colour
 * stays in its icon badge, like the error card's: the answer stands, it just saw part of one result.
 */
export function ContextNoticeView({ notice }: { readonly notice: ContextNotice }): ReactElement {
	const { t } = useTranslation();
	if (notice.kind === "compacted") {
		return (
			<div className="context-divider flex flex-col items-center gap-6 py-4" role="note" data-context="compacted">
				<div className="flex w-full items-center gap-10">
					<span className="h-px min-w-24 flex-1 bg-divider" aria-hidden="true" />
					<span className="inline-flex h-26 max-w-[80%] flex-none items-center gap-6 rounded-full border border-border bg-window px-12 text-meta font-medium text-ink-muted">
						<CompactIcon className="flex-none text-accent" />
						<span className="truncate">{t("aiSearch.context.compacted")}</span>
					</span>
					<span className="h-px min-w-24 flex-1 bg-divider" aria-hidden="true" />
				</div>
				<span className="max-w-[560px] text-center text-badge leading-normal text-ink-muted break-keep">{t("aiSearch.context.compactedHint")}</span>
			</div>
		);
	}
	return (
		<div className="context-trimmed flex items-center gap-8 text-meta text-ink-muted" role="note" data-context="trimmed">
			<span className="flex size-20 flex-none items-center justify-center rounded-6 bg-warn-bg text-warn-text" aria-hidden="true">
				<TrimIcon />
			</span>
			<span className="min-w-0">{t("aiSearch.context.trimmed")}</span>
		</div>
	);
}
