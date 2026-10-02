import type { ReactElement, RefObject } from "react";
import type { IndexStatus } from "../../../shared/index-contract";
import { FileRow, type RowCallbacks } from "./FileRow";
import type { TreeRow } from "../state/folder-tree";
import type { VersionFamilyError } from "../state/version-family";
import { VersionFamilyBanner } from "./VersionFamilyBanner";

/**
 * Scrolling file list (handoff README §2): the search summary, the rows, and
 * the two empty states.
 */
export function FileList({
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
	indexStatus,
	listPath,
	versionFamilyError,
	onRetryVersionFamilies,
	callbacks,
}: {
	readonly rows: readonly TreeRow[];
	readonly listRef: RefObject<HTMLDivElement | null>;
	readonly searching: boolean;
	readonly summary: string;
	readonly emptyText: string;
	readonly selectedKeys: readonly string[];
	readonly focusedZone: boolean;
	readonly flashPath: string | null;
	readonly renamePath: string | null;
	readonly renameDraft: string;
	readonly indexStatus: Readonly<Record<string, IndexStatus>>;
	readonly listPath: string;
	readonly versionFamilyError: VersionFamilyError | null;
	readonly onRetryVersionFamilies: () => void;
	readonly callbacks: RowCallbacks;
}): ReactElement {
	return (
		<div className="list flex-1 min-h-0 py-4 px-8 overflow-auto" ref={listRef}>
			<VersionFamilyBanner error={versionFamilyError} onRetry={onRetryVersionFamilies} />
			{searching ? (
				<div className="list__summary pt-6 px-12 pb-8 text-ink-muted text-meta">{summary}</div>
			) : null}
			<div role={searching ? "grid" : "treegrid"} aria-label="Files">
				{rows.map((row) => (
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
