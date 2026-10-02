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
	classes.push(
		"grid grid-cols-(--grid-file-row) gap-12 items-center h-row pr-8 rounded-6 select-none cursor-default transition-[background,box-shadow] duration-(--dur-flash-fade) ease-[ease]",
		child
			? "pl-[calc(var(--space-12)+18px+var(--row-depth,0)*var(--tree-indent))]"
			: "pl-[calc(var(--space-12)+var(--row-depth,0)*var(--tree-indent))]",
		// State background first, then the hover wash unconditionally: the
		// reference's `.row:hover` is (0,2,0) while every `row--*` state class is
		// (0,1,0), so a hovered row always paints the hover wash, whatever else it
		// is. Making the state exclusive and dropping the hover rule would change
		// a hovered selected row from the wash to the selection tint.
		flash
			? "bg-accent-flash shadow-[inset_0_0_0_1px_var(--accent-flash-ring)]"
			: selected
				? zoneFocused
					? "bg-accent-soft"
					: "bg-input"
				: "",
		"hover:bg-hover-row",
		isHiddenName(entry.name) ? "opacity-45" : "",
	);

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
			<div className="row__name flex items-center gap-10 min-w-0" role="gridcell">
				{disclosure === "none" ? null : disclosure === "leaf" ? (
					<span
						className="row__disclosure flex items-center justify-center flex-none size-disclosure mr-[calc(var(--space-6)-var(--space-10))] p-0 border-0 rounded-5 bg-transparent text-ink-muted cursor-default"
						aria-hidden="true"
					/>
				) : (
					<button
						type="button"
						className={[
							`row__disclosure${disclosure === "expanded" ? " row__disclosure--open" : ""}`,
							"flex items-center justify-center flex-none size-disclosure mr-[calc(var(--space-6)-var(--space-10))] p-0 border-0 rounded-5 bg-transparent text-ink-muted cursor-default hover:text-ink [&_svg]:transition-transform [&_svg]:duration-(--dur-color) [&_svg]:ease-[ease]",
							disclosure === "expanded" ? "[&_svg]:rotate-90" : "",
						].join(" ")}
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
				{child ? (
					<span
						className="row__connector flex-none w-[18px] h-[14px] border-l border-b border-border-strong rounded-bl-4"
						aria-hidden="true"
					/>
				) : (
					<FileTile kind={entry.fileKind} iconDataUrl={entry.iconDataUrl} />
				)}
				{renameDraft === null ? (
					<span
						className={[
							"row__label overflow-hidden whitespace-nowrap text-ellipsis text-body",
							child ? "text-ink-body" : "text-ink",
						].join(" ")}
					>
						{entry.name}
					</span>
				) : (
					<input
						// biome-ignore lint/a11y/noAutofocus: inline rename must take the caret immediately
						autoFocus
						className="row__rename flex-1 min-w-0 h-pill px-5 border border-accent rounded-5 outline-none bg-window text-ink text-body"
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
						className={[
							`row__stackbadge${stackOpen ? " row__stackbadge--open" : ""}`,
							"flex items-center gap-3 flex-none h-18 px-5 border-0 rounded-9 text-badge font-semibold cursor-pointer [&_svg]:transition-transform [&_svg]:duration-(--dur-color) [&_svg]:ease-[ease]",
							stackOpen
								? "bg-border text-ink [&_svg]:rotate-90"
								: "bg-input text-ink-body hover:bg-border",
						].join(" ")}
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
			<span className="row__meta text-ink-muted text-meta whitespace-nowrap overflow-hidden text-ellipsis" role="gridcell">
				{entry.dateLabel}
			</span>
			<span
				className="row__meta row__meta--right text-ink-muted text-meta whitespace-nowrap overflow-hidden text-ellipsis text-right"
				role="gridcell"
			>
				{entry.sizeLabel}
			</span>
			<span className="row__meta text-ink-muted text-meta whitespace-nowrap overflow-hidden text-ellipsis" role="gridcell">
				{child && relation !== null
					? relationLabel(relation, entry.location, listPath)
					: searching
						? whereSegments(entry.location)
						: entry.kindLabel}
			</span>
			<div className="row__cell flex min-w-0" role="gridcell">
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
