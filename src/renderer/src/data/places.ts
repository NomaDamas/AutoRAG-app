/**
 * Sidebar navigation, derived from the live locations the main process reports
 * (`fs.locations`): Favorites (the Finder/Explorer standard folders), Cloud (the
 * drives connected to the OS — one row per account), and Locations (the boot
 * disk plus every mounted volume / drive letter). Nothing here is a fixed list;
 * a section with no rows is not rendered — the only app row is the AI Search
 * entry that heads Favorites (DESIGN.md §1.3a).
 *
 * The status dot beside a cloud row is NOT data: it is driven by the live
 * datasource status the shell reads from `settings.sourcesList`, keyed by the
 * row's provider glyph and passed down as `sourceStatus`.
 */

import {
	AppWindow,
	Box,
	Clock,
	Cloud,
	Download,
	File,
	FlaskConical,
	Film,
	HardDrive,
	Hexagon,
	House,
	Image,
	Monitor,
	Music,
	Package,
	Server,
	Sparkles,
	Trash2,
	type LucideIcon,
} from "lucide-react";
import type { FsLocation, FsLocationIcon } from "../../../shared/fs-contract";
import { AI_SEARCH_PATH } from "../state/tabs";

export interface NavItem {
	readonly label: string;
	readonly path: string;
	/** Lucide glyph for the place. */
	readonly icon: LucideIcon;
	/** The contract glyph key; datasource status dots are keyed by it. Absent on app rows. */
	readonly kind?: FsLocationIcon;
	readonly available: boolean;
	/** A mounted volume the row offers to unmount. */
	readonly ejectable: boolean;
	/** An app view instead of a folder: "aiSearch" turns the focused tab into AI Search. */
	readonly view?: "aiSearch";
}

export interface NavGroup {
	readonly label: string;
	readonly items: readonly NavItem[];
}

const ICONS: Readonly<Record<FsLocationIcon, LucideIcon>> = {
	recents: Clock,
	home: House,
	applications: AppWindow,
	desktop: Monitor,
	documents: File,
	downloads: Download,
	music: Music,
	movies: Film,
	pictures: Image,
	trash: Trash2,
	qa: FlaskConical,
	icloud: Cloud,
	"google-drive": Hexagon,
	onedrive: Cloud,
	dropbox: Box,
	box: Package,
	cloud: Cloud,
	disk: HardDrive,
	network: Server,
};

/**
 * The one app row in the sidebar, at the top of Favorites: it is not a
 * location, and clicking it turns the focused tab into an AI Search tab
 * (DESIGN.md §1.3a). Its `path` is the tab model's virtual AI Search path, so
 * the row can sit in the same active-path comparison as the OS places.
 */
const AI_SEARCH_ITEM: NavItem = {
	label: "AI Search",
	path: AI_SEARCH_PATH,
	icon: Sparkles,
	available: true,
	ejectable: false,
	view: "aiSearch",
};

const SECTIONS: readonly (readonly [FsLocation["section"], string])[] = [
	["favorites", "Favorites"],
	["cloud", "Cloud"],
	["locations", "Locations"],
];

/** The sidebar groups for `locations`, each section in the order the OS reported. */
export function navGroups(locations: readonly FsLocation[]): readonly NavGroup[] {
	const groups: NavGroup[] = [];
	for (const [section, label] of SECTIONS) {
		const items: NavItem[] = locations
			.filter((location) => location.section === section)
			.map((location) => ({
				label: location.name,
				path: location.path,
				icon: ICONS[location.icon],
				kind: location.icon,
				available: location.available,
				ejectable: location.ejectable,
			}));
		if (section === "favorites") items.unshift(AI_SEARCH_ITEM);
		if (items.length > 0) groups.push({ label, items });
	}
	return groups;
}
