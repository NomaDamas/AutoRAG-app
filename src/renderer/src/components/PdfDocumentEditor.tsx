import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { getDocument, type PDFDocumentProxy } from "pdfjs-dist";
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
	ExternalLink,
	EyeOff,
	FileInput,
	FileOutput,
	FilePlus2,
	FileSliders,
	GripHorizontal,
	Hash,
	Highlighter,
	Image as ImageIcon,
	Info,
	Layers,
	Loader2,
	Minus,
	PanelRight,
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
} from "lucide-react";
import { previewStreamUrl } from "../../../preview/shared/contract";
import { pdfRuns } from "../../../preview/shared/text-marks";
import { pdfDocumentSource } from "../../../preview/ui/pdf-config";
import type {
	DocumentEditorPdfPayload,
	PdfEditOperation,
	PdfPointFraction,
} from "../../../shared/document-editor-contract";
import { cn } from "../lib/cn";
import { canvasCharEdges, findPageTextMatches, type PdfSearchHit } from "../lib/pdf-search";
import { loadLocalImageAsPngDataUrl } from "../lib/pdf-image-load";
import { ensurePdfWorker } from "../lib/pdf-worker";
import { DazziFilePickerModal } from "./DazziFilePickerModal";
import {
	BOX_FONT_FAMILY,
	BOX_LINE_HEIGHT,
	NOTE_BOX_PAD,
	NOTE_BOX_RADIUS,
	NOTE_PALETTES,
	notePalette,
	type NotePaletteId,
	PageNumbersModal,
	PdfFormsModal,
	PdfPropertiesModal,
	PRESET_STAMPS,
	renderNoteBoxPng,
	renderPresetStampPng,
	renderTextBoxPng,
	renderWatermarkPng,
	SplitPdfModal,
	TEXT_BOX_PAD,
	todayIso,
	WatermarkModal,
} from "./PdfEditorTools";


const SAVED_SIGNATURES_KEY = "dazzi.pdfEditor.signatures";
const MAX_SAVED_SIGNATURES = 6;
const THUMB_MAX_W = 104;
const THUMB_MAX_H = 128;
const ZOOM_STEPS = [0.5, 0.65, 0.8, 1, 1.15, 1.35, 1.6, 2] as const;

function parentDirOf(filePath: string): string {
	const trimmed = filePath.replace(/[\\/]+$/, "");
	const sep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return sep > 0 ? trimmed.slice(0, sep) : "/";
}

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

type InteractiveTool = "none" | "text" | "note" | "crop" | "highlight" | "redact" | "whiteout" | "draw" | "shape";
type ShapeKind = "rect" | "ellipse" | "line" | "arrow";
type StampKind = "signature" | "image" | "stamp";

interface InlineTextBox {
	readonly id: number;
	/** "text" is a transparent Keynote-style text box; "note" is a colored sticky-note card. */
	readonly variant: "text" | "note";
	readonly pageIndex: number;
	/** Top-left normalized coordinates (0..1) on the active page. */
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly minHeight: number;
	readonly text: string;
	readonly fontSizePt: number;
	readonly color: string;
	readonly noteColor: NotePaletteId;
}

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


/**
 * Renders one PDF page either at an explicit `scale` (main stage) or fitted
 * strictly inside `fitBox` (right thumbnail rail — handles both portrait and
 * wide landscape slides cleanly with zero overflow or clipping).
 */
function PdfPageCanvas({
	pdf,
	pageNumber,
	scale,
	fitBox,
	onNaturalSize,
	className,
}: {
	readonly pdf: PDFDocumentProxy;
	readonly pageNumber: number;
	readonly scale?: number;
	readonly fitBox?: { readonly maxWidth: number; readonly maxHeight: number };
	readonly onNaturalSize?: (size: { readonly width: number; readonly height: number }) => void;
	readonly className?: string;
}): ReactElement {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const onNaturalSizeRef = useRef(onNaturalSize);
	onNaturalSizeRef.current = onNaturalSize;
	const [size, setSize] = useState<{ readonly width: number; readonly height: number } | null>(null);

	const fitW = fitBox?.maxWidth;
	const fitH = fitBox?.maxHeight;

	useEffect(() => {
		let cancelled = false;
		let renderTask: { cancel(): void; promise: Promise<void> } | null = null;
		const run = async (): Promise<void> => {
			try {
				const page = await pdf.getPage(pageNumber);
				if (cancelled) return;
				const natural = page.getViewport({ scale: 1 });
				onNaturalSizeRef.current?.({ width: natural.width, height: natural.height });
				const resolvedScale =
					fitW !== undefined && fitH !== undefined
						? Math.min(fitW / Math.max(1, natural.width), fitH / Math.max(1, natural.height))
						: (scale ?? 1);
				const viewport = page.getViewport({ scale: resolvedScale });
				const cssW = Math.max(1, Math.round(viewport.width));
				const cssH = Math.max(1, Math.round(viewport.height));
				setSize({ width: cssW, height: cssH });
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
	}, [pdf, pageNumber, scale, fitW, fitH]);

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
	onPickImageFromDazzi,
	onRemoveSaved,
	onClose,
}: {
	readonly saved: readonly string[];
	readonly onSaveSignature: (pngDataUrl: string, aspect: number, remember: boolean) => void;
	readonly onPickImageFromDazzi: (remember: boolean) => void;
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

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-xs" role="dialog" aria-modal="true" aria-label={t("documentEditor.pdf.signatureTitle")}>
			<div className="flex w-[460px] max-w-[92vw] flex-col gap-12 rounded-12 border border-border bg-window p-16 shadow-xl">
				<div className="flex items-center justify-between">
					<h3 className="m-0 text-body font-semibold text-ink">{t("documentEditor.pdf.signatureTitle")}</h3>
					<button
						type="button"
						aria-label={t("common.close")}
						className="flex size-24 items-center justify-center rounded-6 border-0 bg-transparent text-ink-muted hover:bg-hover hover:text-ink"
						onClick={onClose}
					>
						<X size={15} />
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
									inkColor === color ? "border-accent ring-2 ring-accent/20" : "border-border",
								)}
								style={{ backgroundColor: color }}
								onClick={() => setInkColor(color)}
							/>
						))}
					</div>
					<div className="flex items-center gap-6">
						<button
							type="button"
							className="inline-flex h-24 items-center gap-4 rounded-6 border border-border bg-subtle px-8 text-meta text-ink hover:bg-hover"
							onClick={() => onPickImageFromDazzi(remember)}
						>
							<Upload size={12} />
							{t("documentEditor.pdf.uploadSignature")}
						</button>
						<button
							type="button"
							className="h-24 rounded-6 border border-border bg-subtle px-8 text-meta text-ink hover:bg-hover"
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
							className="h-28 rounded-6 border border-border bg-window px-12 text-meta font-medium text-ink hover:bg-hover-row"
							onClick={onClose}
						>
							{t("common.cancel")}
						</button>
						<button
							type="button"
							disabled={!hasInk}
							className="h-28 rounded-6 border-0 bg-accent px-14 text-meta font-medium text-on-accent hover:opacity-90 disabled:opacity-35"
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
 * Designed to match macOS Preview / Acrobat Quick Tools & Dazzi Quick Look (`PagedView`):
 * - Single-row borderless native macOS toolbar + contextual active-tool sub-bar
 * - Auto-fit page canvas with Quick-Look-style floating bottom zoom & page pill
 * - Right-hand page thumbnail rail with aspect-ratio fitting for both portrait and landscape PDFs
 * - In-app Dazzi file picker for images, signatures, and PDF merge (never opens OS Finder)
 * - Live sync with concurrent right-sidebar AI edits via `onPdfChanged`
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
	const [railOpen, setRailOpen] = useState(true);
	const [manualScale, setManualScale] = useState<number | null>(null);
	const [fitScale, setFitScale] = useState(1);
	const [pageNaturalSize, setPageNaturalSize] = useState<{ readonly width: number; readonly height: number } | null>(null);
	const [busy, setBusy] = useState(false);
	const [statusMsg, setStatusMsg] = useState<string | null>(null);
	const [extractedFile, setExtractedFile] = useState<{ readonly path: string; readonly name: string } | null>(null);
	const [undoStack, setUndoStack] = useState<readonly string[]>([]);

	// Modals, composers, menus & active interactive overlays
	const [sigModalOpen, setSigModalOpen] = useState(false);
	const [savedSigs, setSavedSigs] = useState<readonly string[]>(loadSavedSignatures);
	const [pickerMode, setPickerMode] = useState<null | { readonly kind: "image" | "pdf" | "signature"; readonly rememberSig?: boolean }>(null);
	const [textColor, setTextColor] = useState("#1D1D1F");
	const [textSize, setTextSize] = useState(16);
	const [inlineTextBox, setInlineTextBox] = useState<InlineTextBox | null>(null);
	const [textBoxDraft, setTextBoxDraft] = useState<RectDraft | null>(null);
	const inlineTextBoxRef = useRef<InlineTextBox | null>(null);
	inlineTextBoxRef.current = inlineTextBox;
	const textBoxDraftRef = useRef<RectDraft | null>(null);
	const inlineTextInputRef = useRef<HTMLTextAreaElement | null>(null);
	const textBoxSeqRef = useRef(1);
	const [noteColor, setNoteColor] = useState<NotePaletteId>("yellow");
	const [noteSize, setNoteSize] = useState(13);
	const [stampMenuOpen, setStampMenuOpen] = useState(false);
	const [moreMenuOpen, setMoreMenuOpen] = useState(false);
	const [watermarkOpen, setWatermarkOpen] = useState(false);
	const [pageNumbersOpen, setPageNumbersOpen] = useState(false);
	const [splitOpen, setSplitOpen] = useState(false);
	const [formsOpen, setFormsOpen] = useState(false);
	const [propertiesOpen, setPropertiesOpen] = useState(false);

	// Find-in-PDF bar (exact per-match highlight rects in page coordinates)
	const [findOpen, setFindOpen] = useState(false);
	const [findQuery, setFindQuery] = useState("");
	const [findHits, setFindHits] = useState<readonly PdfSearchHit[]>([]);
	const [findCursor, setFindCursor] = useState(0);
	const findInputRef = useRef<HTMLInputElement | null>(null);

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

	const stageScrollRef = useRef<HTMLDivElement | null>(null);
	const railScrollRef = useRef<HTMLDivElement | null>(null);
	const pageFrameRef = useRef<HTMLDivElement | null>(null);
	const dragRef = useRef<{
		readonly mode:
			| "move"
			| "resize"
			| "crop"
			| "highlight"
			| "redact"
			| "whiteout"
			| "shape"
			| "draw"
			| "textbox-draw"
			| "textbox-move"
			| "textbox-resize";
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
	const effectiveScale = manualScale ?? fitScale;

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

	// Auto-fit active page cleanly to the available stage width (handles landscape slides & narrow panes).
	useEffect(() => {
		const scroller = stageScrollRef.current;
		if (scroller === null || pageNaturalSize === null || pageNaturalSize.width <= 0) return;
		const updateFit = (): void => {
			const availW = Math.max(240, scroller.clientWidth - 56);
			const nextFit = Math.min(1.35, Math.max(0.45, availW / pageNaturalSize.width));
			setFitScale(Number(nextFit.toFixed(3)));
		};
		updateFit();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(updateFit);
		observer.observe(scroller);
		return () => observer.disconnect();
	}, [pageNaturalSize, railOpen]);

	// Live-sync when AI agent tools mutate the PDF concurrently while the user is viewing/editing.
	const payloadRef = useRef(payload);
	payloadRef.current = payload;
	useEffect(() => {
		if (typeof editorApi.onPdfChanged !== "function") return;
		return editorApi.onPdfChanged((ev) => {
			const curr = payloadRef.current;
			if (ev.path !== curr.path) return;
			if (ev.mtimeMs === curr.mtimeMs && ev.size === curr.size && ev.pageCount === curr.pageCount) return;
			if (ev.source === "ai" && ev.snapshotId !== undefined) {
				setUndoStack((stack) => (stack.includes(ev.snapshotId!) ? stack : [...stack, ev.snapshotId!]));
			}
			onPayloadChange({
				...curr,
				size: ev.size,
				modifiedAt: ev.modifiedAt,
				mtimeMs: ev.mtimeMs,
				pageCount: ev.pageCount,
			});
		});
	}, [editorApi, onPayloadChange]);

	// Execute PDF text search with exact bounding-box coordinates for live canvas highlighting
	useEffect(() => {
		if (!findOpen || pdf === null || findQuery.trim() === "") {
			setFindHits([]);
			setFindCursor(0);
			return;
		}
		let cancelled = false;
		const run = async (): Promise<void> => {
			const allHits: PdfSearchHit[] = [];
			for (let p = 1; p <= pdf.numPages; p += 1) {
				if (cancelled) return;
				try {
					const page = await pdf.getPage(p);
					const content = await page.getTextContent();
					const viewport = page.getViewport({ scale: 1 });
					const runs = pdfRuns(content.items, viewport.transform ?? [1, 0, 0, -1, 0, viewport.height], canvasCharEdges(content.styles));
					const pageHits = findPageTextMatches(p - 1, runs, findQuery);
					allHits.push(...pageHits);
				} catch {
					// Ignore page text extraction error
				}
			}
			if (cancelled) return;
			setFindHits(allHits);
			setFindCursor(0);
			if (allHits.length > 0) setActivePage(allHits[0]!.pageIndex);
		};
		const timer = window.setTimeout(() => void run(), 150);
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
					force: true,
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

	const numPages = pdf?.numPages ?? payload.pageCount;

	const goToPage = useCallback(
		(nextIndex: number): void => {
			if (numPages <= 0) return;
			const clamped = Math.min(numPages - 1, Math.max(0, nextIndex));
			setActivePage(clamped);
			setPendingStamp((curr) => (curr === null ? null : { ...curr, pageIndex: clamped }));
			setCropDraft((curr) => (curr === null ? null : { ...curr, pageIndex: clamped }));
			if (stageScrollRef.current !== null) {
				stageScrollRef.current.scrollTop = 0;
			}
		},
		[numPages],
	);

	// Keep the active thumbnail visible in the right rail when navigating pages via keyboard or HUD.
	useEffect(() => {
		const thumb = railScrollRef.current?.querySelector<HTMLElement>(`[data-pdf-thumb="${activePage + 1}"]`);
		if (thumb !== null && thumb !== undefined && typeof thumb.scrollIntoView === "function") {
			thumb.scrollIntoView({ block: "nearest" });
		}
	}, [activePage]);

	// Focus newly placed Keynote/PPT-style on-canvas text box immediately.
	const inlineTextBoxId = inlineTextBox?.id ?? null;
	useEffect(() => {
		if (inlineTextBoxId === null) return;
		const el = inlineTextInputRef.current;
		if (el !== null) {
			el.focus();
			el.setSelectionRange(el.value.length, el.value.length);
		}
	}, [inlineTextBoxId]);

	// Auto-grow the on-canvas text box height cleanly as the user types or resizes width.
	useEffect(() => {
		const el = inlineTextInputRef.current;
		if (el === null || inlineTextBox === null) return;
		const padY = inlineTextBox.variant === "note" ? NOTE_BOX_PAD.y : TEXT_BOX_PAD.y;
		el.style.height = "auto";
		el.style.height = `${Math.max(el.scrollHeight, Math.ceil((inlineTextBox.fontSizePt * BOX_LINE_HEIGHT + padY * 2) * effectiveScale))}px`;
	}, [inlineTextBox?.text, inlineTextBox?.width, inlineTextBox?.fontSizePt, inlineTextBox?.variant, effectiveScale, inlineTextBox]);

	const commitInlineTextBox = useCallback(
		async (boxOverride?: InlineTextBox | null): Promise<boolean> => {
			const box = boxOverride ?? inlineTextBoxRef.current;
			if (box === null) return false;
			const trimmed = box.text.replace(/\s+$/u, "");
			if (trimmed.trim() === "") {
				setInlineTextBox(null);
				return false;
			}
			const natW = pageNaturalSize?.width ?? 612;
			const natH = pageNaturalSize?.height ?? 792;
			// Render at the width actually stamped, so the committed text wraps exactly like the on-canvas box.
			const widthFraction = Math.min(1 - box.x, box.width);
			const boxWidthPt = Math.max(40, widthFraction * natW);
			const rendered =
				box.variant === "note"
					? renderNoteBoxPng(trimmed, boxWidthPt, box.fontSizePt, notePalette(box.noteColor), box.minHeight * natH)
					: renderTextBoxPng(trimmed, boxWidthPt, box.fontSizePt, box.color);
			const heightFraction = Math.min(1 - box.y, Math.max(0.02, rendered.heightPt / Math.max(1, natH)));
			const ok = await applyOps(
				[
					{
						kind: "stampImage",
						pageIndex: box.pageIndex,
						pngDataUrl: rendered.dataUrl,
						x: box.x,
						y: box.y,
						width: Math.min(1 - box.x, rendered.widthPt / Math.max(1, natW)),
						height: heightFraction,
					},
				],
				box.variant === "note" ? t("documentEditor.pdf.noteApplied") : t("documentEditor.pdf.textApplied"),
			);
			if (ok) {
				setInlineTextBox(null);
			}
			return ok;
		},
		[applyOps, pageNaturalSize, t],
	);

	// Capture-phase keyboard shortcuts for PDF editor:
	// - ArrowUp/ArrowDown/PageUp/PageDown/ArrowLeft/ArrowRight/Home/End: Step pages cleanly
	// - Cmd/Ctrl+Z: Undo last PDF edit (unless typing inside an input/textarea or modal)
	// - Cmd/Ctrl+F: Open & focus in-PDF Find bar (when no modal picker is open)
	// - Escape: Dismiss open popovers / inline text box / active tool / Find bar
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.isComposing) return;
			if (pickerMode !== null || sigModalOpen || watermarkOpen || pageNumbersOpen || splitOpen || formsOpen || propertiesOpen) {
				return;
			}
			const target = event.target;
			const typing =
				target instanceof HTMLElement &&
				(target.tagName === "INPUT" ||
					target.tagName === "TEXTAREA" ||
					target.tagName === "SELECT" ||
					target.isContentEditable);
			const inOverlayControl =
				target instanceof HTMLElement &&
				target.closest('[role="dialog"], [role="menu"], [role="listbox"]') !== null;
			const mod = event.metaKey || event.ctrlKey;
			const key = event.key.toLowerCase();

			if (mod && !event.shiftKey && !event.altKey && (key === "z" || event.code === "KeyZ")) {
				if (typing) return;
				event.preventDefault();
				event.stopPropagation();
				void undoLast();
				return;
			}
			if (mod && !event.shiftKey && !event.altKey && (key === "f" || event.code === "KeyF")) {
				event.preventDefault();
				event.stopPropagation();
				setFindOpen(true);
				window.setTimeout(() => {
					findInputRef.current?.focus();
					findInputRef.current?.select();
				}, 0);
				return;
			}
			if (event.key === "Escape") {
				if (inlineTextBoxRef.current !== null) {
					event.preventDefault();
					event.stopPropagation();
					setInlineTextBox(null);
					return;
				}
				if (stampMenuOpen || moreMenuOpen) {
					setStampMenuOpen(false);
					setMoreMenuOpen(false);
				} else if (findOpen) {
					setFindOpen(false);
					setFindQuery("");
				} else if (pendingStamp !== null) {
					setPendingStamp(null);
				} else if (tool !== "none") {
					setTool("none");
					setCropDraft(null);
				}
				return;
			}
			if (
				!mod &&
				!event.altKey &&
				!typing &&
				!inOverlayControl &&
				!stampMenuOpen &&
				!moreMenuOpen &&
				pendingStamp === null &&
				inlineTextBoxRef.current === null &&
				numPages > 1
			) {
				if (event.key === "ArrowDown" || event.key === "PageDown" || event.key === "ArrowRight") {
					event.preventDefault();
					event.stopPropagation();
					goToPage(activePage + 1);
				} else if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "ArrowLeft") {
					event.preventDefault();
					event.stopPropagation();
					goToPage(activePage - 1);
				} else if (event.key === "Home") {
					event.preventDefault();
					event.stopPropagation();
					goToPage(0);
				} else if (event.key === "End") {
					event.preventDefault();
					event.stopPropagation();
					goToPage(numPages - 1);
				}
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [
		activePage,
		findOpen,
		formsOpen,
		goToPage,
		moreMenuOpen,
		numPages,
		pageNumbersOpen,
		pendingStamp,
		pickerMode,
		propertiesOpen,
		sigModalOpen,
		splitOpen,
		stampMenuOpen,
		tool,
		undoLast,
		watermarkOpen,
	]);

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

	const activateTool = (next: InteractiveTool): void => {
		if (inlineTextBoxRef.current !== null) {
			if (inlineTextBoxRef.current.text.trim() !== "") {
				void commitInlineTextBox(inlineTextBoxRef.current);
			} else {
				setInlineTextBox(null);
			}
		}
		setPendingStamp(null);
		setStampMenuOpen(false);
		setMoreMenuOpen(false);
		setRectDraft(null);
		setTextBoxDraft(null);
		setShapeDraft(null);
		setDrawDraft(null);
		setTool((curr) => {
			const resolved = curr === next ? "none" : next;
			setCropDraft(resolved === "crop" ? { pageIndex: activePage, left: 0.08, top: 0.08, width: 0.84, height: 0.84 } : null);
			return resolved;
		});
	};

	const beginStampPlacement = useCallback(
		(kind: StampKind, pngDataUrl: string, aspect: number): void => {
			setTool("none");
			setCropDraft(null);
			setStampMenuOpen(false);
			setMoreMenuOpen(false);
			const width = kind === "image" ? 0.36 : 0.28;
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
		},
		[activePage],
	);

	const handlePickedFiles = useCallback(
		async (paths: readonly string[]) => {
			const mode = pickerMode;
			setPickerMode(null);
			if (mode === null || paths.length === 0) return;
			try {
				if (mode.kind === "pdf") {
					await applyOps(
						[{ kind: "mergePdfs", sourcePaths: paths }],
						t("documentEditor.pdf.mergedApplied", { count: paths.length }),
					);
					return;
				}
				const loaded = await loadLocalImageAsPngDataUrl(paths[0]!, mode.kind === "signature" ? 1200 : 1600);
				if (mode.kind === "signature") {
					if (mode.rememberSig) {
						const next = [loaded.dataUrl, ...savedSigs.filter((item) => item !== loaded.dataUrl)].slice(0, MAX_SAVED_SIGNATURES);
						setSavedSigs(next);
						storeSavedSignatures(next);
					}
					beginStampPlacement("signature", loaded.dataUrl, loaded.aspect);
				} else {
					beginStampPlacement("image", loaded.dataUrl, loaded.aspect);
				}
			} catch (error: unknown) {
				setStatusMsg(error instanceof Error ? error.message : String(error));
			}
		},
		[applyOps, beginStampPlacement, pickerMode, savedSigs, t],
	);

	const commitStamp = async (): Promise<void> => {
		if (pendingStamp === null) return;
		const noteKey: Record<StampKind, string> = {
			signature: t("documentEditor.pdf.signatureApplied"),
			image: t("documentEditor.pdf.imageApplied"),
			stamp: t("documentEditor.pdf.stampApplied"),
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
		if (event.button !== 0 || pageFrameRef.current === null || busy) return;
		if (inlineTextBoxRef.current !== null) {
			const currentBox = inlineTextBoxRef.current;
			if (currentBox.text.trim() !== "") {
				void commitInlineTextBox(currentBox);
				return;
			}
			setInlineTextBox(null);
		}
		if (tool === "none") return;
		const rect = pageFrameRef.current.getBoundingClientRect();
		const fx = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
		const fy = Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height)));
		event.currentTarget.setPointerCapture(event.pointerId);

		if (tool === "text" || tool === "note") {
			dragRef.current = { mode: "textbox-draw", startX: fx, startY: fy, initX: fx, initY: fy, initW: 0, initH: 0 };
			textBoxDraftRef.current = null;
			setTextBoxDraft(null);
		} else if (tool === "crop") {
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

		if (drag.mode === "textbox-draw") {
			const dx = Math.abs(fx - drag.startX);
			const dy = Math.abs(fy - drag.startY);
			if (dx >= 0.015 || dy >= 0.015) {
				const left = Math.min(drag.startX, fx);
				const top = Math.min(drag.startY, fy);
				const width = Math.min(1 - left, Math.max(0.04, dx));
				const height = Math.min(1 - top, Math.max(0.03, dy));
				const next: RectDraft = { pageIndex: activePage, left, top, width, height };
				textBoxDraftRef.current = next;
				setTextBoxDraft(next);
			}
			return;
		}
		if (drag.mode === "textbox-move") {
			const dx = fx - drag.startX;
			const dy = fy - drag.startY;
			setInlineTextBox((curr) =>
				curr === null
					? null
					: {
							...curr,
							x: Math.min(1 - curr.width, Math.max(0, drag.initX + dx)),
							y: Math.min(0.95, Math.max(0, drag.initY + dy)),
						},
			);
			return;
		}
		if (drag.mode === "textbox-resize") {
			const dx = fx - drag.startX;
			const nextW = Math.min(1 - drag.initX, Math.max(0.12, drag.initW + dx));
			setInlineTextBox((curr) => (curr === null ? null : { ...curr, width: nextW }));
			return;
		}
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

		if (drag.mode === "textbox-draw") {
			const draft = textBoxDraftRef.current;
			textBoxDraftRef.current = null;
			setTextBoxDraft(null);
			const nextId = textBoxSeqRef.current++;
			const isNote = tool === "note";
			const style = {
				variant: isNote ? ("note" as const) : ("text" as const),
				text: "",
				fontSizePt: isNote ? noteSize : textSize,
				color: textColor,
				noteColor,
			};
			if (draft !== null && (draft.width >= 0.06 || draft.height >= 0.03)) {
				setInlineTextBox({
					id: nextId,
					pageIndex: activePage,
					x: draft.left,
					y: draft.top,
					width: Math.min(1 - draft.left, Math.max(isNote ? 0.2 : 0.16, draft.width)),
					minHeight: Math.max(isNote ? 0.06 : 0.04, draft.height),
					...style,
				});
			} else {
				const x = Math.min(isNote ? 0.7 : 0.8, Math.max(0.02, drag.startX));
				const y = Math.min(isNote ? 0.86 : 0.92, Math.max(0.02, drag.startY));
				setInlineTextBox({
					id: nextId,
					pageIndex: activePage,
					x,
					y,
					width: isNote ? Math.min(0.3, 0.98 - x) : Math.min(0.42, Math.max(0.18, 0.98 - x)),
					minHeight: isNote ? 0.09 : 0.045,
					...style,
				});
			}
			return;
		}
		if (drag.mode === "textbox-move" || drag.mode === "textbox-resize") {
			inlineTextInputRef.current?.focus();
			return;
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

	const presetStamps = PRESET_STAMPS.map((stamp) => ({ id: stamp.id, label: t(stamp.labelKey), color: stamp.color }));

	const zoomInTarget = ZOOM_STEPS.find((step) => step > effectiveScale + 0.01);
	const zoomOutTarget = [...ZOOM_STEPS].reverse().find((step) => step < effectiveScale - 0.01);

	const labeledToolBtn = (active: boolean): string =>
		cn(
			"inline-flex h-28 flex-none items-center gap-6 rounded-6 border-0 px-8 text-meta transition-colors disabled:opacity-35",
			active
				? "bg-accent-soft font-medium text-accent"
				: "bg-transparent font-normal text-ink-body hover:bg-hover hover:text-ink",
		);

	const iconToolBtn = (active: boolean): string =>
		cn(
			"flex size-28 flex-none items-center justify-center rounded-6 border-0 transition-colors disabled:opacity-35",
			active
				? "bg-accent-soft text-accent"
				: "bg-transparent text-ink-body hover:bg-hover hover:text-ink",
		);

	const railIconBtn =
		"flex size-24 flex-none items-center justify-center rounded-5 border-0 bg-transparent text-ink-body transition-colors hover:bg-hover hover:text-ink disabled:opacity-30";

	const isRedactGroup = tool === "redact" || tool === "whiteout";
	const activeHint =
		tool === "text"
			? t("documentEditor.pdf.textBoxHint")
			: tool === "note"
				? t("documentEditor.pdf.noteBoxHint")
				: tool === "highlight"
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
		<div className="doc-editor__pdf flex min-h-0 flex-1 flex-col bg-ql-sunk text-ink" data-pdf-editor="true">
			{/* Single-row native macOS PDF toolbar (zero border-soup, zero 2-row wrapping) */}
			<div
				className="flex h-40 flex-none items-center gap-2 border-b border-divider bg-chrome px-12"
				role="toolbar"
				aria-label="PDF"
			>
				{/* Group 1: Fill & Sign */}
				<button
					type="button"
					disabled={busy || payload.encrypted}
					title={t("documentEditor.pdf.addSignature")}
					aria-label={t("documentEditor.pdf.addSignature")}
					data-pdf-action="signature"
					className={labeledToolBtn(sigModalOpen)}
					onClick={() => setSigModalOpen(true)}
				>
					<PenLine size={15} strokeWidth={1.65} />
					<span>{t("documentEditor.pdf.signatureShort")}</span>
				</button>
				<button
					type="button"
					aria-pressed={tool === "text"}
					disabled={busy || payload.encrypted}
					title={t("documentEditor.pdf.addText")}
					aria-label={t("documentEditor.pdf.addText")}
					data-pdf-tool="text"
					className={labeledToolBtn(tool === "text")}
					onClick={() => activateTool("text")}
				>
					<Type size={15} strokeWidth={1.65} />
					<span>{t("documentEditor.pdf.textShort")}</span>
				</button>
				<button
					type="button"
					disabled={busy || payload.encrypted}
					title={t("documentEditor.pdf.addImage")}
					aria-label={t("documentEditor.pdf.addImage")}
					data-pdf-action="insert-image"
					className={labeledToolBtn(pickerMode?.kind === "image")}
					onClick={() => {
						setStampMenuOpen(false);
						setMoreMenuOpen(false);
						setPickerMode({ kind: "image" });
					}}
				>
					<ImageIcon size={15} strokeWidth={1.65} />
					<span>{t("documentEditor.pdf.addImage")}</span>
				</button>

				<span className="mx-4 h-16 w-px flex-none bg-divider" aria-hidden="true" />

				{/* Group 2: Annotate & Redact (compact icon tools with contextual sub-bar) */}
				<button
					type="button"
					aria-pressed={tool === "highlight"}
					disabled={busy || payload.encrypted}
					title={t("documentEditor.pdf.highlight")}
					aria-label={t("documentEditor.pdf.highlight")}
					data-pdf-tool="highlight"
					className={iconToolBtn(tool === "highlight")}
					onClick={() => activateTool("highlight")}
				>
					<Highlighter size={15} strokeWidth={1.65} />
				</button>
				<button
					type="button"
					aria-pressed={tool === "draw"}
					disabled={busy || payload.encrypted}
					title={t("documentEditor.pdf.draw")}
					aria-label={t("documentEditor.pdf.draw")}
					data-pdf-tool="draw"
					className={iconToolBtn(tool === "draw")}
					onClick={() => activateTool("draw")}
				>
					<Pencil size={15} strokeWidth={1.65} />
				</button>
				<button
					type="button"
					aria-pressed={tool === "shape"}
					disabled={busy || payload.encrypted}
					title={t("documentEditor.pdf.shapes")}
					aria-label={t("documentEditor.pdf.shapes")}
					data-pdf-tool="shape"
					className={iconToolBtn(tool === "shape")}
					onClick={() => activateTool("shape")}
				>
					<Shapes size={15} strokeWidth={1.65} />
				</button>
				<button
					type="button"
					aria-pressed={isRedactGroup}
					disabled={busy || payload.encrypted}
					title={`${t("documentEditor.pdf.redact")} / ${t("documentEditor.pdf.whiteout")}`}
					aria-label={t("documentEditor.pdf.redact")}
					data-pdf-tool="redact"
					className={iconToolBtn(isRedactGroup)}
					onClick={() => activateTool(isRedactGroup ? tool : "redact")}
				>
					<EyeOff size={15} strokeWidth={1.65} />
				</button>

				{/* Stamp popover */}
				<div className="relative flex-none">
					<button
						type="button"
						disabled={busy || payload.encrypted}
						aria-expanded={stampMenuOpen}
						title={t("documentEditor.pdf.stamp")}
						aria-label={t("documentEditor.pdf.stamp")}
						data-pdf-stamp-menu="true"
						className={iconToolBtn(stampMenuOpen)}
						onClick={() => {
							setMoreMenuOpen(false);
							setStampMenuOpen((open) => !open);
						}}
					>
						<Stamp size={15} strokeWidth={1.65} />
					</button>
					{stampMenuOpen ? (
						<div className="absolute top-full left-0 z-40 mt-4 flex w-160 flex-col gap-2 rounded-8 border border-border bg-window p-4 shadow-lg">
							{presetStamps.map((st) => (
								<button
									key={st.id}
									type="button"
									data-pdf-preset-stamp={st.id}
									className="flex items-center justify-between rounded-6 border-0 bg-transparent px-8 py-6 text-left text-meta font-semibold hover:bg-hover"
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
					aria-pressed={tool === "note"}
					disabled={busy || payload.encrypted}
					title={t("documentEditor.pdf.stickyNote")}
					aria-label={t("documentEditor.pdf.stickyNote")}
					data-pdf-tool="note"
					className={iconToolBtn(tool === "note")}
					onClick={() => activateTool("note")}
				>
					<StickyNote size={15} strokeWidth={1.65} />
				</button>

				<span className="mx-4 h-16 w-px flex-none bg-divider" aria-hidden="true" />

				{/* Group 3: Crop + Organize / Document menu */}
				<button
					type="button"
					aria-pressed={tool === "crop"}
					disabled={busy || payload.encrypted}
					title={t("documentEditor.pdf.cropPage")}
					aria-label={t("documentEditor.pdf.cropPage")}
					data-pdf-tool="crop"
					className={iconToolBtn(tool === "crop")}
					onClick={() => activateTool("crop")}
				>
					<Crop size={15} strokeWidth={1.65} />
				</button>

				<div className="relative flex-none">
					<button
						type="button"
						disabled={busy || payload.encrypted}
						aria-expanded={moreMenuOpen}
						data-pdf-more-tools="true"
						className={labeledToolBtn(moreMenuOpen)}
						onClick={() => {
							setStampMenuOpen(false);
							setMoreMenuOpen((open) => !open);
						}}
					>
						<Layers size={15} strokeWidth={1.65} />
						<span>{t("documentEditor.pdf.documentTools")}</span>
						<ChevronDown size={12} className="text-ink-muted" />
					</button>
					{moreMenuOpen ? (
						<div className="absolute top-full left-0 z-40 mt-4 flex w-220 flex-col gap-2 rounded-8 border border-border bg-window p-6 shadow-lg">
							<div className="px-8 py-4 text-badge font-medium text-ink-muted">{t("documentEditor.pdf.sectionPages")}</div>
							<button
								type="button"
								data-pdf-action="merge"
								className="flex h-28 items-center gap-8 rounded-6 border-0 bg-transparent px-8 text-left text-meta text-ink hover:bg-hover"
								onClick={() => {
									setMoreMenuOpen(false);
									setPickerMode({ kind: "pdf" });
								}}
							>
								<FileInput size={14} strokeWidth={1.65} className="text-ink-muted" />
								{t("documentEditor.pdf.merge")}
							</button>
							<button
								type="button"
								data-pdf-action="split"
								className="flex h-28 items-center gap-8 rounded-6 border-0 bg-transparent px-8 text-left text-meta text-ink hover:bg-hover"
								onClick={() => {
									setMoreMenuOpen(false);
									setSplitOpen(true);
								}}
							>
								<SplitSquareHorizontal size={14} strokeWidth={1.65} className="text-ink-muted" />
								{t("documentEditor.pdf.split")}
							</button>
							<button
								type="button"
								data-pdf-action="duplicate"
								className="flex h-28 items-center gap-8 rounded-6 border-0 bg-transparent px-8 text-left text-meta text-ink hover:bg-hover"
								onClick={async () => {
									setMoreMenuOpen(false);
									const ok = await applyOps([{ kind: "duplicatePage", pageIndex: activePage }], t("documentEditor.pdf.pageDuplicated"));
									if (ok) setActivePage(activePage + 1);
								}}
							>
								<Copy size={14} strokeWidth={1.65} className="text-ink-muted" />
								{t("documentEditor.pdf.duplicatePage")}
							</button>
							<button
								type="button"
								data-pdf-action="insert-blank"
								className="flex h-28 items-center gap-8 rounded-6 border-0 bg-transparent px-8 text-left text-meta text-ink hover:bg-hover"
								onClick={async () => {
									setMoreMenuOpen(false);
									const ok = await applyOps(
										[{ kind: "insertBlankPage", insertAtIndex: activePage + 1, size: "match" }],
										t("documentEditor.pdf.blankPageInserted"),
									);
									if (ok) setActivePage(activePage + 1);
								}}
							>
								<FilePlus2 size={14} strokeWidth={1.65} className="text-ink-muted" />
								{t("documentEditor.pdf.insertBlankPage")}
							</button>
							<button
								type="button"
								data-pdf-action="rotate-left"
								className="flex h-28 items-center gap-8 rounded-6 border-0 bg-transparent px-8 text-left text-meta text-ink hover:bg-hover"
								onClick={() => {
									setMoreMenuOpen(false);
									void applyOps([{ kind: "rotatePage", pageIndex: activePage, deltaDegrees: -90 }], t("documentEditor.pdf.rotated"));
								}}
							>
								<RotateCcw size={14} strokeWidth={1.65} className="text-ink-muted" />
								{t("documentEditor.pdf.rotateLeft")}
							</button>

							<div className="my-4 h-px bg-divider" />
							<div className="px-8 py-4 text-badge font-medium text-ink-muted">{t("documentEditor.pdf.sectionDocument")}</div>

							<button
								type="button"
								data-pdf-action="watermark"
								className="flex h-28 items-center gap-8 rounded-6 border-0 bg-transparent px-8 text-left text-meta text-ink hover:bg-hover"
								onClick={() => {
									setMoreMenuOpen(false);
									setWatermarkOpen(true);
								}}
							>
								<Droplets size={14} strokeWidth={1.65} className="text-ink-muted" />
								{t("documentEditor.pdf.watermark")}
							</button>
							<button
								type="button"
								data-pdf-action="page-numbers"
								className="flex h-28 items-center gap-8 rounded-6 border-0 bg-transparent px-8 text-left text-meta text-ink hover:bg-hover"
								onClick={() => {
									setMoreMenuOpen(false);
									setPageNumbersOpen(true);
								}}
							>
								<Hash size={14} strokeWidth={1.65} className="text-ink-muted" />
								{t("documentEditor.pdf.pageNumbers")}
							</button>
							<button
								type="button"
								data-pdf-action="forms"
								className="flex h-28 items-center gap-8 rounded-6 border-0 bg-transparent px-8 text-left text-meta text-ink hover:bg-hover"
								onClick={() => {
									setMoreMenuOpen(false);
									setFormsOpen(true);
								}}
							>
								<FileSliders size={14} strokeWidth={1.65} className="text-ink-muted" />
								{t("documentEditor.pdf.forms")}
							</button>
							<button
								type="button"
								data-pdf-action="properties"
								className="flex h-28 items-center gap-8 rounded-6 border-0 bg-transparent px-8 text-left text-meta text-ink hover:bg-hover"
								onClick={() => {
									setMoreMenuOpen(false);
									setPropertiesOpen(true);
								}}
							>
								<Info size={14} strokeWidth={1.65} className="text-ink-muted" />
								{t("documentEditor.pdf.properties")}
							</button>
						</div>
					) : null}
				</div>

				<div className="flex-1" />

				{/* Right Utility Cluster: Find, Undo, Page Rail Toggle, External */}
				<button
					type="button"
					aria-pressed={findOpen}
					aria-label={t("documentEditor.pdf.findPlaceholder")}
					title={`${t("documentEditor.pdf.findPlaceholder")} (⌘F)`}
					className={iconToolBtn(findOpen)}
					onClick={() => setFindOpen((open) => !open)}
				>
					<Search size={15} strokeWidth={1.65} />
				</button>
				<button
					type="button"
					disabled={busy || undoStack.length === 0}
					aria-label={t("documentEditor.toolbar.undo")}
					title={t("documentEditor.toolbar.undo")}
					data-pdf-undo="true"
					className={iconToolBtn(false)}
					onClick={() => void undoLast()}
				>
					<RotateCcw size={15} strokeWidth={1.65} />
				</button>
				{onOpenExternal !== undefined ? (
					<button
						type="button"
						aria-label={t("documentEditor.package.openExternal")}
						title={t("documentEditor.package.openExternal")}
						className={iconToolBtn(false)}
						onClick={() => onOpenExternal(payload.path)}
					>
						<ExternalLink size={15} strokeWidth={1.65} />
					</button>
				) : null}
				<button
					type="button"
					aria-pressed={railOpen}
					aria-label={t("documentEditor.pdf.togglePagesRail")}
					title={t("documentEditor.pdf.togglePagesRail")}
					className={iconToolBtn(railOpen)}
					onClick={() => setRailOpen((open) => !open)}
				>
					<PanelRight size={15} strokeWidth={1.65} />
				</button>
			</div>

			{/* Find bar */}
			{findOpen ? (
				<div className="flex h-36 flex-none items-center gap-8 border-b border-divider bg-window px-12">
					<Search size={14} className="text-ink-muted" />
					<input
						ref={findInputRef}
						type="text"
						value={findQuery}
						data-pdf-find-input="true"
						placeholder={t("documentEditor.pdf.findPlaceholder")}
						className="h-24 w-240 rounded-6 border border-border bg-input px-8 text-meta text-ink outline-none focus:border-accent"
						onChange={(e) => setFindQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && findHits.length > 0) {
								e.preventDefault();
								const delta = e.shiftKey ? -1 : 1;
								const next = (findCursor + delta + findHits.length) % findHits.length;
								setFindCursor(next);
								setActivePage(findHits[next]!.pageIndex);
							}
						}}
						autoFocus
					/>
					{findQuery.trim() !== "" ? (
						<span className="text-badge tabular-nums text-ink-muted" data-pdf-find-count="true">
							{findHits.length > 0
								? t("documentEditor.pdf.findMatches", { current: findCursor + 1, total: findHits.length })
								: t("documentEditor.pdf.findNoMatch")}
						</span>
					) : null}
					<button
						type="button"
						disabled={findHits.length === 0}
						aria-label={t("documentEditor.pdf.findPrev")}
						className={railIconBtn}
						onClick={() => {
							if (findHits.length === 0) return;
							const next = (findCursor - 1 + findHits.length) % findHits.length;
							setFindCursor(next);
							setActivePage(findHits[next]!.pageIndex);
						}}
					>
						<ChevronLeft size={13} />
					</button>
					<button
						type="button"
						disabled={findHits.length === 0}
						aria-label={t("documentEditor.pdf.findNext")}
						className={railIconBtn}
						onClick={() => {
							if (findHits.length === 0) return;
							const next = (findCursor + 1) % findHits.length;
							setFindCursor(next);
							setActivePage(findHits[next]!.pageIndex);
						}}
					>
						<ChevronRight size={13} />
					</button>
					<div className="flex-1" />
					<button
						type="button"
						aria-label={t("common.close")}
						className={railIconBtn}
						onClick={() => {
							setFindOpen(false);
							setFindQuery("");
						}}
					>
						<X size={13} />
					</button>
				</div>
			) : null}

			{/* Contextual active-tool sub-bar (Apple Preview / Acrobat style) */}
			{activeHint !== null ? (
				<div className="flex flex-none flex-wrap items-center justify-between gap-8 border-b border-divider bg-window px-12 py-6 text-meta">
					<div className="flex flex-wrap items-center gap-12">
						{tool === "text" ? (
							<div className="flex items-center gap-8">
								<div className="flex items-center gap-4">
									{INK_COLORS.map((c) => (
										<button
											key={c}
											type="button"
											aria-label={c}
											aria-pressed={textColor === c}
											className={cn("size-16 rounded-full border-2", textColor === c ? "border-accent ring-2 ring-accent/20" : "border-border")}
											style={{ backgroundColor: c }}
											onMouseDown={(e) => e.preventDefault()}
											onClick={() => {
												setTextColor(c);
												setInlineTextBox((curr) => (curr === null ? null : { ...curr, color: c }));
											}}
										/>
									))}
								</div>
								<select
									aria-label={t("documentEditor.pdf.textSize")}
									value={textSize}
									onChange={(e) => {
										const nextSize = Number(e.target.value);
										setTextSize(nextSize);
										setInlineTextBox((curr) => (curr === null ? null : { ...curr, fontSizePt: nextSize }));
									}}
									className="h-24 rounded-6 border border-border bg-window px-6 text-badge text-ink"
								>
									{[12, 14, 16, 20, 28, 36].map((sz) => (
										<option key={sz} value={sz}>
											{sz}pt
										</option>
									))}
								</select>
								<button
									type="button"
									className="inline-flex h-24 items-center gap-4 rounded-6 border-0 bg-subtle px-8 text-badge text-ink hover:bg-hover"
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => {
										const stamp = todayIso();
										if (inlineTextBoxRef.current !== null) {
											setInlineTextBox((curr) =>
												curr === null
													? null
													: { ...curr, text: curr.text.trim() ? `${curr.text} ${stamp}` : stamp },
											);
										} else {
											const nextId = textBoxSeqRef.current++;
											setInlineTextBox({
												id: nextId,
												variant: "text",
												pageIndex: activePage,
												x: 0.12,
												y: 0.14,
												width: 0.28,
												minHeight: 0.045,
												text: stamp,
												fontSizePt: textSize,
												color: textColor,
												noteColor,
											});
										}
									}}
								>
									<Calendar size={12} />
									{t("documentEditor.pdf.insertToday")}
								</button>
							</div>
						) : null}
						{tool === "note" ? (
							<div className="flex items-center gap-8">
								<div className="flex items-center gap-4" role="group" aria-label={t("documentEditor.pdf.noteColor")}>
									{NOTE_PALETTES.map((palette) => (
										<button
											key={palette.id}
											type="button"
											data-pdf-note-color={palette.id}
											aria-label={t(`documentEditor.pdf.noteColors.${palette.id}`)}
											title={t(`documentEditor.pdf.noteColors.${palette.id}`)}
											aria-pressed={noteColor === palette.id}
											className={cn(
												"size-16 rounded-full border-2",
												noteColor === palette.id ? "border-accent ring-2 ring-accent/20" : "border-border",
											)}
											style={{ backgroundColor: palette.fill }}
											onMouseDown={(e) => e.preventDefault()}
											onClick={() => {
												setNoteColor(palette.id);
												setInlineTextBox((curr) => (curr === null || curr.variant !== "note" ? curr : { ...curr, noteColor: palette.id }));
											}}
										/>
									))}
								</div>
								<select
									aria-label={t("documentEditor.pdf.textSize")}
									value={noteSize}
									onChange={(e) => {
										const nextSize = Number(e.target.value);
										setNoteSize(nextSize);
										setInlineTextBox((curr) => (curr === null || curr.variant !== "note" ? curr : { ...curr, fontSizePt: nextSize }));
									}}
									className="h-24 rounded-6 border border-border bg-window px-6 text-badge text-ink"
								>
									{[11, 12, 13, 14, 16, 18].map((sz) => (
										<option key={sz} value={sz}>
											{sz}pt
										</option>
									))}
								</select>
							</div>
						) : null}
						{isRedactGroup ? (
							<div className="inline-flex h-24 items-center rounded-6 bg-segment-track p-2" role="group">
								<button
									type="button"
									aria-pressed={tool === "redact"}
									data-pdf-redact-mode="black"
									className={cn(
										"h-20 rounded-4 border-0 px-8 text-badge font-medium transition-colors",
										tool === "redact" ? "bg-segment-thumb text-ink shadow-xs" : "bg-transparent text-ink-muted hover:text-ink",
									)}
									onClick={() => setTool("redact")}
								>
									{t("documentEditor.pdf.redactBlack")}
								</button>
								<button
									type="button"
									aria-pressed={tool === "whiteout"}
									data-pdf-redact-mode="white"
									className={cn(
										"h-20 rounded-4 border-0 px-8 text-badge font-medium transition-colors",
										tool === "whiteout" ? "bg-segment-thumb text-ink shadow-xs" : "bg-transparent text-ink-muted hover:text-ink",
									)}
									onClick={() => setTool("whiteout")}
								>
									{t("documentEditor.pdf.whiteout")}
								</button>
							</div>
						) : null}
						{tool === "highlight" ? (
							<div className="flex items-center gap-6">
								{HIGHLIGHT_COLORS.map((c) => (
									<button
										key={c}
										type="button"
										aria-label={c}
										aria-pressed={highlightColor === c}
										className={cn("size-16 rounded-full border-2", highlightColor === c ? "border-accent ring-2 ring-accent/20" : "border-border")}
										style={{ backgroundColor: c }}
										onClick={() => setHighlightColor(c)}
									/>
								))}
							</div>
						) : null}
						{tool === "shape" ? (
							<div className="inline-flex h-24 items-center rounded-6 bg-segment-track p-2" role="group">
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
												"inline-flex h-20 items-center gap-4 rounded-4 border-0 px-8 text-badge transition-colors",
												shapeKind === item.id ? "bg-segment-thumb font-medium text-ink shadow-xs" : "bg-transparent text-ink-muted hover:text-ink",
											)}
											onClick={() => setShapeKind(item.id)}
										>
											<Icon size={12} />
											{item.label}
										</button>
									);
								})}
							</div>
						) : null}
						{tool === "draw" || tool === "shape" ? (
							<div className="flex items-center gap-8">
								<div className="flex items-center gap-4">
									{INK_COLORS.map((c) => (
										<button
											key={c}
											type="button"
											aria-label={c}
											aria-pressed={strokeColor === c}
											className={cn("size-16 rounded-full border-2", strokeColor === c ? "border-accent ring-2 ring-accent/20" : "border-border")}
											style={{ backgroundColor: c }}
											onClick={() => setStrokeColor(c)}
										/>
									))}
								</div>
								<select
									aria-label={t("documentEditor.pdf.strokeWidth")}
									value={strokeWidthPt}
									onChange={(e) => setStrokeWidthPt(Number(e.target.value))}
									className="h-24 rounded-6 border border-border bg-window px-6 text-badge text-ink"
								>
									{[1.5, 2.5, 4, 6].map((w) => (
										<option key={w} value={w}>
											{w}pt
										</option>
									))}
								</select>
							</div>
						) : null}
						<span className="text-ink-muted">{activeHint}</span>
					</div>
					<button
						type="button"
						className="h-24 rounded-6 border-0 bg-transparent px-8 text-badge font-medium text-ink-muted hover:bg-hover hover:text-ink"
						onClick={() => {
							setInlineTextBox(null);
							setTextBoxDraft(null);
							setTool("none");
						}}
					>
						{t("common.close")}
					</button>
				</div>
			) : null}

			{/* Pending placement / crop confirmation bar */}
			{pendingStamp !== null ? (
				<div className="flex h-36 flex-none items-center justify-between gap-8 border-b border-divider bg-accent-soft px-12 text-meta text-accent">
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
							className="inline-flex h-24 items-center gap-4 rounded-6 border-0 bg-accent px-12 text-meta font-medium text-on-accent"
							onClick={() => void commitStamp()}
						>
							<Check size={12} />
							{t("documentEditor.ai.send")}
						</button>
					</div>
				</div>
			) : null}

			{tool === "crop" && cropDraft !== null ? (
				<div className="flex h-36 flex-none items-center justify-between gap-8 border-b border-divider bg-accent-soft px-12 text-meta text-accent">
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
							className="inline-flex h-24 items-center gap-4 rounded-6 border-0 bg-accent px-12 text-meta font-medium text-on-accent"
							onClick={() => void commitCrop()}
						>
							<Scissors size={12} />
							{t("documentEditor.pdf.applyCrop")}
						</button>
					</div>
				</div>
			) : null}

			{statusMsg !== null ? (
				<div className="flex h-30 flex-none items-center justify-between gap-8 border-b border-divider bg-window px-12 text-meta text-ink-body" role="status">
					<span className="truncate">{statusMsg}</span>
					<div className="flex flex-none items-center gap-8">
						{extractedFile !== null && onOpenExtracted !== undefined ? (
							<button
								type="button"
								className="h-22 rounded-5 border-0 bg-accent-soft px-8 text-badge font-medium text-accent hover:opacity-90"
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

			{/* Main split: Center PDF canvas + Right-side page thumbnail rail (matches Quick Look PagedView) */}
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
					{/* Center PDF canvas + Quick-Look-style floating zoom/page HUD pill */}
					<div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
						<div
							ref={stageScrollRef}
							className="flex min-h-0 flex-1 items-start justify-center overflow-auto px-28 pt-28 pb-64"
							onPointerDown={(event) => {
								if (event.button !== 0 || inlineTextBoxRef.current === null) return;
								if (pageFrameRef.current !== null && pageFrameRef.current.contains(event.target as Node)) return;
								const currentBox = inlineTextBoxRef.current;
								if (currentBox.text.trim() !== "") {
									void commitInlineTextBox(currentBox);
								} else {
									setInlineTextBox(null);
								}
							}}
						>
							<div
								ref={pageFrameRef}
								data-page={activePage + 1}
								data-pdf-page-stage={activePage + 1}
								className={cn(
									"relative flex-none rounded-[2px] bg-white shadow-ql-page select-none",
									tool === "crop" && "overflow-hidden",
									tool === "text" || tool === "note" ? "cursor-text" : tool !== "none" && "cursor-crosshair",
								)}
								onPointerDown={onStagePointerDown}
								onPointerMove={onStagePointerMove}
								onPointerUp={onStagePointerUp}
								onPointerCancel={onStagePointerUp}
							>
								<PdfPageCanvas
									pdf={pdf}
									pageNumber={activePage + 1}
									scale={effectiveScale}
									onNaturalSize={setPageNaturalSize}
								/>

								{/* Live Find-in-PDF text match highlight boxes (matches Quick Look evidence mark style) */}
								{findOpen && findHits.length > 0
									? findHits.map((hit, hitIdx) => {
											if (hit.pageIndex !== activePage) return null;
											const isCurrent = hitIdx === findCursor;
											return hit.rects.map((rect, rectIdx) => (
												<div
													key={`${hitIdx}-${rectIdx}`}
													data-pdf-find-highlight={isCurrent ? "current" : "match"}
													className={cn(
														"pointer-events-none absolute z-10 rounded-[2px] mix-blend-multiply",
														isCurrent
															? "bg-[#FF9500]/50 shadow-[0_0_0_1.5px_#E67600]"
															: "bg-ql-evidence-mark shadow-[0_0_0_1px_var(--ql-evidence-mark-ring)]",
													)}
													style={{
														left: (rect.x - 1) * effectiveScale,
														top: (rect.y - 1) * effectiveScale,
														width: (rect.width + 2) * effectiveScale,
														height: (rect.height + 2) * effectiveScale,
													}}
												/>
											));
										})
									: null}

								{/* Keynote / PowerPoint-style Text Box drag preview */}
								{textBoxDraft !== null && textBoxDraft.pageIndex === activePage ? (
									<div
										className="pointer-events-none absolute z-20 rounded-[2px] border-[1.5px] border-dashed border-accent bg-accent/5"
										style={{
											left: `${textBoxDraft.left * 100}%`,
											top: `${textBoxDraft.top * 100}%`,
											width: `${textBoxDraft.width * 100}%`,
											height: `${textBoxDraft.height * 100}%`,
										}}
									/>
								) : null}

								{/* Keynote / PowerPoint-style live editable on-canvas Text Box */}
								{inlineTextBox !== null && inlineTextBox.pageIndex === activePage ? (
									<div
										data-pdf-textbox="true"
										data-pdf-textbox-variant={inlineTextBox.variant}
										className={cn(
											"absolute z-30 select-text",
											inlineTextBox.variant === "text" && "rounded-[3px] bg-white/85 shadow-sm ring-[1.5px] ring-accent",
										)}
										style={{
											left: `${inlineTextBox.x * 100}%`,
											top: `${inlineTextBox.y * 100}%`,
											width: `${inlineTextBox.width * 100}%`,
											minHeight: `${inlineTextBox.minHeight * 100}%`,
											...(inlineTextBox.variant === "note"
												? {
														backgroundColor: notePalette(inlineTextBox.noteColor).fill,
														borderRadius: NOTE_BOX_RADIUS * effectiveScale,
														// Hairline card border (inside, so it never eats text width) + accent focus ring + soft lift.
														boxShadow: `inset 0 0 0 1px ${notePalette(inlineTextBox.noteColor).stroke}, 0 0 0 2px var(--accent), 0 4px 12px rgba(20, 20, 41, 0.14)`,
													}
												: {}),
										}}
										onPointerDown={(event) => event.stopPropagation()}
									>
										{/* Top floating move/confirm/cancel bar */}
										<div
											className="absolute -top-26 left-0 flex h-22 items-center gap-2 rounded-6 border border-border bg-window px-4 shadow-md"
											onPointerDown={(event) => event.stopPropagation()}
										>
											<span
												role="presentation"
												title={t("documentEditor.pdf.textBoxMove")}
												className="flex h-full cursor-move items-center px-3 text-ink-muted hover:text-ink"
												onPointerDown={(event) => {
													if (event.button !== 0 || pageFrameRef.current === null) return;
													event.stopPropagation();
													const rect = pageFrameRef.current.getBoundingClientRect();
													const fx = (event.clientX - rect.left) / Math.max(1, rect.width);
													const fy = (event.clientY - rect.top) / Math.max(1, rect.height);
													pageFrameRef.current.setPointerCapture(event.pointerId);
													dragRef.current = {
														mode: "textbox-move",
														startX: fx,
														startY: fy,
														initX: inlineTextBox.x,
														initY: inlineTextBox.y,
														initW: inlineTextBox.width,
														initH: inlineTextBox.minHeight,
													};
												}}
											>
												<GripHorizontal size={12} />
											</span>
											<button
												type="button"
												disabled={busy || inlineTextBox.text.trim() === ""}
												data-pdf-textbox-commit="true"
												aria-label={t("documentEditor.ai.send")}
												title={`${t("documentEditor.ai.send")} (⌘Enter)`}
												className="inline-flex h-16 items-center gap-3 rounded-4 border-0 bg-accent px-6 text-[11px] font-medium text-on-accent hover:opacity-90 disabled:opacity-35"
												onClick={() => void commitInlineTextBox()}
											>
												<Check size={10} />
												<span>{t("documentEditor.ai.send")}</span>
											</button>
											<button
												type="button"
												data-pdf-textbox-cancel="true"
												aria-label={t("common.cancel")}
												title={`${t("common.cancel")} (Esc)`}
												className="flex size-16 items-center justify-center rounded-4 border-0 bg-transparent text-ink-muted hover:bg-hover hover:text-ink"
												onClick={() => setInlineTextBox(null)}
											>
												<X size={11} />
											</button>
										</div>

										<textarea
											ref={inlineTextInputRef}
											rows={1}
											data-pdf-textbox-input="true"
											value={inlineTextBox.text}
											placeholder={
												inlineTextBox.variant === "note"
													? t("documentEditor.pdf.noteBoxPlaceholder")
													: t("documentEditor.pdf.textBoxPlaceholder")
											}
											className="block w-full resize-none overflow-hidden border-0 bg-transparent outline-none placeholder:text-ink-faint"
											style={{
												padding:
													inlineTextBox.variant === "note"
														? `${NOTE_BOX_PAD.y * effectiveScale}px ${NOTE_BOX_PAD.x * effectiveScale}px`
														: `${TEXT_BOX_PAD.y * effectiveScale}px ${TEXT_BOX_PAD.x * effectiveScale}px`,
												fontSize: `${inlineTextBox.fontSizePt * effectiveScale}px`,
												lineHeight: BOX_LINE_HEIGHT,
												fontWeight: 500,
												color: inlineTextBox.variant === "note" ? notePalette(inlineTextBox.noteColor).ink : inlineTextBox.color,
												fontFamily: BOX_FONT_FAMILY,
												// Same wrapping rules as wrapBoxText(), so the saved PDF matches what was typed.
												whiteSpace: "pre-wrap",
												wordBreak: "keep-all",
												overflowWrap: "anywhere",
											}}
											onChange={(event) => {
												const nextText = event.target.value;
												setInlineTextBox((curr) => (curr === null ? null : { ...curr, text: nextText }));
											}}
											onKeyDown={(event) => {
												if (event.nativeEvent.isComposing) return;
												if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
													event.preventDefault();
													event.stopPropagation();
													void commitInlineTextBox();
												} else if (event.key === "Escape") {
													event.preventDefault();
													event.stopPropagation();
													setInlineTextBox(null);
												}
											}}
										/>

										{/* Right-edge width resize handle (Keynote/PPT style) */}
										<div
											role="presentation"
											title={t("documentEditor.pdf.textBoxResize")}
											className="absolute top-1/2 -right-5 size-10 -translate-y-1/2 cursor-ew-resize rounded-full border-2 border-white bg-accent shadow"
											onPointerDown={(event) => {
												if (event.button !== 0 || pageFrameRef.current === null) return;
												event.stopPropagation();
												const rect = pageFrameRef.current.getBoundingClientRect();
												const fx = (event.clientX - rect.left) / Math.max(1, rect.width);
												const fy = (event.clientY - rect.top) / Math.max(1, rect.height);
												pageFrameRef.current.setPointerCapture(event.pointerId);
												dragRef.current = {
													mode: "textbox-resize",
													startX: fx,
													startY: fy,
													initX: inlineTextBox.x,
													initY: inlineTextBox.y,
													initW: inlineTextBox.width,
													initH: inlineTextBox.minHeight,
												};
											}}
										/>
									</div>
								) : null}

								{/* Draggable & resizable stamp overlay */}
								{pendingStamp !== null && pendingStamp.pageIndex === activePage ? (
									<div
										data-pdf-stamp-box="true"
										className="absolute z-20 cursor-move border-2 border-dashed border-accent bg-transparent"
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

						{/* Floating translucent Zoom & Page HUD pill (matches Quick Look PagedView) */}
						<div className="pointer-events-auto absolute bottom-14 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-11 bg-ql-panel px-6 py-3 text-[12px] tabular-nums shadow-ql-float [backdrop-filter:var(--backdrop-ql-float)]">
							<button
								type="button"
								aria-label={t("documentEditor.pdf.zoomOut")}
								disabled={zoomOutTarget === undefined}
								className="grid size-24 place-items-center rounded-6 border-0 bg-transparent text-[15px] text-ql-ink hover:bg-ql-button disabled:opacity-35"
								onClick={() => setManualScale(zoomOutTarget ?? effectiveScale)}
							>
								−
							</button>
							<button
								type="button"
								title={t("documentEditor.pdf.fitWidth")}
								className="h-24 min-w-44 rounded-6 border-0 bg-transparent px-4 text-center text-[12px] tabular-nums text-ql-ink-secondary hover:bg-ql-button"
								onClick={() => setManualScale(null)}
							>
								{Math.round(effectiveScale * 100)}%
							</button>
							<button
								type="button"
								aria-label={t("documentEditor.pdf.zoomIn")}
								disabled={zoomInTarget === undefined}
								className="grid size-24 place-items-center rounded-6 border-0 bg-transparent text-[15px] text-ql-ink hover:bg-ql-button disabled:opacity-35"
								onClick={() => setManualScale(zoomInTarget ?? effectiveScale)}
							>
								+
							</button>
							<span className="mx-4 h-14 w-px bg-ql-hairline" aria-hidden="true" />
							<button
								type="button"
								aria-label={t("documentEditor.pdf.prevPage")}
								disabled={activePage <= 0}
								className="grid size-24 place-items-center rounded-6 border-0 bg-transparent text-ql-ink hover:bg-ql-button disabled:opacity-35"
								onClick={() => goToPage(activePage - 1)}
							>
								<ChevronLeft size={13} />
							</button>
							<span className="px-4 font-medium text-ql-ink" data-pdf-page-indicator="true">
								{activePage + 1} / {numPages}
							</span>
							<button
								type="button"
								aria-label={t("documentEditor.pdf.nextPage")}
								disabled={activePage >= numPages - 1}
								className="grid size-24 place-items-center rounded-6 border-0 bg-transparent text-ql-ink hover:bg-ql-button disabled:opacity-35"
								onClick={() => goToPage(activePage + 1)}
							>
								<ChevronRight size={13} />
							</button>
						</div>
					</div>

					{/* Right-side Page Thumbnail Rail (unified with Quick Look PagedView, aspect-ratio fitted for portrait & landscape) */}
					{railOpen ? (
						<aside
							data-pdf-thumbnail-rail="right"
							className="flex w-[144px] flex-none flex-col border-l border-divider bg-chrome/75"
							aria-label={t("documentEditor.pdf.pages")}
						>
							{/* Contextual page action strip */}
							<div className="flex h-32 flex-none items-center justify-between border-b border-divider px-8">
								<button
									type="button"
									disabled={busy || payload.encrypted || numPages === 0}
									title={t("documentEditor.pdf.rotateRight")}
									aria-label={t("documentEditor.pdf.rotateRight")}
									className={railIconBtn}
									onClick={() => void applyOps([{ kind: "rotatePage", pageIndex: activePage, deltaDegrees: 90 }], t("documentEditor.pdf.rotated"))}
								>
									<RotateCw size={13} strokeWidth={1.65} />
								</button>
								<button
									type="button"
									disabled={busy || payload.encrypted || activePage <= 0}
									title={t("documentEditor.pdf.moveUp")}
									aria-label={t("documentEditor.pdf.moveUp")}
									className={railIconBtn}
									onClick={async () => {
										const target = activePage - 1;
										const ok = await applyOps([{ kind: "movePage", fromIndex: activePage, toIndex: target }]);
										if (ok) setActivePage(target);
									}}
								>
									<ArrowUp size={13} strokeWidth={1.65} />
								</button>
								<button
									type="button"
									disabled={busy || payload.encrypted || activePage >= numPages - 1}
									title={t("documentEditor.pdf.moveDown")}
									aria-label={t("documentEditor.pdf.moveDown")}
									className={railIconBtn}
									onClick={async () => {
										const target = activePage + 1;
										const ok = await applyOps([{ kind: "movePage", fromIndex: activePage, toIndex: target }]);
										if (ok) setActivePage(target);
									}}
								>
									<ArrowDown size={13} strokeWidth={1.65} />
								</button>
								<button
									type="button"
									disabled={busy || payload.encrypted || numPages === 0}
									title={
										selectedPages.size > 0
											? t("documentEditor.pdf.extractCount", { count: selectedPages.size })
											: t("documentEditor.pdf.extractCurrent")
									}
									aria-label={
										selectedPages.size > 0
											? t("documentEditor.pdf.extractCount", { count: selectedPages.size })
											: t("documentEditor.pdf.extractCurrent")
									}
									data-pdf-extract="true"
									className={cn(railIconBtn, selectedPages.size > 0 && "text-accent")}
									onClick={() => void handleExtractPages()}
								>
									<FileOutput size={13} strokeWidth={1.65} />
								</button>
								<button
									type="button"
									disabled={busy || payload.encrypted || numPages <= 1}
									title={t("documentEditor.pdf.deletePage")}
									aria-label={t("documentEditor.pdf.deletePage")}
									className="flex size-24 flex-none items-center justify-center rounded-5 border-0 bg-transparent text-ink-body transition-colors hover:bg-error-soft hover:text-error disabled:opacity-30"
									onClick={async () => {
										const ok = await applyOps([{ kind: "deletePage", pageIndex: activePage }], t("documentEditor.pdf.pageDeleted"));
										if (ok) {
											setSelectedPages(new Set());
											setActivePage((curr) => Math.max(0, Math.min(curr, numPages - 2)));
										}
									}}
								>
									<Trash2 size={13} strokeWidth={1.65} />
								</button>
							</div>

							{/* Scrollable aspect-ratio-fitted thumbnail list */}
							<div ref={railScrollRef} className="flex min-h-0 flex-1 flex-col items-center gap-14 overflow-y-auto px-12 py-12">
								{Array.from({ length: pdf.numPages }, (_unused, idx) => {
									const isActive = idx === activePage;
									const isChecked = selectedPages.has(idx);
									const isFindHit = findHits.some((h) => h.pageIndex === idx);
									return (
										<div
											key={idx}
											data-pdf-thumb={idx + 1}
											data-active={isActive ? "true" : undefined}
											className="group flex w-full cursor-default flex-col items-center gap-6"
											onClick={() => goToPage(idx)}
										>
											<div
												className={cn(
													"flex items-center justify-center overflow-hidden rounded-[3px] bg-white transition-shadow",
													isActive
														? "ring-2 ring-accent shadow-sm"
														: isFindHit
															? "ring-2 ring-warning shadow-xs"
															: "ring-1 ring-black/10 shadow-xs group-hover:ring-black/25",
												)}
											>
												<PdfPageCanvas
													pdf={pdf}
													pageNumber={idx + 1}
													fitBox={{ maxWidth: THUMB_MAX_W, maxHeight: THUMB_MAX_H }}
												/>
											</div>
											<div className="relative flex w-full items-center justify-center">
												<input
													type="checkbox"
													aria-label={t("documentEditor.pdf.selectPage", { page: idx + 1 })}
													checked={isChecked}
													onClick={(e) => e.stopPropagation()}
													onChange={() => togglePageSelected(idx)}
													className={cn(
														"absolute left-6 size-12 accent-accent transition-opacity",
														isChecked ? "opacity-100" : "opacity-0 group-hover:opacity-80 focus:opacity-100",
													)}
												/>
												<span
													className={cn(
														"text-center text-badge tabular-nums",
														isActive ? "font-semibold text-accent" : "text-ink-muted",
													)}
												>
													{idx + 1}
												</span>
											</div>
										</div>
									);
								})}
							</div>
						</aside>
					) : null}
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
					onPickImageFromDazzi={(remember) => {
						setSigModalOpen(false);
						setPickerMode({ kind: "signature", rememberSig: remember });
					}}
					onRemoveSaved={(index) => {
						const next = savedSigs.filter((_item, idx) => idx !== index);
						setSavedSigs(next);
						storeSavedSignatures(next);
					}}
					onClose={() => setSigModalOpen(false)}
				/>
			) : null}

			{pickerMode !== null ? (
				<DazziFilePickerModal
					mode={pickerMode.kind === "pdf" ? "pdf" : "image"}
					initialDir={parentDirOf(payload.path)}
					{...(pickerMode.kind === "pdf" ? { excludePath: payload.path, multiple: true } : {})}
					onPick={(paths) => void handlePickedFiles(paths)}
					onClose={() => setPickerMode(null)}
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
								force: true,
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
