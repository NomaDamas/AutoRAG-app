import { useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactElement, type RefObject } from "react";
import { GripVertical } from "lucide-react";

/** `items` with the element at `from` taken out and put back at `to`. */
export function moveIndex<T>(items: readonly T[], from: number, to: number): T[] {
	const next = [...items];
	const [moved] = next.splice(from, 1);
	if (moved === undefined) return next;
	next.splice(Math.max(0, Math.min(to, next.length)), 0, moved);
	return next;
}

interface DragState {
	readonly kind: string;
	readonly from: number;
	/** Where the dragged item would land: its position in the previewed order. */
	readonly over: number;
}

export interface Reorder {
	/** The positions to render a list of `length` in: the original indices, rearranged while one of them is dragged. */
	readonly order: (kind: string, length: number) => readonly number[];
	/** Whether the item at original index `index` is the one being dragged. */
	readonly isDragging: (kind: string, index: number) => boolean;
	/** Handlers for the box that holds an item: hovering past its middle moves the dragged one there; dropping commits. */
	readonly target: (
		kind: string,
		index: number,
		length: number,
		onMove: (from: number, to: number) => void,
	) => {
		readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
		readonly onDrop: (event: DragEvent<HTMLElement>) => void;
	};
	/** Handlers for the list around the boxes: the gaps between them (and boxes still sliding) accept the drop too. */
	readonly zone: (
		kind: string,
		onMove: (from: number, to: number) => void,
	) => {
		readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
		readonly onDrop: (event: DragEvent<HTMLElement>) => void;
	};
	/** The handle: drag it (the whole box follows the pointer), or focus it and press ↑/↓. */
	readonly grip: (props: {
		readonly kind: string;
		readonly index: number;
		readonly length: number;
		readonly id: string;
		readonly label: string;
		readonly attr: string;
		readonly onMove: (from: number, to: number) => void;
	}) => ReactElement;
}

/**
 * Drag-to-reorder for the settings lists (사이드바, 우클릭 메뉴). While an item is dragged the list is shown in the
 * order it would have if dropped now, so the other boxes slide out of its way (see `useSlideAnimation`) and the
 * dragged box keeps its own place as a highlighted slot; the drag image is the whole box, not just the handle.
 * Nothing is saved until the drop; leaving the list or pressing Esc puts everything back.
 */
export function useReorder(): Reorder {
	const [drag, setDrag] = useState<DragState | null>(null);

	const order = (kind: string, length: number): readonly number[] => {
		const base = Array.from({ length }, (_, index) => index);
		return drag?.kind === kind ? moveIndex(base, drag.from, drag.over) : base;
	};

	return {
		order,
		isDragging: (kind, index) => drag?.kind === kind && drag.from === index,
		target: (kind, index, length, onMove) => ({
			onDragOver: (event) => {
				if (drag?.kind !== kind) return;
				event.preventDefault();
				event.stopPropagation();
				event.dataTransfer.dropEffect = "move";
				if (index === drag.from) return;
				const positions = order(kind, length);
				const at = positions.indexOf(index);
				const current = positions.indexOf(drag.from);
				// Move only once the pointer passes the box's middle, so boxes of different heights do not flicker.
				const box = event.currentTarget.getBoundingClientRect();
				const middle = box.top + box.height / 2;
				if ((at > current && event.clientY > middle) || (at < current && event.clientY < middle)) {
					setDrag({ ...drag, over: at });
				}
			},
			onDrop: (event) => {
				if (drag?.kind !== kind) return;
				event.preventDefault();
				event.stopPropagation();
				const { from, over } = drag;
				setDrag(null);
				if (from !== over) onMove(from, over);
			},
		}),
		zone: (kind, onMove) => ({
			onDragOver: (event) => {
				if (drag?.kind !== kind) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "move";
			},
			onDrop: (event) => {
				if (drag?.kind !== kind) return;
				event.preventDefault();
				const { from, over } = drag;
				setDrag(null);
				if (from !== over) onMove(from, over);
			},
		}),
		grip: ({ kind, index, length, id, label, attr, onMove }) => (
			<button
				type="button"
				className="sidebar-grip"
				draggable
				{...{ [attr]: id }}
				title={label}
				aria-label={label}
				onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
					if (event.key === "ArrowUp" && index > 0) {
						event.preventDefault();
						onMove(index, index - 1);
					} else if (event.key === "ArrowDown" && index < length - 1) {
						event.preventDefault();
						onMove(index, index + 1);
					}
				}}
				onDragStart={(event) => {
					event.dataTransfer.effectAllowed = "move";
					event.dataTransfer.setData("text/plain", id);
					const box = event.currentTarget.closest<HTMLElement>("[data-reorder-key]");
					if (box !== null) {
						const rect = box.getBoundingClientRect();
						event.dataTransfer.setDragImage(box, event.clientX - rect.left, event.clientY - rect.top);
					}
					setDrag({ kind, from: index, over: index });
				}}
				onDragEnd={() => setDrag(null)}
			>
				<GripVertical size={14} strokeWidth={1.5} aria-hidden="true" />
			</button>
		),
	};
}

function translateY(element: HTMLElement): number {
	const transform = getComputedStyle(element).transform;
	if (transform === "none" || transform === "") return 0;
	return new DOMMatrixReadOnly(transform).m42;
}

/**
 * Slides each `[data-reorder-key]` box under `root` from where it was to where it is after a render (FLIP), so a
 * reordered list moves instead of jumping. Positions are taken against the box's parent, so a row inside a section
 * that moved is not animated twice. Off when the system asks for reduced motion.
 */
export function useSlideAnimation(root: RefObject<HTMLElement | null>): void {
	const tops = useRef(new Map<string, number>());
	useLayoutEffect(() => {
		const container = root.current;
		if (container === null) return;
		const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const next = new Map<string, number>();
		for (const element of container.querySelectorAll<HTMLElement>("[data-reorder-key]")) {
			const key = element.dataset.reorderKey;
			const parent = element.parentElement;
			if (key === undefined || parent === null) continue;
			const top = element.getBoundingClientRect().top - translateY(element) - parent.getBoundingClientRect().top;
			next.set(key, top);
			const previous = tops.current.get(key);
			if (reduce || previous === undefined || Math.abs(previous - top) < 0.5) continue;
			element.style.transition = "none";
			element.style.transform = `translateY(${previous - top}px)`;
			void element.offsetHeight;
			element.style.transition = "transform 180ms cubic-bezier(0.2, 0, 0, 1)";
			element.style.transform = "";
		}
		tops.current = next;
	});
}
