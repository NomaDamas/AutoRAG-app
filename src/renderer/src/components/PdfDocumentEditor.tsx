import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
	ArrowDown,
	ArrowUp,
	ArrowUpRight,
	Calendar,
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	Circle,
	Copy,
	Crop,
	Droplets,
	Eraser,
	ExternalLink,
	EyeOff,
	FileInput,
	FileOutput,
	FilePlus2,
	FileSliders,
	Hash,
	Highlighter,
	Image as ImageIcon,
	Info,
	Loader2,
	Minus,
	MoreHorizontal,
	Pencil,
	PenLine,
	RotateCcw,
	RotateCw,
	Scissors,
	Search,
	Shapes,
	SplitSquareHorizontal,
	Square,
	Stamp,
	StickyNote,
	Trash2,
	Type,
	Upload,
	X,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import { previewStreamUrl } from "../../../preview/shared/contract";
import { pdfDocumentSource } from "../../../preview/ui/pdf-config";
import type {
	DocumentEditorPdfPayload,
	PdfEditOperation,
	PdfPointFraction,
} from "../../../shared/document-editor-contract";
import { cn } from "../lib/cn";
import {
	PageNumbersModal,
	PdfFormsModal,
	PdfPropertiesModal,
	renderPresetStampPng,
	renderStickyNotePng,
	renderTextStampPng,
	renderWatermarkPng,
	SplitPdfModal,
	WatermarkModal,
} from "./PdfEditorTools";

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

type InteractiveTool = "none" | "crop" | "highlight" | "redact" | "whiteout" | "draw" | "shape";
type ShapeKind = "rect" | "ellipse" | "line" | "arrow";
type StampKind = "signature" | "text" | "image" | "stamp" | "note";

interface PendingStamp {
	readonly kind: StampKind;
	readonly pngDataUrl: string;
	readonly pageIndex: number;
	/** Normalized top-left coordinates (0..1) on the target page. */
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

interface RectDraft {
	readonly pageIndex: number;
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

interface ShapeDraft {
	readonly pageIndex: number;
	readonly shape: ShapeKind;
	readonly x1: number;
	readonly y1: number;
	readonly x2: number;
	readonly y2: number;
}

interface DrawDraft {
	readonly pageIndex: number;
	readonly points: readonly PdfPointFraction[];
}

const HIGHLIGHT_COLORS = ["#FDE047", "#86EFAC", "#93C5FD", "#F9A8D4", "#FDBA74"] as const;
const INK_COLORS = ["#1D1D1F", "#DC2626", "#2563EB", "#16A34A", "#9333EA"] as const;

function todayIso(): string {
	const now = new Date();
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
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
 * Covers core Adobe Acrobat workflows:
 * - Fill & Sign: signature pad/upload, styled text & date stamps, image insertion, AcroForm fill & flatten
 * - Annotate & Redact: highlighter, freehand pen, shapes (rect/ellipse/line/arrow), preset stamps, sticky notes, black redaction & whiteout
 * - Organize Pages: crop, rotate CW/CCW, reorder, duplicate, insert blank page, delete, extract, merge PDFs, split PDFs
 * - Polish & Inspect: watermark, page numbers + header/footer, document properties, full-text search, and multi-step snapshot undo
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

	// Modals, composers, menus & active interactive overlays
	const [sigModalOpen, setSigModalOpen] = useState(false);
	const [savedSigs, setSavedSigs] = useState<readonly string[]>(loadSavedSignatures);
	const [textPromptOpen, setTextPromptOpen] = useState(false);
	const [textInput, setTextInput] = useState("");
	const [textColor, setTextColor] = useState("#1D1D1F");
	const [textSize, setTextSize] = useState(28);
	const [notePromptOpen, setNotePromptOpen] = useState(false);
	const [noteInput, setNoteInput] = useState("");
	const [stampMenuOpen, setStampMenuOpen] = useState(false);
	const [moreMenuOpen, setMoreMenuOpen] = useState(false);
	const [watermarkOpen, setWatermarkOpen] = useState(false);
	const [pageNumbersOpen, setPageNumbersOpen] = useState(false);
	const [splitOpen, setSplitOpen] = useState(false);
	const [formsOpen, setFormsOpen] = useState(false);
	const [propertiesOpen, setPropertiesOpen] = useState(false);

	// Find-in-PDF bar
	const [findOpen, setFindOpen] = useState(false);
	const [findQuery, setFindQuery] = useState("");
	const [findMatches, setFindMatches] = useState<readonly number[]>([]); // 0-based page indices with matches
	const [findCursor, setFindCursor] = useState(0);

	// Active drawing / interactive tool state
	const [tool, setTool] = useState<InteractiveTool>("none");
	const [shapeKind, setShapeKind] = useState<ShapeKind>("rect");
	const [highlightColor, setHighlightColor] = useState<string>(HIGHLIGHT_COLORS[0]);
	const [strokeColor, setStrokeColor] = useState<string>(INK_COLORS[1]);
	const [strokeWidthPt, setStrokeWidthPt] = useState<number>(2.5);

	const [pendingStamp, setPendingStamp] = useState<PendingStamp | null>(null);
	const [cropDraft, setCropDraft] = useState<RectDraft | null>(null);
	const [rectDraft, setRectDraft] = useState<RectDraft | null>(null);
	const [shapeDraft, setShapeDraft] = useState<ShapeDraft | null>(null);
	const [drawDraft, setDrawDraft] = useState<DrawDraft | null>(null);

	const pageFrameRef = useRef<HTMLDivElement | null>(null);
	const imageInputRef = useRef<HTMLInputElement | null>(null);
	const dragRef = useRef<{
		readonly mode: "move" | "resize" | "crop" | "highlight" | "redact" | "whiteout" | "shape" | "draw";
		readonly startX: number;
		readonly startY: number;
		readonly initX: number;
		readonly initY: number;
		readonly initW: number;
		readonly initH: number;
	} | null>(null);
	const drawPointsRef = useRef<PdfPointFraction[]>([]);
	const rectDraftRef = useRef<RectDraft | null>(null);
	const shapeDraftRef = useRef<ShapeDraft | null>(null);

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

	// Cmd/Ctrl+F opens Find bar inside the PDF editor
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
				event.preventDefault();
				setFindOpen(true);
			} else if (event.key === "Escape") {
				setStampMenuOpen(false);
				setMoreMenuOpen(false);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// Execute PDF text search when query changes
	useEffect(() => {
		if (!findOpen || pdf === null || findQuery.trim() === "") {
			setFindMatches([]);
			setFindCursor(0);
			return;
		}
		let cancelled = false;
		const needle = findQuery.trim().toLowerCase();
		const run = async (): Promise<void> => {
			const matchedPages: number[] = [];
			for (let p = 1; p <= pdf.numPages; p += 1) {
				if (cancelled) return;
				try {
					const page = await pdf.getPage(p);
					const content = await page.getTextContent();
					const text = content.items
						.map((item) => ("str" in item ? item.str : ""))
						.join(" ")
						.toLowerCase();
					if (text.includes(needle)) matchedPages.push(p - 1);
				} catch {
					// Ignore page text extraction error
				}
			}
			if (cancelled) return;
			setFindMatches(matchedPages);
			setFindCursor(0);
			if (matchedPages.length > 0) setActivePage(matchedPages[0]!);
		};
		const timer = window.setTimeout(() => void run(), 180);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [findOpen, findQuery, pdf]);

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

	const handleMergePdfs = useCallback(async () => {
		if (busy || payload.encrypted) return;
		setMoreMenuOpen(false);
		try {
			const picked = await editorApi.pdfPickMergeFiles();
			if (picked.length === 0) return;
			await applyOps(
				[{ kind: "mergePdfs", sourcePaths: picked }],
				t("documentEditor.pdf.mergedApplied", { count: picked.length }),
			);
		} catch (error: unknown) {
			setStatusMsg(error instanceof Error ? error.message : String(error));
		}
	}, [applyOps, busy, editorApi, payload.encrypted, t]);

	const activateTool = (next: InteractiveTool): void => {
		setPendingStamp(null);
		setStampMenuOpen(false);
		setMoreMenuOpen(false);
		setTextPromptOpen(false);
		setNotePromptOpen(false);
		setRectDraft(null);
		setShapeDraft(null);
		setDrawDraft(null);
		setTool((curr) => {
			const resolved = curr === next ? "none" : next;
			setCropDraft(resolved === "crop" ? { pageIndex: activePage, left: 0.08, top: 0.08, width: 0.84, height: 0.84 } : null);
			return resolved;
		});
	};

	const beginStampPlacement = (kind: StampKind, pngDataUrl: string, aspect: number): void => {
		setTool("none");
		setCropDraft(null);
		setStampMenuOpen(false);
		setMoreMenuOpen(false);
		const width =
			kind === "signature"
				? 0.28
				: kind === "image"
					? 0.36
					: kind === "stamp"
						? 0.3
						: kind === "note"
							? 0.28
							: Math.min(0.45, Math.max(0.16, 0.06 * aspect));
		const frame = pageFrameRef.current?.getBoundingClientRect();
		const pageAspect = frame !== undefined && frame.height > 0 ? frame.width / frame.height : 0.72;
		const height = Math.min(0.45, Math.max(0.035, (width * pageAspect) / Math.max(0.2, aspect)));
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

	const handleInsertImageFile = (file: File | undefined): void => {
		if (file === undefined) return;
		const reader = new FileReader();
		reader.onload = () => {
			const src = typeof reader.result === "string" ? reader.result : "";
			if (!src) return;
			const img = new Image();
			img.onload = () => {
				const maxDim = 1600;
				const scaleDown = Math.min(1, maxDim / Math.max(1, img.naturalWidth, img.naturalHeight));
				const w = Math.max(1, Math.round(img.naturalWidth * scaleDown));
				const h = Math.max(1, Math.round(img.naturalHeight * scaleDown));
				const out = document.createElement("canvas");
				out.width = w;
				out.height = h;
				out.getContext("2d")?.drawImage(img, 0, 0, w, h);
				beginStampPlacement("image", out.toDataURL("image/png"), w / Math.max(1, h));
			};
			img.src = src;
		};
		reader.readAsDataURL(file);
	};

	const commitStamp = async (): Promise<void> => {
		if (pendingStamp === null) return;
		const noteKey: Record<StampKind, string> = {
			signature: t("documentEditor.pdf.signatureApplied"),
			text: t("documentEditor.pdf.textApplied"),
			image: t("documentEditor.pdf.imageApplied"),
			stamp: t("documentEditor.pdf.stampApplied"),
			note: t("documentEditor.pdf.noteApplied"),
		};
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
			noteKey[pendingStamp.kind],
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
			setTool("none");
			setCropDraft(null);
		}
	};

	const onStagePointerDown = (event: PointerEvent<HTMLDivElement>): void => {
		if (tool === "none" || event.button !== 0 || pageFrameRef.current === null || busy) return;
		const rect = pageFrameRef.current.getBoundingClientRect();
		const fx = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
		const fy = Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height)));
		event.currentTarget.setPointerCapture(event.pointerId);

		if (tool === "crop") {
			dragRef.current = { mode: "crop", startX: fx, startY: fy, initX: fx, initY: fy, initW: 0, initH: 0 };
			setCropDraft({ pageIndex: activePage, left: fx, top: fy, width: 0.01, height: 0.01 });
		} else if (tool === "highlight" || tool === "redact" || tool === "whiteout") {
			dragRef.current = { mode: tool, startX: fx, startY: fy, initX: fx, initY: fy, initW: 0, initH: 0 };
			const next: RectDraft = { pageIndex: activePage, left: fx, top: fy, width: 0.005, height: 0.005 };
			rectDraftRef.current = next;
			setRectDraft(next);
		} else if (tool === "shape") {
			dragRef.current = { mode: "shape", startX: fx, startY: fy, initX: fx, initY: fy, initW: 0, initH: 0 };
			const next: ShapeDraft = { pageIndex: activePage, shape: shapeKind, x1: fx, y1: fy, x2: fx, y2: fy };
			shapeDraftRef.current = next;
			setShapeDraft(next);
		} else if (tool === "draw") {
			dragRef.current = { mode: "draw", startX: fx, startY: fy, initX: fx, initY: fy, initW: 0, initH: 0 };
			drawPointsRef.current = [{ x: fx, y: fy }];
			setDrawDraft({ pageIndex: activePage, points: [{ x: fx, y: fy }] });
		}
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
		if (drag.mode === "highlight" || drag.mode === "redact" || drag.mode === "whiteout") {
			const left = Math.min(drag.startX, fx);
			const top = Math.min(drag.startY, fy);
			const width = Math.max(0.005, Math.abs(fx - drag.startX));
			const height = Math.max(0.005, Math.abs(fy - drag.startY));
			const next: RectDraft = { pageIndex: activePage, left, top, width: Math.min(1 - left, width), height: Math.min(1 - top, height) };
			rectDraftRef.current = next;
			setRectDraft(next);
			return;
		}
		if (drag.mode === "shape") {
			const next: ShapeDraft = { pageIndex: activePage, shape: shapeKind, x1: drag.startX, y1: drag.startY, x2: fx, y2: fy };
			shapeDraftRef.current = next;
			setShapeDraft(next);
			return;
		}
		if (drag.mode === "draw") {
			const pts = drawPointsRef.current;
			const last = pts.at(-1);
			if (last === undefined || Math.hypot(fx - last.x, fy - last.y) >= 0.004) {
				const nextPts = [...pts, { x: fx, y: fy }];
				drawPointsRef.current = nextPts;
				setDrawDraft({ pageIndex: activePage, points: nextPts });
			}
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
		const drag = dragRef.current;
		if (drag === null) return;
		dragRef.current = null;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}

		if (drag.mode === "highlight" || drag.mode === "redact" || drag.mode === "whiteout") {
			const draft = rectDraftRef.current;
			rectDraftRef.current = null;
			setRectDraft(null);
			if (draft !== null && draft.width >= 0.008 && draft.height >= 0.006) {
				if (drag.mode === "highlight") {
					void applyOps(
						[
							{
								kind: "highlightRect",
								pageIndex: draft.pageIndex,
								x: draft.left,
								y: draft.top,
								width: draft.width,
								height: draft.height,
								color: highlightColor,
								opacity: 0.35,
							},
						],
						t("documentEditor.pdf.highlightApplied"),
					);
				} else {
					const color = drag.mode === "redact" ? "#000000" : "#FFFFFF";
					void applyOps(
						[
							{
								kind: "redactRect",
								pageIndex: draft.pageIndex,
								x: draft.left,
								y: draft.top,
								width: draft.width,
								height: draft.height,
								color,
							},
						],
						drag.mode === "redact" ? t("documentEditor.pdf.redactApplied") : t("documentEditor.pdf.whiteoutApplied"),
					);
				}
			}
			return;
		}

		if (drag.mode === "shape") {
			const draft = shapeDraftRef.current;
			shapeDraftRef.current = null;
			setShapeDraft(null);
			if (draft !== null && Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) >= 0.01) {
				void applyOps(
					[
						{
							kind: "drawShape",
							pageIndex: draft.pageIndex,
							shape: draft.shape,
							x1: draft.x1,
							y1: draft.y1,
							x2: draft.x2,
							y2: draft.y2,
							strokeColor,
							strokeWidthPt,
						},
					],
					t("documentEditor.pdf.shapeApplied"),
				);
			}
			return;
		}

		if (drag.mode === "draw") {
			const pts = drawPointsRef.current;
			drawPointsRef.current = [];
			setDrawDraft(null);
			if (pts.length >= 2) {
				void applyOps(
					[
						{
							kind: "freehandPath",
							pageIndex: activePage,
							points: pts,
							strokeColor,
							strokeWidthPt,
						},
					],
					t("documentEditor.pdf.drawApplied"),
				);
			}
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

	const presetStamps = [
		{ id: "approved", label: t("documentEditor.pdf.stampApproved"), color: "#15803D" },
		{ id: "confidential", label: t("documentEditor.pdf.stampConfidential"), color: "#B91C1C" },
		{ id: "draft", label: t("documentEditor.pdf.stampDraft"), color: "#475569" },
		{ id: "reviewed", label: t("documentEditor.pdf.stampReviewed"), color: "#1D4ED8" },
		{ id: "urgent", label: t("documentEditor.pdf.stampUrgent"), color: "#C2410C" },
	] as const;

	const numPages = pdf?.numPages ?? payload.pageCount;

	const toolButtonClass = (active: boolean): string =>
		cn(
			"inline-flex h-26 items-center gap-4 rounded-6 border px-8 text-meta font-medium transition-colors disabled:opacity-40",
			active ? "border-accent bg-accent-soft text-accent" : "border-border bg-window text-ink hover:bg-hover-row",
		);

	const activeHint =
		tool === "highlight"
			? t("documentEditor.pdf.highlightHint")
			: tool === "redact"
				? t("documentEditor.pdf.redactHint")
				: tool === "whiteout"
					? t("documentEditor.pdf.whiteoutHint")
					: tool === "draw"
						? t("documentEditor.pdf.drawHint")
						: tool === "shape"
							? t("documentEditor.pdf.shapeHint")
							: null;

	return (
		<div className="doc-editor__pdf flex min-h-0 flex-1 flex-col bg-subtle text-ink" data-pdf-editor="true">
			{/* Hidden file picker for image stamp */}
			<input
				ref={imageInputRef}
				type="file"
				accept="image/png,image/jpeg,image/webp"
				className="hidden"
				onChange={(e) => {
					handleInsertImageFile(e.target.files?.[0]);
					e.target.value = "";
				}}
			/>

			{/* PDF Action Toolbar */}
			<div className="flex flex-none flex-wrap items-center gap-5 border-b border-divider bg-window px-10 py-6" role="toolbar" aria-label="PDF">
				{/* Group 1: Fill & Sign + Content */}
				<button
					type="button"
					disabled={busy || payload.encrypted}
					className={toolButtonClass(false)}
					onClick={() => setSigModalOpen(true)}
				>
					<PenLine size={13} className="text-accent" />
					{t("documentEditor.pdf.addSignature")}
				</button>
				<button
					type="button"
					disabled={busy || payload.encrypted}
					className={toolButtonClass(textPromptOpen)}
					onClick={() => {
						setNotePromptOpen(false);
						setTextPromptOpen((open) => !open);
						setTextInput("");
					}}
				>
					<Type size={13} />
					{t("documentEditor.pdf.addText")}
				</button>
				<button
					type="button"
					disabled={busy || payload.encrypted}
					className={toolButtonClass(false)}
					onClick={() => imageInputRef.current?.click()}
				>
					<ImageIcon size={13} />
					{t("documentEditor.pdf.addImage")}
				</button>

				<span className="mx-1 h-16 w-px bg-divider" aria-hidden="true" />

				{/* Group 2: Annotate & Redact */}
				<button
					type="button"
					aria-pressed={tool === "highlight"}
					disabled={busy || payload.encrypted}
					data-pdf-tool="highlight"
					className={toolButtonClass(tool === "highlight")}
					onClick={() => activateTool("highlight")}
				>
					<Highlighter size={13} />
					{t("documentEditor.pdf.highlight")}
				</button>
				<button
					type="button"
					aria-pressed={tool === "draw"}
					disabled={busy || payload.encrypted}
					data-pdf-tool="draw"
					className={toolButtonClass(tool === "draw")}
					onClick={() => activateTool("draw")}
				>
					<Pencil size={13} />
					{t("documentEditor.pdf.draw")}
				</button>
				<button
					type="button"
					aria-pressed={tool === "shape"}
					disabled={busy || payload.encrypted}
					data-pdf-tool="shape"
					className={toolButtonClass(tool === "shape")}
					onClick={() => activateTool("shape")}
				>
					<Shapes size={13} />
					{t("documentEditor.pdf.shapes")}
				</button>
				<button
					type="button"
					aria-pressed={tool === "redact"}
					disabled={busy || payload.encrypted}
					data-pdf-tool="redact"
					className={toolButtonClass(tool === "redact")}
					onClick={() => activateTool("redact")}
				>
					<EyeOff size={13} />
					{t("documentEditor.pdf.redact")}
				</button>
				<button
					type="button"
					aria-pressed={tool === "whiteout"}
					disabled={busy || payload.encrypted}
					data-pdf-tool="whiteout"
					className={toolButtonClass(tool === "whiteout")}
					onClick={() => activateTool("whiteout")}
				>
					<Eraser size={13} />
					{t("documentEditor.pdf.whiteout")}
				</button>

				{/* Stamp dropdown */}
				<div className="relative">
					<button
						type="button"
						disabled={busy || payload.encrypted}
						aria-expanded={stampMenuOpen}
						data-pdf-stamp-menu="true"
						className={toolButtonClass(stampMenuOpen)}
						onClick={() => {
							setMoreMenuOpen(false);
							setStampMenuOpen((open) => !open);
						}}
					>
						<Stamp size={13} />
						{t("documentEditor.pdf.stamp")}
						<ChevronDown size={11} />
					</button>
					{stampMenuOpen ? (
						<div className="absolute top-full left-0 z-40 mt-4 flex w-160 flex-col gap-2 rounded-8 border border-border bg-window p-4 shadow-lg">
							{presetStamps.map((st) => (
								<button
									key={st.id}
									type="button"
									data-pdf-preset-stamp={st.id}
									className="flex items-center justify-between rounded-6 border-0 bg-transparent px-8 py-5 text-left text-meta font-semibold hover:bg-hover-row"
									style={{ color: st.color }}
									onClick={() => {
										const rendered = renderPresetStampPng(st.label, st.color, todayIso());
										beginStampPlacement("stamp", rendered.dataUrl, rendered.aspect);
									}}
								>
									<span>{st.label}</span>
									<span className="size-8 rounded-full" style={{ backgroundColor: st.color }} />
								</button>
							))}
						</div>
					) : null}
				</div>

				<button
					type="button"
					disabled={busy || payload.encrypted}
					className={toolButtonClass(notePromptOpen)}
					onClick={() => {
						setTextPromptOpen(false);
						setNotePromptOpen((open) => !open);
						setNoteInput("");
					}}
				>
					<StickyNote size={13} />
					{t("documentEditor.pdf.stickyNote")}
				</button>

				<span className="mx-1 h-16 w-px bg-divider" aria-hidden="true" />

				{/* Group 3: Page Operations */}
				<button
					type="button"
					aria-pressed={tool === "crop"}
					disabled={busy || payload.encrypted}
					className={toolButtonClass(tool === "crop")}
					onClick={() => activateTool("crop")}
				>
					<Crop size={13} />
					{t("documentEditor.pdf.cropPage")}
				</button>
				<button
					type="button"
					disabled={busy || payload.encrypted || numPages === 0}
					title={t("documentEditor.pdf.rotateRight")}
					aria-label={t("documentEditor.pdf.rotateRight")}
					className={toolButtonClass(false)}
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
					className={toolButtonClass(false)}
					onClick={() => void handleExtractPages()}
				>
					<FileOutput size={13} />
					{selectedPages.size > 0
						? t("documentEditor.pdf.extractCount", { count: selectedPages.size })
						: t("documentEditor.pdf.extractCurrent")}
				</button>

				{/* Group 4: Organize & Document Tools dropdown */}
				<div className="relative">
					<button
						type="button"
						disabled={busy || payload.encrypted}
						aria-expanded={moreMenuOpen}
						data-pdf-more-tools="true"
						className={toolButtonClass(moreMenuOpen)}
						onClick={() => {
							setStampMenuOpen(false);
							setMoreMenuOpen((open) => !open);
						}}
					>
						<MoreHorizontal size={13} />
						{t("documentEditor.pdf.moreTools")}
					</button>
					{moreMenuOpen ? (
						<div className="absolute top-full left-0 z-40 mt-4 flex w-210 flex-col gap-2 rounded-8 border border-border bg-window p-4 shadow-lg">
							<button
								type="button"
								data-pdf-action="merge"
								className="flex items-center gap-8 rounded-6 border-0 bg-transparent px-8 py-6 text-left text-meta text-ink hover:bg-hover-row"
								onClick={() => void handleMergePdfs()}
							>
								<FileInput size={13} />
								{t("documentEditor.pdf.merge")}
							</button>
							<button
								type="button"
								data-pdf-action="split"
								className="flex items-center gap-8 rounded-6 border-0 bg-transparent px-8 py-6 text-left text-meta text-ink hover:bg-hover-row"
								onClick={() => {
									setMoreMenuOpen(false);
									setSplitOpen(true);
								}}
							>
								<SplitSquareHorizontal size={13} />
								{t("documentEditor.pdf.split")}
							</button>
							<button
								type="button"
								data-pdf-action="duplicate"
								className="flex items-center gap-8 rounded-6 border-0 bg-transparent px-8 py-6 text-left text-meta text-ink hover:bg-hover-row"
								onClick={async () => {
									setMoreMenuOpen(false);
									const ok = await applyOps([{ kind: "duplicatePage", pageIndex: activePage }], t("documentEditor.pdf.pageDuplicated"));
									if (ok) setActivePage(activePage + 1);
								}}
							>
								<Copy size={13} />
								{t("documentEditor.pdf.duplicatePage")}
							</button>
							<button
								type="button"
								data-pdf-action="insert-blank"
								className="flex items-center gap-8 rounded-6 border-0 bg-transparent px-8 py-6 text-left text-meta text-ink hover:bg-hover-row"
								onClick={async () => {
									setMoreMenuOpen(false);
									const ok = await applyOps(
										[{ kind: "insertBlankPage", insertAtIndex: activePage + 1, size: "match" }],
										t("documentEditor.pdf.blankPageInserted"),
									);
									if (ok) setActivePage(activePage + 1);
								}}
							>
								<FilePlus2 size={13} />
								{t("documentEditor.pdf.insertBlankPage")}
							</button>
							<button
								type="button"
								data-pdf-action="rotate-left"
								className="flex items-center gap-8 rounded-6 border-0 bg-transparent px-8 py-6 text-left text-meta text-ink hover:bg-hover-row"
								onClick={() => {
									setMoreMenuOpen(false);
									void applyOps([{ kind: "rotatePage", pageIndex: activePage, deltaDegrees: -90 }], t("documentEditor.pdf.rotated"));
								}}
							>
								<RotateCcw size={13} />
								{t("documentEditor.pdf.rotateLeft")}
							</button>

							<div className="my-2 h-px bg-divider" />

							<button
								type="button"
								data-pdf-action="watermark"
								className="flex items-center gap-8 rounded-6 border-0 bg-transparent px-8 py-6 text-left text-meta text-ink hover:bg-hover-row"
								onClick={() => {
									setMoreMenuOpen(false);
									setWatermarkOpen(true);
								}}
							>
								<Droplets size={13} />
								{t("documentEditor.pdf.watermark")}
							</button>
							<button
								type="button"
								data-pdf-action="page-numbers"
								className="flex items-center gap-8 rounded-6 border-0 bg-transparent px-8 py-6 text-left text-meta text-ink hover:bg-hover-row"
								onClick={() => {
									setMoreMenuOpen(false);
									setPageNumbersOpen(true);
								}}
							>
								<Hash size={13} />
								{t("documentEditor.pdf.pageNumbers")}
							</button>
							<button
								type="button"
								data-pdf-action="forms"
								className="flex items-center gap-8 rounded-6 border-0 bg-transparent px-8 py-6 text-left text-meta text-ink hover:bg-hover-row"
								onClick={() => {
									setMoreMenuOpen(false);
									setFormsOpen(true);
								}}
							>
								<FileSliders size={13} />
								{t("documentEditor.pdf.forms")}
							</button>
							<button
								type="button"
								data-pdf-action="properties"
								className="flex items-center gap-8 rounded-6 border-0 bg-transparent px-8 py-6 text-left text-meta text-ink hover:bg-hover-row"
								onClick={() => {
									setMoreMenuOpen(false);
									setPropertiesOpen(true);
								}}
							>
								<Info size={13} />
								{t("documentEditor.pdf.properties")}
							</button>
						</div>
					) : null}
				</div>

				<div className="flex-1" />

				{/* Find, Undo & Zoom */}
				<button
					type="button"
					aria-pressed={findOpen}
					aria-label={t("documentEditor.pdf.findPlaceholder")}
					title={t("documentEditor.pdf.findPlaceholder")}
					className={cn(
						"flex size-26 items-center justify-center rounded-6 border transition-colors",
						findOpen ? "border-accent bg-accent-soft text-accent" : "border-border bg-window text-ink-body hover:bg-hover-row",
					)}
					onClick={() => setFindOpen((open) => !open)}
				>
					<Search size={13} />
				</button>
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

			{/* Find bar */}
			{findOpen ? (
				<div className="flex flex-none items-center gap-8 border-b border-divider bg-subtle px-14 py-6">
					<Search size={13} className="text-ink-muted" />
					<input
						type="text"
						value={findQuery}
						data-pdf-find-input="true"
						placeholder={t("documentEditor.pdf.findPlaceholder")}
						className="h-26 w-240 rounded-6 border border-border bg-window px-8 text-meta text-ink outline-none focus:border-accent"
						onChange={(e) => setFindQuery(e.target.value)}
						autoFocus
					/>
					{findQuery.trim() !== "" ? (
						<span className="text-badge tabular-nums text-ink-muted">
							{findMatches.length > 0
								? t("documentEditor.pdf.findMatches", { current: findCursor + 1, total: findMatches.length })
								: t("documentEditor.pdf.findNoMatch")}
						</span>
					) : null}
					<button
						type="button"
						disabled={findMatches.length === 0}
						aria-label={t("documentEditor.pdf.findPrev")}
						className="flex size-24 items-center justify-center rounded-5 border border-border bg-window text-ink disabled:opacity-35"
						onClick={() => {
							if (findMatches.length === 0) return;
							const next = (findCursor - 1 + findMatches.length) % findMatches.length;
							setFindCursor(next);
							setActivePage(findMatches[next]!);
						}}
					>
						<ChevronLeft size={12} />
					</button>
					<button
						type="button"
						disabled={findMatches.length === 0}
						aria-label={t("documentEditor.pdf.findNext")}
						className="flex size-24 items-center justify-center rounded-5 border border-border bg-window text-ink disabled:opacity-35"
						onClick={() => {
							if (findMatches.length === 0) return;
							const next = (findCursor + 1) % findMatches.length;
							setFindCursor(next);
							setActivePage(findMatches[next]!);
						}}
					>
						<ChevronRight size={12} />
					</button>
					<div className="flex-1" />
					<button
						type="button"
						aria-label={t("common.close")}
						className="border-0 bg-transparent text-ink-muted hover:text-ink"
						onClick={() => {
							setFindOpen(false);
							setFindQuery("");
						}}
					>
						<X size={13} />
					</button>
				</div>
			) : null}

			{/* Inline text stamp composer (with color, size & today's date quick button) */}
			{textPromptOpen ? (
				<div className="flex flex-none flex-wrap items-center gap-8 border-b border-divider bg-subtle px-14 py-8">
					<input
						type="text"
						value={textInput}
						placeholder={t("documentEditor.pdf.textPlaceholder")}
						className="h-28 min-w-[200px] flex-1 rounded-6 border border-border bg-window px-10 text-body text-ink outline-none focus:border-accent"
						onChange={(e) => setTextInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && textInput.trim() !== "") {
								const rendered = renderTextStampPng(textInput.trim(), textSize, textColor);
								beginStampPlacement("text", rendered.dataUrl, rendered.aspect);
								setTextPromptOpen(false);
							}
						}}
						autoFocus
					/>
					<button
						type="button"
						className="inline-flex h-26 items-center gap-4 rounded-6 border border-border bg-window px-8 text-badge text-ink hover:bg-hover-row"
						onClick={() => setTextInput((curr) => (curr.trim() ? `${curr.trim()} ${todayIso()}` : todayIso()))}
					>
						<Calendar size={11} />
						{t("documentEditor.pdf.insertToday")}
					</button>
					<div className="flex items-center gap-4">
						{INK_COLORS.map((c) => (
							<button
								key={c}
								type="button"
								aria-label={c}
								aria-pressed={textColor === c}
								className={cn("size-18 rounded-full border-2", textColor === c ? "scale-110 border-accent" : "border-border")}
								style={{ backgroundColor: c }}
								onClick={() => setTextColor(c)}
							/>
						))}
					</div>
					<select
						aria-label={t("documentEditor.pdf.textSize")}
						value={textSize}
						onChange={(e) => setTextSize(Number(e.target.value))}
						className="h-26 rounded-6 border border-border bg-window px-6 text-badge text-ink"
					>
						{[18, 22, 28, 36, 48].map((sz) => (
							<option key={sz} value={sz}>
								{sz}px
							</option>
						))}
					</select>
					<button
						type="button"
						disabled={textInput.trim() === ""}
						className="h-28 rounded-6 border-0 bg-accent px-12 text-meta font-semibold text-on-accent disabled:opacity-40"
						onClick={() => {
							const rendered = renderTextStampPng(textInput.trim(), textSize, textColor);
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

			{/* Inline sticky note composer */}
			{notePromptOpen ? (
				<div className="flex flex-none items-center gap-8 border-b border-divider bg-subtle px-14 py-8">
					<StickyNote size={14} className="text-warning" />
					<input
						type="text"
						value={noteInput}
						data-pdf-note-input="true"
						placeholder={t("documentEditor.pdf.notePlaceholder")}
						className="h-28 flex-1 rounded-6 border border-border bg-window px-10 text-body text-ink outline-none focus:border-accent"
						onChange={(e) => setNoteInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && noteInput.trim() !== "") {
								const rendered = renderStickyNotePng(noteInput.trim());
								beginStampPlacement("note", rendered.dataUrl, rendered.aspect);
								setNotePromptOpen(false);
							}
						}}
						autoFocus
					/>
					<button
						type="button"
						disabled={noteInput.trim() === ""}
						className="h-28 rounded-6 border-0 bg-accent px-12 text-meta font-semibold text-on-accent disabled:opacity-40"
						onClick={() => {
							const rendered = renderStickyNotePng(noteInput.trim());
							beginStampPlacement("note", rendered.dataUrl, rendered.aspect);
							setNotePromptOpen(false);
						}}
					>
						{t("documentEditor.pdf.placeNote")}
					</button>
					<button
						type="button"
						className="h-28 rounded-6 border border-border bg-window px-10 text-meta text-ink"
						onClick={() => setNotePromptOpen(false)}
					>
						{t("common.cancel")}
					</button>
				</div>
			) : null}

			{/* Active interactive tool options & hint bar */}
			{activeHint !== null ? (
				<div className="flex flex-none flex-wrap items-center justify-between gap-8 border-b border-divider bg-accent-soft px-14 py-6 text-meta text-accent">
					<div className="flex flex-wrap items-center gap-10">
						<span>{activeHint}</span>
						{tool === "highlight" ? (
							<div className="flex items-center gap-4">
								{HIGHLIGHT_COLORS.map((c) => (
									<button
										key={c}
										type="button"
										aria-label={c}
										aria-pressed={highlightColor === c}
										className={cn("size-16 rounded-full border-2", highlightColor === c ? "scale-110 border-accent" : "border-white/70")}
										style={{ backgroundColor: c }}
										onClick={() => setHighlightColor(c)}
									/>
								))}
							</div>
						) : null}
						{tool === "shape" ? (
							<div className="inline-flex items-center gap-3">
								{(
									[
										{ id: "rect", icon: Square, label: t("documentEditor.pdf.shapeRect") },
										{ id: "ellipse", icon: Circle, label: t("documentEditor.pdf.shapeEllipse") },
										{ id: "line", icon: Minus, label: t("documentEditor.pdf.shapeLine") },
										{ id: "arrow", icon: ArrowUpRight, label: t("documentEditor.pdf.shapeArrow") },
									] as const
								).map((item) => {
									const Icon = item.icon;
									return (
										<button
											key={item.id}
											type="button"
											aria-pressed={shapeKind === item.id}
											title={item.label}
											data-pdf-shape={item.id}
											className={cn(
												"inline-flex h-22 items-center gap-3 rounded-5 border px-6 text-badge",
												shapeKind === item.id ? "border-accent bg-window text-accent font-semibold" : "border-border bg-window/70 text-ink",
											)}
											onClick={() => setShapeKind(item.id)}
										>
											<Icon size={11} />
											{item.label}
										</button>
									);
								})}
							</div>
						) : null}
						{tool === "draw" || tool === "shape" ? (
							<div className="flex items-center gap-6">
								<div className="flex items-center gap-4">
									{INK_COLORS.map((c) => (
										<button
											key={c}
											type="button"
											aria-label={c}
											aria-pressed={strokeColor === c}
											className={cn("size-16 rounded-full border-2", strokeColor === c ? "scale-110 border-accent" : "border-white/80")}
											style={{ backgroundColor: c }}
											onClick={() => setStrokeColor(c)}
										/>
									))}
								</div>
								<select
									aria-label={t("documentEditor.pdf.strokeWidth")}
									value={strokeWidthPt}
									onChange={(e) => setStrokeWidthPt(Number(e.target.value))}
									className="h-22 rounded-5 border border-border bg-window px-4 text-badge text-ink"
								>
									{[1.5, 2.5, 4, 6].map((w) => (
										<option key={w} value={w}>
											{w}pt
										</option>
									))}
								</select>
							</div>
						) : null}
					</div>
					<button
						type="button"
						className="h-22 rounded-6 border border-border bg-window px-8 text-badge font-medium text-ink"
						onClick={() => setTool("none")}
					>
						{t("common.close")}
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

			{tool === "crop" && cropDraft !== null ? (
				<div className="flex flex-none items-center justify-between gap-8 border-b border-divider bg-accent-soft px-14 py-6 text-meta text-accent">
					<span>{t("documentEditor.pdf.cropHint")}</span>
					<div className="flex items-center gap-6">
						<button
							type="button"
							className="h-24 rounded-6 border border-border bg-window px-10 text-meta font-medium text-ink"
							onClick={() => {
								setTool("none");
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
							const isFindHit = findMatches.includes(idx);
							return (
								<div
									key={idx}
									data-pdf-thumb={idx + 1}
									className={cn(
										"group relative flex flex-col items-center gap-4 rounded-8 p-6 transition-colors",
										isActive ? "bg-accent-soft ring-1 ring-accent" : isFindHit ? "bg-warning-soft/50 ring-1 ring-warning" : "hover:bg-hover-row",
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
								tool !== "none" && "cursor-crosshair",
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
							{tool === "crop" && cropDraft !== null && cropDraft.pageIndex === activePage ? (
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

							{/* Live Highlight / Redact / Whiteout drag overlay */}
							{rectDraft !== null && rectDraft.pageIndex === activePage ? (
								<div
									className="pointer-events-none absolute z-20"
									style={{
										left: `${rectDraft.left * 100}%`,
										top: `${rectDraft.top * 100}%`,
										width: `${rectDraft.width * 100}%`,
										height: `${rectDraft.height * 100}%`,
										backgroundColor:
											tool === "highlight"
												? highlightColor
												: tool === "redact"
													? "#000000"
													: "#FFFFFF",
										opacity: tool === "highlight" ? 0.35 : 0.95,
										border: tool === "whiteout" ? "1px dashed #64748B" : "none",
									}}
								/>
							) : null}

							{/* Live Shape / Freehand SVG preview overlay */}
							{(shapeDraft !== null && shapeDraft.pageIndex === activePage) ||
							(drawDraft !== null && drawDraft.pageIndex === activePage) ? (
								<svg
									viewBox="0 0 100 100"
									preserveAspectRatio="none"
									className="pointer-events-none absolute inset-0 z-20 h-full w-full"
								>
									{shapeDraft !== null && shapeDraft.shape === "rect" ? (
										<rect
											x={Math.min(shapeDraft.x1, shapeDraft.x2) * 100}
											y={Math.min(shapeDraft.y1, shapeDraft.y2) * 100}
											width={Math.abs(shapeDraft.x2 - shapeDraft.x1) * 100}
											height={Math.abs(shapeDraft.y2 - shapeDraft.y1) * 100}
											fill="none"
											stroke={strokeColor}
											strokeWidth={0.5}
										/>
									) : shapeDraft !== null && shapeDraft.shape === "ellipse" ? (
										<ellipse
											cx={((shapeDraft.x1 + shapeDraft.x2) / 2) * 100}
											cy={((shapeDraft.y1 + shapeDraft.y2) / 2) * 100}
											rx={(Math.abs(shapeDraft.x2 - shapeDraft.x1) / 2) * 100}
											ry={(Math.abs(shapeDraft.y2 - shapeDraft.y1) / 2) * 100}
											fill="none"
											stroke={strokeColor}
											strokeWidth={0.5}
										/>
									) : shapeDraft !== null ? (
										<line
											x1={shapeDraft.x1 * 100}
											y1={shapeDraft.y1 * 100}
											x2={shapeDraft.x2 * 100}
											y2={shapeDraft.y2 * 100}
											stroke={strokeColor}
											strokeWidth={0.5}
										/>
									) : null}
									{drawDraft !== null && drawDraft.points.length >= 2 ? (
										<polyline
											fill="none"
											stroke={strokeColor}
											strokeWidth={0.5}
											strokeLinecap="round"
											strokeLinejoin="round"
											points={drawDraft.points.map((pt) => `${pt.x * 100},${pt.y * 100}`).join(" ")}
										/>
									) : null}
								</svg>
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

			{watermarkOpen ? (
				<WatermarkModal
					selectedCount={selectedPages.size}
					onClose={() => setWatermarkOpen(false)}
					onApply={async ({ text, color, opacity, angle, scale: wmScale, scope }) => {
						const pngDataUrl = renderWatermarkPng(text, color, angle);
						const pageIndices =
							scope === "current"
								? [activePage]
								: scope === "selected" && selectedPages.size > 0
									? [...selectedPages].sort((a, b) => a - b)
									: undefined;
						const ok = await applyOps(
							[
								{
									kind: "addWatermark",
									pngDataUrl,
									opacity,
									scale: wmScale,
									...(pageIndices === undefined ? {} : { pageIndices }),
								},
							],
							t("documentEditor.pdf.watermarkApplied"),
						);
						if (ok) setWatermarkOpen(false);
					}}
				/>
			) : null}

			{pageNumbersOpen ? (
				<PageNumbersModal
					onClose={() => setPageNumbersOpen(false)}
					onApply={async ({ position, format, startNumber, fontSize, color, headerText, footerText }) => {
						const ok = await applyOps(
							[
								{
									kind: "addPageNumbers",
									position,
									format,
									startNumber,
									fontSize,
									color,
									...(headerText ? { headerText } : {}),
									...(footerText ? { footerText } : {}),
								},
							],
							t("documentEditor.pdf.pageNumbersApplied"),
						);
						if (ok) setPageNumbersOpen(false);
					}}
				/>
			) : null}

			{splitOpen ? (
				<SplitPdfModal
					totalPages={numPages}
					onClose={() => setSplitOpen(false)}
					onRunSplit={async (req) => {
						setBusy(true);
						setStatusMsg(null);
						try {
							const res = await editorApi.pdfSplit({ path: payload.path, ...req });
							if (res.outputs.length > 0) {
								setExtractedFile({ path: res.outputs[0]!.outputPath, name: res.outputs[0]!.name });
							}
							setStatusMsg(t("documentEditor.pdf.splitSuccess", { count: res.outputs.length }));
							setSplitOpen(false);
						} catch (error: unknown) {
							setStatusMsg(error instanceof Error ? error.message : String(error));
						} finally {
							setBusy(false);
						}
					}}
				/>
			) : null}

			{propertiesOpen ? (
				<PdfPropertiesModal
					path={payload.path}
					onClose={() => setPropertiesOpen(false)}
					onSave={async (metadata) => {
						const ok = await applyOps([{ kind: "setMetadata", metadata }], t("documentEditor.pdf.metadataSaved"));
						if (ok) setPropertiesOpen(false);
					}}
				/>
			) : null}

			{formsOpen ? (
				<PdfFormsModal
					path={payload.path}
					onClose={() => setFormsOpen(false)}
					onSave={async (values, flatten) => {
						setBusy(true);
						setStatusMsg(null);
						try {
							const result = await editorApi.pdfSaveFormFields({
								path: payload.path,
								values,
								flatten,
								expectedMtimeMs: payload.mtimeMs,
							});
							if (!result.ok) {
								setStatusMsg(t("documentEditor.conflict"));
								return;
							}
							setUndoStack((stack) => [...stack, result.snapshotId]);
							onPayloadChange({
								...payload,
								size: result.size,
								modifiedAt: result.modifiedAt,
								mtimeMs: result.mtimeMs,
								pageCount: result.pageCount,
							});
							setStatusMsg(flatten ? t("documentEditor.pdf.formsFlattened") : t("documentEditor.pdf.formsSaved"));
							setFormsOpen(false);
						} catch (error: unknown) {
							setStatusMsg(error instanceof Error ? error.message : String(error));
						} finally {
							setBusy(false);
						}
					}}
				/>
			) : null}
		</div>
	);
}
