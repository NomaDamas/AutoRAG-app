import { useRef, type ReactElement, type RefObject } from "react";
import type { IndexStatus } from "../../../shared/index-contract";
import { FileRow, type BackgroundDropHandlers, type RowCallbacks } from "./FileRow";
import { GroupHeader } from "./GroupHeader";
import { cn } from "../lib/cn";
import type { TreeRow } from "../state/folder-tree";
import { GROUP_HEADER_HEIGHT, groupedLayout, groupedWindow, type GroupSection } from "../state/grouping";
import type { ListColumnsState } from "../state/list-columns";
import { ROW_HEIGHT } from "../state/selection";
import { LIST_OVERSCAN } from "../state/virtual";
import type { VersionFamilyError } from "../state/version-family";
import { useScrollWindow } from "../hooks/useScrollWindow";
import { VersionFamilyBanner } from "./VersionFamilyBanner";

/**
 * Scrolling file list (v7 `.lv`): the rows and the two empty states. The search
 * summary lives in the ScopeBar now, so the list no longer renders it. Rows are
 * virtualized (issue #16): the container is sized to the full row count and
 * only the window around the viewport is mounted, so a 5,000-entry folder stays
 * cheap to paint. Grouping (issue #47) inserts a section header between row
 * runs; the header adds fixed height, so the window math runs on the grouped
 * layout in `state/grouping`. The controller keeps scrolling the list by
 * setting `listRef.current.scrollTop`; this view derives its window from that
 * same element.
 */
export function FileList({
	sections,
	listRef,
	searching,
	emptyText,
	selectedKeys,
	focusedZone,
	flashPath,
	renamePath,
	renameDraft,
	indexStatus,
	listPath,
	columns,
	minWidth,
	versionFamilyError,
	onRetryVersionFamilies,
	background,
	dropBackground,
	callbacks,
}: {
	/** The rows split into the toolbar Group control's sections (one when off). */
	readonly sections: readonly GroupSection<TreeRow>[];
	readonly listRef: RefObject<HTMLDivElement | null>;
	readonly searching: boolean;
	readonly emptyText: string;
	readonly selectedKeys: readonly string[];
	readonly focusedZone: boolean;
	readonly flashPath: string | null;
	readonly renamePath: string | null;
	readonly renameDraft: string;
	readonly indexStatus: Readonly<Record<string, IndexStatus>>;
	readonly listPath: string;
	readonly columns: ListColumnsState;
	/** Fixed total track width once the name column is user-resized (x-scroll). */
	readonly minWidth: number | null;
	readonly versionFamilyError: VersionFamilyError | null;
	readonly onRetryVersionFamilies: () => void;
	readonly background: BackgroundDropHandlers;
	readonly dropBackground: boolean;
	readonly callbacks: RowCallbacks;
}): ReactElement {
	const rowsRef = useRef<HTMLDivElement | null>(null);
	const scroll = useScrollWindow(listRef, rowsRef);
	const layout = groupedLayout(
		sections.map((section) => ({ label: section.label, rows: section.rows.length })),
		{ columns: 1, rowStride: ROW_HEIGHT, headerStride: GROUP_HEADER_HEIGHT },
	);
	const window = groupedWindow(layout, {
		offset: scroll.offset,
		viewport: scroll.viewport,
		overscan: LIST_OVERSCAN,
	});
	const rowCount = sections.reduce((total, section) => total + section.rows.length, 0);
	const padTop = window.start < layout.items.length ? (layout.offsets[window.start] ?? layout.total) : layout.total;
	const padBottom = layout.total - (window.end < layout.items.length ? (layout.offsets[window.end] ?? layout.total) : layout.total);

	const row = (row_: TreeRow): ReactElement => (
		<FileRow
			key={row_.entry.path}
			entry={row_.entry}
			selected={selectedKeys.includes(row_.entry.path)}
			zoneFocused={focusedZone}
			flash={flashPath === row_.entry.path}
			searching={searching}
			indexStatus={indexStatus[row_.entry.path] ?? null}
			renameDraft={renamePath === row_.entry.path ? renameDraft : null}
			stackCount={row_.stackCount}
			stackOpen={row_.stackOpen}
			child={row_.child}
			relation={row_.relation}
			depth={row_.depth}
			disclosure={row_.disclosure}
			listPath={listPath}
			columns={columns}
			callbacks={callbacks}
		/>
	);

	return (
		<div
			className={cn("list flex-1 min-h-0 py-4 overflow-auto", dropBackground && "bg-accent-drop-hover")}
			ref={listRef}
			style={{ minWidth: minWidth ?? undefined }}
			onDragOver={background.onDragOver}
			onDrop={background.onDrop}
			onDragLeave={background.onDragLeave}
		>
			<VersionFamilyBanner error={versionFamilyError} onRetry={onRetryVersionFamilies} />
			<div
				ref={rowsRef}
				role={searching ? "grid" : "treegrid"}
				aria-label="Files"
				style={{
					paddingTop: padTop,
					paddingBottom: padBottom,
				}}
			>
				{layout.items.slice(window.start, window.end).map((item) =>
					item.kind === "header" ? (
						<GroupHeader key={`group-${item.section}`} label={sections[item.section]?.label ?? ""} />
					) : (
						sections[item.section]?.rows.slice(item.start, item.start + item.count).map(row)
					),
				)}
			</div>
			{rowCount === 0 ? (
				<div className="list__empty py-40 px-12 text-ink-muted text-body text-center">{emptyText}</div>
			) : null}
		</div>
	);
}