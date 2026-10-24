import { useLayoutEffect, useMemo, useRef } from "react";
import type { MouseEvent, ReactElement, RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { FinderEntry } from "../data/entries";
import { useScrollWindow } from "../hooks/useScrollWindow";
import { useDirectoryData, useEntrySidecar } from "../hooks/useDirectoryData";
import { cn } from "../lib/cn";
import { COLUMN_ROW_HEIGHT } from "../state/columns";
import { GROUP_HEADER_HEIGHT, groupedLayout, groupedWindow, type GroupSection } from "../state/grouping";
import { basename } from "../state/paths";
import { LIST_OVERSCAN } from "../state/virtual";
import type { StackRow, VersionFamilyError } from "../state/version-family";
import { isHiddenName } from "../state/visibility";
import { ChevronRightIcon } from "./icons";
import { GroupHeader } from "./GroupHeader";
import { type BackgroundDropHandlers, type RowCallbacks, VersionTag } from "./FileRow";
import { EntryTile } from "./primitives/EntryTile";
import { TagDots } from "./primitives/TagDot";
import { useTagCatalog } from "../hooks/useTagCatalog";
import { tagDotsOf } from "../state/tags";
import { RenameInput } from "./RenameInput";
import { VersionFamilyBanner } from "./VersionFamilyBanner";

export interface ColumnPaneView {
	/** The folder this pane lists. */
	readonly path: string;
	/** False until the folder's first listing arrives. */
	readonly loaded: boolean;
	readonly rows: readonly StackRow[];
	/** The same rows split into the toolbar Group control's sections (one when off). */
	readonly sections: readonly GroupSection<StackRow>[];
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
	paneBackground,
	dropBackgroundDir,
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
	readonly paneBackground: (dir: string) => BackgroundDropHandlers;
	readonly dropBackgroundDir: string | null;
	readonly callbacks: RowCallbacks;
}): ReactElement {
	const { t } = useTranslation();
	return (
		<div className="columns flex flex-1 flex-col min-h-0" ref={listRef}>
			<VersionFamilyBanner error={versionFamilyError} onRetry={onRetryVersionFamilies} />
			<div className="columns__panes flex flex-1 min-h-0">
				{panes.map((pane, index) => (
					<ColumnPane
						key={pane.path}
						pane={pane}
						index={index}
						opened={panes[index + 1]?.path ?? null}
						background={paneBackground(pane.path)}
						dropBackground={dropBackgroundDir === pane.path}
						emptyText={emptyText}
						selectedKeys={selectedKeys}
						focusedZone={focusedZone}
						flashPath={flashPath}
						renamePath={renamePath}
						renameDraft={renameDraft}
						columnCallbacks={columnCallbacks}
						callbacks={callbacks}
					/>
				))}
				{variantColumn === null ? null : (
					<div
						className="column column--variants flex-1 basis-0 min-w-0 min-h-0 p-6 overflow-auto"
						role="listbox"
						aria-label={t("finderComponents.variantColumn")}
						aria-multiselectable="true"
					>
						<div className="column-title flex items-center gap-6 h-28 px-12 text-meta font-semibold text-ink-muted">
							{t("finderComponents.variantColumn")}
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
									callbacks.dropTargetPath === member.entry.path && "bg-accent-drop-hover shadow-[inset_0_0_0_1.5px_var(--accent)]",
								)}
								role="option"
								aria-selected={selectedKeys.includes(member.entry.path)}
								aria-label={member.entry.name}
								data-path={member.entry.path}
								title={member.entry.name}
								onPointerDown={(event) => callbacks.onPointerDown(member.entry, event)}
								onClick={() => onSelectVariant(member.entry)}
								onDoubleClick={() => callbacks.onOpen(member.entry)}
								onContextMenu={(event) => callbacks.onContextMenu(member.entry, event)}
								onDragOver={(event) => callbacks.onDragOver(member.entry, event)}
								onDrop={(event) => callbacks.onDrop(member.entry, event)}
							>
								<SidecarTile entry={member.entry} size={16} />
								<span className="col-name flex-1 min-w-0 overflow-hidden whitespace-nowrap text-ellipsis text-sm">
									{member.entry.name}
								</span>
								<VersionTag tone={member.relation} />
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * One column pane: its own scroller, virtualized like the list view. The pane
 * is sized to the full row count and only the window around its viewport is
 * mounted, so a 5,000-file folder keeps a few dozen rows in the DOM. A
 * keyboard or reveal target outside the window is pulled into the DOM for one
 * commit (see `state/grouping.groupedWindow`) so the controller's
 * `scrollIntoView` still finds its row.
 */
function ColumnPane({
	pane,
	index,
	opened,
	background,
	dropBackground,
	emptyText,
	selectedKeys,
	focusedZone,
	flashPath,
	renamePath,
	renameDraft,
	columnCallbacks,
	callbacks,
}: {
	readonly pane: ColumnPaneView;
	readonly index: number;
	readonly opened: string | null;
	readonly background: BackgroundDropHandlers;
	readonly dropBackground: boolean;
	readonly emptyText: string;
	readonly selectedKeys: readonly string[];
	readonly focusedZone: boolean;
	readonly flashPath: string | null;
	readonly renamePath: string | null;
	readonly renameDraft: string;
	readonly columnCallbacks: ColumnCallbacks;
	readonly callbacks: RowCallbacks;
}): ReactElement {
	const scrollerRef = useRef<HTMLDivElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const scroll = useScrollWindow(scrollerRef, contentRef);
	const layout = useMemo(
		() =>
			groupedLayout(
				pane.sections.map((section) => ({ label: section.label, rows: section.rows.length })),
				{ columns: 1, rowStride: COLUMN_ROW_HEIGHT, headerStride: GROUP_HEADER_HEIGHT },
			),
		[pane.sections],
	);

	// A selection that just landed on one of this pane's rows is mounted for the
	// commit that scrolls to it. `seen` is the last committed single selection;
	// `pending` keeps a target whose row has not been listed yet (a pane still
	// loading) until it appears, then is cleared.
	const single = selectedKeys.length === 1 ? (selectedKeys[0] ?? null) : null;
	const seen = useRef<string | null>(null);
	const pending = useRef<string | null>(null);
	const revealIndex = useMemo(() => {
		if (single === null) return -1;
		let base = 0;
		for (const section of pane.sections) {
			const at = section.rows.findIndex((row) => row.entry.path === single);
			if (at >= 0) return base + at;
			base += section.rows.length;
		}
		return -1;
	}, [pane.sections, single]);
	const reveal = single !== null && (single !== seen.current || pending.current === single);
	useLayoutEffect(() => {
		seen.current = single;
		pending.current = single !== null && revealIndex < 0 ? single : null;
	});

	const window = groupedWindow(layout, {
		offset: scroll.offset,
		viewport: scroll.viewport,
		overscan: LIST_OVERSCAN,
		includeRow: reveal && revealIndex >= 0 ? revealIndex : undefined,
	});
	const padTop = window.start < layout.items.length ? (layout.offsets[window.start] ?? layout.total) : layout.total;
	const padBottom = layout.total - (window.end < layout.items.length ? (layout.offsets[window.end] ?? layout.total) : layout.total);

	return (
		<div
			ref={scrollerRef}
			data-path={pane.path}
			className={cn(
				"column flex-1 basis-0 min-w-0 min-h-0 p-6 overflow-auto border-r border-border",
				dropBackground && "bg-accent-drop-hover",
			)}
			onDragOver={background.onDragOver}
			onDrop={background.onDrop}
			onDragLeave={background.onDragLeave}
			onContextMenu={background.onContextMenu}
		>
			<div ref={contentRef} style={{ paddingTop: padTop, paddingBottom: padBottom }}>
				{layout.items.slice(window.start, window.end).map((item) =>
					item.kind === "header" ? (
						<GroupHeader key={`group-${item.section}`} label={pane.sections[item.section]?.label ?? ""} />
					) : (
						pane.sections[item.section]?.rows.slice(item.start, item.start + item.count).map((row) => (
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
						))
					),
				)}
			</div>
			{pane.loaded && pane.rows.length === 0 ? (
				<div className="column-pane__empty px-8 py-24 text-ink-muted text-meta text-center">{emptyText}</div>
			) : null}
		</div>
	);
}

/** Height is `h-[27px]` = `COLUMN_ROW_HEIGHT`: the pane's virtual window runs on that stride. */
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
	// Icon and OS kind come from the sidecar: only this row re-renders when they land.
	const { entry } = useEntrySidecar(useDirectoryData().sidecar, row.entry);
	const { colors: tagColors } = useTagCatalog();
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
				callbacks.dropTargetPath === entry.path && "bg-accent-drop-hover shadow-[inset_0_0_0_1.5px_var(--accent)]",
			)}
			role="option"
			aria-selected={selected}
			aria-label={entry.name}
			data-path={entry.path}
			title={entry.name}
			onPointerDown={renameDraft === null ? (event) => callbacks.onPointerDown(entry, event) : undefined}
			onClick={(event) => columnCallbacks.onClick(pane, entry, event)}
			onDoubleClick={() => callbacks.onOpen(entry)}
			onContextMenu={(event) => callbacks.onContextMenu(entry, event)}
			onDragOver={(event) => callbacks.onDragOver(entry, event)}
			onDrop={(event) => callbacks.onDrop(entry, event)}
		>
			<EntryTile entry={entry} size={16} />
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
			<TagDots dots={tagDotsOf(entry.finder, tagColors)} size={8} className="ml-auto pl-4" />
			{canOpen ? <ChevronRightIcon size={12} className="col-arrow flex-none ml-2 text-ink-faint" /> : null}
		</div>
	);
}

/** A row's tile with the icon the sidecar holds for it. */
function SidecarTile({ entry, size }: { readonly entry: FinderEntry; readonly size: 16 | 18 | 22 }): ReactElement {
	const resolved = useEntrySidecar(useDirectoryData().sidecar, entry).entry;
	return <EntryTile entry={resolved} size={size} />;
}
