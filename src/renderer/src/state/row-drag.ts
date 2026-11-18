/**
 * Where a held Finder row drag stands.
 *
 * The Finder drives its row drag from pointer events (`lib/row-drag.ts`):
 * inside the window it is an in-app drag that lands on folder rows, tabs, the
 * listing background, and AI Search; the moment the pointer leaves the window
 * it becomes the OS's native file drag (`webContents.startDrag`). Electron
 * cannot be both in one gesture — a native drag carries no app payload and
 * never comes back to the window as an in-app drop — so the window edge is the
 * switch, and a drag that went native stays native.
 */

export type RowDragPhase = "pending" | "inside" | "native";

/** Pointer travel (px) before a press becomes a drag, so a click never drags. */
export const ROW_DRAG_THRESHOLD = 4;

export interface DragPoint {
	readonly x: number;
	readonly y: number;
}

export interface DragViewport {
	readonly width: number;
	readonly height: number;
}

/** The phase a held row drag moves to for a pointer at `point` (viewport coordinates). */
export function rowDragPhase(phase: RowDragPhase, start: DragPoint, point: DragPoint, viewport: DragViewport): RowDragPhase {
	if (phase === "native") return "native";
	const outside = point.x < 0 || point.y < 0 || point.x >= viewport.width || point.y >= viewport.height;
	if (phase === "pending" && Math.hypot(point.x - start.x, point.y - start.y) < ROW_DRAG_THRESHOLD) return "pending";
	return outside ? "native" : "inside";
}

/** The cursor a held in-app row drag shows (`html[data-row-drag]`). */
export type RowDragCursor = "none" | "move" | "copy" | "link";

/**
 * The verb the cursor shows for the target under the pointer. A target that
 * accepted the drag says what it does by writing `dropEffect` on the
 * `dragover` it received (a pin is "copy": the folder stays where it is), and
 * the cursor says the same. A target that wrote nothing is a plain file drop:
 * the rows move, and ⌥ copies. `accepted` is false when no target called
 * `preventDefault`, which shows the no-drop cursor whatever was written.
 */
export function rowDragCursor(accepted: boolean, dropEffect: string, altKey: boolean): RowDragCursor {
	if (!accepted) return "none";
	if (dropEffect === "copy" || dropEffect === "link" || dropEffect === "move") return dropEffect;
	return altKey ? "copy" : "move";
}
