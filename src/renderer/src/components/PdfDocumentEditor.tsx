import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
	ArrowDown,
	ArrowUp,
	Check,
	Crop,
	ExternalLink,
	FileOutput,
	Loader2,
	PenLine,
	RotateCcw,
	RotateCw,
	Scissors,
	Trash2,
	Type,
	Upload,
	X,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import { previewStreamUrl } from "../../../preview/shared/contract";
import { pdfDocumentSource } from "../../../preview/ui/pdf-config";
import type { DocumentEditorPdfPayload, PdfEditOperation } from "../../../shared/document-editor-contract";
import { cn } from "../lib/cn";

let pdfWorkerReady = false;
function ensurePdfWorker(): void {
	if (pdfWorkerReady) return;
	GlobalWorkerOptions.workerSrc = workerUrl;
	pdfWorkerReady = true;
}

const SAVED_SIGNATURES_KEY = "dazzi.pdfEditor.signatures";
const MAX_SAVED_SIGNATURES = 6;

function loadSavedSignatures(): readonly string[] {
	try {
		const raw = window.localStorage.getItem(SAVED_SIGNATURES_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string" && item.startsWith("data:image/png;base64,")).slice(0, MAX_SAVED_SIGNATURES)
			: [];
	} catch {
		return [];
	}
}

function storeSavedSignatures(signatures: readonly string[]): void {
	try {
		window.localStorage.setItem(SAVED_SIGNATURES_KEY, JSON.stringify(signatures.slice(0, MAX_SAVED_SIGNATURES)));
	} catch {
		// Ignore restricted storage.
	}
}

/** Renders arbitrary text (including Korean/CJK/emoji) to a crisp transparent PNG for pdf-lib embedding. */
function renderTextStampPng(text: string, fontSizePx = 28, color = "#1D1D1F"): { readonly dataUrl: string; readonly aspect: number } {
	const lines = text.split("\n");
	const dpr = 3;
	const padX = 10;
	const padY = 6;
	const lineHeight = Math.round(fontSizePx * 1.3);
	const measureCanvas = document.createElement("canvas");
	const mctx = measureCanvas.getContext("2d")!;
	const font = `500 ${fontSizePx}px "Pretendard Variable", -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
	mctx.font = font;
	const maxWidth = Math.max(40, ...lines.map((line) => Math.ceil(mctx.measureText(line || " ").width)));
	const logicalW = maxWidth + padX * 2;
	const logicalH = lines.length * lineHeight + padY * 2;

	const canvas = document.createElement("canvas");
	canvas.width = logicalW * dpr;
	canvas.height = logicalH * dpr;
	const ctx = canvas.getContext("2d")!;
	ctx.scale(dpr, dpr);
	ctx.font = font;
	ctx.fillStyle = color;
	ctx.textBaseline = "top";
	lines.forEach((line, idx) => {
		ctx.fillText(line, padX, padY + idx * lineHeight);
	});
	return { dataUrl: canvas.toDataURL("image/png"), aspect: logicalW / logicalH };
}

interface PendingStamp {
	readonly kind: "signature" | "text";
	readonly pngDataUrl: string;
	readonly pageIndex: number;
	/** Normalized top-left coordinates (0..1) on the target page. */
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

interface CropDraft {
	readonly pageIndex: number;
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

function PdfPageCanvas({
	pdf,
	pageNumber,
	scale,
	className,
}: {
	readonly pdf: PDFDocumentProxy;
	readonly pageNumber: number;
	readonly scale: number;
	readonly className?: string;
}): ReactElement {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const [size, setSize] = useState<{ readonly width: number; readonly height: number } | null>(null);

	useEffect(() => {
		let cancelled = false;
		let renderTask: { cancel(): void; promise: Promise<void> } | null = null;
		const run = async (): Promise<void> => {
			try {
				const page = await pdf.getPage(pageNumber);
				if (cancelled) return;
				const viewport = page.getViewport({ scale });
				setSize({ width: Math.round(viewport.width), height: Math.round(viewport.height) });
				const canvas = canvasRef.current;
				if (canvas === null) return;
				const dpr = Math.min(window.devicePixelRatio || 1, 2);
				canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
				canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
				const ctx = canvas.getContext("2d");
				if (ctx === null) return;
				ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
				ctx.clearRect(0, 0, viewport.width, viewport.height);
				renderTask = page.render({ canvasContext: ctx, canvas, viewport });
				await renderTask.promise;
			} catch {
				// Ignore cancellation or superseded document errors on re-render.
			}
		};
		void run();
		return () => {
			cancelled = true;
			renderTask?.cancel();
		};
	}, [pdf, pageNumber, scale]);

	return (
		<canvas
			ref={canvasRef}
			className={cn("block bg-white", className)}
			style={size === null ? undefined : { width: size.width, height: size.height }}
		/>
	);
}

function SignaturePadModal({
	saved,
	onSaveSignature,
	onRemoveSaved,
	onClose,
}: {
	readonly saved: readonly string[];
	readonly onSaveSignature: (pngDataUrl: string, aspect: number, remember: boolean) => void;
	readonly onRemoveSaved: (index: number) => void;
	readonly onClose: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const drawingRef = useRef(false);
	const [hasInk, setHasInk] = useState(false);
	const [inkColor, setInkColor] = useState("#111827");
	const [remember, setRemember] = useState(true);

	const clearCanvas = (): void => {
		const canvas = canvasRef.current;
		if (canvas === null) return;
		const ctx = canvas.getContext("2d");
		ctx?.clearRect(0, 0, canvas.width, canvas.height);
		setHasInk(false);
	};

	const pointOf = (event: PointerEvent<HTMLCanvasElement>): { readonly x: number; readonly y: number } => {
		const canvas = canvasRef.current!;
		const rect = canvas.getBoundingClientRect();
		return {
			x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * canvas.width,
			y: ((event.clientY - rect.top) / Math.max(1, rect.height)) * canvas.height,
		};
	};

	const onDown = (event: PointerEvent<HTMLCanvasElement>): void => {
		if (event.button !== 0 || canvasRef.current === null) return;
		const ctx = canvasRef.current.getContext("2d");
		if (ctx === null) return;
		canvasRef.current.setPointerCapture(event.pointerId);
		drawingRef.current = true;
		const pt = pointOf(event);
		ctx.strokeStyle = inkColor;
		ctx.lineWidth = 4.5;
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		ctx.beginPath();
		ctx.moveTo(pt.x, pt.y);
		ctx.lineTo(pt.x + 0.1, pt.y + 0.1);
		ctx.stroke();
		setHasInk(true);
	};

	const onMove = (event: PointerEvent<HTMLCanvasElement>): void => {
		if (!drawingRef.current || canvasRef.current === null) return;
		const ctx = canvasRef.current.getContext("2d");
		if (ctx === null) return;
		const pt = pointOf(event);
		ctx.lineTo(pt.x, pt.y);
		ctx.stroke();
	};

	const onUp = (event: PointerEvent<HTMLCanvasElement>): void => {
		if (!drawingRef.current) return;
		drawingRef.current = false;
		if (canvasRef.current?.hasPointerCapture(event.pointerId)) {
			canvasRef.current.releasePointerCapture(event.pointerId);
		}
	};

	const commitDrawing = (): void => {
		const canvas = canvasRef.current;
		if (canvas === null || !hasInk) return;
		// Trim transparent padding around the drawn ink so the placed box fits tightly.
		const ctx = canvas.getContext("2d");
		if (ctx === null) return;
		const { width, height } = canvas;
		const data = ctx.getImageData(0, 0, width, height).data;
		let minX = width;
		let minY = height;
		let maxX = 0;
		let maxY = 0;
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				if ((data[(y * width + x) * 4 + 3] ?? 0) > 10) {
					if (x < minX) minX = x;
					if (y < minY) minY = y;
					if (x > maxX) maxX = x;
					if (y > maxY) maxY = y;
				}
			}
		}
		if (maxX <= minX || maxY <= minY) return;
		const pad = 16;
		const sx = Math.max(0, minX - pad);
		const sy = Math.max(0, minY - pad);
		const sw = Math.min(width - sx, maxX - minX + pad * 2);
		const sh = Math.min(height - sy, maxY - minY + pad * 2);
		const out = document.createElement("canvas");
		out.width = sw;
		out.height = sh;
		out.getContext("2d")?.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
		onSaveSignature(out.toDataURL("image/png"), sw / Math.max(1, sh), remember);
	};

	const onUploadImage = (file: File | undefined): void => {
		if (file === undefined) return;
		const reader = new FileReader();
		reader.onload = () => {
			const src = typeof reader.result === "string" ? reader.result : "";
			if (!src) return;
			const img = new Image();
			img.onload = () => {
				const out = document.createElement("canvas");
				out.width = Math.min(1200, Math.max(1, img.naturalWidth));
				out.height = Math.round((out.width / Math.max(1, img.naturalWidth)) * Math.max(1, img.naturalHeight));
				out.getContext("2d")?.drawImage(img, 0, 0, out.width, out.height);
				onSaveSignature(out.toDataURL("image/png"), out.width / Math.max(1, out.height), remember);
			};
			img.src = src;
		};
		reader.readAsDataURL(file);
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-xs" role="dialog" aria-modal="true" aria-label={t("documentEditor.pdf.signatureTitle")}>
			<div className="flex w-[460px] max-w-[92vw] flex-col gap-12 rounded-modal-md border border-border bg-window p-16 shadow-xl">
				<div className="flex items-center justify-between">
					<h3 className="m-0 text-body font-semibold text-ink">{t("documentEditor.pdf.signatureTitle")}</h3>
					<button
						type="button"
						aria-label={t("common.close")}
						className="flex size-24 items-center justify-center rounded-6 border-0 bg-transparent text-ink-muted hover:bg-hover-icon hover:text-ink"
						onClick={onClose}
					>
						<X size={14} />
					</button>
				</div>

				<div className="flex items-center justify-between gap-8">
					<div className="flex items-center gap-6">
						{["#111827", "#1D4ED8", "#B91C1C"].map((color) => (
							<button
								key={color}
								type="button"
								aria-label={color}
								aria-pressed={inkColor === color}
								className={cn(
									"size-20 rounded-full border-2",
									inkColor === color ? "border-accent scale-110" : "border-border",
								)}
								style={{ backgroundColor: color }}
								onClick={() => setInkColor(color)}
							/>
						))}
					</div>
					<div className="flex items-center gap-6">
						<label className="inline-flex h-24 cursor-pointer items-center gap-4 rounded-6 border border-border bg-subtle px-8 text-meta text-ink hover:bg-hover-row">
							<Upload size={12} />
							{t("documentEditor.pdf.uploadSignature")}
							<input
								type="file"
								accept="image/png,image/jpeg,image/webp"
								className="hidden"
								onChange={(event) => onUploadImage(event.target.files?.[0])}
							/>
						</label>
						<button
							type="button"
							className="h-24 rounded-6 border border-border bg-subtle px-8 text-meta text-ink hover:bg-hover-row"
							onClick={clearCanvas}
						>
							{t("quickLook.markup.clear")}
						</button>
					</div>
				</div>

				<div className="overflow-hidden rounded-8 border border-border bg-white">
					<canvas
						ref={canvasRef}
						width={840}
						height={320}
						data-signature-canvas="true"
						className="block h-[160px] w-full cursor-crosshair touch-none"
						onPointerDown={onDown}
						onPointerMove={onMove}
						onPointerUp={onUp}
						onPointerCancel={onUp}
					/>
				</div>

				{saved.length > 0 ? (
					<div className="flex flex-col gap-6">
						<div className="text-badge font-medium text-ink-muted">{t("documentEditor.pdf.savedSignatures")}</div>
						<div className="flex flex-wrap gap-6">
							{saved.map((sig, index) => (
								<div key={index} className="group relative flex h-44 w-96 items-center justify-center rounded-6 border border-border bg-white p-4">
									<button
										type="button"
										className="flex h-full w-full items-center justify-center border-0 bg-transparent p-0"
										onClick={() => {
											const img = new Image();
											img.onload = () => onSaveSignature(sig, img.naturalWidth / Math.max(1, img.naturalHeight), false);
											img.src = sig;
										}}
									>
										<img src={sig} alt="" className="max-h-full max-w-full object-contain" />
									</button>
									<button
										type="button"
										aria-label={t("common.delete")}
										className="absolute -top-5 -right-5 hidden size-16 items-center justify-center rounded-full border border-border bg-window text-ink-muted group-hover:flex hover:text-error"
										onClick={() => onRemoveSaved(index)}
									>
										<X size={10} />
									</button>
								</div>
							))}
						</div>
					</div>
				) : null}

				<div className="flex items-center justify-between pt-4">
					<label className="inline-flex cursor-pointer items-center gap-6 text-meta text-ink-muted select-none">
						<input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="size-13 accent-accent" />
						{t("documentEditor.pdf.rememberSignature")}
					</label>
					<div className="flex items-center gap-6">
						<button
							type="button"
							className="h-28 rounded-7 border border-border bg-window px-12 text-meta font-medium text-ink hover:bg-hover-row"
							onClick={onClose}
						>
							{t("common.cancel")}
						</button>
						<button
							type="button"
							disabled={!hasInk}
							className="h-28 rounded-7 border-0 bg-accent px-14 text-meta font-semibold text-on-accent hover:opacity-90 disabled:opacity-40"
							onClick={commitDrawing}
						>
							{t("documentEditor.pdf.placeSignature")}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

export interface PdfDocumentEditorProps {
	readonly payload: DocumentEditorPdfPayload;
	readonly onPayloadChange: (next: DocumentEditorPdfPayload) => void;
	readonly onOpenExternal?: (path: string) => void;
	readonly onOpenExtracted?: (path: string) => void;
}

/**
 * Interactive PDF editor built on `pdfjs-dist` (rendering) and `pdf-lib` (main-process edits).
 * Supports signature drawing/upload placement, text/date stamps, page cropping (CropBox),
 * rotation, page reordering, page deletion, multi-page extraction, and snapshot undo.
 */
export function PdfDocumentEditor({
	payload,
	onPayloadChange,
	onOpenExternal,
	onOpenExtracted,
}: PdfDocumentEditorProps): ReactElement {
	const { t } = useTranslation();
	const editorApi = window.autorag.documentEditor;

	const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
	const [pdfError, setPdfError] = useState<string | null>(null);
	const [activePage, setActivePage] = useState(0); // 0-based
	const [selectedPages, setSelectedPages] = useState<ReadonlySet<number>>(() => new Set());
	const [scale, setScale] = useState(1.1);
	const [busy, setBusy] = useState(false);
	const [statusMsg, setStatusMsg] = useState<string | null>(null);
	const [extractedFile, setExtractedFile] = useState<{ readonly path: string; readonly name: string } | null>(null);
	const [undoStack, setUndoStack] = useState<readonly string[]>([]);

	// Modals & active overlays
	const [sigModalOpen, setSigModalOpen] = useState(false);
	const [savedSigs, setSavedSigs] = useState<readonly string[]>(loadSavedSignatures);
	const [textPromptOpen, setTextPromptOpen] = useState(false);
	const [textInput, setTextInput] = useState("");
	const [pendingStamp, setPendingStamp] = useState<PendingStamp | null>(null);
	const [cropMode, setCropMode] = useState(false);
	const [cropDraft, setCropDraft] = useState<CropDraft | null>(null);

	const pageFrameRef = useRef<HTMLDivElement | null>(null);
	const dragRef = useRef<{
		readonly mode: "move" | "resize" | "crop";
		readonly startX: number;
		readonly startY: number;
		readonly initX: number;
		readonly initY: number;
		readonly initW: number;
		readonly initH: number;
	} | null>(null);

	const streamUrl = previewStreamUrl(payload.path, { modifiedAt: payload.modifiedAt, size: payload.size });

	const activeTaskRef = useRef<{ destroy(): Promise<void> } | null>(null);
	useEffect(
		() => () => {
			const prev = activeTaskRef.current;
			activeTaskRef.current = null;
			if (prev !== null) void prev.destroy().catch(() => undefined);
		},
		[],
	);

	useEffect(() => {
		if (payload.encrypted) {
			setPdf(null);
			const prev = activeTaskRef.current;
			activeTaskRef.current = null;
			if (prev !== null) void prev.destroy().catch(() => undefined);
			return;
		}
		ensurePdfWorker();
		let cancelled = false;
		const task = getDocument(pdfDocumentSource(streamUrl));
		task.promise
			.then((doc) => {
				if (cancelled) {
					void task.destroy().catch(() => undefined);
					return;
				}
				const prev = activeTaskRef.current;
				activeTaskRef.current = task;
				setPdf(doc);
				setPdfError(null);
				setActivePage((curr) => Math.min(curr, Math.max(0, doc.numPages - 1)));
				if (prev !== null && prev !== task) {
					window.setTimeout(() => void prev.destroy().catch(() => undefined), 500);
				}
			})
			.catch((error: unknown) => {
				if (!cancelled) setPdfError(error instanceof Error ? error.message : String(error));
			});
		return () => {
			cancelled = true;
			if (activeTaskRef.current !== task) {
				void task.destroy().catch(() => undefined);
			}
		};
	}, [streamUrl, payload.encrypted]);

	const applyOps = useCallback(
		async (operations: readonly PdfEditOperation[], successNote?: string): Promise<boolean> => {
			if (busy || payload.encrypted) return false;
			setBusy(true);
			setStatusMsg(null);
			try {
				const result = await editorApi.pdfApply({
					path: payload.path,
					operations,
					expectedMtimeMs: payload.mtimeMs,
				});
				if (!result.ok) {
					setStatusMsg(t("documentEditor.conflict"));
					return false;
				}
				setUndoStack((stack) => [...stack, result.snapshotId]);
				onPayloadChange({
					...payload,
					size: result.size,
					modifiedAt: result.modifiedAt,
					mtimeMs: result.mtimeMs,
					pageCount: result.pageCount,
				});
				if (successNote) setStatusMsg(successNote);
				return true;
			} catch (error: unknown) {
				setStatusMsg(error instanceof Error ? error.message : String(error));
				return false;
			} finally {
				setBusy(false);
			}
		},
		[busy, editorApi, onPayloadChange, payload, t],
	);

	const undoLast = useCallback(async () => {
		const snapshotId = undoStack.at(-1);
		if (snapshotId === undefined || busy) return;
		setBusy(true);
		setStatusMsg(null);
		try {
			const res = await editorApi.pdfRestore(snapshotId);
			if (res.ok && res.size !== undefined && res.modifiedAt !== undefined && res.mtimeMs !== undefined && res.pageCount !== undefined) {
				setUndoStack((stack) => stack.slice(0, -1));
				onPayloadChange({
					...payload,
					size: res.size,
					modifiedAt: res.modifiedAt,
					mtimeMs: res.mtimeMs,
					pageCount: res.pageCount,
				});
				setStatusMsg(t("documentEditor.pdf.undone"));
			}
		} catch (error: unknown) {
			setStatusMsg(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}, [busy, editorApi, onPayloadChange, payload, t, undoStack]);

	const handleExtractPages = useCallback(async () => {
		if (busy || payload.encrypted || payload.pageCount === 0) return;
		const pages =
			selectedPages.size > 0
				? [...selectedPages].sort((a, b) => a - b).map((idx) => idx + 1)
				: [activePage + 1];
		setBusy(true);
		setStatusMsg(null);
		try {
			const res = await editorApi.pdfExtract({ path: payload.path, pages });
			setExtractedFile({ path: res.outputPath, name: res.name });
			setStatusMsg(t("documentEditor.pdf.extracted", { name: res.name, count: res.pageCount }));
		} catch (error: unknown) {
			setStatusMsg(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}, [activePage, busy, editorApi, payload.encrypted, payload.pageCount, payload.path, selectedPages, t]);

	const beginStampPlacement = (kind: "signature" | "text", pngDataUrl: string, aspect: number): void => {
		setCropMode(false);
		setCropDraft(null);
		const width = kind === "signature" ? 0.28 : Math.min(0.45, Math.max(0.16, 0.06 * aspect));
		// Convert PNG aspect to page-fraction height assuming standard A4-ish 0.72 ratio fallback.
		const frame = pageFrameRef.current?.getBoundingClientRect();
		const pageAspect = frame !== undefined && frame.height > 0 ? frame.width / frame.height : 0.72;
		const height = Math.min(0.4, Math.max(0.035, (width * pageAspect) / Math.max(0.2, aspect)));
		setPendingStamp({
			kind,
			pngDataUrl,
			pageIndex: activePage,
			x: Math.max(0.05, 0.5 - width / 2),
			y: Math.max(0.05, 0.42 - height / 2),
			width,
			height,
		});
	};

	const commitStamp = async (): Promise<void> => {
		if (pendingStamp === null) return;
		const ok = await applyOps(
			[
				{
					kind: "stampImage",
					pageIndex: pendingStamp.pageIndex,
					pngDataUrl: pendingStamp.pngDataUrl,
					x: pendingStamp.x,
					y: pendingStamp.y,
					width: pendingStamp.width,
					height: pendingStamp.height,
				},
			],
			pendingStamp.kind === "signature" ? t("documentEditor.pdf.signatureApplied") : t("documentEditor.pdf.textApplied"),
		);
		if (ok) setPendingStamp(null);
	};

	const commitCrop = async (): Promise<void> => {
		if (cropDraft === null) return;
		const ok = await applyOps(
			[
				{
					kind: "cropPage",
					pageIndex: cropDraft.pageIndex,
					left: cropDraft.left,
					top: cropDraft.top,
					width: cropDraft.width,
					height: cropDraft.height,
				},
			],
			t("documentEditor.pdf.cropped"),
		);
		if (ok) {
			setCropMode(false);
			setCropDraft(null);
		}
	};

	const onStagePointerDown = (event: PointerEvent<HTMLDivElement>): void => {
		if (!cropMode || event.button !== 0 || pageFrameRef.current === null) return;
		const rect = pageFrameRef.current.getBoundingClientRect();
		const fx = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
		const fy = Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height)));
		event.currentTarget.setPointerCapture(event.pointerId);
		dragRef.current = { mode: "crop", startX: fx, startY: fy, initX: fx, initY: fy, initW: 0, initH: 0 };
		setCropDraft({ pageIndex: activePage, left: fx, top: fy, width: 0.01, height: 0.01 });
	};

	const onStagePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
		const drag = dragRef.current;
		if (drag === null || pageFrameRef.current === null) return;
		const rect = pageFrameRef.current.getBoundingClientRect();
		const fx = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
		const fy = Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height)));
		if (drag.mode === "crop") {
			const left = Math.min(drag.startX, fx);
			const top = Math.min(drag.startY, fy);
			const width = Math.max(0.03, Math.abs(fx - drag.startX));
			const height = Math.max(0.03, Math.abs(fy - drag.startY));
			setCropDraft({ pageIndex: activePage, left, top, width: Math.min(1 - left, width), height: Math.min(1 - top, height) });
			return;
		}
		if (drag.mode === "move") {
			const dx = fx - drag.startX;
			const dy = fy - drag.startY;
			setPendingStamp((curr) =>
				curr === null
					? null
					: {
							...curr,
							x: Math.min(1 - curr.width, Math.max(0, drag.initX + dx)),
							y: Math.min(1 - curr.height, Math.max(0, drag.initY + dy)),
						},
			);
			return;
		}
		if (drag.mode === "resize") {
			const dx = fx - drag.startX;
			const nextW = Math.min(1 - drag.initX, Math.max(0.06, drag.initW + dx));
			const ratio = drag.initH / Math.max(0.01, drag.initW);
			const nextH = Math.min(1 - drag.initY, Math.max(0.025, nextW * ratio));
			setPendingStamp((curr) => (curr === null ? null : { ...curr, width: nextW, height: nextH }));
		}
	};

	const onStagePointerUp = (event: PointerEvent<HTMLDivElement>): void => {
		if (dragRef.current === null) return;
		dragRef.current = null;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
	};

	const togglePageSelected = (idx: number): void => {
		setSelectedPages((curr) => {
			const next = new Set(curr);
			if (next.has(idx)) next.delete(idx);
			else next.add(idx);
			return next;
		});
	};

	const numPages = pdf?.numPages ?? payload.pageCount;

	return (
		<div className="doc-editor__pdf flex min-h-0 flex-1 flex-col bg-subtle text-ink" data-pdf-editor="true">
			{/* PDF Action Toolbar */}
			<div className="flex flex-none flex-wrap items-center gap-6 border-b border-divider bg-window px-12 py-6" role="toolbar" aria-label="PDF">
				<button
					type="button"
					disabled={busy || payload.encrypted}
					className="inline-flex h-26 items-center gap-5 rounded-6 border border-border bg-window px-10 text-meta font-medium text-ink hover:bg-hover-row disabled:opacity-40"
					onClick={() => setSigModalOpen(true)}
				>
					<PenLine size={13} className="text-accent" />
					{t("documentEditor.pdf.addSignature")}
				</button>
				<button
					type="button"
					disabled={busy || payload.encrypted}
					className="inline-flex h-26 items-center gap-5 rounded-6 border border-border bg-window px-10 text-meta font-medium text-ink hover:bg-hover-row disabled:opacity-40"
					onClick={() => {
						setTextPromptOpen((open) => !open);
						setTextInput("");
					}}
				>
					<Type size={13} />
					{t("documentEditor.pdf.addText")}
				</button>
				<button
					type="button"
					aria-pressed={cropMode}
					disabled={busy || payload.encrypted}
					className={cn(
						"inline-flex h-26 items-center gap-5 rounded-6 border px-10 text-meta font-medium transition-colors disabled:opacity-40",
						cropMode ? "border-accent bg-accent-soft text-accent" : "border-border bg-window text-ink hover:bg-hover-row",
					)}
					onClick={() => {
						setPendingStamp(null);
						setCropMode((curr) => {
							const next = !curr;
							setCropDraft(next ? { pageIndex: activePage, left: 0.08, top: 0.08, width: 0.84, height: 0.84 } : null);
							return next;
						});
					}}
				>
					<Crop size={13} />
					{t("documentEditor.pdf.cropPage")}
				</button>

				<span className="mx-2 h-16 w-px bg-divider" aria-hidden="true" />

				<button
					type="button"
					disabled={busy || payload.encrypted || numPages === 0}
					title={t("documentEditor.pdf.rotateRight")}
					aria-label={t("documentEditor.pdf.rotateRight")}
					className="inline-flex h-26 items-center gap-4 rounded-6 border border-border bg-window px-8 text-meta text-ink hover:bg-hover-row disabled:opacity-40"
					onClick={() => void applyOps([{ kind: "rotatePage", pageIndex: activePage, deltaDegrees: 90 }], t("documentEditor.pdf.rotated"))}
				>
					<RotateCw size={13} />
					{t("documentEditor.pdf.rotate")}
				</button>
				<button
					type="button"
					disabled={busy || payload.encrypted || activePage <= 0}
					title={t("documentEditor.pdf.moveUp")}
					aria-label={t("documentEditor.pdf.moveUp")}
					className="flex size-26 items-center justify-center rounded-6 border border-border bg-window text-ink hover:bg-hover-row disabled:opacity-35"
					onClick={async () => {
						const target = activePage - 1;
						const ok = await applyOps([{ kind: "movePage", fromIndex: activePage, toIndex: target }]);
						if (ok) setActivePage(target);
					}}
				>
					<ArrowUp size={13} />
				</button>
				<button
					type="button"
					disabled={busy || payload.encrypted || activePage >= numPages - 1}
					title={t("documentEditor.pdf.moveDown")}
					aria-label={t("documentEditor.pdf.moveDown")}
					className="flex size-26 items-center justify-center rounded-6 border border-border bg-window text-ink hover:bg-hover-row disabled:opacity-35"
					onClick={async () => {
						const target = activePage + 1;
						const ok = await applyOps([{ kind: "movePage", fromIndex: activePage, toIndex: target }]);
						if (ok) setActivePage(target);
					}}
				>
					<ArrowDown size={13} />
				</button>
				<button
					type="button"
					disabled={busy || payload.encrypted || numPages <= 1}
					title={t("documentEditor.pdf.deletePage")}
					aria-label={t("documentEditor.pdf.deletePage")}
					className="inline-flex h-26 items-center gap-4 rounded-6 border border-border bg-window px-8 text-meta text-error hover:bg-error-soft disabled:opacity-35"
					onClick={async () => {
						const ok = await applyOps([{ kind: "deletePage", pageIndex: activePage }], t("documentEditor.pdf.pageDeleted"));
						if (ok) {
							setSelectedPages(new Set());
							setActivePage((curr) => Math.max(0, Math.min(curr, numPages - 2)));
						}
					}}
				>
					<Trash2 size={13} />
					{t("documentEditor.pdf.deletePage")}
				</button>
				<button
					type="button"
					disabled={busy || payload.encrypted || numPages === 0}
					className="inline-flex h-26 items-center gap-5 rounded-6 border border-border bg-window px-10 text-meta font-medium text-ink hover:bg-hover-row disabled:opacity-40"
					onClick={() => void handleExtractPages()}
				>
					<FileOutput size={13} />
					{selectedPages.size > 0
						? t("documentEditor.pdf.extractCount", { count: selectedPages.size })
						: t("documentEditor.pdf.extractCurrent")}
				</button>

				<div className="flex-1" />

				{/* Undo & Zoom */}
				<button
					type="button"
					disabled={busy || undoStack.length === 0}
					className="inline-flex h-26 items-center gap-4 rounded-6 border border-border bg-window px-8 text-meta font-medium text-ink hover:bg-hover-row disabled:opacity-35"
					onClick={() => void undoLast()}
				>
					<RotateCcw size={13} />
					{t("documentEditor.toolbar.undo")}
				</button>
				<div className="inline-flex items-center gap-2">
					<button
						type="button"
						aria-label={t("documentEditor.pdf.zoomOut")}
						className="flex size-24 items-center justify-center rounded-5 border-0 bg-transparent text-ink-body hover:bg-hover-icon"
						onClick={() => setScale((s) => Math.max(0.5, Number((s - 0.15).toFixed(2))))}
					>
						<ZoomOut size={13} />
					</button>
					<span className="w-40 text-center text-badge tabular-nums text-ink-muted">{Math.round(scale * 100)}%</span>
					<button
						type="button"
						aria-label={t("documentEditor.pdf.zoomIn")}
						className="flex size-24 items-center justify-center rounded-5 border-0 bg-transparent text-ink-body hover:bg-hover-icon"
						onClick={() => setScale((s) => Math.min(2.2, Number((s + 0.15).toFixed(2))))}
					>
						<ZoomIn size={13} />
					</button>
				</div>
				{onOpenExternal !== undefined ? (
					<button
						type="button"
						aria-label={t("documentEditor.package.openExternal")}
						title={t("documentEditor.package.openExternal")}
						className="flex size-26 items-center justify-center rounded-6 border border-border bg-window text-ink-body hover:bg-hover-row"
						onClick={() => onOpenExternal(payload.path)}
					>
						<ExternalLink size={13} />
					</button>
				) : null}
			</div>

			{/* Inline text stamp composer */}
			{textPromptOpen ? (
				<div className="flex flex-none items-center gap-8 border-b border-divider bg-subtle px-14 py-8">
					<input
						type="text"
						value={textInput}
						placeholder={t("documentEditor.pdf.textPlaceholder")}
						className="h-28 flex-1 rounded-6 border border-border bg-window px-10 text-body text-ink outline-none focus:border-accent"
						onChange={(e) => setTextInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && textInput.trim() !== "") {
								const rendered = renderTextStampPng(textInput.trim());
								beginStampPlacement("text", rendered.dataUrl, rendered.aspect);
								setTextPromptOpen(false);
							}
						}}
						autoFocus
					/>
					<button
						type="button"
						disabled={textInput.trim() === ""}
						className="h-28 rounded-6 border-0 bg-accent px-12 text-meta font-semibold text-on-accent disabled:opacity-40"
						onClick={() => {
							const rendered = renderTextStampPng(textInput.trim());
							beginStampPlacement("text", rendered.dataUrl, rendered.aspect);
							setTextPromptOpen(false);
						}}
					>
						{t("documentEditor.pdf.placeText")}
					</button>
					<button
						type="button"
						className="h-28 rounded-6 border border-border bg-window px-10 text-meta text-ink"
						onClick={() => setTextPromptOpen(false)}
					>
						{t("common.cancel")}
					</button>
				</div>
			) : null}

			{/* Pending placement / crop confirmation bar */}
			{pendingStamp !== null ? (
				<div className="flex flex-none items-center justify-between gap-8 border-b border-divider bg-accent-soft px-14 py-6 text-meta text-accent">
					<span>{t("documentEditor.pdf.placementHint")}</span>
					<div className="flex items-center gap-6">
						<button
							type="button"
							className="h-24 rounded-6 border border-border bg-window px-10 text-meta font-medium text-ink"
							onClick={() => setPendingStamp(null)}
						>
							{t("common.cancel")}
						</button>
						<button
							type="button"
							disabled={busy}
							data-pdf-commit-stamp="true"
							className="inline-flex h-24 items-center gap-4 rounded-6 border-0 bg-accent px-12 text-meta font-semibold text-on-accent"
							onClick={() => void commitStamp()}
						>
							<Check size={12} />
							{t("documentEditor.ai.send")}
						</button>
					</div>
				</div>
			) : null}

			{cropMode && cropDraft !== null ? (
				<div className="flex flex-none items-center justify-between gap-8 border-b border-divider bg-accent-soft px-14 py-6 text-meta text-accent">
					<span>{t("documentEditor.pdf.cropHint")}</span>
					<div className="flex items-center gap-6">
						<button
							type="button"
							className="h-24 rounded-6 border border-border bg-window px-10 text-meta font-medium text-ink"
							onClick={() => {
								setCropMode(false);
								setCropDraft(null);
							}}
						>
							{t("common.cancel")}
						</button>
						<button
							type="button"
							disabled={busy}
							data-pdf-commit-crop="true"
							className="inline-flex h-24 items-center gap-4 rounded-6 border-0 bg-accent px-12 text-meta font-semibold text-on-accent"
							onClick={() => void commitCrop()}
						>
							<Scissors size={12} />
							{t("documentEditor.pdf.applyCrop")}
						</button>
					</div>
				</div>
			) : null}

			{statusMsg !== null ? (
				<div className="flex flex-none items-center justify-between gap-8 border-b border-divider bg-window px-14 py-5 text-meta text-ink-body" role="status">
					<span>{statusMsg}</span>
					<div className="flex items-center gap-8">
						{extractedFile !== null && onOpenExtracted !== undefined ? (
							<button
								type="button"
								className="h-22 rounded-5 border border-accent bg-accent-soft px-8 text-badge font-medium text-accent"
								onClick={() => onOpenExtracted(extractedFile.path)}
							>
								{t("documentEditor.pdf.openExtracted", { name: extractedFile.name })}
							</button>
						) : null}
						<button
							type="button"
							aria-label={t("common.close")}
							className="border-0 bg-transparent text-ink-muted hover:text-ink"
							onClick={() => {
								setStatusMsg(null);
								setExtractedFile(null);
							}}
						>
							<X size={12} />
						</button>
					</div>
				</div>
			) : null}

			{/* Main split: Thumbnail rail + active PDF page canvas */}
			{payload.encrypted ? (
				<div className="flex flex-1 items-center justify-center p-24 text-center text-body text-ink-muted">
					{t("documentEditor.pdf.encryptedNotice")}
				</div>
			) : pdfError !== null ? (
				<div className="flex flex-1 items-center justify-center p-24 text-center text-body text-error">{pdfError}</div>
			) : pdf === null ? (
				<div className="flex flex-1 items-center justify-center gap-8 text-body text-ink-muted">
					<Loader2 size={16} className="animate-spin" />
					<span>{t("documentEditor.loading")}</span>
				</div>
			) : (
				<div className="flex min-h-0 flex-1 overflow-hidden">
					{/* Left page thumbnail rail */}
					<aside className="flex w-[136px] flex-none flex-col gap-10 overflow-y-auto border-r border-divider bg-chrome p-10" aria-label={t("documentEditor.pdf.pages")}>
						{Array.from({ length: pdf.numPages }, (_unused, idx) => {
							const isActive = idx === activePage;
							const isChecked = selectedPages.has(idx);
							return (
								<div
									key={idx}
									data-pdf-thumb={idx + 1}
									className={cn(
										"group relative flex flex-col items-center gap-4 rounded-8 p-6 transition-colors",
										isActive ? "bg-accent-soft ring-1 ring-accent" : "hover:bg-hover-row",
									)}
									onClick={() => {
										setActivePage(idx);
										setPendingStamp((curr) => (curr === null ? null : { ...curr, pageIndex: idx }));
										setCropDraft((curr) => (curr === null ? null : { ...curr, pageIndex: idx }));
									}}
								>
									<input
										type="checkbox"
										aria-label={t("documentEditor.pdf.selectPage", { page: idx + 1 })}
										checked={isChecked}
										onClick={(e) => e.stopPropagation()}
										onChange={() => togglePageSelected(idx)}
										className="absolute top-6 left-6 z-10 size-13 accent-accent"
									/>
									<div className="overflow-hidden rounded-4 shadow-sm ring-1 ring-black/10">
										<PdfPageCanvas pdf={pdf} pageNumber={idx + 1} scale={0.18} />
									</div>
									<span className={cn("text-badge tabular-nums", isActive ? "font-semibold text-accent" : "text-ink-muted")}>
										{idx + 1} / {pdf.numPages}
									</span>
								</div>
							);
						})}
					</aside>

					{/* Center page stage */}
					<div className="relative flex min-h-0 flex-1 items-start justify-center overflow-auto p-24">
						<div
							ref={pageFrameRef}
							data-pdf-page-stage={activePage + 1}
							className={cn(
								"relative flex-none overflow-hidden rounded-4 bg-white shadow-md ring-1 ring-black/10 select-none",
								cropMode && "cursor-crosshair",
							)}
							onPointerDown={onStagePointerDown}
							onPointerMove={onStagePointerMove}
							onPointerUp={onStagePointerUp}
							onPointerCancel={onStagePointerUp}
						>
							<PdfPageCanvas pdf={pdf} pageNumber={activePage + 1} scale={scale} />

							{/* Draggable & resizable stamp overlay */}
							{pendingStamp !== null && pendingStamp.pageIndex === activePage ? (
								<div
									data-pdf-stamp-box="true"
									className="absolute z-20 cursor-move border-2 border-dashed border-accent bg-accent/5"
									style={{
										left: `${pendingStamp.x * 100}%`,
										top: `${pendingStamp.y * 100}%`,
										width: `${pendingStamp.width * 100}%`,
										height: `${pendingStamp.height * 100}%`,
									}}
									onPointerDown={(event) => {
										if (event.button !== 0 || pageFrameRef.current === null) return;
										event.stopPropagation();
										const rect = pageFrameRef.current.getBoundingClientRect();
										const fx = (event.clientX - rect.left) / Math.max(1, rect.width);
										const fy = (event.clientY - rect.top) / Math.max(1, rect.height);
										pageFrameRef.current.setPointerCapture(event.pointerId);
										dragRef.current = {
											mode: "move",
											startX: fx,
											startY: fy,
											initX: pendingStamp.x,
											initY: pendingStamp.y,
											initW: pendingStamp.width,
											initH: pendingStamp.height,
										};
									}}
								>
									<img src={pendingStamp.pngDataUrl} alt="" className="pointer-events-none h-full w-full object-contain" />
									<div
										className="absolute -right-5 -bottom-5 size-12 cursor-nwse-resize rounded-full border-2 border-white bg-accent shadow"
										onPointerDown={(event) => {
											if (event.button !== 0 || pageFrameRef.current === null) return;
											event.stopPropagation();
											const rect = pageFrameRef.current.getBoundingClientRect();
											const fx = (event.clientX - rect.left) / Math.max(1, rect.width);
											const fy = (event.clientY - rect.top) / Math.max(1, rect.height);
											pageFrameRef.current.setPointerCapture(event.pointerId);
											dragRef.current = {
												mode: "resize",
												startX: fx,
												startY: fy,
												initX: pendingStamp.x,
												initY: pendingStamp.y,
												initW: pendingStamp.width,
												initH: pendingStamp.height,
											};
										}}
									/>
								</div>
							) : null}

							{/* Crop selection overlay */}
							{cropMode && cropDraft !== null && cropDraft.pageIndex === activePage ? (
								<div
									data-pdf-crop-box="true"
									className="pointer-events-none absolute z-20 border-2 border-accent shadow-[0_0_0_9999px_rgba(0,0,0,0.32)]"
									style={{
										left: `${cropDraft.left * 100}%`,
										top: `${cropDraft.top * 100}%`,
										width: `${cropDraft.width * 100}%`,
										height: `${cropDraft.height * 100}%`,
									}}
								/>
							) : null}
						</div>
					</div>
				</div>
			)}

			{sigModalOpen ? (
				<SignaturePadModal
					saved={savedSigs}
					onSaveSignature={(pngDataUrl, aspect, remember) => {
						if (remember) {
							const next = [pngDataUrl, ...savedSigs.filter((item) => item !== pngDataUrl)].slice(0, MAX_SAVED_SIGNATURES);
							setSavedSigs(next);
							storeSavedSignatures(next);
						}
						setSigModalOpen(false);
						beginStampPlacement("signature", pngDataUrl, aspect);
					}}
					onRemoveSaved={(index) => {
						const next = savedSigs.filter((_item, idx) => idx !== index);
						setSavedSigs(next);
						storeSavedSignatures(next);
					}}
					onClose={() => setSigModalOpen(false)}
				/>
			) : null}
		</div>
	);
}
