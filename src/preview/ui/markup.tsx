import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement, type RefObject, type WheelEvent } from "react";
import { useTranslation } from "react-i18next";
import {
	ANNOTATION_TOOLS,
	fromAnchor,
	intersects,
	MAX_INSTRUCTION,
	MAX_MARKS,
	markBounds,
	markShape,
	textProbeRect,
	toAnchor,
	type AnnotationMark,
	type AnnotationTool,
	type Bounds,
	type Box,
	type DocumentEditEvent,
	type Point,
} from "../shared/annotation";
import type { QuickLookWindowBridge } from "../shared/contract";
import { SMALL_BUTTON, TOOL_BUTTON } from "./chrome";
import { BoxMarkIcon, PenStrokeIcon, UnderlineMarkIcon } from "./icons";

/** Longest text kept from under one mark; matches the contract's cap. */
const MAX_MARK_TEXT = 2000;
/** A pen stroke keeps a point only after the pointer moved this far, so a long stroke stays small. */
const MIN_STEP = 2;
const MAX_POINTS = 2000;

/** A mark and the element it is anchored to: a page card, or the scrolled box it was drawn in. */
interface PlacedMark {
	readonly mark: AnnotationMark;
	readonly anchor: HTMLElement;
	readonly scrolled: boolean;
}

type RunState =
	| { readonly status: "running"; readonly runId: string; readonly progress: string; readonly draft: string }
	| { readonly status: "done"; readonly runId: string; readonly changed: boolean; readonly reply: string }
	| { readonly status: "error"; readonly runId: string; readonly message: string }
	| { readonly status: "cancelled"; readonly runId: string }
	| { readonly status: "undone"; readonly runId: string };

const TOOL_ICON: Readonly<Record<AnnotationTool, () => ReactElement>> = { pen: PenStrokeIcon, box: BoxMarkIcon, underline: UnderlineMarkIcon };

function boxOf(anchor: HTMLElement, scrolled: boolean): Box {
	const rect = anchor.getBoundingClientRect();
	if (!scrolled) return { left: rect.left, top: rect.top, width: Math.max(rect.width, 1), height: Math.max(rect.height, 1) };
	return {
		left: rect.left - anchor.scrollLeft,
		top: rect.top - anchor.scrollTop,
		width: Math.max(anchor.scrollWidth, 1),
		height: Math.max(anchor.scrollHeight, 1),
	};
}

function scrolls(element: HTMLElement): boolean {
	if (element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1) return false;
	const { overflowX, overflowY } = getComputedStyle(element);
	return /auto|scroll/u.test(overflowY) || /auto|scroll/u.test(overflowX);
}

/** What a mark started on: the page card under the pointer, else the nearest scrolling box, else the stage itself. */
function anchorAt(stage: HTMLElement, layer: Element, point: Point): { readonly anchor: HTMLElement; readonly scrolled: boolean } {
	const stack = document.elementsFromPoint(point.x, point.y).filter((element) => element !== layer && !layer.contains(element));
	const hit = stack.find((element) => stage.contains(element));
	const page = hit?.closest<HTMLElement>("[data-page]");
	if (page !== null && page !== undefined && stage.contains(page)) return { anchor: page, scrolled: false };
	for (let element = hit instanceof HTMLElement ? hit : null; element !== null && element !== stage; element = element.parentElement) {
		if (scrolls(element)) return { anchor: element, scrolled: true };
	}
	return { anchor: stage, scrolled: true };
}

function pageNumber(anchor: HTMLElement, scrolled: boolean): number | null {
	if (scrolled) return null;
	const page = Number(anchor.dataset.page);
	return Number.isInteger(page) && page > 0 ? page : null;
}

function rectBounds(rect: DOMRect): Bounds {
	return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

/** The words the page shows inside `probe` (screen pixels); a page drawn as a picture has none. */
export function textUnder(root: HTMLElement, probe: Bounds): string {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const range = document.createRange();
	const words: string[] = [];
	let length = 0;
	for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
		const text = node.textContent ?? "";
		const parent = node.parentElement;
		if (parent === null || text.trim() === "" || !intersects(rectBounds(parent.getBoundingClientRect()), probe)) continue;
		for (const match of text.matchAll(/\S+/gu)) {
			range.setStart(node, match.index);
			range.setEnd(node, match.index + match[0].length);
			const rect = range.getBoundingClientRect();
			if (rect.width === 0 || !intersects(rectBounds(rect), probe)) continue;
			words.push(match[0]);
			length += match[0].length + 1;
			if (length >= MAX_MARK_TEXT) return words.join(" ").slice(0, MAX_MARK_TEXT);
		}
	}
	return words.join(" ");
}

function screenPoints(placed: PlacedMark): readonly Point[] {
	const box = boxOf(placed.anchor, placed.scrolled);
	return placed.mark.points.map((point) => fromAnchor(point, box));
}

function Shape({ tool, points, origin }: { readonly tool: AnnotationTool; readonly points: readonly Point[]; readonly origin: Point }): ReactElement {
	const local = points.map((point) => ({ x: point.x - origin.x, y: point.y - origin.y }));
	const shape = markShape(tool, local);
	const stroke = { stroke: "var(--ql-annotation)", fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
	if (shape.kind === "rect") return <rect {...stroke} strokeWidth={2.5} rx={3} x={shape.x} y={shape.y} width={shape.width} height={shape.height} data-mark="box" />;
	if (shape.kind === "line") return <line {...stroke} strokeWidth={3} x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} data-mark="underline" />;
	return <path {...stroke} strokeWidth={3} d={shape.d} data-mark="pen" />;
}

/**
 * The pen button's mode: a drawing layer over the stage, a tool palette, and
 * the instruction field. The layer takes the pointer while it is open; the
 * wheel still scrolls the document under it, and marks follow their page.
 */
export function MarkupLayer({
	bridge,
	path,
	seq,
	stageRef,
	onExit,
}: {
	readonly bridge: QuickLookWindowBridge;
	readonly path: string;
	readonly seq: number;
	readonly stageRef: RefObject<HTMLElement | null>;
	readonly onExit: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const [tool, setTool] = useState<AnnotationTool>("pen");
	const [marks, setMarks] = useState<readonly PlacedMark[]>([]);
	const [drawing, setDrawing] = useState<{ readonly tool: AnnotationTool; readonly points: readonly Point[] } | null>(null);
	const [instruction, setInstruction] = useState("");
	const [run, setRun] = useState<RunState | null>(null);
	const [frame, setFrame] = useState<Box | null>(null);
	const [, setTick] = useState(0);
	const layerRef = useRef<SVGSVGElement | null>(null);
	const started = useRef<{ readonly anchor: HTMLElement; readonly scrolled: boolean } | null>(null);
	const runIdRef = useRef<string | null>(null);

	// The stage remounts on every load (the file was edited, or undone): the old marks pointed into the old page.
	useEffect(() => {
		setMarks([]);
		setDrawing(null);
	}, [seq]);

	useLayoutEffect(() => {
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
		document.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", measure);
		return () => {
			observer.disconnect();
			document.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", measure);
		};
	}, [stageRef, seq]);

	useEffect(
		() =>
			bridge.onEditEvent((event: DocumentEditEvent) => {
				if (event.runId !== runIdRef.current) return;
				setRun((current) => {
					switch (event.type) {
						case "started":
							return current;
						case "progress":
							return current?.status === "running" ? { ...current, progress: event.text } : current;
						case "draft":
							return current?.status === "running" ? { ...current, draft: event.text } : current;
						case "done":
							return { status: "done", runId: event.runId, changed: event.changed, reply: event.reply };
						case "error":
							return { status: "error", runId: event.runId, message: event.message };
						case "cancelled":
							return { status: "cancelled", runId: event.runId };
						case "undone":
							return { status: "undone", runId: event.runId };
					}
				});
			}),
		[bridge],
	);

	const running = run?.status === "running";

	const pointAt = (event: PointerEvent<SVGSVGElement>): Point => ({ x: event.clientX, y: event.clientY });

	function onPointerDown(event: PointerEvent<SVGSVGElement>): void {
		const stage = stageRef.current;
		const layer = layerRef.current;
		if (event.button !== 0 || stage === null || layer === null || running || marks.length >= MAX_MARKS) return;
		const point = pointAt(event);
		started.current = anchorAt(stage, layer, point);
		layer.setPointerCapture?.(event.pointerId);
		setDrawing({ tool, points: [point] });
	}

	function onPointerMove(event: PointerEvent<SVGSVGElement>): void {
		if (drawing === null) return;
		const point = pointAt(event);
		setDrawing((current) => {
			if (current === null) return current;
			if (current.tool !== "pen") return { ...current, points: [current.points[0] ?? point, point] };
			const last = current.points[current.points.length - 1];
			if (current.points.length >= MAX_POINTS || (last !== undefined && Math.hypot(point.x - last.x, point.y - last.y) < MIN_STEP)) return current;
			return { ...current, points: [...current.points, point] };
		});
	}

	function onPointerUp(event: PointerEvent<SVGSVGElement>): void {
		const stage = stageRef.current;
		const anchored = started.current;
		started.current = null;
		if (drawing === null || stage === null || anchored === null) return;
		const points = drawing.tool === "pen" ? [...drawing.points, pointAt(event)] : [drawing.points[0] ?? pointAt(event), pointAt(event)];
		setDrawing(null);
		const bounds = markBounds(points);
		// A click without a drag is not a mark.
		if (bounds.right - bounds.left < 4 && bounds.bottom - bounds.top < 4) return;
		const shape = drawing.tool === "underline" ? [points[0] as Point, { x: (points[1] as Point).x, y: (points[0] as Point).y }] : points;
		const box = boxOf(anchored.anchor, anchored.scrolled);
		const mark: AnnotationMark = {
			tool: drawing.tool,
			page: pageNumber(anchored.anchor, anchored.scrolled),
			points: shape.map((point) => toAnchor(point, box)),
			text: textUnder(stage, textProbeRect(drawing.tool, markBounds(shape))),
		};
		setMarks((current) => [...current, { mark, anchor: anchored.anchor, scrolled: anchored.scrolled }]);
	}

	/** The layer holds the pointer, so the wheel is handed to whatever scrolls under it. */
	function onWheel(event: WheelEvent<SVGSVGElement>): void {
		const stage = stageRef.current;
		const layer = layerRef.current;
		if (stage === null || layer === null) return;
		const { anchor } = anchorAt(stage, layer, { x: event.clientX, y: event.clientY });
		let target: HTMLElement | null = anchor;
		while (target !== null && target !== stage && !scrolls(target)) target = target.parentElement;
		(target ?? stage).scrollBy({ left: event.deltaX, top: event.deltaY });
	}

	const submit = useCallback(async () => {
		const text = instruction.trim();
		if (text === "" || running) return;
		const runId = crypto.randomUUID();
		runIdRef.current = runId;
		setRun({ status: "running", runId, progress: "", draft: "" });
		try {
			await bridge.editDocument(runId, { path, instruction: text.slice(0, MAX_INSTRUCTION), marks: marks.map((placed) => placed.mark) });
			setInstruction("");
		} catch (error) {
			setRun({ status: "error", runId, message: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, "") : String(error) });
		}
	}, [bridge, instruction, marks, path, running]);

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		void submit();
	}

	const undo = async (): Promise<void> => {
		if (run?.status !== "done") return;
		const undone = await bridge.undoEdit(run.runId).catch(() => false);
		if (!undone) setRun({ status: "error", runId: run.runId, message: t("quickLook.markup.undoFailed") });
	};

	const origin: Point = frame === null ? { x: 0, y: 0 } : { x: frame.left, y: frame.top };

	return (
		<>
			{frame === null ? null : (
				<svg
					ref={layerRef}
					className="ql-markup fixed z-10 touch-none cursor-crosshair data-[running=true]:cursor-progress"
					style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
					data-running={running ? "true" : undefined}
					data-marks={marks.length}
					aria-label={t("quickLook.markup.canvas")}
					role="img"
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={() => setDrawing(null)}
					onWheel={onWheel}
				>
					{marks.map((placed, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: marks are only appended or dropped from the end.
						<Shape key={index} tool={placed.mark.tool} points={screenPoints(placed)} origin={origin} />
					))}
					{drawing === null ? null : <Shape tool={drawing.tool} points={drawing.points} origin={origin} />}
				</svg>
			)}
			{frame === null ? null : (
				<div className="ql-markup__palette fixed z-20 flex items-center gap-2 p-3 rounded-9 bg-ql-panel-solid shadow-ql-float" style={{ left: frame.left + frame.width / 2, top: frame.top + 10, transform: "translateX(-50%)" }} role="toolbar" aria-label={t("quickLook.markup.tools")}>
					{ANNOTATION_TOOLS.map((option) => {
						const Icon = TOOL_ICON[option];
						return (
							<button key={option} type="button" className={TOOL_BUTTON} aria-pressed={tool === option} aria-label={t(`quickLook.markup.${option}`)} title={t(`quickLook.markup.${option}`)} onClick={() => setTool(option)}>
								<Icon />
							</button>
						);
					})}
					<span className="mx-4 h-16 w-px bg-ql-hairline" aria-hidden="true" />
					<button type="button" className={SMALL_BUTTON} disabled={marks.length === 0 || running} onClick={() => setMarks((current) => current.slice(0, -1))}>
						{t("quickLook.markup.removeLast")}
					</button>
					<button type="button" className={SMALL_BUTTON} disabled={marks.length === 0 || running} onClick={() => setMarks([])}>
						{t("quickLook.markup.clear")}
					</button>
				</div>
			)}
			{frame === null ? null : (
				<div
					className="ql-markup__composer fixed z-20 flex flex-col gap-6 p-8 rounded-12 bg-ql-panel-solid shadow-ql-float text-ql-ink font-ql text-[12.5px]"
					style={{ left: frame.left + 12, width: frame.width - 24, bottom: Math.max(12, window.innerHeight - (frame.top + frame.height) + 12) }}
				>
					{run === null ? null : <RunStatus run={run} onUndo={() => void undo()} onCancel={() => void bridge.cancelEdit(run.runId)} />}
					<div className="flex items-end gap-6">
						<textarea
							className="flex-1 min-h-34 max-h-120 px-8 py-7 rounded-7 border border-ql-hairline bg-ql-page text-ql-ink font-ql text-[13px] leading-[1.4] resize-none outline-none focus:border-ql-accent"
							rows={1}
							value={instruction}
							maxLength={MAX_INSTRUCTION}
							disabled={running}
							aria-label={t("quickLook.markup.instruction")}
							placeholder={t("quickLook.markup.placeholder")}
							onChange={(event) => setInstruction(event.target.value)}
							onKeyDown={onKeyDown}
							onFocus={() => bridge.textEntry(true)}
							onBlur={() => bridge.textEntry(false)}
						/>
						<span className="pb-8 text-ql-ink-secondary tabular-nums whitespace-nowrap">{t("quickLook.markup.markCount", { count: marks.length })}</span>
						<button
							type="button"
							className="h-30 px-14 border-0 rounded-7 bg-ql-accent text-white font-ql text-[13px] font-semibold cursor-default disabled:opacity-40"
							disabled={running || instruction.trim() === ""}
							onClick={() => void submit()}
						>
							{t("quickLook.markup.send")}
						</button>
						<button type="button" className={SMALL_BUTTON} disabled={running} onClick={onExit}>
							{t("common.close")}
						</button>
					</div>
				</div>
			)}
		</>
	);
}

function RunStatus({ run, onUndo, onCancel }: { readonly run: RunState; readonly onUndo: () => void; readonly onCancel: () => void }): ReactElement {
	const { t } = useTranslation();
	switch (run.status) {
		case "running":
			return (
				<div className="flex items-start gap-8" data-edit-state="running" role="status">
					<span className="mt-3 size-10 flex-none rounded-full bg-ql-accent animate-pulse" aria-hidden="true" />
					<div className="flex-1 min-w-0">
						<div className="font-semibold">{t("quickLook.markup.working")}</div>
						{run.progress === "" ? null : <div className="text-ql-ink-secondary truncate">{run.progress}</div>}
						{run.draft === "" ? null : <div className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap text-ql-ink-secondary">{run.draft}</div>}
					</div>
					<button type="button" className={SMALL_BUTTON} onClick={onCancel}>
						{t("common.cancel")}
					</button>
				</div>
			);
		case "done":
			return (
				<div className="flex items-start gap-8" data-edit-state={run.changed ? "changed" : "unchanged"} role="status">
					<div className="flex-1 min-w-0">
						<div className="font-semibold">{run.changed ? t("quickLook.markup.changed") : t("quickLook.markup.unchanged")}</div>
						{run.reply === "" ? null : <div className="mt-2 max-h-90 overflow-auto whitespace-pre-wrap text-ql-ink-secondary">{run.reply}</div>}
					</div>
					{run.changed ? (
						<button type="button" className={SMALL_BUTTON} onClick={onUndo}>
							{t("quickLook.markup.undo")}
						</button>
					) : null}
				</div>
			);
		case "error":
			return (
				<div className="text-ql-annotation" data-edit-state="error" role="alert">
					{t("quickLook.markup.failed", { message: run.message })}
				</div>
			);
		case "cancelled":
			return (
				<div className="text-ql-ink-secondary" data-edit-state="cancelled" role="status">
					{t("quickLook.markup.cancelled")}
				</div>
			);
		case "undone":
			return (
				<div className="text-ql-ink-secondary" data-edit-state="undone" role="status">
					{t("quickLook.markup.undone")}
				</div>
			);
	}
}
