import type { ChangeEvent, CSSProperties, KeyboardEvent, MouseEvent, ReactElement } from "react";
import type { IndexStatus } from "../../../shared/index-contract";
import { indexStatusBadge } from "../state/badges";
import type { FinderEntry } from "../data/entries";
import type { Disclosure } from "../state/folder-tree";
import { whereSegments } from "../state/paths";
import { relationLabel, type VersionRelation } from "../state/version-family";
import { isHiddenName } from "../state/visibility";
import { ChevronRightIcon } from "./icons";
import { FileTile } from "./primitives/FileTile";
import { PillBadge } from "./primitives/PillBadge";

export interface RowCallbacks {
	readonly onClick: (entry: FinderEntry, event: MouseEvent<HTMLDivElement>) => void;
	readonly onOpen: (entry: FinderEntry) => void;
	readonly onContextMenu: (entry: FinderEntry, event: MouseEvent<HTMLDivElement>) => void;
	readonly onToggleIndex: (entry: FinderEntry) => void;
	readonly onToggleStack: (entry: FinderEntry) => void;
	readonly onToggleFolder: (entry: FinderEntry) => void;
	readonly onRenameChange: (value: string) => void;
	readonly onRenameCommit: () => void;
	readonly onRenameCancel: () => void;
}

/**
 * One 32px file row on --grid-file-row (handoff README §2 "File rows").
 * Selection is a wash, never an edge: --accent-soft while the Finder zone owns
 * focus, --bg-input otherwise.
 */
export function FileRow({
	entry,
	selected,
	zoneFocused,
	flash,
	searching,
	indexStatus,
	renameDraft,
	stackCount,
	stackOpen,
	child,
	relation,
	depth,
	disclosure,
	listPath,
	callbacks,
}: {
	readonly entry: FinderEntry;
	readonly selected: boolean;
	readonly zoneFocused: boolean;
	readonly flash: boolean;
	readonly searching: boolean;
	/** Real AutoRAG index state; null until the first status read returns. */
	readonly indexStatus: IndexStatus | null;
	readonly renameDraft: string | null;
	readonly stackCount: number;
	readonly stackOpen: boolean;
	readonly child: boolean;
	readonly relation: VersionRelation | null;
	/** Folder-tree nesting level; 0 for the listed folder's own rows. */
	readonly depth: number;
	readonly disclosure: Disclosure;
	readonly listPath: string;
	readonly callbacks: RowCallbacks;
}): ReactElement {
	const classes = ["row"];
	if (isHiddenName(entry.name)) {
		classes.push("row--hidden");
	}
	if (selected) {
		classes.push(zoneFocused ? "row--selected-focused" : "row--selected");
	}
	if (flash) {
		classes.push("row--flash");
	}
	if (child) {
		classes.push("row--child");
	}

	return (
		<div
			className={classes.join(" ")}
			role="row"
			data-path={entry.path}
			aria-selected={selected}
			aria-level={disclosure === "none" ? undefined : depth + 1}
			aria-expanded={disclosure === "expanded" ? true : disclosure === "collapsed" ? false : undefined}
			style={depth > 0 ? ({ "--row-depth": depth } as CSSProperties) : undefined}
			onClick={(event) => callbacks.onClick(entry, event)}
			onDoubleClick={() => callbacks.onOpen(entry)}
			onContextMenu={(event) => callbacks.onContextMenu(entry, event)}
		>
			<div className="row__name" role="gridcell">
				{disclosure === "none" ? null : disclosure === "leaf" ? (
					<span className="row__disclosure" aria-hidden="true" />
				) : (
					<button
						type="button"
						className={disclosure === "expanded" ? "row__disclosure row__disclosure--open" : "row__disclosure"}
						aria-label={disclosure === "expanded" ? `${entry.name} 접기` : `${entry.name} 펼치기`}
						aria-expanded={disclosure === "expanded"}
						tabIndex={-1}
						onClick={(event) => {
							event.stopPropagation();
							callbacks.onToggleFolder(entry);
						}}
						onDoubleClick={(event) => event.stopPropagation()}
					>
						<ChevronRightIcon size={10} />
					</button>
				)}
				{child ? <span className="row__connector" aria-hidden="true" /> : <FileTile kind={entry.fileKind} iconUrl={entry.iconUrl} />}
				{renameDraft === null ? (
					<span className="row__label">{entry.name}</span>
				) : (
					<input
						// biome-ignore lint/a11y/noAutofocus: inline rename must take the caret immediately
						autoFocus
						className="row__rename"
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
				{stackCount > 0 ? (
					<button
						type="button"
						className={stackOpen ? "row__stackbadge row__stackbadge--open" : "row__stackbadge"}
						title={`다른 버전 ${stackCount}개 · 클릭하면 펼쳐집니다`}
						aria-label={`다른 버전 ${stackCount}개 · 클릭하면 펼쳐집니다`}
						aria-expanded={stackOpen}
						onClick={(event) => {
							event.stopPropagation();
							callbacks.onToggleStack(entry);
						}}
					>
						<ChevronRightIcon size={9} />
						{stackCount}
					</button>
				) : null}
			</div>
			<span className="row__meta" role="gridcell">
				{entry.dateLabel}
			</span>
			<span className="row__meta row__meta--right" role="gridcell">
				{entry.sizeLabel}
			</span>
			<span className="row__meta" role="gridcell">
				{child && relation !== null
					? relationLabel(relation, entry.location, listPath)
					: searching
						? whereSegments(entry.location)
						: entry.kindLabel}
			</span>
			<div className="row__cell" role="gridcell">
				{entry.kind === "file" ? (
					<PillBadge
						visual={indexStatusBadge(indexStatus)}
						onClick={(event) => {
							event.stopPropagation();
							callbacks.onToggleIndex(entry);
						}}
					/>
				) : null}
			</div>
		</div>
	);
}
