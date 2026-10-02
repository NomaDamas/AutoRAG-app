/**
 * Sidebar navigation — the reference's `PLACES` groups (proto:774-779).
 *
 * Each place carries its `lucide-react` glyph and the source tiles are
 * verbatim; `syncing` / `error` mark the status dots the reference shows on
 * Gmail, Google Drive, and Discord.
 * The People/Contacts place is parked until its view ships.
 */

import { Box, Clock, Cloud, Download, File, Hexagon, Monitor, type LucideIcon } from "lucide-react";
import type { FileKind } from "../state/kinds";

export interface NavItem {
	readonly label: string;
	/** Lucide glyph for a place; omitted when the item renders a source tile. */
	readonly icon?: LucideIcon;
	readonly sourceKind: FileKind | null;
	readonly syncing: boolean;
	readonly error: boolean;
	/** A view that is not built yet — navigates to its work-in-progress screen. */
	readonly wip: boolean;
}

export interface NavGroup {
	readonly label: string;
	readonly items: readonly NavItem[];
}

function place(
	label: string,
	icon: LucideIcon,
	status: { syncing?: boolean; error?: boolean; wip?: boolean } = {},
): NavItem {
	return {
		label,
		icon,
		sourceKind: null,
		syncing: status.syncing ?? false,
		error: status.error ?? false,
		wip: status.wip ?? false,
	};
}

function source(
	label: string,
	sourceKind: FileKind,
	status: { syncing?: boolean; error?: boolean } = {},
): NavItem {
	return {
		label,
		sourceKind,
		syncing: status.syncing ?? false,
		error: status.error ?? false,
		wip: false,
	};
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
		items: [
			place("iCloud Drive", Cloud),
			place("Google Drive", Hexagon, { syncing: true }),
			place("Dropbox", Box),
		],
	},
	{
		label: "Sources",
		items: [
			source("Slack", "slack"),
			source("Gmail", "mail", { syncing: true }),
			source("Notion", "notion"),
			source("Discord", "discord", { error: true }),
			source("Telegram", "telegram"),
		],
	},
];

/** Footer indexing progress — the reference's fixed "Indexing · Gmail 88%". */
export const INDEXING_STATUS = { label: "Indexing · Gmail", percent: 88 } as const;
