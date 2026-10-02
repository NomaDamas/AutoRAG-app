import type { MouseEvent, ReactElement, RefObject } from "react";
import type { FinderEntry } from "../data/entries";
import { basename } from "../state/paths";
import type { StackRow, VersionFamilyError } from "../state/version-family";
import { isHiddenName } from "../state/visibility";
import { ChevronRightIcon } from "./icons";
import type { RowCallbacks } from "./FileRow";
import { FileTile } from "./primitives/FileTile";
import { RenameInput } from "./RenameInput";
import { VersionFamilyBanner } from "./VersionFamilyBanner";

export interface ColumnPaneView {
	/** The folder this pane lists. */
	readonly path: string;
	/** False until the folder's first listing arrives. */
	readonly loaded: boolean;
	readonly rows: readonly StackRow[];
}

export interface ColumnCallbacks {
	readonly onClick: (pane: number, entry: FinderEntry, event: MouseEvent<HTMLDivElement>) => void;
}

/**
 * View mode 3: up to three equal panes side by side. The first pane is the
 * current folder; each further pane lists the folder chosen in the pane to
 * its left. The chosen folder stays marked in its pane, like Finder's columns.
 */
export function ColumnBrowser({
	panes,
	listRef,
	emptyText,
	selectedKeys,
	focusedZone,
	flashPath,
	renamePath,
	renameDraft,
	versionFamilyError,
	onRetryVersionFamilies,
	columnCallbacks,
	callbacks,
}: {
	readonly panes: readonly ColumnPaneView[];
	readonly listRef: RefObject<HTMLDivElement | null>;
	readonly emptyText: string;
	readonly selectedKeys: readonly string[];
	readonly focusedZone: boolean;
	readonly flashPath: string | null;
	readonly renamePath: string | null;
	readonly renameDraft: string;
	readonly versionFamilyError: VersionFamilyError | null;
	readonly onRetryVersionFamilies: () => void;
	readonly columnCallbacks: ColumnCallbacks;
	readonly callbacks: RowCallbacks;
}): ReactElement {
	return (
		<div className="columns" ref={listRef}>
			<VersionFamilyBanner error={versionFamilyError} onRetry={onRetryVersionFamilies} />
			<div className="columns__panes">
				{panes.map((pane, index) => {
					const opened = panes[index + 1]?.path ?? null;
					return (
						<div
							key={pane.path}
							className="column-pane"
							role="listbox"
							aria-label={basename(pane.path) || pane.path}
							aria-multiselectable="true"
							data-path={pane.path}
						>
							{pane.rows.map((row) => (
								<ColumnRow
									key={row.entry.path}
									pane={index}
									row={row}
									selected={selectedKeys.includes(row.entry.path)}
									opened={opened === row.entry.path}
									zoneFocused={focusedZone}
									flash={flashPath === row.entry.path}
									renameDraft={renamePath === row.entry.path ? renameDraft : null}
									columnCallbacks={columnCallbacks}
									callbacks={callbacks}
								/>
							))}
							{pane.loaded && pane.rows.length === 0 ? <div className="column-pane__empty">{emptyText}</div> : null}
						</div>
					);
				})}
			</div>
		</div>
	);
}

function ColumnRow({
	pane,
	row,
	selected,
	opened,
	zoneFocused,
	flash,
	renameDraft,
	columnCallbacks,
	callbacks,
}: {
	readonly pane: number;
	readonly row: StackRow;
	readonly selected: boolean;
	readonly opened: boolean;
	readonly zoneFocused: boolean;
	readonly flash: boolean;
	readonly renameDraft: string | null;
	readonly columnCallbacks: ColumnCallbacks;
	readonly callbacks: RowCallbacks;
}): ReactElement {
	const { entry } = row;
	const classes = ["column-row"];
	if (isHiddenName(entry.name)) classes.push("column-row--hidden");
	if (selected) classes.push(zoneFocused ? "column-row--selected-focused" : "column-row--selected");
	else if (opened) classes.push("column-row--opened");
	if (flash) classes.push("column-row--flash");
	if (row.child) classes.push("column-row--child");
	return (
		<div
			className={classes.join(" ")}
			role="option"
			aria-selected={selected}
			aria-label={entry.name}
			data-path={entry.path}
			title={entry.name}
			onClick={(event) => columnCallbacks.onClick(pane, entry, event)}
			onDoubleClick={() => callbacks.onOpen(entry)}
			onContextMenu={(event) => callbacks.onContextMenu(entry, event)}
		>
			{row.child ? <span className="row__connector" aria-hidden="true" /> : <FileTile kind={entry.fileKind} iconUrl={entry.iconUrl} size={16} />}
			{renameDraft === null ? (
				<span className="column-row__label">{entry.name}</span>
			) : (
				<RenameInput className="row__rename" draft={renameDraft} callbacks={callbacks} />
			)}
			{row.stackCount > 0 ? (
				<button
					type="button"
					className={row.stackOpen ? "row__stackbadge row__stackbadge--open" : "row__stackbadge"}
					title={`다른 버전 ${row.stackCount}개 · 클릭하면 펼쳐집니다`}
					aria-label={`다른 버전 ${row.stackCount}개 · 클릭하면 펼쳐집니다`}
					aria-expanded={row.stackOpen}
					onClick={(event) => {
						event.stopPropagation();
						callbacks.onToggleStack(entry);
					}}
				>
					<ChevronRightIcon size={9} />
					{row.stackCount}
				</button>
			) : null}
			{entry.kind === "folder" ? <ChevronRightIcon size={12} className="column-row__chevron" /> : null}
		</div>
	);
}
