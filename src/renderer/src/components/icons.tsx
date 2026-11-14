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

/**
 * The potted flower (Figma 491:12956): a filled flower on a stem in a pot. Its centre is cut out (even-odd), not
 * painted white, so it shows whatever the toolbar sits on in either theme.
 */
export function PottedFlowerIcon({ size = 18, className }: GlyphProps): ReactElement {
	return (
		<svg aria-hidden="true" focusable="false" className={className} width={size} height={size} viewBox="0 0 18 18" fill="currentColor">
			<path fillRule="evenodd" clipRule="evenodd" d="M8.99986 0.672729C8.4405 0.67293 7.8944 0.843086 7.43392 1.16065C6.97344 1.47822 6.62033 1.9282 6.42136 2.45098C5.8625 2.47831 5.32516 2.67495 4.88067 3.01479C4.43617 3.35463 4.10553 3.82161 3.93262 4.35375C3.75972 4.8859 3.75272 5.45804 3.91257 5.99425C4.07242 6.53045 4.39155 7.00537 4.82761 7.35598C4.69523 7.84406 4.69958 8.35914 4.84017 8.84491C4.98076 9.33069 5.25219 9.76847 5.62478 10.1104C5.99737 10.4523 6.45679 10.6853 6.95282 10.7837C7.44885 10.8822 7.96241 10.8424 8.43736 10.6687V12.5632C6.76148 12.5659 5.64473 12.5805 5.00836 12.5925C4.55161 12.6007 4.02511 12.8306 3.95573 13.3837C3.94373 13.4755 3.93748 13.5767 3.93698 13.6875C3.93661 13.8536 3.94411 13.8997 3.95573 13.9912C4.01761 14.4847 4.44323 14.721 4.85873 14.7724C4.92998 15.1181 5.02523 15.5546 5.13098 15.9806C5.34586 16.8461 6.09586 17.3985 6.97448 17.4184C7.46198 17.4296 8.12011 17.4375 8.99948 17.4375C9.87961 17.4375 10.537 17.4296 11.0249 17.4187C11.9039 17.3985 12.6539 16.8461 12.8687 15.9806C12.9745 15.5546 13.0694 15.1181 13.1406 14.7724C13.5561 14.721 13.9821 14.4847 14.044 13.9916C14.0685 13.7897 14.0683 13.5856 14.0436 13.3837C13.9746 12.8306 13.4481 12.6007 12.9914 12.5925C11.8485 12.5731 10.7054 12.5634 9.56236 12.5632V10.6687C10.0373 10.8425 10.5509 10.8823 11.047 10.7838C11.5431 10.6853 12.0026 10.4523 12.3752 10.1103C12.7478 9.76835 13.0192 9.33051 13.1597 8.84467C13.3003 8.35884 13.3046 7.84371 13.1721 7.3556C13.608 7.00496 13.927 6.53007 14.0868 5.99392C14.2466 5.45778 14.2395 4.88573 14.0666 4.35367C13.8937 3.82162 13.5632 3.3547 13.1188 3.01488C12.6744 2.67506 12.1371 2.4784 11.5784 2.45098C11.3794 1.9282 11.0263 1.47822 10.5658 1.16065C10.1053 0.843086 9.55922 0.67293 8.99986 0.672729ZM8.99986 7.68748C8.5523 7.68748 8.12308 7.50969 7.80661 7.19322C7.49015 6.87675 7.31236 6.44753 7.31236 5.99998C7.31236 5.55243 7.49015 5.12321 7.80661 4.80674C8.12308 4.49027 8.5523 4.31248 8.99986 4.31248C9.44741 4.31248 9.87663 4.49027 10.1931 4.80674C10.5096 5.12321 10.6874 5.55243 10.6874 5.99998C10.6874 6.44753 10.5096 6.87675 10.1931 7.19322C9.87663 7.50969 9.44741 7.68748 8.99986 7.68748Z" />
		</svg>
	);
}

/**
 * The right sidebar's toggle (Figma 409:10708 / 403:6565): closed, the blue potted flower (Figma 491:12956), which turns into the plain
 * panel icon while the pointer is on it (or it has keyboard focus), so it reads as the brand and as the control;
 * open, the panel icon alone. The button around it carries Tailwind's `group`.
 */
export function InspectorToggleIcon({ open }: { readonly open: boolean }): ReactElement {
	if (open) return <PanelRightIcon size={18} />;
	return (
		<>
			<span className="flex text-accent group-hover:hidden group-focus-visible:hidden">
				<PottedFlowerIcon />
			</span>
			<span className="hidden group-hover:flex group-focus-visible:flex">
				<PanelRightIcon size={18} />
			</span>
		</>
	);
}

/** Change an image's file format (Figma Icon/image-convert). */
export const ImageConvertIcon = glyph(ImageConvert, 16, 1.8);

/** Lower an image's resolution (Figma Icon/image-reduce). */
export const ImageResizeIcon = glyph(ImageReduce, 16, 1.8);

/** Compress into an archive (Figma Icon/zip: a zipped file, no lettering). */
export const ZipIcon = glyph(FileArchive, 16, 1.8);

/** The inspector chat header's New chat (Figma Icon/edit): a 1.2px line at 16px. */
export const ChatNewIcon = glyph(SquarePen, 16, 1.8);

/** The chat title's history menu chevron and the chat header's ×, at the header's 16px weight. */
export const TitleChevronIcon = glyph(ChevronDown, 16, 1.8);
export const PanelCloseIcon = glyph(X, 16, 1.8);

/** Four corner brackets (Figma Icon/maximize): open the inspector chat in an AI Search tab. */
export const MaximizeIcon = glyph(Maximize, 16, 1.8);
