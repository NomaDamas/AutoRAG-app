import type { ReactElement } from "react";
import { useTranslation } from "../../../shared/i18n";
import { ArrowDownIcon } from "./icons";
import { SeedLoader } from "./SeedLoader";

/**
 * The round button that floats over a chat once it is scrolled up: it brings the newest line back. While Dazzi is
 * answering it shows the loader, and the arrow when the pointer is on it. The hover stays opaque (the window colour with
 * the hover tint laid over it), so the button never turns see-through over the text under it.
 */
export function ScrollToBottomButton({ answering, onClick, className }: { readonly answering: boolean; readonly onClick: () => void; readonly className?: string }): ReactElement {
	const { t } = useTranslation();
	return (
		<button
			type="button"
			data-action="scroll-to-bottom"
			aria-label={t("aiSearch.scrollToBottom")}
			title={t("aiSearch.scrollToBottom")}
			className={`group absolute bottom-12 left-1/2 z-10 grid size-32 -translate-x-1/2 cursor-pointer place-items-center rounded-full border border-border bg-window p-0 text-ink shadow-[0_2px_8px_rgba(0,0,0,0.14)] transition-[background-image] duration-(--dur-color) ease-out hover:[background-image:linear-gradient(var(--bg-hover-strong),var(--bg-hover-strong))] ${className ?? ""}`}
			onClick={onClick}
		>
			{answering ? (
				<>
					<span className="flex group-hover:hidden" aria-hidden="true">
						<SeedLoader />
					</span>
					<span className="hidden group-hover:flex" aria-hidden="true">
						<ArrowDownIcon size={16} />
					</span>
				</>
			) : (
				<ArrowDownIcon size={16} />
			)}
		</button>
	);
}
