import { useMemo, useRef, type CSSProperties, type ReactElement, type RefObject } from "react";
import { FileRow, type BackgroundDropHandlers, type RowCallbacks } from "./FileRow";
import { GroupHeader } from "./GroupHeader";
import { LIST_SCROLLER_CLASS } from "./list-scroll";
import { cn } from "../lib/cn";
import { disclosureView, type RowSlide } from "../state/disclosure-motion";
import type { TreeRow } from "../state/folder-tree";
import { GROUP_HEADER_HEIGHT, groupedLayout, groupedWindow, type GroupSection } from "../state/grouping";
import type { ListColumnsState } from "../state/list-columns";
import { ROW_HEIGHT } from "../state/selection";
import { LIST_OVERSCAN } from "../state/virtual";
import type { VersionFamilyError } from "../state/version-family";
import { useDisclosureMotion } from "../hooks/useDisclosureMotion";
import { useScrollWindow } from "../hooks/useScrollWindow";
import { VersionFamilyBanner } from "./VersionFamilyBanner";

/** Every row and header after the folder row while its block moves: the whole tail travels as one. */
const BELOW: RowSlide = { part: "below", offset: 0 };

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
 *
 * A folder opening or closing in place (seungwonme/AutoRAG-app#19) slides its rows out from
 * behind the folder row, as Finder's outline view does. The window math stays
 * on the plain list: `disclosureView` hangs a block capped at one screenful
 * under the folder row, so a 5,000-entry folder never draws more than the rows
 * the window already shows. See `state/disclosure-motion`.
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
	const flatRows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
	const motion = useDisclosureMotion({ rows: flatRows, sections, scroll, overscan: LIST_OVERSCAN, target: rowsRef });
	const sliding = motion === null ? null : disclosureView(sections, motion, scroll, LIST_OVERSCAN);
	const shown = sliding?.base ?? sections;
	const layout =
		sliding?.layout ??
		groupedLayout(
			shown.map((section) => ({ label: section.label, rows: section.rows.length })),
			{ columns: 1, rowStride: ROW_HEIGHT, headerStride: GROUP_HEADER_HEIGHT },
		);
	const window =
		sliding?.window ??
		groupedWindow(layout, {
			offset: scroll.offset,
			viewport: scroll.viewport,
			overscan: LIST_OVERSCAN,
		});
	const rowCount = sections.reduce((total, section) => total + section.rows.length, 0);
	const padTop = window.start < layout.items.length ? (layout.offsets[window.start] ?? layout.total) : layout.total;
	const padBottom = layout.total - (window.end < layout.items.length ? (layout.offsets[window.end] ?? layout.total) : layout.total);

	const row = (row_: TreeRow, zebra: boolean, slide?: RowSlide): ReactElement => (
		<FileRow
			key={row_.entry.path}
			entry={row_.entry}
			zebra={zebra}
			selected={selectedKeys.includes(row_.entry.path)}
			zoneFocused={focusedZone}
			flash={flashPath === row_.entry.path}
			searching={searching}
			renameDraft={renamePath === row_.entry.path && slide?.part !== "ghost" ? renameDraft : null}
			stackCount={row_.stackCount}
			stackOpen={row_.stackOpen}
			child={row_.child}
			relation={row_.relation}
			depth={row_.depth}
			disclosure={row_.disclosure}
			listPath={listPath}
			columns={columns}
			callbacks={callbacks}
			slide={slide}
		/>
	);

	// One flat, keyed list: a row keeps its element when a block is hung under
	// the folder row or taken off again, so the motion never remounts a row.
	const nodes: ReactElement[] = [];
	// The rows after the block are striped as they will be once the motion has settled, so the last frame
	// of the motion is the settled list; the stripes can only change when the motion starts.
	const stripeShift = sliding !== null && motion?.kind === "expand" ? sliding.count : 0;
	let afterBlock = false;
	for (let itemIndex = window.start; itemIndex < window.end; itemIndex += 1) {
		const item = layout.items[itemIndex];
		if (item === undefined) continue;
		if (item.kind === "header") {
			nodes.push(<GroupHeader key={`group-${item.section}`} label={sections[item.section]?.label ?? ""} slide={afterBlock} />);
			continue;
		}
		const rowBase = (layout.rowBases[itemIndex] ?? 0) + (afterBlock ? stripeShift : 0);
		shown[item.section]?.rows.slice(item.start, item.start + item.count).forEach((entry, rowIndex) => {
			nodes.push(row(entry, (rowBase + rowIndex) % 2 === 1, afterBlock ? BELOW : undefined));
		});
		if (sliding !== null && itemIndex === sliding.parentItem) {
			const parentStripe = (layout.rowBases[itemIndex] ?? 0) + (item.count - 1);
			sliding.drawn.forEach((entry, blockIndex) => {
				const slide: RowSlide = { part: motion?.kind === "collapse" ? "ghost" : "block", offset: blockIndex * ROW_HEIGHT };
				nodes.push(row(entry, (parentStripe + 1 + blockIndex) % 2 === 1, slide));
			});
			afterBlock = true;
		}
	}

	// While the block is out the list is as tall as the open one and grows or shrinks with the motion.
	const rowsStyle: CSSProperties =
		sliding === null
			? { paddingTop: padTop, paddingBottom: padBottom }
			: ({
					paddingTop: padTop,
					height: `calc(${layout.total + sliding.hidden}px + var(--slide-hc) * var(--slide-q, 1))`,
					"--slide-hc": `${sliding.travel}px`,
				} as CSSProperties);

	return (
		<div
			className={cn(LIST_SCROLLER_CLASS, dropBackground && "bg-accent-drop-hover")}
			ref={listRef}
			style={{ minWidth: minWidth ?? undefined }}
			onDragOver={background.onDragOver}
			onDrop={background.onDrop}
			onDragLeave={background.onDragLeave}
			onContextMenu={background.onContextMenu}
		>
			<VersionFamilyBanner error={versionFamilyError} onRetry={onRetryVersionFamilies} />
			<div ref={rowsRef} role={searching ? "grid" : "treegrid"} aria-label="Files" style={rowsStyle}>
				{nodes}
			</div>
			{rowCount === 0 ? (
				<div className="list__empty py-40 px-12 text-ink-muted text-body text-center">{emptyText}</div>
			) : null}
		</div>
	);

}
