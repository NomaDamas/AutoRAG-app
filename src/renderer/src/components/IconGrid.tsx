import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type RefObject } from "react";
import type { FinderEntry } from "../data/entries";
import { cn } from "../lib/cn";
import { tileLabel } from "../state/format";
import type { StackRow, VersionFamilyError } from "../state/version-family";
import { GRID_OVERSCAN, columnsForWidth, gridColumnCount, gridWindow } from "../state/virtual";
import { isHiddenName } from "../state/visibility";
import { useScrollWindow } from "../hooks/useScrollWindow";
import type { RowCallbacks } from "./FileRow";
import { FileTile } from "./primitives/FileTile";
import { RenameInput } from "./RenameInput";
import { VersionFamilyBanner } from "./VersionFamilyBanner";

const DEFAULT_COLUMNS = 1;
const DEFAULT_TILE_MIN = 96;
const DEFAULT_TILE_ROW = 124;

/**
 * View mode 1: every entry as a large folder/doc tile on a wrapping grid, its
 * name centered underneath (v7 `.icon-grid` / `.icon-card`). Same selection,
 * open, context menu, and rename behavior as the list rows. The search summary
 * lives in the ScopeBar now, so the grid no longer renders it.
 *
 * Tiles are virtualized (issue #16): the real CSS grid stays in place, the
 * column count is read from its laid-out tracks, and only the rows around the
 * viewport are mounted via top/bottom padding. A keyboard/reveal target outside
 * the window is pulled into the DOM (see `gridWindow`) so the controller's
 * `scrollIntoView` still finds it.
 */
export function IconGrid({
	rows,
	listRef,
	emptyText,
	selectedKeys,
	focusedZone,
	flashPath,
	renamePath,
	renameDraft,
	versionFamilyError,
	onRetryVersionFamilies,
	callbacks,
}: {
	readonly rows: readonly StackRow[];
	readonly listRef: RefObject<HTMLDivElement | null>;
	readonly searching: boolean;
	readonly emptyText: string;
	readonly selectedKeys: readonly string[];
	readonly focusedZone: boolean;
	readonly flashPath: string | null;
	readonly renamePath: string | null;
	readonly renameDraft: string;
	readonly versionFamilyError: VersionFamilyError | null;
	readonly onRetryVersionFamilies: () => void;
	readonly callbacks: RowCallbacks;
}): ReactElement {
	const gridRef = useRef<HTMLDivElement | null>(null);
	const scroll = useScrollWindow(listRef, gridRef);
	const [layout, setLayout] = useState({ columns: DEFAULT_COLUMNS, stride: DEFAULT_TILE_ROW });

	// The controller scrolls to the focused tile by element, so a keyboard or
	// reveal target that lands outside the natural window must still be mounted
	// for one commit. `previous` holds the last committed single selection, so
	// `reveal` is set only on the commit where the selection actually changed.
	const previous = useRef<string | null>(null);
	const single = selectedKeys.length === 1 ? (selectedKeys[0] ?? null) : null;
	const reveal = single !== null && single !== previous.current ? single : null;
	useLayoutEffect(() => {
		previous.current = single;
	}, [single]);

	const revealIndex = reveal === null ? -1 : rows.findIndex((row) => row.entry.path === reveal);
	const totalRows = layout.columns > 0 ? Math.ceil(rows.length / layout.columns) : 0;
	const window = gridWindow({
		count: rows.length,
		offset: scroll.offset,
		viewport: scroll.viewport,
		stride: layout.stride,
		overscan: GRID_OVERSCAN,
		columns: layout.columns,
		include: revealIndex >= 0 ? revealIndex : undefined,
	});

	useLayoutEffect(() => {
		const element = gridRef.current;
		if (element === null) {
			return;
		}
		const measure = (): void => {
			const styles = getComputedStyle(element);
			const minTrack = Number.parseFloat(styles.getPropertyValue("--tile-min")) || DEFAULT_TILE_MIN;
			const columnGap = Number.parseFloat(styles.columnGap) || 0;
			const columns =
				gridColumnCount(styles.gridTemplateColumns) ||
				columnsForWidth(element.clientWidth, minTrack, columnGap);
			const rowHeight = Number.parseFloat(styles.gridAutoRows) || Number.parseFloat(styles.getPropertyValue("--tile-row")) || DEFAULT_TILE_ROW;
			const stride = rowHeight + (Number.parseFloat(styles.rowGap) || 0);
			setLayout((current) => (current.columns === columns && current.stride === stride ? current : { columns, stride }));
		};
		measure();
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
		observer?.observe(element);
		return () => observer?.disconnect();
	}, []);

	return (
		<div className="list list--icons flex-1 min-h-0 overflow-auto p-16" ref={listRef}>
			<VersionFamilyBanner error={versionFamilyError} onRetry={onRetryVersionFamilies} />
			<div
				className="icon-grid grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] auto-rows-[var(--tile-row)] gap-8 items-start [--tile-min:96px] [--tile-row:124px]"
				ref={gridRef}
				role="listbox"
				aria-label="Files"
				aria-multiselectable="true"
				style={{
					paddingTop: window.startRow * layout.stride,
					paddingBottom: (totalRows - window.endRow) * layout.stride,
				}}
			>
				{rows.slice(window.start, window.end).map((row) => (
					<IconTile
						key={row.entry.path}
						entry={row.entry}
						selected={selectedKeys.includes(row.entry.path)}
						focusedZone={focusedZone}
						flash={flashPath === row.entry.path}
						child={row.child}
						stackCount={row.stackCount}
						stackOpen={row.stackOpen}
						renameDraft={renamePath === row.entry.path ? renameDraft : null}
						callbacks={callbacks}
					/>
				))}
			</div>
			{rows.length === 0 ? (
				<div className="list__empty py-40 px-12 text-ink-muted text-body text-center">{emptyText}</div>
			) : null}
		</div>
	);
}

function IconTile({
	entry,
	selected,
	focusedZone,
	flash,
	child,
	stackCount,
	stackOpen,
	renameDraft,
	callbacks,
}: {
	readonly entry: FinderEntry;
	readonly selected: boolean;
	readonly focusedZone: boolean;
	readonly flash: boolean;
	readonly child: boolean;
	readonly stackCount: number;
	readonly stackOpen: boolean;
	readonly renameDraft: string | null;
	readonly callbacks: RowCallbacks;
}): ReactElement {
	// Virtualized: only tiles near the viewport mount, so reporting them fills
	// thumbnails in on scroll for folders larger than the per-call icon cap.
	useEffect(() => {
		if (entry.kind === "file" && (entry.iconUrl === null || entry.iconUrl === undefined)) {
			callbacks.onVisible(entry);
		}
	}, [callbacks.onVisible, entry]);
	return (
		<div
			className={cn(
				"icon-tile icon-card group flex flex-col items-center gap-5 min-h-[100px] p-10 rounded-10 select-none cursor-default transition-[background,box-shadow] duration-(--dur-flash-fade) ease-[ease] text-ink",
				isHiddenName(entry.name) && "opacity-45",
				flash
					? "bg-accent-flash shadow-[inset_0_0_0_1px_var(--accent-flash-ring)]"
					: selected
						? focusedZone
							? "bg-accent-wash shadow-[inset_0_0_0_1.5px_var(--accent)]"
							: "bg-sel-mute"
						: "hover:bg-hover-row",
			)}
			role="option"
			aria-selected={selected}
			aria-label={entry.name}
			data-path={entry.path}
			title={entry.name}
			onClick={(event) => callbacks.onClick(entry, event)}
			onDoubleClick={() => callbacks.onOpen(entry)}
			onContextMenu={(event) => callbacks.onContextMenu(entry, event)}
		>
			<div
				className={cn(
					"icon-tile__art relative flex items-center justify-center w-[72px] h-[72px]",
					child && "rounded-8 shadow-[inset_0_0_0_1px_var(--border-strong)]",
				)}
			>
				<FileTile kind={entry.fileKind} iconUrl={entry.iconUrl} large />
				{stackCount > 0 ? (
					<button
						type="button"
						className={cn(
							`icon-tile__stack${stackOpen ? " icon-tile__stack--open" : ""}`,
							"absolute -right-4 -bottom-2 min-w-20 h-18 px-5 border border-window rounded-9 text-badge font-semibold cursor-pointer",
							stackOpen ? "bg-border-strong text-ink" : "bg-border text-ink-body",
						)}
						title={`다른 버전 ${stackCount}개 · 클릭하면 펼쳐집니다`}
						aria-label={`다른 버전 ${stackCount}개 · 클릭하면 펼쳐집니다`}
						aria-expanded={stackOpen}
						onClick={(event) => {
							event.stopPropagation();
							callbacks.onToggleStack(entry);
						}}
						onDoubleClick={(event) => event.stopPropagation()}
					>
						{stackCount}
					</button>
				) : null}
			</div>
			{renameDraft === null ? (
				<span className="icon-tile__label line-clamp-2 max-w-[90px] py-px px-4 rounded-4 text-meta leading-[1.25] text-center break-words">
					{tileLabel(entry.name)}
				</span>
			) : (
				<RenameInput
					className="row__rename w-full min-w-0 h-pill px-5 border border-accent rounded-5 outline-none bg-window text-ink text-sm"
					draft={renameDraft}
					callbacks={callbacks}
				/>
			)}
		</div>
	);
}
