/**
 * Sidebar navigation, derived from the live locations the main process reports
 * (`fs.locations`): Favorites (the Finder/Explorer standard folders), Cloud (the
 * drives connected to the OS — one row per account), and Locations (the boot
 * disk plus every mounted volume / drive letter). Nothing here is a fixed list;
 * a section with no rows is not rendered — the app rows are AI Search and
 * Automations, which head Favorites (DESIGN.md §1.3a, §1.3c).
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
	MessagesSquare,
	Package,
	Server,
	Sparkles,
	Tag,
	Trash2,
	Zap,
	type LucideIcon,
} from "lucide-react";
import { tagPath, type FsLocation, type FsLocationIcon, type FsTag, type FsTagColor } from "../../../shared/fs-contract";
import { AI_SEARCH_PATH, AUTOMATIONS_PATH } from "../state/tabs";

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
	/** An app view instead of a folder: "aiSearch" turns the focused tab into AI Search, "automations" into the rules list. */
	readonly view?: "aiSearch" | "automations";
	/** A Finder tag's virtual folder: the row draws this colour as its dot (0 = a tag with no colour). */
	readonly tag?: { readonly name: string; readonly color: FsTagColor };
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
	discord: MessagesSquare,
	cloud: Cloud,
	disk: HardDrive,
	network: Server,
};

/**
 * The two app rows in the sidebar, at the top of Favorites: they are not
 * locations, and clicking one turns the focused tab into an AI Search tab or the
 * automation rules (DESIGN.md §1.3a, §1.3c). Each `path` is the tab model's virtual
 * path, so the row can sit in the same active-path comparison as the OS places.
 */
const AI_SEARCH_ITEM: NavItem = {
	label: "AI Search",
	path: AI_SEARCH_PATH,
	icon: Sparkles,
	available: true,
	ejectable: false,
	view: "aiSearch",
};

const AUTOMATIONS_ITEM: NavItem = {
	label: "Automations",
	path: AUTOMATIONS_PATH,
	icon: Zap,
	available: true,
	ejectable: false,
	view: "automations",
};

const SECTIONS: readonly (readonly [FsLocation["section"], string])[] = [
	["favorites", "Favorites"],
	["cloud", "Cloud"],
	["locations", "Locations"],
];

/** The Tags group heading, kept apart from the OS-reported sections. */
export const TAGS_GROUP_LABEL = "Tags";

/** The sidebar groups for `locations`, each section in the order the OS reported, then Finder's tags. */
export function navGroups(locations: readonly FsLocation[], tags: readonly FsTag[] = []): readonly NavGroup[] {
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
		if (section === "favorites") items.unshift(AI_SEARCH_ITEM, AUTOMATIONS_ITEM);
		if (items.length > 0) groups.push({ label, items });
	}
	if (tags.length > 0) {
		groups.push({
			label: TAGS_GROUP_LABEL,
			items: tags.map((tag) => ({
				label: tag.name,
				path: tagPath(tag.name),
				icon: Tag,
				available: true,
				ejectable: false,
				tag: { name: tag.name, color: tag.color },
			})),
		});
	}
	return groups;
}
