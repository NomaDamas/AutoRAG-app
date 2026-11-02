import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { openMagicActionDialog, useMagicActionSession } from "../hooks/useMagicAction";
import { cn } from "../lib/cn";
import { describeSidebarMagicAction } from "../state/magic-action";
import { SparklesIcon } from "./icons";
import { ProgressBar } from "./primitives/ProgressBar";

/**
 * Sidebar footer block for active or background-completed Magic Actions,
 * matching `SidebarErrorFixActivity` and `SidebarIndexActivity`.
 */
export function SidebarMagicActionActivity(): ReactElement | null {
	const { t } = useTranslation();
	const session = useMagicActionSession();
	const view = describeSidebarMagicAction(session, t);
	if (view === null) return null;
	return (
		<button
			type="button"
			className="sidebar__activity sidebar__magic-action flex w-full flex-col gap-4 mb-6 px-8 py-6 border-0 rounded-6 bg-transparent text-left cursor-pointer transition-[background] duration-(--dur-color) ease-[ease] hover:bg-hover"
			aria-label={t("magicAction.sidebarOpen")}
			title={t("magicAction.sidebarOpen")}
			data-tone={view.tone}
			onClick={openMagicActionDialog}
		>
			<span className="flex items-center gap-6 min-w-0 text-meta text-ink-body">
				<SparklesIcon className="flex-none text-accent" />
				<span className="flex-1 min-w-0 truncate">{view.headline}</span>
			</span>
			<ProgressBar percent={view.percent} tone={view.tone} label={view.headline} />
			{view.detail !== null ? (
				<span
					className={cn(
						"min-w-0 truncate text-badge",
						view.tone === "run" ? "shimmer text-ink-muted" : view.tone === "error" ? "text-(--error-orange-text)" : "text-ink-muted",
					)}
				>
					{view.detail}
				</span>
			) : null}
		</button>
	);
}
