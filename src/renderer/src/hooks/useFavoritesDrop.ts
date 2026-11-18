import { useRef, useState, type DragEvent, type HTMLAttributes, type MouseEvent as ReactMouseEvent } from "react";
import { customPathOfSidebarItemId } from "../../../shared/sidebar-contract";
import type { NavItem } from "../data/places";
import {
	droppedFolders,
	gapAtPointer,
	isMoveInPlace,
	SIDEBAR_ITEM_DRAG_TYPE,
	sidebarDragKind,
} from "../state/sidebar-pins";

/** What the Favorites group hands the sidebar to pin, reorder, and unpin rows. */
export interface FavoritesDropTarget {
	/** The ids of the customizable Favorites rows drawn now, top to bottom. */
	readonly shownIds: readonly string[];
	/** Folders dropped between rows, to pin at `gap`. */
	readonly onPin: (paths: readonly string[], gap: number) => void;
	/** A row dragged between rows, to move to `gap`. */
	readonly onMove: (id: string, gap: number) => void;
	/** Right-click on a row the user pinned. */
	readonly onRowMenu: (item: NavItem, event: ReactMouseEvent<HTMLElement>) => void;
	/** Resolves a file dragged in from another app to its path. */
	readonly pathForFile: (file: File) => string;
}

export interface FavoritesDrop {
	/** Props for the Favorites group element: the drag handlers that find the gap under the pointer. */
	readonly groupProps: HTMLAttributes<HTMLDivElement>;
	/** Props for one row's wrapper: it can be dragged to reorder, and a pinned one opens its menu. */
	rowProps(item: NavItem): HTMLAttributes<HTMLDivElement> & { readonly "data-favorite-id"?: string };
	/** Which edge of `item`'s row carries the insertion line, if any. */
	lineEdge(item: NavItem): "top" | "bottom" | null;
}

const NO_PROPS: HTMLAttributes<HTMLDivElement> = {};

/**
 * Drag handling of the sidebar's Favorites group. A folder dragged between rows
 * pins there, and a row dragged between rows moves there; both show an
 * insertion line at the gap, which is how a pin or move reads differently from
 * dropping ON a row (the AI Search item rings instead and keeps its own drop).
 * The group looks at the pointer, not at a row, so the gap between two rows is
 * as good a target as the rows themselves.
 */
export function useFavoritesDrop(target: FavoritesDropTarget | undefined): FavoritesDrop {
	const [gap, setGap] = useState<number | null>(null);
	const draggingId = useRef<string | null>(null);

	if (target === undefined) return { groupProps: NO_PROPS, rowProps: () => NO_PROPS, lineEdge: () => null };

	const gapOf = (event: DragEvent<HTMLElement>): number => {
		const rows = event.currentTarget.querySelectorAll<HTMLElement>("[data-favorite-id]");
		return gapAtPointer(
			Array.from(rows, (row) => row.getBoundingClientRect()),
			event.clientY,
		);
	};

	const groupProps: HTMLAttributes<HTMLDivElement> = {
		onDragOver: (event) => {
			// The AI Search item claims a drag of Finder rows (it attaches them); a pin never competes with it.
			if (event.defaultPrevented) return;
			const kind = sidebarDragKind(event.dataTransfer);
			if (kind === null) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = kind === "reorder" ? "move" : "copy";
			const next = gapOf(event);
			const inPlace = kind === "reorder" && isMoveInPlace(target.shownIds, draggingId.current ?? "", next);
			setGap(inPlace ? null : next);
		},
		onDragLeave: (event) => {
			if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
			setGap(null);
		},
		onDrop: (event) => {
			setGap(null);
			if (event.defaultPrevented) return;
			const kind = sidebarDragKind(event.dataTransfer);
			if (kind === null) return;
			event.preventDefault();
			const at = gapOf(event);
			if (kind === "reorder") {
				const id = event.dataTransfer.getData(SIDEBAR_ITEM_DRAG_TYPE);
				if (id !== "") target.onMove(id, at);
				return;
			}
			const folders = droppedFolders(event.dataTransfer, target.pathForFile);
			if (folders.length > 0) target.onPin(folders, at);
		},
	};

	return {
		groupProps,
		rowProps: (item) => {
			const id = item.sidebarId;
			if (id === undefined) return NO_PROPS;
			return {
				"data-favorite-id": id,
				draggable: true,
				onDragStart: (event) => {
					draggingId.current = id;
					event.dataTransfer.effectAllowed = "move";
					event.dataTransfer.setData(SIDEBAR_ITEM_DRAG_TYPE, id);
				},
				onDragEnd: () => {
					draggingId.current = null;
					setGap(null);
				},
				onContextMenu: (event) => {
					if (customPathOfSidebarItemId(id) === null) return;
					event.preventDefault();
					target.onRowMenu(item, event);
				},
			};
		},
		lineEdge: (item) => {
			const at = item.sidebarId === undefined ? -1 : target.shownIds.indexOf(item.sidebarId);
			if (gap === null || at < 0) return null;
			if (gap === at) return "top";
			return gap === target.shownIds.length && at === gap - 1 ? "bottom" : null;
		},
	};
}
