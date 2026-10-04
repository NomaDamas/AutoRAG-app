/**
 * Sidebar navigation — the reference's `PLACES` groups (proto:774-779).
 *
 * Each place carries its `lucide-react` glyph. The status dot beside a place is
 * NOT data: it is driven by the live datasource status the shell reads from
 * `settings.sourcesList` and passes down as `sourceStatus`. A place with no
 * reported status renders no dot.
 *
 * The reference's **Sources** group (Slack / Gmail / Notion / Discord /
 * Telegram) is not rendered: those entries are not wired to the librarian's
 * crawler CLIs yet, so they only produced a "not linked" toast. Tracked as
 * issue #20; re-add the group (and a source-tile branch) with that work.
 */

import { Box, Clock, Cloud, Download, File, Hexagon, Monitor, type LucideIcon } from "lucide-react";

export interface NavItem {
	readonly label: string;
	/** Lucide glyph for the place. */
	readonly icon: LucideIcon;
	/** A view that is not built yet — navigates to its work-in-progress screen. */
	readonly wip: boolean;
}

export interface NavGroup {
	readonly label: string;
	readonly items: readonly NavItem[];
}

function place(label: string, icon: LucideIcon, wip = false): NavItem {
	return { label, icon, wip };
}

export const NAV_GROUPS: readonly NavGroup[] = [
	{
		label: "Favorites",
		items: [
			place("Recents", Clock),
			place("Desktop", Monitor),
			place("Downloads", Download),
			place("Documents", File),
		],
	},
	{
		label: "Cloud",
		items: [place("iCloud Drive", Cloud), place("Google Drive", Hexagon), place("Dropbox", Box)],
	},
];

/** The bit of a location the sidebar needs; `FinderLocation` satisfies it structurally. */
export interface NavLocation {
	readonly name: string;
	readonly available: boolean;
}

/**
 * Navigation groups with only the cloud drives this machine actually has.
 *
 * Favorites always render (a missing folder answers with its own friendly
 * "not linked" toast), but a Cloud entry appears only when its location is
 * available — so a disconnected drive, or a macOS-only one on Windows, is
 * never offered. Availability is recomputed whenever the app reloads its
 * locations.
 */
export function connectedNavGroups(locations: readonly NavLocation[]): readonly NavGroup[] {
	const available = new Set(locations.filter((location) => location.available).map((location) => location.name));
	return NAV_GROUPS.map((group) =>
		group.label === "Cloud" ? { ...group, items: group.items.filter((item) => available.has(item.label)) } : group,
	).filter((group) => group.items.length > 0);
}
