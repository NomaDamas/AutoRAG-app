import { useLayoutEffect, useRef, useState, type ReactElement, type RefObject } from "react";
import type { FinderEntry } from "../data/entries";
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
const DEFAULT_TILE_MIN = 112;
const DEFAULT_TILE_ROW = 128;

/**
 * View mode 1: every entry as a 64px icon or OS thumbnail on a wrapping grid,
 * its name centered underneath. Same selection, open, context menu, and rename
 * behavior as the list rows.
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
	searching,
	summary,
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
	readonly summary: string;
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
		<div className="list list--icons" ref={listRef}>
			<VersionFamilyBanner error={versionFamilyError} onRetry={onRetryVersionFamilies} />
			{searching ? <div className="list__summary">{summary}</div> : null}
			<div
				className="icon-grid"
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
						zoneFocused={focusedZone}
						flash={flashPath === row.entry.path}
						child={row.child}
						stackCount={row.stackCount}
						stackOpen={row.stackOpen}
						renameDraft={renamePath === row.entry.path ? renameDraft : null}
						callbacks={callbacks}
					/>
				))}
			</div>
			{rows.length === 0 ? <div className="list__empty">{emptyText}</div> : null}
		</div>
	);
}

function IconTile({
	entry,
	selected,
	zoneFocused,
	flash,
	child,
	stackCount,
	stackOpen,
	renameDraft,
	callbacks,
}: {
	readonly entry: FinderEntry;
	readonly selected: boolean;
	readonly zoneFocused: boolean;
	readonly flash: boolean;
	readonly child: boolean;
	readonly stackCount: number;
	readonly stackOpen: boolean;
	readonly renameDraft: string | null;
	readonly callbacks: RowCallbacks;
}): ReactElement {
	const classes = ["icon-tile"];
	if (isHiddenName(entry.name)) classes.push("icon-tile--hidden");
	if (selected) classes.push(zoneFocused ? "icon-tile--selected-focused" : "icon-tile--selected");
	if (flash) classes.push("icon-tile--flash");
	if (child) classes.push("icon-tile--child");
	return (
		<div
			className={classes.join(" ")}
			role="option"
			aria-selected={selected}
			aria-label={entry.name}
			data-path={entry.path}
			title={entry.name}
			onClick={(event) => callbacks.onClick(entry, event)}
			onDoubleClick={() => callbacks.onOpen(entry)}
			onContextMenu={(event) => callbacks.onContextMenu(entry, event)}
		>
			<div className="icon-tile__art">
				<FileTile kind={entry.fileKind} iconUrl={entry.iconUrl} size={64} />
				{stackCount > 0 ? (
					<button
						type="button"
						className={stackOpen ? "icon-tile__stack icon-tile__stack--open" : "icon-tile__stack"}
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
				<span className="icon-tile__label">{tileLabel(entry.name)}</span>
			) : (
				<RenameInput className="icon-tile__rename" draft={renameDraft} callbacks={callbacks} />
			)}
		</div>
	);
}
