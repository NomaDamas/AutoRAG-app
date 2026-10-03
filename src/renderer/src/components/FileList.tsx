import { useRef, type ReactElement, type RefObject } from "react";
import type { IndexStatus } from "../../../shared/index-contract";
import { FileRow, type RowCallbacks } from "./FileRow";
import type { TreeRow } from "../state/folder-tree";
import type { ListColumnsState } from "../state/list-columns";
import { ROW_HEIGHT } from "../state/selection";
import { LIST_OVERSCAN, linearWindow } from "../state/virtual";
import type { VersionFamilyError } from "../state/version-family";
import { useScrollWindow } from "../hooks/useScrollWindow";
import { VersionFamilyBanner } from "./VersionFamilyBanner";

/**
 * Scrolling file list (v7 `.lv`): the rows and the two empty states. The search
 * summary lives in the ScopeBar now, so the list no longer renders it. Rows are
 * virtualized (issue #16): the container is sized to the full row count and
 * only the window around the viewport is mounted, so a 5,000-entry folder stays
 * cheap to paint. The controller keeps scrolling the list by setting
 * `listRef.current.scrollTop`; this view derives its window from that same
 * element.
 */
export function FileList({
	rows,
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
	callbacks,
}: {
	readonly rows: readonly TreeRow[];
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
	readonly callbacks: RowCallbacks;
}): ReactElement {
	const rowsRef = useRef<HTMLDivElement | null>(null);
	const scroll = useScrollWindow(listRef, rowsRef);
	const window = linearWindow({
		count: rows.length,
		offset: scroll.offset,
		viewport: scroll.viewport,
		stride: ROW_HEIGHT,
		overscan: LIST_OVERSCAN,
	});

	return (
		<div className="list flex-1 min-h-0 py-4 overflow-auto" ref={listRef} style={{ minWidth: minWidth ?? undefined }}>
			<VersionFamilyBanner error={versionFamilyError} onRetry={onRetryVersionFamilies} />
			<div
				ref={rowsRef}
				role={searching ? "grid" : "treegrid"}
				aria-label="Files"
				style={{
					paddingTop: window.start * ROW_HEIGHT,
					paddingBottom: (rows.length - window.end) * ROW_HEIGHT,
				}}
			>
				{rows.slice(window.start, window.end).map((row) => (
					<FileRow
						key={row.entry.path}
						entry={row.entry}
						selected={selectedKeys.includes(row.entry.path)}
						zoneFocused={focusedZone}
						flash={flashPath === row.entry.path}
						searching={searching}
						indexStatus={indexStatus[row.entry.path] ?? null}
						renameDraft={renamePath === row.entry.path ? renameDraft : null}
						stackCount={row.stackCount}
						stackOpen={row.stackOpen}
						child={row.child}
						relation={row.relation}
						depth={row.depth}
						disclosure={row.disclosure}
						listPath={listPath}
						columns={columns}
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
