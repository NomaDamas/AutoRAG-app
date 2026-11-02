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
	const entries: SidebarActivityEntry[] = describeSidebarErrorFixEntries(store, t).map((entry) => ({
		id: `error-fix:${entry.id}`,
		tone: entry.tone,
		percent: entry.percent,
		headline: entry.headline,
		detail: entry.detail,
		ariaLabel: openLabel,
		title: openLabel,
		className: "sidebar__error-fix",
		sparkle: true,
		shimmerDetail: entry.tone === "run",
		onSelect: () => openErrorFixDialog(entry.id),
	}));
	return <SidebarActivityStack entries={entries} />;
}
