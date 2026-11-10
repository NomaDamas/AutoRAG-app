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
	ArrowLeft,
	ArrowUp,
	ChartNoAxesColumn,
	Check,
	ChevronDown,
	FileArchive,
	Maximize,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	ChevronsUp,
	Columns3,
	Copy,
	Database,
	Download,
	Ellipsis,
	Expand,
	ExternalLink,
	Eye,
	File as FileGlyph,
	Film,
	FoldVertical,
	History,
	Image as ImageGlyph,
	Layers,
	LayoutGrid,
	Link2,
	List,
	Maximize2,
	MessagesSquare,
	Mic,
	PackageOpen,
	PanelLeft,
	PanelRight,
	Pencil,
	RefreshCw,
	RotateCw,
	Rows3,
	Search,
	Send,
	SquarePen,
	Settings,
	Share,
	Scissors,
	Shrink,
	Sparkles,
	Trash2,
	TriangleAlert,
	Undo2,
	Users,
	X,
	Zap,
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

/** Sidebar footer: AI usage (bars) and the app-update states (refresh / download). */
export const UsageIcon = glyph(ChartNoAxesColumn, 16, 1.8);

export const DownloadIcon = glyph(Download, 16, 1.8);

export const SearchIcon = glyph(Search, 14, 2.2);

export const ChevronLeftIcon = glyph(ChevronLeft, 16, 2.2);

export const ChevronRightIcon = glyph(ChevronRight, 16, 2.2);

export const ChevronRightSmallIcon = glyph(ChevronRight, 12, 2.4);

export const ChevronUpIcon = glyph(ChevronUp, 10, 3);

export const ChevronsUpIcon = glyph(ChevronsUp, 16, 2.2);

export const EyeIcon = glyph(Eye, 14, 2);

/** Inspector badges: 12px check / copy / trash, matching the reference's `icon(...,12)`. */
export const CheckIcon = glyph(Check, 12, 2.4);

export const CopyIcon = glyph(Copy, 12, 2);

export const TrashIcon = glyph(Trash2, 12, 2);

export const ShareIcon = glyph(Share, 14, 2);

/** Toolbar (Trash view): Finder's put-back arrow and the empty-trash can, 18px like the bar's other glyphs. */
export const PutBackIcon = glyph(Undo2, 18, 2);

export const EmptyTrashIcon = glyph(Trash2, 18, 2);

/** Inspector action bar (18px call size is passed by the bar itself). */
export const OpenIcon = glyph(ExternalLink, 16, 2);

export const OpenWithIcon = glyph(AppWindow, 16, 1.9);

export const CompressIcon = glyph(Archive, 16, 1.8);

export const ReduceSizeIcon = glyph(Shrink, 16, 1.8);

export const ExtractIcon = glyph(PackageOpen, 16, 1.8);

export const ImageEditIcon = glyph(ImageGlyph, 16, 1.8);

export const VideoConvertIcon = glyph(Film, 16, 1.8);

export const CloseIcon = glyph(X, 10, 3);

export const NewChatIcon = glyph(SquarePen, 15, 2);

/** Inspector chat: open the same chat in an AI Search tab, back to Info, and the resume link. */
export const ExpandIcon = glyph(Maximize2, 14, 2);
/** Four corner arrows: the inspector chat's "AI 검색 탭에서 열기" (Figma Icon/확장). */
export const ExpandCornersIcon = glyph(Expand, 16, 1.75);

export const ArrowLeftIcon = glyph(ArrowLeft, 13, 2.2);

export const MessagesIcon = glyph(MessagesSquare, 12, 2);

export const ChevronDownIcon = glyph(ChevronDown, 10, 3);

/** Inspector chat source actions: find the cited file, open it. */
export const FileIcon = glyph(FileGlyph, 12, 2);

/**
 * Tab strip: the reference's `icon('close',11)` / `icon('plus',14)` at the
 * default stroke. lucide's `X` and `Plus` split the strokes into separate
 * `<path>`s, which Chromium rasterizes with a soft fringe the reference's
 * single path does not have, so these carry the reference's path data.
 */
const DazziMark = createLucideIcon("dazzi-mark", [
	["path", { d: "M9.551 6.087C8.56 3.038 10.659 1.082 12 0.7C13.341 1.082 15.44 3.038 14.449 6.087C15.905 3.23 18.772 3.332 19.99 4.01C20.668 5.228 20.77 8.095 17.913 9.551C20.962 8.56 22.918 10.659 23.3 12C22.918 13.341 20.962 15.44 17.913 14.449C20.77 15.905 20.668 18.772 19.99 19.99C18.772 20.668 15.905 20.77 14.449 17.913C15.44 20.962 13.341 22.918 12 23.3C10.659 22.918 8.56 20.962 9.551 17.913C8.095 20.77 5.228 20.668 4.01 19.99C3.332 18.772 3.23 15.905 6.087 14.449C3.038 15.44 1.082 13.341 0.7 12C1.082 10.659 3.038 8.56 6.087 9.551C3.23 8.095 3.332 5.228 4.01 4.01C5.228 3.332 8.095 3.23 9.551 6.087Z", key: "dazzi-0" }],
	["circle", { cx: "12", cy: "12.000", r: "5.1", key: "dazzi-1" }],
	["path", { d: "M7.6 10.7H16.4", key: "dazzi-2" }],
	["path", { d: "M8.3 10.7H11.3V11.8C11.3 12.198 11.142 12.579 10.861 12.861C10.579 13.142 10.198 13.3 9.8 13.3C9.402 13.3 9.021 13.142 8.739 12.861C8.458 12.579 8.3 12.198 8.3 11.8V10.7Z", fill: "currentColor", key: "dazzi-3" }],
	["path", { d: "M12.7 10.7H15.7V11.8C15.7 12.198 15.542 12.579 15.261 12.861C14.979 13.142 14.598 13.3 14.2 13.3C13.802 13.3 13.421 13.142 13.139 12.861C12.858 12.579 12.7 12.198 12.7 11.8V10.7Z", fill: "currentColor", key: "dazzi-4" }],
]);

const ImageConvert = createLucideIcon("image-convert", [
	["path", { d: "M21 11V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6", key: "frame" }],
	["circle", { cx: "9", cy: "9", r: "2", key: "sun" }],
	["path", { d: "m3 16 4.2-4.2a2 2 0 0 1 2.8 0l2 2", key: "hill" }],
	["path", { d: "M15 16h6", key: "to" }],
	["path", { d: "m19 14 2 2-2 2", key: "to-head" }],
	["path", { d: "M21 21h-6", key: "back" }],
	["path", { d: "m17 19-2 2 2 2", key: "back-head" }],
]);

const ImageReduce = createLucideIcon("image-reduce", [
	["path", { d: "M3 7V5a2 2 0 0 1 2-2", key: "c1" }],
	["path", { d: "M9 3h3", key: "c2" }],
	["path", { d: "M17 21h2a2 2 0 0 0 2-2", key: "c3" }],
	["path", { d: "M21 15v-3", key: "c4" }],
	["path", { d: "m21 3-6 6", key: "arrow" }],
	["path", { d: "M15 4v5h5", key: "arrow-head" }],
	["rect", { x: "3", y: "11", width: "10", height: "10", rx: "1", key: "small" }],
	["path", { d: "m5 21 4.144-4.144a1.21 1.21 0 0 1 1.712 0L13 19", key: "hill" }],
]);

const TabX = createLucideIcon("tab-x", [["path", { d: "M6 6l12 12M18 6 6 18", key: "tab-x" }]]);

const TabPlus = createLucideIcon("tab-plus", [["path", { d: "M12 5v14M5 12h14", key: "tab-plus" }]]);

export const TabCloseIcon = glyph(TabX, 11);

export const TabPlusIcon = glyph(TabPlus, 14);

export const SendIcon = glyph(Send, 16, 2.4);

export const SparklesIcon = glyph(Sparkles, 14, 2);

export const ArrowUpIcon = glyph(ArrowUp, 16, 2.6);

export const MicIcon = glyph(Mic, 16, 2);

export const PencilIcon = glyph(Pencil, 13, 2);

export const RotateIcon = glyph(RotateCw, 10, 2.8);

/**
 * File automations: a rule's own glyph in a list row, and the glyph of an
 * `autorag refresh` rule (the zap and the sparkles cover the rest).
 */
export const ZapIcon = glyph(Zap, 11, 2);
export const MoreIcon = glyph(Ellipsis, 16, 2);

export const RefreshIcon = glyph(RefreshCw, 20, 1.8);

export const HistoryIcon = glyph(History, 16, 2);

/** AI Search: a dropped web link's attachment chip. */
export const LinkIcon = glyph(Link2, 12, 2.2);

export const IconsViewIcon = glyph(LayoutGrid, 16, 1.9);

export const ListViewIcon = glyph(List, 16, 1.9);

export const ColumnsViewIcon = glyph(Columns3, 16, 1.9);

export const ListRowsIcon = glyph(Rows3, 16, 1.9);

export const PanelLeftIcon = glyph(PanelLeft, 16, 1.9);

export const PanelRightIcon = glyph(PanelRight, 16, 1.9);

/** A notice that something may not work as expected (a search over an index that is not ready). */
export const WarningIcon = glyph(TriangleAlert, 14, 2);

/** AI Search: the conversation's earlier turns were folded into a summary (issue #389). */
export const CompactIcon = glyph(FoldVertical, 13, 2);

/** AI Search: a search result was cut to fit the model's request. */
export const TrimIcon = glyph(Scissors, 11, 2.2);

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

/** The Dazzi sunflower as a line icon (Figma Icon/dazzi): the right sidebar's show/hide button. */
export const DazziIcon = glyph(DazziMark, 18, 1.35);

/** Change an image's file format (Figma Icon/image-convert). */
export const ImageConvertIcon = glyph(ImageConvert, 16, 1.8);

/** Lower an image's resolution (Figma Icon/image-reduce). */
export const ImageResizeIcon = glyph(ImageReduce, 16, 1.8);

/** Compress into an archive (Figma Icon/zip: a zipped file, no lettering). */
export const ZipIcon = glyph(FileArchive, 16, 1.8);

/** The chat title's history menu chevron and the chat header's ×, at the header's 16px weight. */
export const TitleChevronIcon = glyph(ChevronDown, 16, 1.8);
export const PanelCloseIcon = glyph(X, 16, 1.8);

/** Four corner brackets (Figma Icon/maximize): open the inspector chat in an AI Search tab. */
export const MaximizeIcon = glyph(Maximize, 16, 1.8);
