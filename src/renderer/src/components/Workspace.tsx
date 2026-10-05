import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type ReactElement, type ReactNode } from "react";
import { cn } from "../lib/cn";
import {
	canDropTab,
	dropPreviewRect,
	dropZoneAt,
	paneRects,
	splitHandles,
	stripDropIndex,
	stripGapAt,
	type PaneEdge,
	type PaneLayout,
	type SplitHandle,
	type TabDropTarget,
	type UnitRect,
	type Workspace,
} from "../state/workspace";

/** The drag payload that marks a strip tab (not a Finder row or an OS file). */
export const TAB_DRAG_TYPE = "application/x-dazzi-tab";

/** Smallest pane share a split-handle drag leaves, in px of the split's extent. */
const MIN_PANE_PX = 220;

interface Box {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** What the drop overlay shows: the target and where the tab would end up. */
interface DropState {
	readonly target: TabDropTarget;
	/** The drop preview, in workspace px. */
	readonly preview: Box;
	/** A strip insertion caret, in workspace px (strip targets only). */
	readonly caret: Box | null;
}

function scale(rect: UnitRect, size: { readonly width: number; readonly height: number }): Box {
	return { x: rect.x * size.width, y: rect.y * size.height, width: rect.width * size.width, height: rect.height * size.height };
}

/** Pixel-snapped absolute placement, so neighboring panes never overlap or leave a seam. */
function placement(box: Box): { left: number; top: number; width: number; height: number } {
	const left = Math.round(box.x);
	const top = Math.round(box.y);
	return { left, top, width: Math.round(box.x + box.width) - left, height: Math.round(box.y + box.height) - top };
}

export function isTabDrag(types: ArrayLike<string>): boolean {
	return Array.from(types).includes(TAB_DRAG_TYPE);
}

/** The layout's structure without sizes: changes when panes open, close, or move, not on a resize. */
function layoutShape(layout: PaneLayout): string {
	return layout.kind === "pane" ? String(layout.paneId) : `${layout.direction}(${layout.children.map(layoutShape).join(",")})`;
}

/**
 * The split-pane area. Panes are absolutely placed from the layout tree so a
 * pane keeps its DOM (and its controller) while splits open and close; sizes
 * and positions glide with `--dur-pane`. While a strip tab is dragged, an
 * overlay maps the pointer to a drop target and previews the result: an edge
 * band of a pane splits it, its middle merges into it, and a strip inserts
 * at the caret.
 */
export function WorkspaceView({
	workspace,
	draggingTabId,
	renderPane,
	onDrop,
	onResize,
	overlay,
}: {
	readonly workspace: Workspace;
	/** The strip tab being dragged, or null. */
	readonly draggingTabId: number | null;
	readonly renderPane: (paneId: number) => ReactNode;
	readonly onDrop: (tabId: number, target: TabDropTarget) => void;
	readonly onResize: (handle: SplitHandle, delta: number, minShare: number) => void;
	/** Content placed over the panes (AI Search chats on their pane bodies; see `percentPlacement`); `motion` is the glide class to share. */
	readonly overlay?: (rects: ReadonlyMap<number, UnitRect>, motion: string) => ReactNode;
}): ReactElement {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });
	useLayoutEffect(() => {
		const root = rootRef.current;
		if (root === null) return;
		const measure = (): void => {
			const { width, height } = root.getBoundingClientRect();
			setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(root);
		return () => observer.disconnect();
	}, []);

	// Window resizes and split-handle drags track the pointer 1:1; only a pane
	// opening, closing, or moving (a structural change) glides.
	const [animate, setAnimate] = useState(false);
	const shape = layoutShape(workspace.layout);
	const shapeRef = useRef(shape);
	if (shapeRef.current !== shape) {
		shapeRef.current = shape;
		if (!animate) setAnimate(true);
	}
	useEffect(() => {
		if (!animate) return;
		const timer = window.setTimeout(() => setAnimate(false), 320);
		return () => window.clearTimeout(timer);
	}, [animate, shape]);

	const motion = animate ? "transition-[left,top,width,height] duration-(--dur-pane) ease-(--ease-pane)" : "";
	const mountedRef = useRef(false);
	useEffect(() => {
		mountedRef.current = true;
	}, []);

	const rects = paneRects(workspace.layout);
	const boxes = new Map<number, Box>();
	// Pixel boxes for drag hit-testing and the drop preview (panes themselves are placed in %).
	// Panes not touching the right/bottom edge give up 1px there: the seam between neighbors.
	for (const [paneId, rect] of rects) {
		const box = scale(rect, size);
		const seamX = rect.x + rect.width < 0.9999 ? 1 : 0;
		const seamY = rect.y + rect.height < 0.9999 ? 1 : 0;
		boxes.set(paneId, { ...box, width: box.width - seamX, height: box.height - seamY });
	}
	const handles = splitHandles(workspace.layout);
	const split = workspace.panes.length > 1;

	/* ------------------------------------------------------ tab drag overlay */
	const [drop, setDrop] = useState<DropState | null>(null);
	useEffect(() => {
		if (draggingTabId === null) setDrop(null);
	}, [draggingTabId]);

	/** Map a pointer (client px) to the drop target under it, with its preview. */
	const resolveDrop = useCallback(
		(clientX: number, clientY: number, tabId: number): DropState | null => {
			const root = rootRef.current;
			if (root === null) return null;
			const origin = root.getBoundingClientRect();
			const x = clientX - origin.left;
			const y = clientY - origin.top;
			for (const pane of workspace.panes) {
				const box = boxes.get(pane.id);
				if (box === undefined || x < box.x || x > box.x + box.width || y < box.y || y > box.y + box.height) continue;
				const strip = root.querySelector<HTMLElement>(`[data-pane-id="${pane.id}"] .tabs`);
				const stripBox = strip?.getBoundingClientRect();
				const stripBottom = stripBox === undefined ? box.y + 25 : stripBox.bottom - origin.top;
				if (y <= stripBottom && strip !== null) {
					const tabs = Array.from(strip.querySelectorAll<HTMLElement>(".tab")).map((element) => {
						const tab = element.getBoundingClientRect();
						return { id: Number(element.dataset.tabId), left: tab.left - origin.left, width: tab.width };
					});
					const gap = stripGapAt(x, tabs);
					const fromIndex = tabs.findIndex((tab) => tab.id === tabId);
					const target: TabDropTarget = { kind: "strip", paneId: pane.id, index: stripDropIndex(gap, fromIndex < 0 ? null : fromIndex) };
					if (!canDropTab(workspace, tabId, target)) return null;
					const last = tabs[tabs.length - 1];
					const caretX = gap < tabs.length ? (tabs[gap]?.left ?? box.x) : last === undefined ? box.x : last.left + last.width;
					return {
						target,
						preview: { x: box.x, y: box.y, width: box.width, height: stripBottom - box.y },
						caret: { x: caretX - 1, y: box.y + 3, width: 2, height: stripBottom - box.y - 6 },
					};
				}
				const body = { x: box.x, y: stripBottom, width: box.width, height: box.y + box.height - stripBottom };
				const zone = dropZoneAt((x - body.x) / body.width, (y - body.y) / body.height);
				const target: TabDropTarget = zone === "center" ? { kind: "pane", paneId: pane.id } : { kind: "split", paneId: pane.id, edge: zone as PaneEdge };
				if (!canDropTab(workspace, tabId, target)) return null;
				return { target, preview: dropPreviewRect(zone, box), caret: null };
			}
			return null;
		},
		[workspace, boxes],
	);

	const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
		if (draggingTabId === null || !isTabDrag(event.dataTransfer.types)) return;
		const next = resolveDrop(event.clientX, event.clientY, draggingTabId);
		if (next !== null) {
			event.preventDefault();
			event.dataTransfer.dropEffect = "move";
		}
		setDrop((current) => (sameDrop(current, next) ? current : next));
	};

	const onDropEvent = (event: DragEvent<HTMLDivElement>): void => {
		if (draggingTabId === null || !isTabDrag(event.dataTransfer.types)) return;
		event.preventDefault();
		const next = resolveDrop(event.clientX, event.clientY, draggingTabId);
		setDrop(null);
		if (next !== null) onDrop(draggingTabId, next.target);
	};

	return (
		<div
			ref={rootRef}
			className="workspace relative min-w-0 min-h-0 flex-1 overflow-hidden bg-tabstrip-line"
			data-split={split ? "true" : undefined}
			// Blink fires no dragover on a move that changes the hovered element (only enter/leave),
			// so a fast pointer would freeze the preview: both events resolve the target.
			onDragEnterCapture={onDragOver}
			onDragOverCapture={onDragOver}
			onDropCapture={onDropEvent}
			onDragLeave={(event) => {
				if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
				setDrop(null);
			}}
		>
			{workspace.panes.map((pane) => {
				const rect = rects.get(pane.id);
				if (rect === undefined) return null;
				return (
					<PaneFrame key={pane.id} paneId={pane.id} rect={rect} motion={motion} enter={mountedRef.current}>
						{renderPane(pane.id)}
					</PaneFrame>
				);
			})}
			{overlay?.(rects, motion)}
			{handles.map((handle) => (
				<SplitGrip key={`${handle.splitId}:${handle.index}`} handle={handle} size={size} onResize={onResize} />
			))}
			{drop === null ? null : (
				<>
					<div
						className={cn(
							"workspace-drop-preview pointer-events-none absolute z-50 animate-drop-in",
							"transition-[left,top,width,height] duration-(--dur-pane) ease-(--ease-pane)",
							// A strip insertion is a quiet wash: the caret says where the tab lands.
							drop.caret === null ? "rounded-6 border-[1.5px] border-accent bg-accent-soft" : "rounded-4 bg-accent-drop-hover",
						)}
						data-drop-kind={drop.target.kind}
						data-drop-pane={drop.target.paneId}
						data-drop-edge={drop.target.kind === "split" ? drop.target.edge : undefined}
						style={placement(inset(drop.preview, drop.caret === null ? 4 : 1))}
					/>
					{drop.caret === null ? null : (
						<div
							className="workspace-drop-caret pointer-events-none absolute z-50 rounded-full bg-accent shadow-[0_0_0_2px_var(--accent-soft)] transition-[left] duration-(--dur-menu) ease-(--ease-pane)"
							style={placement(drop.caret)}
						/>
					)}
				</>
			)}
		</div>
	);
}

function inset(box: Box, by: number): Box {
	return { x: box.x + by, y: box.y + by, width: Math.max(0, box.width - by * 2), height: Math.max(0, box.height - by * 2) };
}

/**
 * A pane's placed box, in percentages of the workspace so a window resize
 * reflows it in the same layout pass (no frame with stale px sizes). A pane
 * not touching the right/bottom edge gives up 1px there: the seam.
 * A pane created after first paint fades in once; its class never changes after mount.
 */
function PaneFrame({
	paneId,
	rect,
	motion,
	enter,
	children,
}: {
	readonly paneId: number;
	readonly rect: UnitRect;
	readonly motion: string;
	readonly enter: boolean;
	readonly children: ReactNode;
}): ReactElement {
	const [entering] = useState(enter);
	return (
		<div
			className={cn("workspace-pane absolute overflow-hidden bg-window", motion, entering && "animate-pane-in")}
			data-workspace-pane={paneId}
			style={percentPlacement(rect)}
		>
			{children}
		</div>
	);
}

const pct = (value: number): string => `${(value * 100).toFixed(4)}%`;

/** Percentages of the workspace, so the overlay of a pane follows it through every resize. */
export function percentPlacement(rect: UnitRect, insetTop = 0): { left: string; top: string; width: string; height: string } {
	const seamX = rect.x + rect.width < 0.9999;
	const seamY = rect.y + rect.height < 0.9999;
	return {
		left: pct(rect.x),
		top: `calc(${pct(rect.y)} + ${insetTop}px)`,
		width: seamX ? `calc(${pct(rect.width)} - 1px)` : pct(rect.width),
		height: `calc(${pct(rect.height)} - ${(seamY ? 1 : 0) + insetTop}px)`,
	};
}

function sameDrop(a: DropState | null, b: DropState | null): boolean {
	if (a === null || b === null) return a === b;
	return (
		JSON.stringify(a.target) === JSON.stringify(b.target) &&
		a.preview.x === b.preview.x &&
		a.preview.y === b.preview.y &&
		a.preview.width === b.preview.width &&
		a.preview.height === b.preview.height &&
		a.caret?.x === b.caret?.x
	);
}

/**
 * A boundary between two panes: a 6px hit strip over the 1px seam, with a hover wash.
 * Its ends are inset by the strip's half-width so at a T-junction the seam running
 * through owns the junction instead of the nested seam that ends there.
 */
function SplitGrip({
	handle,
	size,
	onResize,
}: {
	readonly handle: SplitHandle;
	readonly size: { readonly width: number; readonly height: number };
	readonly onResize: (handle: SplitHandle, delta: number, minShare: number) => void;
}): ReactElement {
	const drag = useRef<number | null>(null);
	const row = handle.direction === "row";
	const extentPx = (row ? size.width : size.height) * handle.extent;
	const style = row
		? { left: handle.x * size.width - 3, top: handle.y * size.height + 3, width: 6, height: handle.length * size.height - 6 }
		: { left: handle.x * size.width + 3, top: handle.y * size.height - 3, width: handle.length * size.width - 6, height: 6 };
	return (
		<div
			role="separator"
			aria-label="Resize panes"
			aria-orientation={row ? "vertical" : "horizontal"}
			className={cn("absolute z-30 hover:bg-accent-soft [-webkit-app-region:no-drag]", row ? "cursor-col-resize" : "cursor-row-resize")}
			style={style}
			onPointerDown={(event) => {
				event.preventDefault();
				drag.current = row ? event.clientX : event.clientY;
				event.currentTarget.setPointerCapture(event.pointerId);
			}}
			onPointerMove={(event) => {
				if (drag.current === null || extentPx <= 0) return;
				const at = row ? event.clientX : event.clientY;
				onResize(handle, (at - drag.current) / extentPx, Math.min(0.45, MIN_PANE_PX / extentPx));
				drag.current = at;
			}}
			onPointerUp={(event) => {
				drag.current = null;
				event.currentTarget.releasePointerCapture(event.pointerId);
			}}
			onPointerCancel={() => {
				drag.current = null;
			}}
		/>
	);
}
