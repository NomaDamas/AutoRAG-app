import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from "react";
import type { FinderEntry } from "../data/entries";
import { cn } from "../lib/cn";
import { fileKindOf } from "../state/entry-values";
import { tileLabel } from "../state/format";
import { GROUP_HEADER_HEIGHT, groupedLayout, groupedWindow, type GroupSection } from "../state/grouping";
import type { StackRow, VersionFamilyError } from "../state/version-family";
import { GRID_OVERSCAN, columnsForWidth, gridColumnCount } from "../state/virtual";
import { isHiddenName } from "../state/visibility";
import { useDirectoryData, useEntrySidecar } from "../hooks/useDirectoryData";
import { useScrollWindow } from "../hooks/useScrollWindow";
import { useMarquee } from "../hooks/useMarquee";
import { GroupHeader } from "./GroupHeader";
import { type BackgroundDropHandlers, type RowCallbacks } from "./FileRow";
import { FileTile } from "./primitives/FileTile";
import { RenameInput } from "./RenameInput";
import { VersionFamilyBanner } from "./VersionFamilyBanner";

const DEFAULT_COLUMNS = 1;
const DEFAULT_TILE_MIN = 96;
const DEFAULT_TILE_ROW = 124;
const DEFAULT_GAP = 8;
/** The grid template every section's tile block shares; the constants above must match it. */
const GRID_CLASS =
	"icon-grid grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] auto-rows-[var(--tile-row)] gap-8 items-start [--tile-min:96px] [--tile-row:124px]";

/**
 * View mode 1: every entry as a large folder/doc tile on a wrapping grid, its
 * name centered underneath (v7 `.icon-grid` / `.icon-card`). Same selection,
 * open, context menu, and rename behavior as the list rows. The search summary
 * lives in the ScopeBar now, so the grid no longer renders it.
 *
 * Tiles are virtualized (issue #16): only the rows around the viewport mount
 * via top/bottom padding, and a keyboard/reveal target outside the window is
 * pulled into the DOM (see `state/grouping.groupedWindow`) so the controller's
 * `scrollIntoView` still finds it. Grouping (issue #47) renders one header plus
 * one grid block per section; a section's visible tile-rows merge into a single
 * grid so the tracks line up, and the window math runs on the grouped layout.
 */
export function IconGrid({
	sections,
	listRef,
	emptyText,
	selectedKeys,
	focusedZone,
	flashPath,
	renamePath,
	renameDraft,
	versionFamilyError,
	onRetryVersionFamilies,
	background,
	dropBackground,
	callbacks,
	onMarqueeSelect,
}: {
	/** The rows split into the toolbar Group control's sections (one when off). */
	readonly sections: readonly GroupSection<StackRow>[];
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
	readonly background: BackgroundDropHandlers;
	readonly dropBackground: boolean;
	readonly callbacks: RowCallbacks;
	/** A rubber-band drag on empty space: the covered tiles, in view order. */
	readonly onMarqueeSelect: (keys: readonly string[]) => void;
}): ReactElement {
	const contentRef = useRef<HTMLDivElement | null>(null);
	const scroll = useScrollWindow(listRef, contentRef);
	// Tile geometry read from the laid-out grid: tracks per row and one row's
	// stride. Group headers add a fixed block on top of the tile rows.
	const [metrics, setMetrics] = useState({
		columns: DEFAULT_COLUMNS,
		stride: DEFAULT_TILE_ROW + DEFAULT_GAP,
		gap: DEFAULT_GAP,
	});

	const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);

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

	const layout = useMemo(
		() =>
			groupedLayout(
				sections.map((section) => ({ label: section.label, rows: section.rows.length })),
				{
					columns: metrics.columns,
					rowStride: metrics.stride,
					rowGap: metrics.gap,
					headerStride: GROUP_HEADER_HEIGHT,
				},
			),
		[sections, metrics],
	);
	const revealIndex = reveal === null ? -1 : rows.findIndex((row) => row.entry.path === reveal);
	const window = groupedWindow(layout, {
		offset: scroll.offset,
		viewport: scroll.viewport,
		overscan: GRID_OVERSCAN,
		includeRow: revealIndex >= 0 ? revealIndex : undefined,
	});

	const measure = (): void => {
		const element = contentRef.current;
		if (element === null) {
			return;
		}
		// Prefer the resolved grid template (always the real track count); fall
		// back to width math before the first grid block has mounted.
		const grid = element.querySelector<HTMLElement>(".icon-grid");
		const styles = grid === null ? null : getComputedStyle(grid);
		const minTrack = Number.parseFloat(styles?.getPropertyValue("--tile-min") ?? "") || DEFAULT_TILE_MIN;
		const columnGap = styles !== null ? Number.parseFloat(styles.columnGap) || DEFAULT_GAP : DEFAULT_GAP;
		const columns =
			(styles !== null ? gridColumnCount(styles.gridTemplateColumns) : 0) ||
			columnsForWidth(element.clientWidth, minTrack, columnGap);
		const rowHeight =
			Number.parseFloat(styles?.gridAutoRows ?? "") || Number.parseFloat(styles?.getPropertyValue("--tile-row") ?? "") || DEFAULT_TILE_ROW;
		const rowGap = styles !== null ? Number.parseFloat(styles.rowGap) || DEFAULT_GAP : DEFAULT_GAP;
		const stride = rowHeight + rowGap;
		setMetrics((current) =>
			current.columns === columns && current.stride === stride && current.gap === rowGap
				? current
				: { columns, stride, gap: rowGap },
		);
	};
	// Re-measure after every commit: the first grid block mounts only once its
	// listing lands, and the content box can move without a resize event.
	useLayoutEffect(measure);
	useEffect(() => {
		const element = contentRef.current;
		if (element === null) {
			return;
		}
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
		observer?.observe(element);
		return () => {
			observer?.disconnect();
		};
	}, []);

	const rowPaths = useMemo(() => rows.map((row) => row.entry.path), [rows]);
	const marquee = useMarquee(listRef, contentRef, {
		layout,
		geometry: { columns: metrics.columns, rowHeight: metrics.stride - metrics.gap, columnGap: metrics.gap },
		paths: rowPaths,
		selectedKeys,
		onSelect: onMarqueeSelect,
	});

	const padTop = window.start < layout.items.length ? (layout.offsets[window.start] ?? layout.total) : layout.total;
	const padBottom = layout.total - (window.end < layout.items.length ? (layout.offsets[window.end] ?? layout.total) : layout.total);

	// Merge a section's consecutive visible tile-rows into one grid block so
	// the tracks line up; headers stay their own blocks.
	type Block =
		| { readonly kind: "header"; readonly section: number }
		| { kind: "tiles"; section: number; start: number; end: number };
	const blocks: Block[] = [];
	for (const item of layout.items.slice(window.start, window.end)) {
		if (item.kind === "header") {
			blocks.push({ kind: "header", section: item.section });
			continue;
		}
		const last = blocks[blocks.length - 1];
		if (last !== undefined && last.kind === "tiles" && last.section === item.section && last.end === item.start) {
			last.end = item.start + item.count;
		} else {
			blocks.push({ kind: "tiles", section: item.section, start: item.start, end: item.start + item.count });
		}
	}

	// A grid block's CSS gap only sits between rows, so a block the virtual
	// window cuts before its section's last row renders one row-gap shorter than
	// its layout offset; marginBottom restores it (the layout counted a full
	// stride for that row), so padBottom lands the next window exactly and the
	// content height stays stable while scrolling.
	return (
		<div
			className={cn("list list--icons relative flex-1 min-h-0 overflow-auto p-16", dropBackground && "bg-accent-drop-hover")}
			ref={listRef}
			onDragOver={background.onDragOver}
			onDrop={background.onDrop}
			onDragLeave={background.onDragLeave}
			onContextMenu={background.onContextMenu}
			onPointerDown={marquee.onPointerDown}
		>
			<VersionFamilyBanner error={versionFamilyError} onRetry={onRetryVersionFamilies} />
			<div
				ref={contentRef}
				role="listbox"
				aria-label="Files"
				aria-multiselectable="true"
				style={{
					paddingTop: padTop,
					paddingBottom: padBottom,
				}}
			>
				{blocks.map((block) =>
					block.kind === "header" ? (
						<GroupHeader key={`group-${block.section}`} label={sections[block.section]?.label ?? ""} />
					) : (
						<div
							key={`tiles-${block.section}-${block.start}`}
							className={GRID_CLASS}
							style={block.end < (sections[block.section]?.rows.length ?? 0) ? { marginBottom: metrics.gap } : undefined}
						>
							{sections[block.section]?.rows.slice(block.start, block.end).map((row) => (
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
					),
				)}
			</div>
			{rows.length === 0 ? (
				<div className="list__empty py-40 px-12 text-ink-muted text-body text-center">{emptyText}</div>
			) : null}
			{marquee.rect === null ? null : (
				<div
					className="icon-marquee absolute pointer-events-none z-10 border border-accent bg-accent-soft"
					aria-hidden="true"
					style={{
						left: marquee.rect.left,
						top: marquee.rect.top,
						width: marquee.rect.right - marquee.rect.left,
						height: marquee.rect.bottom - marquee.rect.top,
					}}
				/>
			)}
		</div>
	);
}

function IconTile({
	entry: listed,
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
	// Icon and OS kind come from the sidecar: only this tile re-renders when they land.
	const { entry } = useEntrySidecar(useDirectoryData().sidecar, listed);
	// Virtualized: only tiles near the viewport mount, so reporting them fills
	// thumbnails in on scroll for folders larger than the per-call icon cap.
	useEffect(() => {
		if (entry.kind === "file" && entry.iconUrl === undefined) {
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
				callbacks.dropTargetPath === entry.path && "bg-accent-drop-hover shadow-[inset_0_0_0_1.5px_var(--accent)]",
			)}
			role="option"
			aria-selected={selected}
			aria-label={entry.name}
			data-path={entry.path}
			title={entry.name}
			onPointerDown={renameDraft === null ? (event) => callbacks.onPointerDown(entry, event) : undefined}
			onClick={(event) => callbacks.onClick(entry, event)}
			onDoubleClick={() => callbacks.onOpen(entry)}
			onContextMenu={(event) => callbacks.onContextMenu(entry, event)}
			onDragOver={(event) => callbacks.onDragOver(entry, event)}
			onDrop={(event) => callbacks.onDrop(entry, event)}
		>
			<div
				className={cn(
					"icon-tile__art relative flex items-center justify-center w-[72px] h-[72px]",
					child && "rounded-8 shadow-[inset_0_0_0_1px_var(--border-strong)]",
				)}
			>
				<FileTile kind={fileKindOf(entry)} iconUrl={entry.iconUrl} large />
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