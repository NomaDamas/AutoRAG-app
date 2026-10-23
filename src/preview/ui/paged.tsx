import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { PreviewDocument } from "../shared/contract";
import type { Size } from "../shared/fit";
import type { PageMarks } from "../shared/text-marks";
import { useChrome } from "./chrome";
import { FallbackView } from "./fallback";

/** Pages render while they are this close to the viewport and release beyond it. */
const RENDER_MARGIN = "600px 0px";
/** Rail thumbnails render ahead of the rail's own scroll position. */
const RAIL_MARGIN = "400px 0px";
const THUMB_WIDTH = 86;
/** Reference geometry: 56px of panel either side of the page, an 18px gap, a 128px rail. */
const PAGE_GUTTER = 56;
const PAGE_GAP = 18;
const PAGES_TOP = 8;
const PAGES_BOTTOM = 70;
const RAIL_WIDTH = 128;
const ZOOM_STEPS = [0.5, 0.6, 0.75, 0.9, 1, 1.15, 1.3, 1.5, 2] as const;
const MIN_SCALE = 0.25;
const MAX_SCALE = 2;

/** One page being drawn. `done` resolves to the element that shows it; results after `cancel` are ignored. */
export interface PageJob {
	readonly done: Promise<HTMLElement>;
	cancel(): void;
}

/**
 * Draws page `index` for a slot `width` CSS pixels wide. A format that learns
 * a page's real size only while drawing reports it through `onBox`.
 */
export type DrawPage = (index: number, width: number, onBox: (box: Size) => void) => PageJob;

/**
 * Whether `node` sits near the viewport of its closest `scroller` ancestor.
 * The rail scrolls on its own, so its thumbnails observe the rail.
 */
function useNearScreen<T extends HTMLElement>(scroller: string, margin: string): { readonly attach: (node: T | null) => void; readonly near: boolean } {
	const [node, setNode] = useState<T | null>(null);
	const [near, setNear] = useState(false);
	useEffect(() => {
		if (node === null) return;
		const root = node.closest(scroller);
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) setNear(entry.isIntersecting);
			},
			{ root: root instanceof HTMLElement ? root : null, rootMargin: margin },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [node, scroller, margin]);
	return { attach: setNode, near };
}

/**
 * Draws page `index` into a fresh element and swaps it into `holder` once
 * drawn, so a zoom keeps showing the old pixels (stretched) instead of a blank
 * page while the new resolution renders.
 */
function usePageDraw(draw: DrawPage, index: number, width: number | null, holder: HTMLElement | null, onBox: (index: number, box: Size) => void, onError: (message: string) => void): boolean {
	const { t } = useTranslation();
	const [drawn, setDrawn] = useState(false);
	useEffect(() => {
		if (width === null || holder === null) return;
		let cancelled = false;
		const job = draw(index, width, (box) => {
			if (!cancelled) onBox(index, box);
		});
		job.done
			.then((node) => {
				if (cancelled) return;
				holder.replaceChildren(node);
				setDrawn(true);
			})
			.catch((caught: unknown) => {
				if (!cancelled) onError(caught instanceof Error ? caught.message : t("quickLook.paged.drawFailed"));
			});
		return () => {
			cancelled = true;
			job.cancel();
		};
	}, [draw, index, width, holder, onBox, onError, t]);
	return drawn;
}

interface PageProps {
	readonly draw: DrawPage;
	readonly index: number;
	readonly box: Size;
	readonly scale: number;
	/** Cited passages on this page, in page units. */
	readonly marks: PageMarks["rects"] | undefined;
	readonly onBox: (index: number, box: Size) => void;
	readonly onError: (message: string) => void;
	readonly register: (index: number, node: HTMLDivElement | null) => void;
}

/** One paper card. It keeps its size while released, so a long document stays cheap to scroll. */
function Page({ draw, index, box, scale, marks, onBox, onError, register }: PageProps): ReactElement {
	const { attach, near } = useNearScreen<HTMLDivElement>(".ql-pages__scroll", RENDER_MARGIN);
	const [holder, setHolder] = useState<HTMLDivElement | null>(null);
	const width = Math.round(box.width * scale);
	usePageDraw(draw, index, near ? width : null, holder, onBox, onError);
	useEffect(() => {
		// Leaving the viewport drops the backing store.
		if (!near) holder?.replaceChildren();
	}, [near, holder]);
	const ref = useCallback(
		(node: HTMLDivElement | null) => {
			attach(node);
			register(index, node);
		},
		[attach, index, register],
	);
	return (
		<div ref={ref} className="ql__paper relative flex-none bg-ql-page shadow-ql-page" data-page={index + 1} style={{ width, height: Math.round(box.height * scale) }}>
			<div ref={setHolder} className="absolute inset-0 overflow-hidden [&>*]:block [&>*]:w-full [&>*]:h-full" />
			{marks?.map((rect, order) => (
				<div
					key={order}
					className="ql__mark absolute pointer-events-none rounded-2 bg-ql-evidence-mark mix-blend-multiply shadow-[0_0_0_1px_var(--ql-evidence-mark-ring)]"
					data-evidence-mark={order === 0 ? "first" : "rest"}
					style={{ left: (rect.x - 1) * scale, top: (rect.y - 1) * scale, width: (rect.width + 2) * scale, height: (rect.height + 2) * scale }}
				/>
			))}
		</div>
	);
}

/** A rail thumbnail: drawn once its slot nears the rail's viewport, then kept. */
function Thumb({ draw, index, box, active, onPick, onBox, onError }: {
	readonly draw: DrawPage;
	readonly index: number;
	readonly box: Size;
	readonly active: boolean;
	readonly onPick: (index: number) => void;
	readonly onBox: (index: number, box: Size) => void;
	readonly onError: (message: string) => void;
}): ReactElement {
	const { t } = useTranslation();
	const { attach, near } = useNearScreen<HTMLButtonElement>(".ql__rail", RAIL_MARGIN);
	const [holder, setHolder] = useState<HTMLDivElement | null>(null);
	const [seen, setSeen] = useState(false);
	useEffect(() => {
		if (near) setSeen(true);
	}, [near]);
	const drawn = usePageDraw(draw, index, seen ? THUMB_WIDTH : null, holder, onBox, onError);
	return (
		<button
			ref={attach}
			type="button"
			className="ql__rail-item block flex-none p-0 border-0 bg-transparent text-ql-ink-secondary font-ql text-[10.5px] text-center cursor-default"
			data-active={active ? "true" : undefined}
			aria-label={t("quickLook.paged.goToPage", { count: index + 1 })}
			onClick={() => onPick(index)}
		>
			<div
				ref={setHolder}
				className="w-86 overflow-hidden rounded-2 bg-ql-page shadow-ql-doc [&>*]:block [&>*]:w-full [&>*]:h-full data-[active=true]:shadow-ql-page-active"
				data-active={active ? "true" : undefined}
				data-drawn={drawn ? "true" : undefined}
				style={{ aspectRatio: `${box.width} / ${box.height}` }}
			/>
			<div className="mt-5">{index + 1}</div>
		</button>
	);
}

/**
 * What the evidence highlight shows: still searching the document's text, the
 * cited passage's marks, or nothing found (the document opens at the top).
 */
export type EvidenceMarks = { readonly state: "searching" } | { readonly state: "found"; readonly pages: readonly PageMarks[] } | { readonly state: "missing" };

/** The reading line sits a third of the way down; a cited passage lands just above it. */
const MARK_LEAD = 0.25;

/**
 * A paged document like the reference PDF panel: paper cards in one scrolling
 * column, a floating pill with zoom and the current page, and a page rail on
 * the right. `boxes` is every page's size as known when the document opened;
 * `draw` may correct a page's size as it renders. The panel asks for the
 * document's width plus the margins and rail once, when it mounts. `evidence`
 * (AI Search) draws the cited passage over its pages and scrolls to it once.
 */
export function PagedView({
	file,
	boxes: initialBoxes,
	draw,
	evidence = null,
}: {
	readonly file: PreviewDocument;
	readonly boxes: readonly Size[];
	readonly draw: DrawPage;
	readonly evidence?: EvidenceMarks | null;
}): ReactElement {
	const { t } = useTranslation();
	const { report } = useChrome();
	const scrollerRef = useRef<HTMLDivElement | null>(null);
	const nodesRef = useRef<(HTMLDivElement | null)[]>([]);
	const [boxes, setBoxes] = useState(initialBoxes);
	const [fit, setFit] = useState(1);
	const [zoom, setZoom] = useState<number | null>(null);
	const [active, setActive] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const marksByPage = useMemo(() => new Map(evidence?.state === "found" ? evidence.pages.map((marks) => [marks.page, marks.rects]) : []), [evidence]);

	const openedWith = useRef(initialBoxes);
	useEffect(() => {
		const opened = openedWith.current;
		const rail = opened.length > 1 ? RAIL_WIDTH : 0;
		report(
			{
				width: Math.ceil(opened.reduce((max, box) => Math.max(max, box.width), 0)) + PAGE_GUTTER * 2 + rail,
				height: Math.ceil(opened.reduce((sum, box) => sum + box.height + PAGE_GAP, 0)) + PAGES_TOP + PAGES_BOTTOM,
			},
			"clamp",
		);
	}, [report]);

	const widest = useMemo(() => boxes.reduce((max, box) => Math.max(max, box.width), 0), [boxes]);
	/** The panel's own width has been measured once; until then `fit` is a guess. */
	const [measured, setMeasured] = useState(false);
	useEffect(() => {
		const scroller = scrollerRef.current;
		if (scroller === null || widest <= 0) return;
		const observer = new ResizeObserver(() => {
			setFit(Math.min(MAX_SCALE, Math.max(MIN_SCALE, (scroller.clientWidth - PAGE_GUTTER * 2) / widest)));
			setMeasured(true);
		});
		observer.observe(scroller);
		return () => observer.disconnect();
	}, [widest]);
	const scale = zoom ?? fit;

	// Keep the reading position when the scale changes.
	const lastScale = useRef(scale);
	useLayoutEffect(() => {
		const scroller = scrollerRef.current;
		const previous = lastScale.current;
		lastScale.current = scale;
		if (scroller === null || previous === scale) return;
		scroller.scrollTop = (scroller.scrollTop * scale) / previous;
	}, [scale]);

	// Bring the cited passage into view once, after the fit scale settled; a later zoom keeps the reading position.
	const focused = useRef(false);
	const first = evidence?.state === "found" ? evidence.pages[0] : undefined;
	useLayoutEffect(() => {
		const scroller = scrollerRef.current;
		const node = first === undefined ? undefined : nodesRef.current[first.page];
		if (focused.current || !measured || first === undefined || scroller === null || node === null || node === undefined) return;
		focused.current = true;
		const top = Math.min(...first.rects.map((rect) => rect.y));
		scroller.scrollTop = Math.max(0, node.offsetTop + top * scale - scroller.clientHeight * MARK_LEAD);
	}, [first, measured, scale]);

	useEffect(() => {
		const scroller = scrollerRef.current;
		if (scroller === null) return;
		let frame = 0;
		const measure = (): void => {
			frame = 0;
			// The last pages can never reach the reading line, so the end of the scroll is the last page.
			if (scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
				setActive(nodesRef.current.length - 1);
				return;
			}
			const line = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
			let current = 0;
			nodesRef.current.forEach((node, index) => {
				if (node !== null && node.getBoundingClientRect().top <= line) current = index;
			});
			setActive(current);
		};
		const onScroll = (): void => {
			if (frame === 0) frame = requestAnimationFrame(measure);
		};
		measure();
		scroller.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			scroller.removeEventListener("scroll", onScroll);
			cancelAnimationFrame(frame);
		};
	}, []);

	const register = useCallback((index: number, node: HTMLDivElement | null) => {
		nodesRef.current[index] = node;
	}, []);
	const onBox = useCallback((index: number, box: Size) => {
		setBoxes((current) => {
			const known = current[index];
			if (known === undefined || (Math.abs(known.width - box.width) < 0.5 && Math.abs(known.height - box.height) < 0.5)) return current;
			const next = [...current];
			next[index] = box;
			return next;
		});
	}, []);
	const fail = useCallback((message: string) => setError(message), []);
	const pick = useCallback((index: number) => nodesRef.current[index]?.scrollIntoView({ block: "start", behavior: "smooth" }), []);

	if (error !== null) return <FallbackView file={file} note={error} />;
	const zoomIn = ZOOM_STEPS.find((step) => step > scale + 0.001);
	const zoomOut = [...ZOOM_STEPS].reverse().find((step) => step < scale - 0.001);
	return (
		<div className="ql-pages flex flex-1 min-h-0">
			<div className="relative flex-1 min-w-0">
				<div ref={scrollerRef} className="ql-pages__scroll absolute inset-0 overflow-auto">
					<div className="flex flex-col items-center gap-18 w-fit min-w-full px-[56px] pt-8 pb-70 box-border">
						{boxes.map((box, index) => (
							<Page key={index} draw={draw} index={index} box={box} scale={scale} marks={marksByPage.get(index)} onBox={onBox} onError={fail} register={register} />
						))}
					</div>
				</div>
				<div className="ql-pages__pill absolute left-1/2 bottom-14 flex items-center gap-2 px-6 py-3 rounded-11 bg-ql-panel text-[12px] tabular-nums shadow-ql-float [backdrop-filter:var(--backdrop-ql-float)] -translate-x-1/2">
					<button type="button" className="grid place-items-center w-26 h-26 p-0 border-0 rounded-7 bg-transparent text-ql-ink font-ql text-[15px] cursor-default hover:bg-ql-button disabled:opacity-40" aria-label={t("quickLook.paged.zoomOut")} disabled={zoomOut === undefined} onClick={() => setZoom(zoomOut ?? scale)}>
						−
					</button>
					<span className="min-w-44 text-center text-ql-ink-secondary">{Math.round(scale * 100)}%</span>
					<button type="button" className="grid place-items-center w-26 h-26 p-0 border-0 rounded-7 bg-transparent text-ql-ink font-ql text-[15px] cursor-default hover:bg-ql-button disabled:opacity-40" aria-label={t("quickLook.paged.zoomIn")} disabled={zoomIn === undefined} onClick={() => setZoom(zoomIn ?? scale)}>
						+
					</button>
					<span className="w-1 h-14 mx-6 bg-ql-hairline" />
					<span className="pr-8 pl-2 font-semibold">
						{active + 1} / {boxes.length}
					</span>
					{evidence === null ? null : (
						<>
							<span className="w-1 h-14 mx-6 bg-ql-hairline" />
							<span className="ql-pages__evidence pr-8 text-ql-ink-secondary" data-evidence-state={evidence.state}>
								{evidence.state === "searching" ? t("quickLook.evidence.searching") : evidence.state === "found" ? t("quickLook.evidence.found") : t("quickLook.evidence.missing")}
							</span>
						</>
					)}
				</div>
			</div>
			{boxes.length > 1 ? (
				<nav className="ql__rail flex flex-none flex-col items-center gap-12 w-128 pt-10 pb-20 overflow-y-auto bg-ql-sunk border-l-[0.5px] border-ql-hairline" aria-label={t("quickLook.paged.rail")}>
					{boxes.map((box, index) => (
						<Thumb key={index} draw={draw} index={index} box={box} active={index === active} onPick={pick} onBox={onBox} onError={fail} />
					))}
				</nav>
			) : null}
		</div>
	);
}
