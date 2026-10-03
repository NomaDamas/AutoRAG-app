import type { MouseEvent, ReactElement, RefObject } from "react";
import type { FinderEntry } from "../data/entries";
import { cn } from "../lib/cn";
import { basename } from "../state/paths";
import { RELATION_LABELS, type StackRow, type VersionFamilyError } from "../state/version-family";
import { isHiddenName } from "../state/visibility";
import { ChevronRightIcon } from "./icons";
import { type RowCallbacks, VersionTag } from "./FileRow";
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

export interface ColumnVariantRow {
	readonly entry: FinderEntry;
	readonly relation: "exact" | "near" | "contains";
}

export interface ColumnVariantView {
	readonly count: number;
	readonly rows: readonly ColumnVariantRow[];
}

export interface ColumnCallbacks {
	readonly onClick: (pane: number, entry: FinderEntry, event: MouseEvent<HTMLDivElement>) => void;
}

/**
 * View mode 3: equal-width panes side by side. The first pane is the current
 * folder; each further pane lists the folder chosen in the pane to its left.
 * The chosen folder stays marked in its pane, like Finder's columns. When a
 * family head is selected a trailing "유사·중복본" pane lists its members.
 */
export function ColumnBrowser({
	panes,
	variantColumn,
	onSelectVariant,
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
	readonly variantColumn: ColumnVariantView | null;
	readonly onSelectVariant: (entry: FinderEntry) => void;
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
		<div className="columns flex flex-1 flex-col min-h-0" ref={listRef}>
			<VersionFamilyBanner error={versionFamilyError} onRetry={onRetryVersionFamilies} />
			<div className="columns__panes flex flex-1 min-h-0">
				{panes.map((pane, index) => {
					const opened = panes[index + 1]?.path ?? null;
					return (
						<div
							key={pane.path}
							className="column flex-1 basis-0 min-w-0 min-h-0 p-6 overflow-auto border-r border-border"
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
									focusedZone={focusedZone}
									opened={opened === row.entry.path}
									flash={flashPath === row.entry.path}
									renameDraft={renamePath === row.entry.path ? renameDraft : null}
									columnCallbacks={columnCallbacks}
									callbacks={callbacks}
								/>
							))}
							{pane.loaded && pane.rows.length === 0 ? (
								<div className="column-pane__empty px-8 py-24 text-ink-muted text-meta text-center">{emptyText}</div>
							) : null}
						</div>
					);
				})}
				{variantColumn === null ? null : (
					<div
						className="column column--variants flex-1 basis-0 min-w-0 min-h-0 p-6 overflow-auto"
						role="listbox"
						aria-label="유사·중복본"
						aria-multiselectable="true"
					>
						<div className="column-title flex items-center gap-6 h-28 px-12 text-meta font-semibold text-ink-muted">
							유사·중복본
							<span className="vcount inline-flex flex-none items-center h-16 px-6 rounded-full bg-input text-tile text-ink-muted">
								{variantColumn.count}
							</span>
						</div>
						{variantColumn.rows.map((member) => (
							<div
								key={member.entry.path}
								className={cn(
									"col-row variant flex items-center gap-7 h-[27px] px-7 rounded-5 select-none cursor-default",
									selectedKeys.includes(member.entry.path)
										? focusedZone
											? "bg-accent text-on-accent"
											: "bg-sel-mute text-ink"
										: "hover:bg-hover-row",
								)}
								role="option"
								aria-selected={selectedKeys.includes(member.entry.path)}
								aria-label={member.entry.name}
								data-path={member.entry.path}
								title={member.entry.name}
								onClick={() => onSelectVariant(member.entry)}
								onDoubleClick={() => callbacks.onOpen(member.entry)}
								onContextMenu={(event) => callbacks.onContextMenu(member.entry, event)}
							>
								<FileTile kind={member.entry.fileKind} iconUrl={member.entry.iconUrl} size={16} />
								<span className="col-name flex-1 min-w-0 overflow-hidden whitespace-nowrap text-ellipsis text-sm">
									{member.entry.name}
								</span>
								<VersionTag tone={member.relation} label={RELATION_LABELS[member.relation]} />
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function ColumnRow({
	pane,
	row,
	selected,
	focusedZone,
	opened,
	flash,
	renameDraft,
	columnCallbacks,
	callbacks,
}: {
	readonly pane: number;
	readonly row: StackRow;
	readonly selected: boolean;
	readonly focusedZone: boolean;
	readonly opened: boolean;
	readonly flash: boolean;
	readonly renameDraft: string | null;
	readonly columnCallbacks: ColumnCallbacks;
	readonly callbacks: RowCallbacks;
}): ReactElement {
	const { entry } = row;
	const isHead = row.stackCount > 0;
	const canOpen = entry.kind === "folder" || isHead;
	return (
		<div
			className={cn(
				"column-row col-row flex items-center gap-7 h-[27px] px-7 rounded-5 select-none cursor-default",
				isHiddenName(entry.name) && "opacity-45",
				flash
					? "bg-accent-flash shadow-[inset_0_0_0_1px_var(--accent-flash-ring)]"
					: selected
						? focusedZone
							? "bg-accent text-on-accent"
							: "bg-sel-mute text-ink"
						: opened || row.child
							? "text-ink-muted"
							: "hover:bg-hover-row",
			)}
			role="option"
			aria-selected={selected}
			aria-label={entry.name}
			data-path={entry.path}
			title={entry.name}
			onClick={(event) => columnCallbacks.onClick(pane, entry, event)}
			onDoubleClick={() => callbacks.onOpen(entry)}
			onContextMenu={(event) => callbacks.onContextMenu(entry, event)}
		>
			<FileTile kind={entry.fileKind} iconUrl={entry.iconUrl} size={16} />
			{renameDraft === null ? (
				<span className="col-name flex-1 min-w-0 overflow-hidden whitespace-nowrap text-ellipsis text-sm">
					{entry.name}
				</span>
			) : (
				<RenameInput
					className="row__rename flex-1 min-w-0 h-pill px-5 border border-accent rounded-5 outline-none bg-window text-ink text-sm"
					draft={renameDraft}
					callbacks={callbacks}
				/>
			)}
			{canOpen ? <ChevronRightIcon size={12} className="col-arrow flex-none ml-auto text-ink-faint" /> : null}
		</div>
	);
}
