import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { openErrorFixDialog, useErrorFixStore } from "../hooks/useErrorFix";
import { describeSidebarErrorFixEntries } from "../state/error-fix";
import type { SidebarActivityEntry } from "../state/sidebar-activity-queue";
import { SidebarActivityStack } from "./SidebarActivityQueue";

/**
 * Standalone error-fix stack view (used by isolated `RunErrorNotice` tests);
 * the main `Sidebar` renders the unified `SidebarActivityQueue` across all
 * background producers.
 */
export function SidebarErrorFixActivity(): ReactElement | null {
	const { t } = useTranslation();
	const store = useErrorFixStore();
	const openLabel = t("appError.fix.sidebar.open");
	const firstRunningIndex = store.sessions.findIndex((entry) => entry.run.status === "running");
	const entries: SidebarActivityEntry[] = describeSidebarErrorFixEntries(store, t).map((entry, idx) => {
		const session = store.sessions.find((item) => item.id === entry.id);
		const isQueued = entry.tone === "queued" || (session?.run.status === "running" && firstRunningIndex >= 0 && idx > firstRunningIndex && session.run.progress === null);
		const headline =
			isQueued
				? t("appError.fix.title")
				: session?.run.status === "running"
					? (session.run.progress ?? entry.headline)
					: entry.headline;
		return {
			id: `error-fix:${entry.id}`,
			tone: isQueued ? "queued" : entry.tone,
			percent: isQueued ? 0 : entry.percent,
			headline,
			ariaLabel: openLabel,
			title: entry.detail ? `${entry.detail} — ${openLabel}` : openLabel,
			className: "sidebar__error-fix",
			sparkle: true,
			shimmerHeadline: !isQueued && entry.tone === "run",
			onSelect: () => openErrorFixDialog(entry.id),
		};
	});
	return <SidebarActivityStack entries={entries} />;
}
