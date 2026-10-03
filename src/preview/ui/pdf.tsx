import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { previewStreamUrl, type PreviewDocument } from "../shared/contract";
import type { Size } from "../shared/fit";
import { useChrome } from "./chrome";
import { FallbackView, Status } from "./fallback";

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

let workerReady = false;

function ensurePdfWorker(): void {
	if (workerReady) return;
	GlobalWorkerOptions.workerSrc = workerUrl;
	workerReady = true;
}

function backingScale(): number {
	return Math.min(2, window.devicePixelRatio || 1);
}

function isCancel(caught: unknown): boolean {
	return caught instanceof Error && caught.name === "RenderingCancelledException";
}

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
 * Renders page `index` into a fresh canvas and swaps it into `holder` once
 * drawn, so a zoom keeps showing the old pixels (stretched) instead of a blank
 * page while the new resolution renders.
 */
function usePageCanvas(pdf: PDFDocumentProxy, index: number, width: number | null, holder: HTMLElement | null, onBox: (index: number, box: Size) => void, onError: (message: string) => void): boolean {
	const [drawn, setDrawn] = useState(false);
	useEffect(() => {
		if (width === null || holder === null) return;
		let cancelled = false;
		let task: RenderTask | null = null;
		void pdf
			.getPage(index + 1)
			.then((page) => {
				if (cancelled) return;
				const natural = page.getViewport({ scale: 1 });
				onBox(index, { width: natural.width, height: natural.height });
				const viewport = page.getViewport({ scale: (width * backingScale()) / natural.width });
				const canvas = document.createElement("canvas");
				canvas.width = Math.floor(viewport.width);
				canvas.height = Math.floor(viewport.height);
				task = page.render({ canvas, viewport });
				return task.promise.then(() => {
					if (cancelled) return;
					holder.replaceChildren(canvas);
					setDrawn(true);
				});
			})
			.catch((caught: unknown) => {
				if (!cancelled && !isCancel(caught)) onError(caught instanceof Error ? caught.message : "PDF 페이지를 그리지 못했습니다");
			});
		return () => {
			cancelled = true;
			task?.cancel();
		};
	}, [pdf, index, width, holder, onBox, onError]);
	return drawn;
}

interface PageProps {
	readonly pdf: PDFDocumentProxy;
	readonly index: number;
	readonly box: Size;
	readonly scale: number;
	readonly onBox: (index: number, box: Size) => void;
	readonly onError: (message: string) => void;
	readonly register: (index: number, node: HTMLDivElement | null) => void;
}

/** One paper card. It keeps its size while released, so a long document stays cheap to scroll. */
function PdfPage({ pdf, index, box, scale, onBox, onError, register }: PageProps): ReactElement {
	const { attach, near } = useNearScreen<HTMLDivElement>(".ql-pdf__scroll", RENDER_MARGIN);
	const [holder, setHolder] = useState<HTMLDivElement | null>(null);
	const width = Math.round(box.width * scale);
	usePageCanvas(pdf, index, near ? width : null, holder, onBox, onError);
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
			<div ref={setHolder} className="absolute inset-0 overflow-hidden [&_canvas]:block [&_canvas]:w-full [&_canvas]:h-full" />
		</div>
	);
}

/** A rail thumbnail: drawn once its slot nears the rail's viewport, then kept. */
function PdfThumb({ pdf, index, box, active, onPick, onBox, onError }: {
	readonly pdf: PDFDocumentProxy;
	readonly index: number;
	readonly box: Size;
	readonly active: boolean;
	readonly onPick: (index: number) => void;
	readonly onBox: (index: number, box: Size) => void;
	readonly onError: (message: string) => void;
}): ReactElement {
	const { attach, near } = useNearScreen<HTMLButtonElement>(".ql__rail", RAIL_MARGIN);
	const [holder, setHolder] = useState<HTMLDivElement | null>(null);
	const [seen, setSeen] = useState(false);
	useEffect(() => {
		if (near) setSeen(true);
	}, [near]);
	const drawn = usePageCanvas(pdf, index, seen ? THUMB_WIDTH : null, holder, onBox, onError);
	return (
		<button
			ref={attach}
			type="button"
			className="ql__rail-item block flex-none p-0 border-0 bg-transparent text-ql-ink-secondary font-ql text-[10.5px] text-center cursor-default"
			data-active={active ? "true" : undefined}
			aria-label={`${index + 1}페이지로 이동`}
			onClick={() => onPick(index)}
		>
			<div
				ref={setHolder}
				className="w-86 overflow-hidden rounded-2 bg-ql-page shadow-ql-doc [&_canvas]:block [&_canvas]:w-full [&_canvas]:h-full data-[active=true]:shadow-ql-page-active"
				data-active={active ? "true" : undefined}
				data-drawn={drawn ? "true" : undefined}
				style={{ aspectRatio: `${box.width} / ${box.height}` }}
			/>
			<div className="mt-5">{index + 1}</div>
		</button>
	);
}

/**
 * PDF like the reference: paper cards in one scrolling column, a floating pill
 * with zoom and the current page, and a page rail on the right. Pages stream
 * through the range-capable protocol, so a large document opens on its first
 * page; every other page assumes the first page's size until it renders.
 */
export function PdfView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { report } = useChrome();
	const scrollerRef = useRef<HTMLDivElement | null>(null);
	const nodesRef = useRef<(HTMLDivElement | null)[]>([]);
	const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
	const [boxes, setBoxes] = useState<readonly Size[]>([]);
	const [fit, setFit] = useState(1);
	const [zoom, setZoom] = useState<number | null>(null);
	const [active, setActive] = useState(0);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		ensurePdfWorker();
		let cancelled = false;
		const task = getDocument({ url: previewStreamUrl(file.path), disableAutoFetch: true });
		void task.promise
			.then(async (loaded) => {
				const first = (await loaded.getPage(1)).getViewport({ scale: 1 });
				if (cancelled) return;
				const box = { width: first.width, height: first.height };
				setPdf(loaded);
				setBoxes(Array.from({ length: loaded.numPages }, () => box));
				const rail = loaded.numPages > 1 ? RAIL_WIDTH : 0;
				report(
					{
						width: Math.ceil(box.width) + PAGE_GUTTER * 2 + rail,
						height: Math.ceil((box.height + PAGE_GAP) * loaded.numPages) + PAGES_TOP + PAGES_BOTTOM,
					},
					"clamp",
				);
			})
			.catch((caught: unknown) => {
				if (!cancelled) setError(caught instanceof Error ? caught.message : "PDF를 열 수 없습니다");
			});
		return () => {
			cancelled = true;
			void task.destroy();
		};
	}, [file.path, report]);

	const widest = useMemo(() => boxes.reduce((max, box) => Math.max(max, box.width), 0), [boxes]);
	useEffect(() => {
		const scroller = scrollerRef.current;
		if (scroller === null || widest <= 0) return;
		const observer = new ResizeObserver(() => {
			setFit(Math.min(MAX_SCALE, Math.max(MIN_SCALE, (scroller.clientWidth - PAGE_GUTTER * 2) / widest)));
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

	useEffect(() => {
		const scroller = scrollerRef.current;
		if (scroller === null || pdf === null) return;
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
	}, [pdf]);

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
	if (pdf === null) return <Status>불러오는 중</Status>;
	const zoomIn = ZOOM_STEPS.find((step) => step > scale + 0.001);
	const zoomOut = [...ZOOM_STEPS].reverse().find((step) => step < scale - 0.001);
	return (
		<div className="ql-pdf flex flex-1 min-h-0">
			<div className="relative flex-1 min-w-0">
				<div ref={scrollerRef} className="ql-pdf__scroll absolute inset-0 overflow-auto">
					<div className="flex flex-col items-center gap-18 w-fit min-w-full px-[56px] pt-8 pb-70 box-border">
						{boxes.map((box, index) => (
							<PdfPage key={index} pdf={pdf} index={index} box={box} scale={scale} onBox={onBox} onError={fail} register={register} />
						))}
					</div>
				</div>
				<div className="ql-pdf__pill absolute left-1/2 bottom-14 flex items-center gap-2 px-6 py-3 rounded-11 bg-ql-panel text-[12px] tabular-nums shadow-ql-float [backdrop-filter:var(--backdrop-ql-float)] -translate-x-1/2">
					<button type="button" className="grid place-items-center w-26 h-26 p-0 border-0 rounded-7 bg-transparent text-ql-ink font-ql text-[15px] cursor-default hover:bg-ql-button disabled:opacity-40" aria-label="축소" disabled={zoomOut === undefined} onClick={() => setZoom(zoomOut ?? scale)}>
						−
					</button>
					<span className="min-w-44 text-center text-ql-ink-secondary">{Math.round(scale * 100)}%</span>
					<button type="button" className="grid place-items-center w-26 h-26 p-0 border-0 rounded-7 bg-transparent text-ql-ink font-ql text-[15px] cursor-default hover:bg-ql-button disabled:opacity-40" aria-label="확대" disabled={zoomIn === undefined} onClick={() => setZoom(zoomIn ?? scale)}>
						+
					</button>
					<span className="w-1 h-14 mx-6 bg-ql-hairline" />
					<span className="pr-8 pl-2 font-semibold">
						{active + 1} / {boxes.length}
					</span>
				</div>
			</div>
			{boxes.length > 1 ? (
				<nav className="ql__rail flex flex-none flex-col items-center gap-12 w-128 pt-10 pb-20 overflow-y-auto bg-ql-sunk border-l-[0.5px] border-ql-hairline" aria-label="페이지 미리보기">
					{boxes.map((box, index) => (
						<PdfThumb key={index} pdf={pdf} index={index} box={box} active={index === active} onPick={pick} onBox={onBox} onError={fail} />
					))}
				</nav>
			) : null}
		</div>
	);
}
