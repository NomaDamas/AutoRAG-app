import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { renderAsync } from "docx-preview";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { read, utils } from "xlsx";
import { previewStreamUrl, type PreviewDocument } from "../shared/contract";
import type { Size } from "../shared/fit";
import { FallbackView, Status } from "./fallback";

let workerReady = false;

/** A page never renders larger than this many CSS pixels per PDF point. */
const PDF_MAX_SCALE = 2;
/** Pages render while they are this close to the viewport and release beyond it. */
const PDF_RENDER_MARGIN = "600px 0px";
/** Rail thumbnails render ahead of the rail's own scroll position. */
const PDF_RAIL_MARGIN = "400px 0px";
const PDF_THUMB_WIDTH = 80;
/** Width kept free right of the pages for the rail: `--ql-rail` plus its 12px inset on both sides. */
const PDF_RAIL_GUTTER = 104 + 12 * 2;

function ensurePdfWorker(): void {
	if (workerReady) return;
	GlobalWorkerOptions.workerSrc = workerUrl;
	workerReady = true;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

function backingScale(): number {
	return Math.min(2, window.devicePixelRatio || 1);
}

/**
 * Reports whether a page or rail slot sits near the viewport of `scroller`,
 * the closest ancestor matching that selector. The rail is fixed-position, so
 * its thumbnails must observe the rail itself: the stage is not in their
 * containing-block chain and would never report them intersecting.
 */
function useNearScreen<T extends HTMLElement>(
	scroller: string,
	margin: string,
): {
	readonly attach: (node: T | null) => void;
	readonly near: boolean;
} {
	const [node, setNode] = useState<T | null>(null);
	const [near, setNear] = useState(false);
	const attach = useCallback((next: T | null) => setNode(next), []);
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
	return { attach, near };
}

interface PdfPageProps {
	readonly pdf: PDFDocumentProxy;
	readonly index: number;
	readonly box: Size;
	readonly scale: number;
	readonly onError: (message: string) => void;
	readonly register: (index: number, node: HTMLDivElement | null) => void;
}

/**
 * One PDF page: a paper-sized slot that keeps the document's scroll height even
 * while its canvas is released, so a long document stays cheap to scroll.
 */
function PdfPage({ pdf, index, box, scale, onError, register }: PdfPageProps): ReactElement {
	const { attach, near } = useNearScreen<HTMLDivElement>(".ql__stage", PDF_RENDER_MARGIN);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const attachRef = useCallback(
		(node: HTMLDivElement | null) => {
			attach(node);
			register(index, node);
		},
		[attach, index, register],
	);
	useEffect(() => {
		if (!near) return;
		const canvas = canvasRef.current;
		if (canvas === null) return;
		let cancelled = false;
		let task: { cancel: () => void } | null = null;
		void pdf
			.getPage(index + 1)
			.then((page) => {
				if (cancelled) return;
				const viewport = page.getViewport({ scale: scale * backingScale() });
				canvas.width = Math.floor(viewport.width);
				canvas.height = Math.floor(viewport.height);
				const rendering = page.render({ canvas, viewport });
				task = rendering;
				return rendering.promise;
			})
			.catch((caught: unknown) => {
				if (!cancelled) onError(caught instanceof Error ? caught.message : "PDF 페이지를 그리지 못했습니다");
			});
		return () => {
			cancelled = true;
			task?.cancel();
			canvas.width = 0;
			canvas.height = 0;
		};
	}, [near, pdf, index, scale, onError]);
	return (
		<div
			ref={attachRef}
			className="ql__paper"
			data-page={index + 1}
			style={{ width: box.width * scale, height: box.height * scale }}
		>
			<canvas ref={canvasRef} />
		</div>
	);
}

/**
 * One rail thumbnail. It renders the first time its slot nears the rail's
 * viewport and keeps the pixels: a thumbnail is a few KB, and redrawing it on
 * every scroll back is what made the rail feel empty.
 */
function PdfThumb({
	pdf,
	index,
	box,
	onError,
}: {
	readonly pdf: PDFDocumentProxy;
	readonly index: number;
	readonly box: Size;
	readonly onError: (message: string) => void;
}): ReactElement {
	const { attach, near } = useNearScreen<HTMLCanvasElement>(".ql__rail", PDF_RAIL_MARGIN);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const [drawn, setDrawn] = useState(false);
	const attachRef = useCallback(
		(node: HTMLCanvasElement | null) => {
			canvasRef.current = node;
			attach(node);
		},
		[attach],
	);
	useEffect(() => {
		if (!near || drawn) return;
		const canvas = canvasRef.current;
		if (canvas === null) return;
		let cancelled = false;
		let task: { cancel: () => void } | null = null;
		void pdf
			.getPage(index + 1)
			.then((page) => {
				if (cancelled) return;
				const viewport = page.getViewport({ scale: (PDF_THUMB_WIDTH * backingScale()) / box.width });
				canvas.width = Math.floor(viewport.width);
				canvas.height = Math.floor(viewport.height);
				const rendering = page.render({ canvas, viewport });
				task = rendering;
				return rendering.promise.then(() => {
					if (!cancelled) setDrawn(true);
				});
			})
			.catch((caught: unknown) => {
				if (cancelled) return;
				if (caught instanceof Error && caught.name === "RenderingCancelledException") return;
				onError(caught instanceof Error ? caught.message : "PDF 페이지를 그리지 못했습니다");
			});
		return () => {
			cancelled = true;
			task?.cancel();
		};
	}, [near, drawn, pdf, index, box.width, onError]);
	return <canvas ref={attachRef} data-drawn={drawn ? "true" : undefined} />;
}

/**
 * Continuous page flow, like macOS Quick Look: every page is reachable by
 * scrolling, and the rail jumps between them. The first page's size is reported
 * so the window can hug the document's shape.
 */
export function PdfView({
	file,
	onIntrinsicSize,
}: {
	readonly file: PreviewDocument;
	readonly onIntrinsicSize?: ((size: Size) => void) | undefined;
}): ReactElement {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const nodesRef = useRef<(HTMLDivElement | null)[]>([]);
	const sizeRef = useRef(onIntrinsicSize);
	sizeRef.current = onIntrinsicSize;
	const [doc, setDoc] = useState<{ readonly pdf: PDFDocumentProxy; readonly boxes: readonly Size[] } | null>(null);
	const [width, setWidth] = useState(0);
	const [active, setActive] = useState(0);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		ensurePdfWorker();
		let cancelled = false;
		const task =
			file.bytes === null
				? getDocument({ url: previewStreamUrl(file.path) })
				: getDocument({ data: copyBytes(file.bytes) });
		void task.promise
			.then(async (pdf) => {
				const boxes = await Promise.all(
					Array.from({ length: pdf.numPages }, (_unused, index) =>
						pdf.getPage(index + 1).then((page) => {
							const viewport = page.getViewport({ scale: 1 });
							return { width: viewport.width, height: viewport.height };
						}),
					),
				);
				if (cancelled) return;
				setDoc({ pdf, boxes });
				setActive(0);
				const first = boxes[0];
				// A multi-page document keeps a gutter for the rail, so the window grows by it.
				const gutter = boxes.length > 1 ? PDF_RAIL_GUTTER : 0;
				if (first !== undefined) sizeRef.current?.({ width: first.width + gutter, height: first.height });
			})
			.catch((caught: unknown) => {
				if (!cancelled) setError(caught instanceof Error ? caught.message : "PDF를 열 수 없습니다");
			});
		return () => {
			cancelled = true;
			void task.destroy();
		};
	}, [file]);

	useEffect(() => {
		const host = hostRef.current;
		if (host === null) return;
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) setWidth(entry.contentRect.width);
		});
		observer.observe(host);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		const host = hostRef.current;
		if (host === null || doc === null) return;
		const scroller = host.closest(".ql__stage");
		if (!(scroller instanceof HTMLElement)) return;
		let frame = 0;
		const measure = (): void => {
			frame = 0;
			const top = scroller.getBoundingClientRect().top;
			let best = 0;
			let distance = Number.POSITIVE_INFINITY;
			nodesRef.current.forEach((node, index) => {
				if (node === null) return;
				const offset = Math.abs(node.getBoundingClientRect().top - top);
				if (offset < distance) {
					distance = offset;
					best = index;
				}
			});
			setActive(best);
		};
		const onScroll = (): void => {
			if (frame === 0) frame = requestAnimationFrame(measure);
		};
		measure();
		scroller.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			scroller.removeEventListener("scroll", onScroll);
			if (frame !== 0) cancelAnimationFrame(frame);
		};
	}, [doc]);

	const scale = useMemo(() => {
		if (doc === null || width <= 0) return 1;
		const widest = doc.boxes.reduce((max, box) => Math.max(max, box.width), 0);
		return widest <= 0 ? 1 : Math.max(0.1, Math.min(PDF_MAX_SCALE, width / widest));
	}, [doc, width]);

	const register = useCallback((index: number, node: HTMLDivElement | null) => {
		nodesRef.current[index] = node;
	}, []);
	const fail = useCallback((message: string) => setError(message), []);

	if (error !== null) return <FallbackView file={file} note={error} />;
	return (
		<>
			<div ref={hostRef} className="ql__pages" data-rail={doc !== null && doc.boxes.length > 1 ? "true" : undefined}>
				{doc === null ? (
					<Status>불러오는 중</Status>
				) : (
					doc.boxes.map((box, index) => (
						<PdfPage
							key={index}
							pdf={doc.pdf}
							index={index}
							box={box}
							scale={scale}
							onError={fail}
							register={register}
						/>
					))
				)}
			</div>
			{doc !== null && doc.boxes.length > 1 ? (
				<div className="ql__rail" role="group" aria-label="페이지">
					{doc.boxes.map((box, index) => (
						<button
							key={index}
							type="button"
							className="ql__rail-item"
							data-active={index === active ? "true" : undefined}
							aria-label={`${index + 1}페이지`}
							style={{ aspectRatio: `${box.width} / ${box.height}` }}
							onClick={() => nodesRef.current[index]?.scrollIntoView({ block: "start", behavior: "smooth" })}
						>
							<PdfThumb pdf={doc.pdf} index={index} box={box} onError={fail} />
						</button>
					))}
				</div>
			) : null}
		</>
	);
}

export function DocxView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const bytes = file.bytes;
	const [srcdoc, setSrcdoc] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (bytes === null) return;
		let cancelled = false;
		const host = document.createElement("div");
		renderAsync(new Blob([copyBytes(bytes)]), host, host, { inWrapper: true, breakPages: true })
			.then(() => {
				if (cancelled) return;
				setSrcdoc(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fff}</style>${host.innerHTML}`);
			})
			.catch((caught: unknown) => {
				if (cancelled) return;
				setError(caught instanceof Error ? caught.message : "문서를 열 수 없습니다");
			});
		return () => {
			cancelled = true;
		};
	}, [bytes]);
	if (bytes === null) return <FallbackView file={file} note="문서를 읽지 못했습니다" />;
	if (error !== null) return <FallbackView file={file} note={error} />;
	if (srcdoc === null) return <Status>불러오는 중</Status>;
	return <iframe className="ql__frame" sandbox="" title={file.name} srcDoc={srcdoc} />;
}

function cellText(cell: unknown): string {
	if (cell === null || cell === undefined) return "";
	if (typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean") return String(cell);
	return "";
}

export function SheetView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const bytes = file.bytes;
	const [sheet, setSheet] = useState(0);
	if (bytes === null) return <FallbackView file={file} note="시트를 읽지 못했습니다" />;
	let names: readonly string[] = [];
	let rows: readonly (readonly string[])[] = [];
	try {
		const book = read(copyBytes(bytes), { type: "array" });
		names = book.SheetNames;
		const name = names[sheet] ?? names[0];
		const grid = name === undefined ? undefined : book.Sheets[name];
		if (grid !== undefined) {
			const table: unknown = utils.sheet_to_json(grid, { header: 1, raw: false, blankrows: false });
			if (Array.isArray(table)) {
				rows = table.slice(0, 100).map((row) => (Array.isArray(row) ? row.slice(0, 20).map(cellText) : []));
			}
		}
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : "시트를 열 수 없습니다";
		return <FallbackView file={file} note={message} />;
	}
	if (names.length === 0) return <FallbackView file={file} note="시트가 없습니다" />;
	return (
		<>
			<div className="ql__tablewrap">
				<table className="ql__table">
					<tbody>
						{rows.map((row, rowIndex) => (
							<tr key={rowIndex}>
								{row.map((cell, cellIndex) =>
									rowIndex === 0 ? <th key={cellIndex}>{cell}</th> : <td key={cellIndex}>{cell}</td>,
								)}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{names.length > 1 ? (
				<div className="ql__pager">
					<button type="button" disabled={sheet <= 0} onClick={() => setSheet((current) => current - 1)}>
						이전
					</button>
					<span>{names[sheet] ?? ""}</span>
					<button type="button" disabled={sheet >= names.length - 1} onClick={() => setSheet((current) => current + 1)}>
						다음
					</button>
				</div>
			) : null}
		</>
	);
}
