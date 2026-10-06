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
