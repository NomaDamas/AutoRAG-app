import type { ReactElement, RefObject } from "react";
import type { FinderEntry } from "../data/entries";
import { tileLabel } from "../state/format";
import type { StackRow, VersionFamilyError } from "../state/version-family";
import { isHiddenName } from "../state/visibility";
import type { RowCallbacks } from "./FileRow";
import { FileTile } from "./primitives/FileTile";
import { RenameInput } from "./RenameInput";
import { VersionFamilyBanner } from "./VersionFamilyBanner";

/**
 * View mode 1: every entry as a 64px icon or OS thumbnail on a wrapping grid,
 * its name centered underneath. Same selection, open, context menu, and rename
 * behavior as the list rows.
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
	return (
		<div className="list list--icons" ref={listRef}>
			<VersionFamilyBanner error={versionFamilyError} onRetry={onRetryVersionFamilies} />
			{searching ? <div className="list__summary">{summary}</div> : null}
			<div className="icon-grid" role="listbox" aria-label="Files" aria-multiselectable="true">
				{rows.map((row) => (
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
				<FileTile kind={entry.fileKind} iconDataUrl={entry.iconDataUrl} size={64} />
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
