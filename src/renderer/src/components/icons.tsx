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
	ArrowUp,
	Bell,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	ChevronsUp,
	Columns3,
	Eye,
	History,
	LayoutGrid,
	List,
	Pencil,
	Plus,
	RotateCw,
	Search,
	Send,
	Settings,
	Sparkles,
	ThumbsDown,
	ThumbsUp,
	X,
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

export const BellIcon = glyph(Bell, 16);

export const GearIcon = glyph(Settings, 16);

export const SearchIcon = glyph(Search, 14, 2.2);

export const ChevronLeftIcon = glyph(ChevronLeft, 16, 2.2);

export const ChevronRightIcon = glyph(ChevronRight, 16, 2.2);

export const ChevronUpIcon = glyph(ChevronUp, 10, 3);

export const ChevronsUpIcon = glyph(ChevronsUp, 16, 2.2);

export const EyeIcon = glyph(Eye, 14, 2);

export const ThumbsUpIcon = glyph(ThumbsUp, 14, 2);

export const ThumbsDownIcon = glyph(ThumbsDown, 14, 2);

export const CloseIcon = glyph(X, 10, 3);

export const PlusIcon = glyph(Plus, 14, 2.4);

export const SendIcon = glyph(Send, 16, 2.4);

export const SparklesIcon = glyph(Sparkles, 14, 2);

export const ArrowUpIcon = glyph(ArrowUp, 16, 2.6);

export const PencilIcon = glyph(Pencil, 13, 2);

export const RotateIcon = glyph(RotateCw, 10, 2.8);

export const HistoryIcon = glyph(History, 16, 2);

export const IconsViewIcon = glyph(LayoutGrid, 16, 1.9);

export const ListViewIcon = glyph(List, 16, 1.9);

export const ColumnsViewIcon = glyph(Columns3, 16, 1.9);

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
