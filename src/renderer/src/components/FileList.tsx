import type { ReactElement, RefObject } from "react";
import type { IndexStatus } from "../../../shared/index-contract";
import type { TreeRow } from "../state/folder-tree";
import type { VersionFamilyError } from "../state/version-family";
import { FileRow, type RowCallbacks } from "./FileRow";
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
		<div className="list" ref={listRef}>
			<VersionFamilyBanner
				error={versionFamilyError}
				onRetry={onRetryVersionFamilies}
			/>
			{searching ? <div className="list__summary">{summary}</div> : null}
			<div role={searching ? "grid" : "treegrid"} aria-label="Files">
				{rows.map((row) => (
					<FileRow
						key={row.entry.path}
						entry={row.entry}
						selected={selectedKeys.includes(row.entry.path)}
						zoneFocused={focusedZone}
						flash={flashPath === row.entry.path}
						searching={searching}
						indexIncluded={indexStatus[row.entry.path]?.kind === "included"}
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
				<div className="list__empty">{emptyText}</div>
			) : null}
		</div>
	);
}
