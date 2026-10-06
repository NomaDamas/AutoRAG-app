/**
 * The Finder's row drag, driven by the pointer.
 *
 * Electron cannot run one drag as both kinds: a native file drag
 * (`webContents.startDrag`) carries no app payload and never comes back to the
 * window as an in-app drop, while an HTML5 drag can never hand the OS real
 * files. So the row drag is not an HTML5 drag at all. A press on a row becomes
 * a drag past {@link ROW_DRAG_THRESHOLD}; while the pointer stays inside the
 * window this module plays the browser's part — it dispatches `dragenter`,
 * `dragover`, `dragleave`, `drop`, and `dragend` carrying the Finder payload
 * ({@link writeFinderDrag}) to whatever is under the pointer, so every in-app
 * drop target (folder rows, tabs, the listing background, AI Search) keeps its
 * own handlers. The moment the pointer leaves the window the in-app drag ends
 * and the rows go to the OS as real files. See `state/row-drag.ts` for the
 * phase rule.
 */

import type { PointerEvent as ReactPointerEvent } from "react";
import { type FinderDragEntry, writeFinderDrag } from "../state/attachments";
import { type DragPoint, type RowDragPhase, rowDragPhase } from "../state/row-drag";

/** How often a held, still drag repeats `dragover`, as the browser's own drag does. */
const DRAGOVER_REPEAT_MS = 100;
/** The drag image sits below-right of the pointer, clear of the hot spot. */
const GHOST_OFFSET_PX = 12;

export interface RowDragSource {
	/** The rows the drag carries, resolved when the press becomes a drag. */
	entries(): readonly FinderDragEntry[];
	/** The pointer left the window: hand the rows to the OS as real files. */
	startNative(paths: readonly string[]): void;
}

let dragging = false;

/** The in-window drag image: the first row's name, with a count for a multi-row drag. */
function createGhost(entries: readonly FinderDragEntry[]): HTMLElement {
	const ghost = document.createElement("div");
	ghost.className =
		"row-drag-ghost fixed left-0 top-0 z-60 pointer-events-none flex items-center gap-6 h-24 max-w-240 px-8 rounded-6 border border-border bg-window shadow-menu text-file-row text-ink";
	const label = document.createElement("span");
	label.className = "min-w-0 overflow-hidden whitespace-nowrap text-ellipsis";
	label.textContent = entries[0]?.name ?? "";
	ghost.append(label);
	if (entries.length > 1) {
		const count = document.createElement("span");
		count.className = "flex-none px-6 rounded-full bg-accent text-on-accent text-badge font-semibold";
		count.textContent = String(entries.length);
		ghost.append(count);
	}
	document.body.append(ghost);
	return ghost;
}

/**
 * A primary-button press on a row: track it until it is a click, an in-app
 * drop, or a drag that left the window.
 */
export function pressRow(event: ReactPointerEvent<HTMLElement>, source: RowDragSource): void {
	if (event.button !== 0 || dragging) return;
	dragging = true;
	const pointerId = event.pointerId;
	const start: DragPoint = { x: event.clientX, y: event.clientY };
	const root = document.documentElement;
	let phase: RowDragPhase = "pending";
	let point = start;
	let altKey = event.altKey;
	let data: DataTransfer | null = null;
	let paths: readonly string[] = [];
	let ghost: HTMLElement | null = null;
	let target: Element | null = null;
	let accepted = false;
	let repeat = 0;

	const fire = (type: string, element: EventTarget, relatedTarget: Element | null = null): DragEvent => {
		const dragEvent = new DragEvent(type, {
			bubbles: true,
			cancelable: true,
			composed: true,
			dataTransfer: data,
			clientX: point.x,
			clientY: point.y,
			altKey,
			relatedTarget,
		});
		element.dispatchEvent(dragEvent);
		return dragEvent;
	};

	/* The browser's half of a drag: enter/leave as the target changes, then a dragover it may accept. */
	const hover = (): void => {
		if (data === null) return;
		const next = document.elementFromPoint(point.x, point.y);
		if (next !== target) {
			if (target !== null) fire("dragleave", target, next);
			if (next !== null) fire("dragenter", next, target);
			target = next;
		}
		accepted = target !== null && fire("dragover", target).defaultPrevented;
		// A script-built DataTransfer ignores `dropEffect` writes, so the cursor
		// shows the verb every in-app file target applies: move, ⌥ copies.
		root.dataset.rowDrag = accepted ? (altKey ? "copy" : "move") : "none";
		if (ghost !== null) ghost.style.transform = `translate(${point.x + GHOST_OFFSET_PX}px, ${point.y + GHOST_OFFSET_PX}px)`;
	};

	/* The in-app half is over (dropped, cancelled, or gone native): clear what it drew. */
	const endInApp = (drop: boolean): void => {
		window.clearInterval(repeat);
		if (target !== null) {
			if (drop && accepted) fire("drop", target);
			else fire("dragleave", target);
		}
		window.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: data }));
		ghost?.remove();
		delete root.dataset.rowDrag;
	};

	const swallowClick = (click: MouseEvent): void => {
		click.preventDefault();
		click.stopPropagation();
	};

	const stop = (): void => {
		window.removeEventListener("pointermove", onMove, true);
		window.removeEventListener("pointerup", onUp, true);
		window.removeEventListener("pointercancel", onCancel, true);
		window.removeEventListener("keydown", onKey, true);
		window.removeEventListener("keyup", onKey, true);
		window.removeEventListener("blur", onCancel);
		if (root.hasPointerCapture(pointerId)) root.releasePointerCapture(pointerId);
		// The click that follows a drag's release must not select or open the row under it.
		if (phase !== "pending") window.setTimeout(() => window.removeEventListener("click", swallowClick, true), 0);
		dragging = false;
	};

	function onMove(move: PointerEvent): void {
		if (move.pointerId !== pointerId) return;
		point = { x: move.clientX, y: move.clientY };
		altKey = move.altKey;
		const next = rowDragPhase(phase, start, point, { width: window.innerWidth, height: window.innerHeight });
		if (next === "pending") return;
		if (phase === "pending") {
			const entries = source.entries();
			paths = entries.map((entry) => entry.path);
			data = new DataTransfer();
			writeFinderDrag(data, entries);
			window.addEventListener("click", swallowClick, true);
			if (next === "inside") {
				ghost = createGhost(entries);
				// Keep the pointer stream when it crosses the window edge or the row unmounts.
				root.setPointerCapture(pointerId);
				repeat = window.setInterval(hover, DRAGOVER_REPEAT_MS);
			}
		}
		if (next === "native") {
			if (phase === "inside") endInApp(false);
			phase = "native";
			stop();
			source.startNative(paths);
			return;
		}
		phase = "inside";
		hover();
	}

	function onUp(up: PointerEvent): void {
		if (up.pointerId !== pointerId) return;
		if (phase === "inside") {
			point = { x: up.clientX, y: up.clientY };
			altKey = up.altKey;
			hover();
			endInApp(true);
		}
		stop();
	}

	function onCancel(): void {
		if (phase === "inside") endInApp(false);
		stop();
	}

	function onKey(key: KeyboardEvent): void {
		if (phase !== "inside") return;
		if (key.key === "Escape" && key.type === "keydown") {
			key.preventDefault();
			onCancel();
			return;
		}
		if (key.key === "Alt") {
			altKey = key.type === "keydown";
			hover();
		}
	}

	window.addEventListener("pointermove", onMove, true);
	window.addEventListener("pointerup", onUp, true);
	window.addEventListener("pointercancel", onCancel, true);
	window.addEventListener("keydown", onKey, true);
	window.addEventListener("keyup", onKey, true);
	window.addEventListener("blur", onCancel);
}
