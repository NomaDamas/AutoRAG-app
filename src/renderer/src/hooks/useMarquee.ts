import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { GroupedLayout } from "../state/grouping";
import { combineMarquee, marqueeHits, marqueeRect, type GridGeometry, type MarqueeMode, type MarqueeRect } from "../state/marquee";
import { ROW_DRAG_THRESHOLD } from "../state/row-drag";

/** The live inputs a drag reads on every move; refreshed each render. */
export interface MarqueeSource {
	readonly layout: GroupedLayout;
	readonly geometry: Omit<GridGeometry, "width">;
	/** Flattened row paths in the order `layout.rowBases` indexes. */
	readonly paths: readonly string[];
	readonly selectedKeys: readonly string[];
	readonly onSelect: (keys: readonly string[]) => void;
}

/** Pixels from the scroller's top/bottom edge where a held drag starts scrolling. */
const EDGE_PX = 24;
/** Scroll speed per frame at the edge, growing with distance past it. */
const EDGE_STEP_PX = 12;

/** Presses that belong to something else: a tile, a control, or a text field. */
const NOT_BACKGROUND = '[role="option"], button, input, textarea, a, [role="alert"]';

/**
 * Finder's rubber-band selection on the icon grid's empty space. A press on
 * the background that travels past the drag threshold draws a rectangle and
 * selects every tile it touches (⌘ toggles them, ⇧ adds them); holding the
 * pointer past the top or bottom edge scrolls and keeps extending. A press
 * that never moves is a background click, which clears the selection unless a
 * modifier is held.
 *
 * Points are kept in the scroller's scroll space, so the rectangle stays
 * pinned to the content while it scrolls. `rect` is in that same space
 * (clamped to the scrollable area) for drawing inside the scroller; hits are
 * computed in the grid content's own space.
 */
export function useMarquee(
	scrollerRef: RefObject<HTMLElement | null>,
	contentRef: RefObject<HTMLElement | null>,
	source: MarqueeSource,
): { readonly rect: MarqueeRect | null; readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void } {
	const [rect, setRect] = useState<MarqueeRect | null>(null);
	const latest = useRef(source);
	latest.current = source;

	const onPointerDown = useCallback(
		(event: ReactPointerEvent<HTMLElement>) => {
			const scroller = scrollerRef.current;
			const content = contentRef.current;
			if (event.button !== 0 || scroller === null || content === null) return;
			if (event.target instanceof Element && event.target.closest(NOT_BACKGROUND) !== null) return;
			// A press on the scrollbar gutter scrolls; it never starts a marquee.
			const box = scroller.getBoundingClientRect();
			if (event.clientX >= box.left + scroller.clientLeft + scroller.clientWidth) return;
			if (event.clientY >= box.top + scroller.clientTop + scroller.clientHeight) return;

			const mode: MarqueeMode = event.metaKey || event.ctrlKey ? "toggle" : event.shiftKey ? "add" : "replace";
			const base = latest.current.selectedKeys;
			const pointerId = event.pointerId;
			/** Client point → the scroller's scroll space. */
			const toScroll = (x: number, y: number) => {
				const bounds = scroller.getBoundingClientRect();
				return {
					x: x - bounds.left - scroller.clientLeft + scroller.scrollLeft,
					y: y - bounds.top - scroller.clientTop + scroller.scrollTop,
				};
			};
			const startClient = { x: event.clientX, y: event.clientY };
			const start = toScroll(startClient.x, startClient.y);
			let client = startClient;
			let dragging = false;
			let lastKeys = "";
			let frame = 0;

			const update = (): void => {
				const area = marqueeRect(start, toScroll(client.x, client.y));
				setRect({
					left: Math.max(0, area.left),
					top: Math.max(0, area.top),
					right: Math.min(scroller.scrollWidth, area.right),
					bottom: Math.min(scroller.scrollHeight, area.bottom),
				});
				// The grid content's origin in scroll space, read now: banners and
				// the virtual padding can move it between moves.
				const origin = toScroll(content.getBoundingClientRect().left, content.getBoundingClientRect().top);
				const inContent = {
					left: area.left - origin.x,
					top: area.top - origin.y,
					right: area.right - origin.x,
					bottom: area.bottom - origin.y,
				};
				const { layout, geometry, paths, onSelect } = latest.current;
				const hits = marqueeHits(layout, { ...geometry, width: content.clientWidth }, inContent).flatMap((index) => {
					const path = paths[index];
					return path === undefined ? [] : [path];
				});
				const keys = combineMarquee(paths, base, hits, mode);
				const signature = keys.join("\n");
				if (signature !== lastKeys) {
					lastKeys = signature;
					onSelect(keys);
				}
			};

			const edgeScroll = (): void => {
				frame = 0;
				if (!dragging) return;
				const bounds = scroller.getBoundingClientRect();
				const above = bounds.top + EDGE_PX - client.y;
				const below = client.y - (bounds.bottom - EDGE_PX);
				const speed = (past: number): number => Math.ceil(EDGE_STEP_PX * Math.min(4, past / EDGE_PX));
				const delta = above > 0 ? -speed(above) : below > 0 ? speed(below) : 0;
				if (delta === 0) return;
				const before = scroller.scrollTop;
				scroller.scrollTop = before + delta;
				if (scroller.scrollTop === before) return;
				update();
				frame = requestAnimationFrame(edgeScroll);
			};

			const onScroll = (): void => {
				if (dragging) update();
			};
			const preventSelect = (select: Event): void => select.preventDefault();

			const onMove = (move: PointerEvent): void => {
				if (move.pointerId !== pointerId) return;
				client = { x: move.clientX, y: move.clientY };
				if (!dragging) {
					if (Math.hypot(client.x - startClient.x, client.y - startClient.y) < ROW_DRAG_THRESHOLD) return;
					dragging = true;
					window.getSelection()?.removeAllRanges();
				}
				update();
				if (frame === 0) frame = requestAnimationFrame(edgeScroll);
			};

			const stop = (): void => {
				window.removeEventListener("pointermove", onMove, true);
				window.removeEventListener("pointerup", onUp, true);
				window.removeEventListener("pointercancel", onCancel, true);
				window.removeEventListener("selectstart", preventSelect, true);
				window.removeEventListener("blur", onCancel);
				scroller.removeEventListener("scroll", onScroll);
				if (frame !== 0) cancelAnimationFrame(frame);
				frame = 0;
				setRect(null);
			};

			function onUp(up: PointerEvent): void {
				if (up.pointerId !== pointerId) return;
				const clicked = !dragging;
				stop();
				if (clicked && mode === "replace" && base.length > 0) latest.current.onSelect([]);
			}

			function onCancel(): void {
				stop();
			}

			window.addEventListener("pointermove", onMove, true);
			window.addEventListener("pointerup", onUp, true);
			window.addEventListener("pointercancel", onCancel, true);
			window.addEventListener("selectstart", preventSelect, true);
			window.addEventListener("blur", onCancel);
			scroller.addEventListener("scroll", onScroll, { passive: true });
		},
		[scrollerRef, contentRef],
	);

	return { rect, onPointerDown };
}
