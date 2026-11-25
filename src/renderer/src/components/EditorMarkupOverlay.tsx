import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type PointerEvent,
	type ReactElement,
	type RefObject,
	type WheelEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
	ANNOTATION_TOOLS,
	fromAnchor,
	markBounds,
	markShape,
	textProbeRect,
	toAnchor,
	type AnnotationMark,
	type AnnotationTool,
	type Box,
	type Point,
} from "../../../preview/shared/annotation";
import { BoxMarkIcon, PenStrokeIcon, UnderlineMarkIcon } from "../../../preview/ui/icons";
import { textUnder } from "../../../preview/ui/markup";
import { cn } from "../lib/cn";

const MAX_MARK_TEXT = 2000;
const MIN_STEP = 2;
const MAX_POINTS = 2000;

interface PlacedMark {
	readonly tool: AnnotationTool;
	readonly anchor: HTMLElement;
	readonly scrolled: boolean;
	readonly page: number | null;
	readonly points: readonly Point[];
	readonly text: string;
}

const TOOL_ICON: Readonly<Record<AnnotationTool, () => ReactElement>> = {
	pen: PenStrokeIcon,
	box: BoxMarkIcon,
	underline: UnderlineMarkIcon,
};

function boxOf(anchor: HTMLElement, scrolled: boolean): Box {
	const rect = anchor.getBoundingClientRect();
	if (scrolled) {
		return {
			left: rect.left - anchor.scrollLeft,
			top: rect.top - anchor.scrollTop,
			width: Math.max(1, anchor.scrollWidth),
			height: Math.max(1, anchor.scrollHeight),
		};
	}
	return {
		left: rect.left,
		top: rect.top,
		width: Math.max(1, rect.width),
		height: Math.max(1, rect.height),
	};
}

function scrolls(element: HTMLElement): boolean {
	const style = getComputedStyle(element);
	const overflow = `${style.overflowX} ${style.overflowY}`;
	return (
		/(?:auto|scroll)/.test(overflow) &&
		(element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1)
	);
}

function anchorAt(
	stage: HTMLElement,
	layer: Element,
	point: Point,
): { readonly anchor: HTMLElement; readonly scrolled: boolean } {
	const hits = document.elementsFromPoint(point.x, point.y);
	const under = hits.find((element) => element !== layer && !layer.contains(element) && stage.contains(element));
	let node: HTMLElement | null = under instanceof HTMLElement ? under : null;
	while (node !== null && node !== stage) {
		if (node.dataset.page !== undefined) return { anchor: node, scrolled: false };
		node = node.parentElement;
	}
	node = under instanceof HTMLElement ? under : null;
	while (node !== null && node !== stage) {
		if (scrolls(node)) return { anchor: node, scrolled: true };
		node = node.parentElement;
	}
	return { anchor: stage, scrolled: scrolls(stage) };
}

function pageNumber(anchor: HTMLElement, scrolled: boolean): number | null {
	if (scrolled) return null;
	const parsed = Number.parseInt(anchor.dataset.page ?? "", 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function screenPoints(placed: PlacedMark): readonly Point[] {
	const box = boxOf(placed.anchor, placed.scrolled);
	return placed.points.map((point) => fromAnchor(point, box));
}

function MarkSvgShape({
	tool,
	points,
	origin,
}: {
	readonly tool: AnnotationTool;
	readonly points: readonly Point[];
	readonly origin: Point;
}): ReactElement {
	const local = points.map((point) => ({ x: point.x - origin.x, y: point.y - origin.y }));
	const shape = markShape(tool, local);
	const stroke = "var(--ql-annotation)";
	if (shape.kind === "rect") {
		return (
			<rect
				x={shape.x}
				y={shape.y}
				width={shape.width}
				height={shape.height}
				rx={3}
				fill="color-mix(in srgb, var(--ql-annotation) 10%, transparent)"
				stroke={stroke}
				strokeWidth={2.5}
			/>
		);
	}
	if (shape.kind === "line") {
		return <line x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} stroke={stroke} strokeWidth={3} strokeLinecap="round" />;
	}
	return <path d={shape.d} fill="none" stroke={stroke} strokeWidth={2.75} strokeLinecap="round" strokeLinejoin="round" />;
}

export interface EditorMarkupSurfaceProps {
	readonly stageRef: RefObject<HTMLElement | null>;
	readonly active: boolean;
	readonly disabled?: boolean;
	readonly revision: number;
	readonly onMarksChange: (marks: readonly AnnotationMark[]) => void;
}

/**
 * Interactive SVG mark-up overlay and compact tool palette for an editor tab
 * (used on package documents and optionally toggled on text documents).
 * Anchors marks as fractions of the underlying page card or scroll container
 * so they track scrolling and window resizing.
 */
export function EditorMarkupOverlay({
	stageRef,
	active,
	disabled = false,
	revision,
	onMarksChange,
}: EditorMarkupSurfaceProps): ReactElement | null {
	const { t } = useTranslation();
	const [tool, setTool] = useState<AnnotationTool>("box");
	const [marks, setMarks] = useState<readonly PlacedMark[]>([]);
	const [drawing, setDrawing] = useState<{ readonly tool: AnnotationTool; readonly points: readonly Point[] } | null>(null);
	const [frame, setFrame] = useState<Box | null>(null);
	const [, setTick] = useState(0);
	const layerRef = useRef<SVGSVGElement | null>(null);
	const started = useRef<{ readonly anchor: HTMLElement; readonly scrolled: boolean } | null>(null);

	useEffect(() => {
		setMarks([]);
		setDrawing(null);
	}, [revision]);

	useEffect(() => {
		const serialized: AnnotationMark[] = marks.map((placed) => ({
			tool: placed.tool,
			page: placed.page,
			points: placed.points,
			text: placed.text,
		}));
		onMarksChange(serialized);
	}, [marks, onMarksChange]);

	useLayoutEffect(() => {
		if (!active) return;
		const stage = stageRef.current;
		if (stage === null) return;
		const measure = (): void => {
			const rect = stage.getBoundingClientRect();
			setFrame({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
			setTick((tick) => tick + 1);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(stage);
		const onScroll = (): void => setTick((tick) => tick + 1);
		stage.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", measure);
		return () => {
			observer.disconnect();
			stage.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", measure);
		};
	}, [stageRef, active, revision]);

	const onWheel = useCallback(
		(event: WheelEvent<SVGSVGElement>) => {
			const stage = stageRef.current;
			const layer = layerRef.current;
			if (stage === null || layer === null) return;
			const hits = document.elementsFromPoint(event.clientX, event.clientY);
			const under = hits.find((el) => el !== layer && !layer.contains(el) && stage.contains(el));
			let node: HTMLElement | null = under instanceof HTMLElement ? under : stage;
			while (node !== null) {
				if (scrolls(node)) {
					node.scrollBy(event.deltaX, event.deltaY);
					return;
				}
				if (node === stage) break;
				node = node.parentElement;
			}
			stage.scrollBy(event.deltaX, event.deltaY);
		},
		[stageRef],
	);

	if (!active) return null;

	function onPointerDown(event: PointerEvent<SVGSVGElement>): void {
		if (event.button !== 0 || disabled) return;
		const stage = stageRef.current;
		const layer = layerRef.current;
		if (stage === null || layer === null) return;
		const start = { x: event.clientX, y: event.clientY };
		started.current = anchorAt(stage, layer, start);
		layer.setPointerCapture(event.pointerId);
		setDrawing({ tool, points: [start] });
	}

	function onPointerMove(event: PointerEvent<SVGSVGElement>): void {
		if (drawing === null) return;
		const next = { x: event.clientX, y: event.clientY };
		setDrawing((current) => {
			if (current === null) return null;
			if (current.tool !== "pen") return { ...current, points: [current.points[0]!, next] };
			if (current.points.length >= MAX_POINTS) return current;
			const prev = current.points.at(-1)!;
			if (Math.hypot(next.x - prev.x, next.y - prev.y) < MIN_STEP) return current;
			return { ...current, points: [...current.points, next] };
		});
	}

	function finish(event: PointerEvent<SVGSVGElement>): void {
		if (drawing === null) return;
		const anchor = started.current;
		started.current = null;
		const points = drawing.points;
		setDrawing(null);
		if (layerRef.current?.hasPointerCapture(event.pointerId)) {
			layerRef.current.releasePointerCapture(event.pointerId);
		}
		if (anchor === null || points.length < 2) return;
		const bounds = markBounds(points);
		if (bounds.right - bounds.left < 3 && bounds.bottom - bounds.top < 3) return;
		const box = boxOf(anchor.anchor, anchor.scrolled);
		const anchored = points.map((point) => toAnchor(point, box));
		const text = textUnder(anchor.anchor, textProbeRect(drawing.tool, bounds)).slice(0, MAX_MARK_TEXT);
		setMarks((current) => [
			...current,
			{
				tool: drawing.tool,
				anchor: anchor.anchor,
				scrolled: anchor.scrolled,
				page: pageNumber(anchor.anchor, anchor.scrolled),
				points: anchored,
				text,
			},
		]);
	}

	return (
		<>
			{frame === null ? null : (
				<svg
					ref={layerRef}
					className="doc-editor__markup-layer pointer-events-auto absolute inset-0 z-10 h-full w-full touch-none cursor-crosshair"
					data-markup-layer="true"
					aria-label={t("quickLook.markup.canvas")}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={finish}
					onPointerCancel={finish}
					onWheel={onWheel}
				>
					{marks.map((placed, index) => (
						<MarkSvgShape
							key={index}
							tool={placed.tool}
							points={screenPoints(placed)}
							origin={{ x: frame.left, y: frame.top }}
						/>
					))}
					{drawing === null ? null : (
						<MarkSvgShape tool={drawing.tool} points={drawing.points} origin={{ x: frame.left, y: frame.top }} />
					)}
				</svg>
			)}
			<div
				className="doc-editor__markup-palette absolute right-14 bottom-12 z-20 flex items-center gap-4 rounded-9 border border-border bg-window/95 px-8 py-4 shadow-md backdrop-blur-md"
				role="toolbar"
				aria-label={t("quickLook.markup.tools")}
			>
				{ANNOTATION_TOOLS.map((option) => {
					const Icon = TOOL_ICON[option];
					return (
						<button
							key={option}
							type="button"
							aria-pressed={tool === option}
							aria-label={t(`quickLook.markup.${option}`)}
							title={t(`quickLook.markup.${option}`)}
							className={cn(
								"flex size-26 items-center justify-center rounded-6 border-0 bg-transparent text-ink-body transition-colors",
								tool === option ? "bg-accent-soft text-accent" : "hover:bg-hover-icon hover:text-ink",
							)}
							onClick={() => setTool(option)}
						>
							<Icon />
						</button>
					);
				})}
				<span className="mx-2 h-14 w-px bg-divider" aria-hidden="true" />
				<button
					type="button"
					disabled={marks.length === 0 || disabled}
					className="h-24 rounded-6 border-0 bg-transparent px-8 text-meta font-medium text-ink-body hover:bg-hover-icon disabled:opacity-40"
					onClick={() => setMarks((current) => current.slice(0, -1))}
				>
					{t("quickLook.markup.removeLast")}
				</button>
				<button
					type="button"
					disabled={marks.length === 0 || disabled}
					className="h-24 rounded-6 border-0 bg-transparent px-8 text-meta font-medium text-ink-body hover:bg-hover-icon disabled:opacity-40"
					onClick={() => setMarks([])}
				>
					{t("quickLook.markup.clear")}
				</button>
			</div>
		</>
	);
}
