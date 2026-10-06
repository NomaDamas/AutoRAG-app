/**
 * Icon set — adapters over `lucide-react` (DESIGN.md §5).
 *
 * The reference draws every icon as an inline 24 × 24 stroke glyph with round
 * caps, and lucide is the library those glyphs come from, so each adapter is a
 * named lucide icon pinned to the size and stroke width the reference specifies
 * at its call site. Consumers keep passing the same props they always did.
 *
 * `FolderGlyph` is the one exception: the reference requires a *filled* folder
 * in `--folder`, and lucide's `folder` is stroke-only, so there is no library
 * equivalent to substitute and the path stays here.
 */

import {
	AppWindow,
	Archive,
	ArrowDownUp,
	ArrowUp,
	Check,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	ChevronsUp,
	Columns3,
	Copy,
	Database,
	ExternalLink,
	Eye,
	FilePlus,
	Film,
	FolderPlus,
	History,
	Image as ImageGlyph,
	Info,
	Layers,
	LayoutGrid,
	Link2,
	List,
	PackageOpen,
	PanelLeft,
	PanelRight,
	Pencil,
	Plus,
	RotateCw,
	Rows3,
	Search,
	Send,
	Settings,
	Share,
	Sparkles,
	ThumbsDown,
	ThumbsUp,
	Trash2,
	Users,
	X,
	createLucideIcon,
	type LucideIcon,
} from "lucide-react";
import type { ReactElement } from "react";

interface GlyphProps {
	readonly size?: number | undefined;
	readonly className?: string | undefined;
}

/** The reference's default stroke: 24 × 24 viewBox, round caps, 1.8. */
const GLYPH_STROKE = 1.8;

/** Pin a lucide icon to the reference's per-glyph size and stroke width. */
function glyph(Icon: LucideIcon, defaultSize: number, strokeWidth: number = GLYPH_STROKE) {
	return function Glyph({ size = defaultSize, className }: GlyphProps): ReactElement {
		return (
			<Icon aria-hidden="true" focusable="false" className={className} size={size} strokeWidth={strokeWidth} />
		);
	};
}

export const GearIcon = glyph(Settings, 16);

export const SearchIcon = glyph(Search, 14, 2.2);

export const ChevronLeftIcon = glyph(ChevronLeft, 16, 2.2);

export const ChevronRightIcon = glyph(ChevronRight, 16, 2.2);

export const ChevronRightSmallIcon = glyph(ChevronRight, 12, 2.4);

export const ChevronUpIcon = glyph(ChevronUp, 10, 3);

export const ChevronsUpIcon = glyph(ChevronsUp, 16, 2.2);

export const EyeIcon = glyph(Eye, 14, 2);

export const ThumbsUpIcon = glyph(ThumbsUp, 14, 2);

export const ThumbsDownIcon = glyph(ThumbsDown, 14, 2);

/** Inspector badges: 12px check / copy / trash, matching the reference's `icon(...,12)`. */
export const CheckIcon = glyph(Check, 12, 2.4);

export const CopyIcon = glyph(Copy, 12, 2);

export const TrashIcon = glyph(Trash2, 12, 2);

export const ShareIcon = glyph(Share, 14, 2);

/** Inspector action bar (18px call size is passed by the bar itself). */
export const OpenIcon = glyph(ExternalLink, 16, 2);

export const OpenWithIcon = glyph(AppWindow, 16, 1.9);

export const CompressIcon = glyph(Archive, 16, 1.8);

export const ExtractIcon = glyph(PackageOpen, 16, 1.8);

export const ImageEditIcon = glyph(ImageGlyph, 16, 1.8);

export const VideoConvertIcon = glyph(Film, 16, 1.8);

export const CloseIcon = glyph(X, 10, 3);

export const PlusIcon = glyph(Plus, 14, 2.4);

/**
 * Tab strip: the reference's `icon('close',11)` / `icon('plus',14)` at the
 * default stroke. lucide's `X` and `Plus` split the strokes into separate
 * `<path>`s, which Chromium rasterizes with a soft fringe the reference's
 * single path does not have, so these carry the reference's path data.
 */
const TabX = createLucideIcon("tab-x", [["path", { d: "M6 6l12 12M18 6 6 18", key: "tab-x" }]]);

const TabPlus = createLucideIcon("tab-plus", [["path", { d: "M12 5v14M5 12h14", key: "tab-plus" }]]);

export const TabCloseIcon = glyph(TabX, 11);

export const TabPlusIcon = glyph(TabPlus, 14);

export const SendIcon = glyph(Send, 16, 2.4);

export const SparklesIcon = glyph(Sparkles, 14, 2);

export const ArrowUpIcon = glyph(ArrowUp, 16, 2.6);

export const PencilIcon = glyph(Pencil, 13, 2);

export const RotateIcon = glyph(RotateCw, 10, 2.8);

export const HistoryIcon = glyph(History, 16, 2);

/** AI Search: a dropped web link's attachment chip. */
export const LinkIcon = glyph(Link2, 12, 2.2);

export const IconsViewIcon = glyph(LayoutGrid, 16, 1.9);

export const ListViewIcon = glyph(List, 16, 1.9);

export const ColumnsViewIcon = glyph(Columns3, 16, 1.9);

export const ListRowsIcon = glyph(Rows3, 16, 1.9);

export const PanelLeftIcon = glyph(PanelLeft, 16, 1.9);

export const PanelRightIcon = glyph(PanelRight, 16, 1.9);

/** Toolbar inspector toggle — the mockup's info-circle glyph, not the panel glyph. */
export const InfoIcon = glyph(Info, 16, 1.8);

export const FolderPlusIcon = glyph(FolderPlus, 16, 1.9);

export const FilePlusIcon = glyph(FilePlus, 16, 1.9);

export const SortIcon = glyph(ArrowDownUp, 16, 1.9);

export const GroupIcon = glyph(Layers, 16, 1.9);

export const DatabaseIcon = glyph(Database, 16, 1.8);

export const UsersIcon = glyph(Users, 16, 1.8);


/**
 * Folders render the filled glyph in `--folder`, never a tile (DESIGN.md §5).
 * lucide has no filled folder, so this stays a bespoke path; the classes are the
 * `.tile` + `.tile--folder` pair it used to inherit, now as utilities.
 */
export function FolderGlyph({ size = 18 }: GlyphProps): ReactElement {
	return (
		<svg
			className="flex flex-none items-center justify-center text-folder"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			aria-hidden="true"
			focusable="false"
		>
			<path
				d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"
				fill="currentColor"
			/>
		</svg>
	);
}
