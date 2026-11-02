import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { openErrorFixDialog, useErrorFixSession } from "../hooks/useErrorFix";
import { cn } from "../lib/cn";
import { describeSidebarErrorFix } from "../state/error-fix";
import { SparklesIcon } from "./icons";
import { ProgressBar } from "./primitives/ProgressBar";

/**
 * Sidebar footer block, styled identically to `SidebarIndexActivity`: shows
 * live "AI로 고치기" progress (with a shimmering bar and the agent's live `i`
 * intent phrase) even when the modal is minimized, and stays visible when a
 * minimized repair finishes until the user clicks it to inspect or close.
 */
export function SidebarErrorFixActivity(): ReactElement | null {
	const { t } = useTranslation();
	const session = useErrorFixSession();
	const view = describeSidebarErrorFix(session, t);
	if (view === null) return null;
	return (
		<button
			type="button"
			className="sidebar__activity sidebar__error-fix flex w-full flex-col gap-4 mb-6 px-8 py-6 border-0 rounded-6 bg-transparent text-left cursor-pointer transition-[background] duration-(--dur-color) ease-[ease] hover:bg-hover"
			aria-label={t("appError.fix.sidebar.open")}
			title={t("appError.fix.sidebar.open")}
			data-tone={view.tone}
			onClick={openErrorFixDialog}
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
