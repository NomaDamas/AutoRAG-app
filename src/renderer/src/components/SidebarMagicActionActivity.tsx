import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { openMagicActionDialog, useMagicActionStore } from "../hooks/useMagicAction";
import { describeSidebarMagicActionEntries } from "../state/magic-action";
import type { SidebarActivityEntry } from "../state/sidebar-activity-queue";
import { SidebarActivityStack } from "./SidebarActivityQueue";

/**
 * Standalone Magic Action stack view (used by isolated `MagicActionDialog` tests);
 * the main `Sidebar` renders the unified `SidebarActivityQueue` across all
 * background producers.
 */
export function SidebarMagicActionActivity(): ReactElement | null {
	const { t } = useTranslation();
	const store = useMagicActionStore();
	const openLabel = t("magicAction.sidebarOpen");
	const entries: SidebarActivityEntry[] = describeSidebarMagicActionEntries(store, t).map((entry) => ({
		id: `magic-action:${entry.id}`,
		tone: entry.tone,
		percent: entry.percent,
		headline: entry.headline,
		ariaLabel: openLabel,
		title: entry.detail ? `${entry.detail} — ${openLabel}` : openLabel,
		className: "sidebar__magic-action",
		sparkle: true,
		shimmerHeadline: entry.tone === "run",
		onSelect: () => openMagicActionDialog(entry.id),
	}));
	return <SidebarActivityStack entries={entries} />;
}
