import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

export interface ScrollWindow {
	/** Content pixels scrolled past the virtual content's top edge. */
	readonly offset: number;
	/** Visible height of the scroll container in pixels. */
	readonly viewport: number;
}

/**
 * Tracks a scroll container's viewport height and how far its virtual content
 * has scrolled, for the window math in `state/virtual`. `scrollerRef` is the
 * element the controller scrolls (`listRef`); `contentRef` is the first virtual
 * child, whose distance inside the scroller is subtracted so `offset` is
 * measured from the first item rather than from the scroller's padding edge.
 */
export function useScrollWindow(
	scrollerRef: RefObject<HTMLElement | null>,
	contentRef: RefObject<HTMLElement | null>,
): ScrollWindow {
	const [metrics, setMetrics] = useState<ScrollWindow>({ offset: 0, viewport: 0 });
	const frame = useRef<number | null>(null);

	const measure = useCallback(() => {
		const scroller = scrollerRef.current;
		if (scroller === null) {
			return;
		}
		const content = contentRef.current;
		const origin =
			content === null ? 0 : content.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
		const offset = Math.max(0, scroller.scrollTop - origin);
		const viewport = scroller.clientHeight;
		setMetrics((current) => (current.offset === offset && current.viewport === viewport ? current : { offset, viewport }));
	}, [scrollerRef, contentRef]);

	// Re-measure after every commit: the summary or version-family banner can
	// appear above the content and move its origin without a scroll event.
	useLayoutEffect(measure);

	useEffect(() => {
		const scroller = scrollerRef.current;
		if (scroller === null) {
			return;
		}
		const schedule = (): void => {
			if (frame.current !== null) {
				return;
			}
			frame.current = requestAnimationFrame(() => {
				frame.current = null;
				measure();
			});
		};
		scroller.addEventListener("scroll", schedule, { passive: true });
		window.addEventListener("resize", schedule);
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
		observer?.observe(scroller);
		if (contentRef.current !== null) {
			observer?.observe(contentRef.current);
		}
		return () => {
			scroller.removeEventListener("scroll", schedule);
			window.removeEventListener("resize", schedule);
			observer?.disconnect();
			if (frame.current !== null) {
				cancelAnimationFrame(frame.current);
				frame.current = null;
			}
		};
	}, [scrollerRef, contentRef, measure]);

	return metrics;
}
