import { useEffect, type ChangeEvent, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactElement } from "react";
import type { FinderEntry } from "../data/entries";
import { useDirectoryData, useEntrySidecar } from "../hooks/useDirectoryData";
import { dateLabelOf, fileKindOf, kindLabelOf, locationOf, sizeLabelOf } from "../state/entry-values";
import type { Disclosure } from "../state/folder-tree";
import { LIST_COLUMN_OPTIONS, type ListColumnKey, type ListColumnsState, listGridTemplate } from "../state/list-columns";
import { basename, dirname } from "../state/paths";
import { RELATION_LABELS, type VersionRelation } from "../state/version-family";
import { isHiddenName } from "../state/visibility";
import { cn } from "../lib/cn";
import { CheckIcon } from "./icons";
import { FileTile } from "./primitives/FileTile";

/** Handlers for the empty background of a listing (in-app drags and the New menu). */
export interface BackgroundDropHandlers {
	readonly onDragOver: (event: DragEvent<HTMLDivElement>) => void;
	readonly onDrop: (event: DragEvent<HTMLDivElement>) => void;
	readonly onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
	readonly onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
}

export interface RowCallbacks {
	readonly onClick: (entry: FinderEntry, event: MouseEvent<HTMLDivElement>) => void;
	readonly onOpen: (entry: FinderEntry) => void;
	readonly onContextMenu: (entry: FinderEntry, event: MouseEvent<HTMLDivElement>) => void;
	readonly onToggleIndex: (entry: FinderEntry) => void;
	/**
	 * A press on a row that may become a row drag (`lib/row-drag.ts`): an
	 * in-app drag inside the window, the OS's file drag once it leaves.
	 */
	readonly onPointerDown: (entry: FinderEntry, event: PointerEvent<HTMLDivElement>) => void;
	/** An in-app drag hovers the row; folder rows accept it as a drop target. */
	readonly onDragOver: (entry: FinderEntry, event: DragEvent<HTMLDivElement>) => void;
	/** An in-app drag was dropped on the row; folder rows receive the dragged rows. */
	readonly onDrop: (entry: FinderEntry, event: DragEvent<HTMLDivElement>) => void;
	/** The folder row currently under an in-app drag; null when none. */
	readonly dropTargetPath: string | null;
	readonly onToggleStack: (entry: FinderEntry) => void;
	readonly onToggleFolder: (entry: FinderEntry) => void;
	readonly onRenameChange: (value: string) => void;
	readonly onRenameCommit: () => void;
	readonly onRenameCancel: () => void;
	/**
	 * A row/tile mounted without an OS icon. Because both views are virtualized,
	 * this fires only for entries near the viewport, so the controller can fill
	 * thumbnails in as the user scrolls instead of leaning on the single capped
	 * background pass.
	 */
	readonly onVisible: (entry: FinderEntry) => void;
}

const VTAG_BASE = "vtag inline-flex flex-none items-center h-16 px-6 rounded-4 text-tile font-semibold whitespace-nowrap";
const VTAG_TONE: Readonly<Record<"latest" | VersionRelation, string>> = {
	latest: "bg-vtag-latest-bg text-vtag-latest-text",
	near: "bg-vtag-near-bg text-vtag-near-text",
	exact: "bg-vtag-exact-bg text-vtag-exact-text",
	contains: "bg-vtag-exact-bg text-vtag-exact-text",
};

/** v7 `.vtag` — the duplicate-family relation chip shared by the list, columns,
 * and variants rows. */
export function VersionTag({ tone, label }: { readonly tone: "latest" | VersionRelation; readonly label: string }): ReactElement {
	return <span className={`${VTAG_BASE} ${VTAG_TONE[tone]}`}>{label}</span>;
}

const FOLDER_BACK = "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z";
const FOLDER_FRONT = "M3 9h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z";

/** v7 `.vwhere` — the parent folder a family member lives in. */
function LocationChip({ location }: { readonly location: string }): ReactElement {
	return (
		<span className="vwhere inline-flex flex-none items-center gap-3 text-badge text-ink-muted whitespace-nowrap" title={location}>
			<svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
				<path d={FOLDER_BACK} fill="var(--folder)" stroke="var(--folder-stroke)" strokeWidth="0.7" />
				<path d={FOLDER_FRONT} fill="var(--folder-front)" />
			</svg>
			{basename(location)}
		</span>
	);
}

/**
 * One 24px Bloom-style list row: the columns come from
 * `listGridTemplate(columns)`, the name cell carries the disclosure, tile,
 * name, and any version tags. Selection is full-width; while the Finder zone
 * owns focus it is the solid accent with white text, otherwise muted gray.
 */
export function FileRow({
	entry: listed,
	zebra,
	selected,
	zoneFocused,
	flash,
	searching,
	renameDraft,
	stackCount,
	stackOpen,
	relation,
	depth,
	disclosure,
	listPath,
	columns,
	callbacks,
}: {
	readonly entry: FinderEntry;
	readonly zebra: boolean;
	readonly selected: boolean;
	readonly zoneFocused: boolean;
	readonly flash: boolean;
	readonly searching: boolean;
	readonly renameDraft: string | null;
	readonly stackCount: number;
	readonly stackOpen: boolean;
	readonly child: boolean;
	readonly relation: VersionRelation | null;
	/** Folder-tree nesting level; 0 for the listed folder's own rows. */
	readonly depth: number;
	readonly disclosure: Disclosure;
	readonly listPath: string;
	readonly columns: ListColumnsState;
	readonly callbacks: RowCallbacks;
}): ReactElement {
	// The listing row stays as read; its icon, OS kind, metadata, and index
	// state come from the sidecar, and only this row re-renders when they land.
	const { entry, indexStatus } = useEntrySidecar(useDirectoryData().sidecar, listed);
	// Virtualized: only rows near the viewport mount, so reporting them fills
	// thumbnails in on scroll for folders larger than the per-call icon cap.
	useEffect(() => {
		if (entry.kind === "file" && entry.iconUrl === undefined) {
			callbacks.onVisible(entry);
		}
	}, [callbacks.onVisible, entry]);

	const isHead = stackCount > 0;
	const isVariant = relation !== null && !isHead;
	const folderDisclosure = disclosure === "collapsed" || disclosure === "expanded";
	const canOpen = !searching && (folderDisclosure || isHead);
	const open = folderDisclosure ? disclosure === "expanded" : stackOpen;

	const state = indexStatus?.kind ?? "pending";
	// The box shows the user's intent: a file that is wanted but still syncing is checked (dimmed), not blank.
	const included = state === "included";
	const syncing = state === "pending" && indexStatus?.excluded === false;
	const checked = included || syncing;
	// No refresh can ever index these; a checkbox would promise something the librarian will not do.
	const inert = state === "outside" || state === "unsupported" || state === "skipped";

	const rowTone = selected ? (zoneFocused ? "text-on-accent" : "text-ink") : "text-ink";
	const metaTone = selected ? (zoneFocused ? "text-on-accent/80" : "text-ink-muted") : "text-ink-muted";

	const cellText = (key: ListColumnKey): string => {
		switch (key) {
			case "extension": {
				if (entry.kind === "folder") return "—";
				const dot = entry.name.lastIndexOf(".");
				return dot > 0 ? entry.name.slice(dot + 1).toUpperCase() : "—";
			}
			case "date":
				return dateLabelOf(entry);
			case "size":
				return sizeLabelOf(entry);
			case "kind":
				return kindLabelOf(entry);
			case "relativePath":
				return dirname(entry.path);
			case "index":
				return "—";
		}
	};

	const visibleColumns = LIST_COLUMN_OPTIONS.filter(
		(column): column is { readonly key: ListColumnKey; readonly label: string } =>
			column.key !== "name" && columns.visible[column.key],
	);

	return (
		<div
			className={cn(
				"row grid gap-8 items-center h-file-row px-13 rounded-none select-none cursor-default transition-[box-shadow] duration-(--dur-flash-fade) ease-[ease] [&>*]:min-w-0",
				rowTone,
				isHiddenName(entry.name) && "opacity-45",
				flash
					? "bg-accent-flash shadow-[inset_0_0_0_1px_var(--accent-flash-ring)]"
					: selected
						? zoneFocused
							? "bg-accent"
							: "bg-sel-mute"
						: zebra
							? "bg-row-alt hover:bg-hover-row"
							: "bg-window hover:bg-hover-row",
				callbacks.dropTargetPath === entry.path && "bg-accent-drop-hover shadow-[inset_0_0_0_1.5px_var(--accent)]",
			)}
			role="row"
			data-path={entry.path}
			aria-selected={selected}
			aria-level={disclosure === "none" ? undefined : depth + 1}
			aria-expanded={canOpen ? open : undefined}
			style={{ gridTemplateColumns: listGridTemplate(columns) }}
			onPointerDown={renameDraft === null ? (event) => callbacks.onPointerDown(entry, event) : undefined}
			onClick={(event) => callbacks.onClick(entry, event)}
			onDoubleClick={() => callbacks.onOpen(entry)}
			onContextMenu={(event) => callbacks.onContextMenu(entry, event)}
			onDragOver={(event) => callbacks.onDragOver(entry, event)}
			onDrop={(event) => callbacks.onDrop(entry, event)}
		>
			<div className="row__name flex items-center gap-7 min-w-0" role="gridcell">
				<span className="indent flex-none" style={{ width: depth * 16 }} aria-hidden="true" />
				{canOpen ? (
					<button
						type="button"
						className={cn(
							`row__disclosure${open ? " row__disclosure--open" : ""}`,
							"disclosure flex flex-none items-center justify-center w-[13px] h-[17px] p-0 border-0 bg-transparent cursor-default",
							selected ? "text-inherit" : "text-ink-muted",
						)}
						aria-label={`${entry.name} ${isHead ? "유사·중복본 " : ""}${open ? "접기" : "펼치기"}`}
						aria-expanded={open}
						tabIndex={-1}
						onClick={(event) => {
							event.stopPropagation();
							if (isHead) callbacks.onToggleStack(entry);
							else callbacks.onToggleFolder(entry);
						}}
						onDoubleClick={(event) => event.stopPropagation()}
					>
						<span
							className={cn(
								"block border-l-[5px] border-y-[4px] border-l-current border-y-transparent transition-transform duration-(--dur-color) ease-[ease]",
								open && "rotate-90",
							)}
						/>
					</button>
				) : (
					<span className="flex-none w-[13px]" aria-hidden="true" />
				)}
				<FileTile kind={fileKindOf(entry)} iconUrl={entry.iconUrl} />
				{renameDraft === null ? (
					<span
						className={cn(
							"row__label min-w-0 overflow-hidden whitespace-nowrap text-ellipsis text-file-row",
							isVariant && "text-ink-muted",
						)}
					>
						{entry.name}
					</span>
				) : (
					<input
						// biome-ignore lint/a11y/noAutofocus: inline rename must take the caret immediately
						autoFocus
						className="row__rename flex-1 min-w-0 h-pill px-5 border border-accent rounded-5 outline-none bg-window text-ink text-file-row"
						type="text"
						value={renameDraft}
						aria-label="새 이름"
						onChange={(event: ChangeEvent<HTMLInputElement>) => callbacks.onRenameChange(event.target.value)}
						onClick={(event: MouseEvent<HTMLInputElement>) => event.stopPropagation()}
						onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
							if (event.key === "Enter") {
								event.preventDefault();
								callbacks.onRenameCommit();
							}
							if (event.key === "Escape") {
								event.preventDefault();
								callbacks.onRenameCancel();
							}
						}}
						onBlur={callbacks.onRenameCancel}
					/>
				)}
				{isHead ? (
					<>
						<VersionTag tone="latest" label="최신본" />
						<span className="vcount inline-flex flex-none items-center h-16 px-6 rounded-full bg-input text-tile text-ink-muted">
							+{stackCount}
						</span>
					</>
				) : relation !== null ? (
					<>
						<VersionTag tone={relation} label={RELATION_LABELS[relation]} />
						{locationOf(entry) !== listPath ? <LocationChip location={locationOf(entry)} /> : null}
					</>
				) : null}
			</div>
			{visibleColumns.map((column) =>
				column.key === "index" ? (
					<div key="index" className="ix-cell flex min-w-0 justify-center" role="gridcell">
						{entry.kind === "folder" ? null : inert ? (
							<span className={cn("text-meta", metaTone)} title={indexStatus?.detail}>—</span>
						) : (
							<button
								type="button"
								role="checkbox"
								aria-checked={checked}
								className={cn(
									"chk inline-grid flex-none place-items-center size-14 p-0 rounded-4 border cursor-default",
									checked
										? selected
											? "bg-window border-window text-accent"
											: "bg-accent border-accent text-on-accent"
										: cn("bg-window text-accent", selected ? "border-on-accent/90" : "border-border-strong"),
									syncing && "opacity-60",
								)}
								title={indexStatus?.detail ?? (checked ? "AI 검색 인덱스에 포함됨" : "AI 검색 인덱스에서 제외됨")}
								aria-label={checked ? "AI 검색 인덱스에 포함됨" : "AI 검색 인덱스에서 제외됨"}
								onClick={(event) => {
									event.stopPropagation();
									callbacks.onToggleIndex(entry);
								}}
							>
								<CheckIcon size={10} className={checked ? undefined : "opacity-0"} />
							</button>
						)}
					</div>
				) : (
					<span
						key={column.key}
						className={cn(
							"row__meta min-w-0 whitespace-nowrap overflow-hidden text-ellipsis text-file-meta",
							column.key === "size" && "text-right",
							metaTone,
						)}
						role="gridcell"
					>
						{cellText(column.key)}
					</span>
				),
			)}
		</div>
	);
}
