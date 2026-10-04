/**
 * Sidebar navigation, derived from the live locations the main process reports
 * (`fs.locations`): Favorites (the Finder/Explorer standard folders), Cloud (the
 * drives connected to the OS — one row per account), and Locations (the boot
 * disk plus every mounted volume / drive letter). Nothing here is a fixed list;
 * a section with no rows is not rendered.
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
	Trash2,
	type LucideIcon,
} from "lucide-react";
import type { FsLocation, FsLocationIcon } from "../../../shared/fs-contract";

export interface NavItem {
	readonly label: string;
	readonly path: string;
	/** Lucide glyph for the place. */
	readonly icon: LucideIcon;
	/** The contract glyph key; datasource status dots are keyed by it. */
	readonly kind: FsLocationIcon;
	readonly available: boolean;
	/** A mounted volume the row offers to unmount. */
	readonly ejectable: boolean;
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

const SECTIONS: readonly (readonly [FsLocation["section"], string])[] = [
	["favorites", "Favorites"],
	["cloud", "Cloud"],
	["locations", "Locations"],
];

/** The sidebar groups for `locations`, each section in the order the OS reported. */
export function navGroups(locations: readonly FsLocation[]): readonly NavGroup[] {
	const groups: NavGroup[] = [];
	for (const [section, label] of SECTIONS) {
		const items = locations
			.filter((location) => location.section === section)
			.map((location) => ({
				label: location.name,
				path: location.path,
				icon: ICONS[location.icon],
				kind: location.icon,
				available: location.available,
				ejectable: location.ejectable,
			}));
		if (items.length > 0) groups.push({ label, items });
	}
	return groups;
}
