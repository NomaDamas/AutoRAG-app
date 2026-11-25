/**
 * Contract for the in-app Document Editor tab (`documentEditor:*`), shared by
 * the main process, preload bridge, remote bootstrap, and renderer.
 *
 * A Document Editor tab opens either from:
 * - Quick Look's pen (edit) button (closes Quick Look and hands the file to a
 *   new tab in the Finder window), or
 * - Option+click (macOS) / Alt+click (Windows/Linux) on a file row/tile.
 *
 * Text-based documents (`markdown`, `html`, `plain`, `code`) load as UTF-8/decoded
 * text so the user can edit directly (WYSIWYG for Markdown/HTML/plain text,
 * monospace source editor for code/data text) with autosave, alongside AI editing.
 * Package documents (`docx`, `pptx`, `xlsx`, `hwp`, `hwpx`, `odt`, `odp`, `ods`)
 * load their preview payload so the user can draw marks and instruct the
 * `document-edit` agent in place.
 */

import { documentEditMode, type DocumentEditEvent, type DocumentEditMode, type DocumentEditRequest } from "../preview/shared/annotation";
import type { PreviewDocument } from "../preview/shared/contract";
import { viewerForExtension } from "../preview/shared/registry";

export const DOCUMENT_EDITOR_CHANNELS = {
	open: "documentEditor:open",
	save: "documentEditor:save",
	pdfApply: "documentEditor:pdfApply",
	pdfExtract: "documentEditor:pdfExtract",
	pdfRestore: "documentEditor:pdfRestore",
	aiStart: "documentEditor:aiStart",
	aiCancel: "documentEditor:aiCancel",
	aiUndo: "documentEditor:aiUndo",
	aiEvent: "documentEditor:aiEvent",
} as const;

/**
 * Which editor surface a file gets inside a Document Editor tab:
 * - `wysiwyg`: TipTap rich-text WYSIWYG with Markdown/HTML/source toggle (`.md`, `.markdown`, `.mdx`, `.html`, `.htm`, `.xhtml`, `.txt`, `.text`).
 * - `code`: Monospace text/code editor (code, JSON, YAML, CSV/TSV, logs, configs).
 * - `package`: Visual preview + mark-up canvas + AI in-place editing (Office Open XML, HWP/HWPX, OpenDocument).
 * - `pdf`: Visual PDF editor (signature & text stamps, crop, rotate, reorder, delete, extract pages).
 */
export type DocumentEditorSurface = "wysiwyg" | "code" | "package" | "pdf";

const WYSIWYG_EXTENSIONS: Readonly<Record<string, "markdown" | "html" | "plain">> = {
	md: "markdown",
	markdown: "markdown",
	mdx: "markdown",
	html: "html",
	htm: "html",
	xhtml: "html",
	txt: "plain",
	text: "plain",
};

export type WysiwygFormat = "markdown" | "html" | "plain";

export function wysiwygFormatForExtension(ext: string): WysiwygFormat | null {
	const key = ext.toLowerCase().replace(/^\./, "");
	return WYSIWYG_EXTENSIONS[key] ?? null;
}

export function documentEditorSurface(ext: string): DocumentEditorSurface | null {
	const lower = ext.toLowerCase().replace(/^\./, "");
	if (lower === "pdf") return "pdf";
	const mode = documentEditMode(lower);
	if (mode === null) return null;
	if (mode === "package") return "package";
	if (wysiwygFormatForExtension(lower) !== null) return "wysiwyg";
	const viewer = viewerForExtension(lower);
	if (viewer === "markdown" || viewer === "html") return "wysiwyg";
	return "code";
}

export type DocumentLineEnding = "LF" | "CRLF" | "CR";

export interface DocumentEditorTextPayload {
	readonly kind: "text";
	readonly surface: "wysiwyg" | "code";
	readonly wysiwygFormat: WysiwygFormat | null;
	readonly path: string;
	readonly name: string;
	readonly ext: string;
	readonly text: string;
	readonly encoding: string;
	readonly ending: DocumentLineEnding;
	readonly size: number;
	readonly modifiedAt: string;
	readonly mtimeMs: number;
	readonly truncated: boolean;
}

export interface DocumentEditorPackagePayload {
	readonly kind: "package";
	readonly surface: "package";
	readonly path: string;
	readonly name: string;
	readonly ext: string;
	readonly document: PreviewDocument;
	readonly mtimeMs: number;
}

export interface DocumentEditorPdfPayload {
	readonly kind: "pdf";
	readonly surface: "pdf";
	readonly path: string;
	readonly name: string;
	readonly ext: "pdf";
	readonly size: number;
	readonly modifiedAt: string;
	readonly mtimeMs: number;
	readonly pageCount: number;
	readonly encrypted: boolean;
}

export type DocumentEditorLoad = DocumentEditorTextPayload | DocumentEditorPackagePayload | DocumentEditorPdfPayload;

/**
 * One PDF edit operation applied by `pdf-lib` in the main process.
 * All spatial coordinates are fractions (0..1) of the visible page box, origin top-left.
 */
export type PdfEditOperation =
	| {
			readonly kind: "stampImage";
			readonly pageIndex: number;
			/** PNG data URL (`data:image/png;base64,...`) rendered from the signature pad or text stamp canvas. */
			readonly pngDataUrl: string;
			readonly x: number;
			readonly y: number;
			readonly width: number;
			readonly height: number;
	  }
	| {
			readonly kind: "rotatePage";
			readonly pageIndex: number;
			readonly deltaDegrees: 90 | -90 | 180 | 270;
	  }
	| {
			readonly kind: "deletePage";
			readonly pageIndex: number;
	  }
	| {
			readonly kind: "movePage";
			readonly fromIndex: number;
			readonly toIndex: number;
	  }
	| {
			readonly kind: "cropPage";
			readonly pageIndex: number;
			readonly left: number;
			readonly top: number;
			readonly width: number;
			readonly height: number;
	  };

export interface PdfApplyRequest {
	readonly path: string;
	readonly operations: readonly PdfEditOperation[];
	readonly expectedMtimeMs?: number;
	readonly force?: boolean;
}

export type PdfApplyResult =
	| {
			readonly ok: true;
			readonly size: number;
			readonly modifiedAt: string;
			readonly mtimeMs: number;
			readonly pageCount: number;
			readonly snapshotId: string;
	  }
	| { readonly ok: false; readonly reason: "conflict"; readonly diskMtimeMs: number };

export interface PdfExtractRequest {
	readonly path: string;
	/** 1-based page numbers to extract into a new sibling PDF file. */
	readonly pages: readonly number[];
}

export interface PdfExtractResult {
	readonly outputPath: string;
	readonly name: string;
	readonly pageCount: number;
}

export interface PdfRestoreResult {
	readonly ok: boolean;
	readonly size?: number;
	readonly modifiedAt?: string;
	readonly mtimeMs?: number;
	readonly pageCount?: number;
}
export interface DocumentEditorSaveRequest {
	readonly path: string;
	readonly text: string;
	readonly ending?: DocumentLineEnding;
	/** Last mtimeMs the editor saw on disk; when provided, main reports external conflict unless force is true. */
	readonly expectedMtimeMs?: number;
	readonly force?: boolean;
}

export type DocumentEditorSaveResult =
	| { readonly ok: true; readonly size: number; readonly modifiedAt: string; readonly mtimeMs: number }
	| { readonly ok: false; readonly reason: "conflict"; readonly diskMtimeMs: number };

export interface DocumentEditorAiCapture {
	/** Optional viewport-relative capture rectangle (CSS px) for screenshotting the editor pane. */
	readonly rect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface DocumentEditorBridge {
	open(path: string): Promise<DocumentEditorLoad>;
	save(request: DocumentEditorSaveRequest): Promise<DocumentEditorSaveResult>;
	pdfApply(request: PdfApplyRequest): Promise<PdfApplyResult>;
	pdfExtract(request: PdfExtractRequest): Promise<PdfExtractResult>;
	pdfRestore(snapshotId: string): Promise<PdfRestoreResult>;
	aiStart(runId: string, request: DocumentEditRequest, capture?: DocumentEditorAiCapture): Promise<{ readonly changed: boolean }>;
	aiCancel(runId: string): Promise<void>;
	aiUndo(runId: string): Promise<boolean>;
	onAiEvent(listener: (event: DocumentEditEvent) => void): () => void;
}

export function isDocumentEditorSaveRequest(value: unknown): value is DocumentEditorSaveRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.path !== "string" || candidate.path.length === 0) return false;
	if (typeof candidate.text !== "string") return false;
	if (candidate.ending !== undefined && candidate.ending !== "LF" && candidate.ending !== "CRLF" && candidate.ending !== "CR") return false;
	if (candidate.expectedMtimeMs !== undefined && (typeof candidate.expectedMtimeMs !== "number" || !Number.isFinite(candidate.expectedMtimeMs))) return false;
	if (candidate.force !== undefined && typeof candidate.force !== "boolean") return false;
	return true;
}

export function isDocumentEditorAiCapture(value: unknown): value is DocumentEditorAiCapture {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	if (candidate.rect === undefined) return true;
	if (typeof candidate.rect !== "object" || candidate.rect === null || Array.isArray(candidate.rect)) return false;
	const rect = candidate.rect as Record<string, unknown>;
	return (
		typeof rect.x === "number" &&
		Number.isFinite(rect.x) &&
		typeof rect.y === "number" &&
		Number.isFinite(rect.y) &&
		typeof rect.width === "number" &&
		Number.isFinite(rect.width) &&
		rect.width > 0 &&
		typeof rect.height === "number" &&
		Number.isFinite(rect.height) &&
		rect.height > 0
	);
}

function isUnitFraction(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonNegativeInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isPdfEditOperation(value: unknown): value is PdfEditOperation {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const op = value as Record<string, unknown>;
	switch (op.kind) {
		case "stampImage":
			return (
				isNonNegativeInt(op.pageIndex) &&
				typeof op.pngDataUrl === "string" &&
				op.pngDataUrl.startsWith("data:image/png;base64,") &&
				op.pngDataUrl.length <= 8 * 1024 * 1024 &&
				isUnitFraction(op.x) &&
				isUnitFraction(op.y) &&
				typeof op.width === "number" &&
				Number.isFinite(op.width) &&
				op.width > 0 &&
				op.width <= 1 &&
				typeof op.height === "number" &&
				Number.isFinite(op.height) &&
				op.height > 0 &&
				op.height <= 1
			);
		case "rotatePage":
			return (
				isNonNegativeInt(op.pageIndex) &&
				(op.deltaDegrees === 90 || op.deltaDegrees === -90 || op.deltaDegrees === 180 || op.deltaDegrees === 270)
			);
		case "deletePage":
			return isNonNegativeInt(op.pageIndex);
		case "movePage":
			return isNonNegativeInt(op.fromIndex) && isNonNegativeInt(op.toIndex);
		case "cropPage":
			return (
				isNonNegativeInt(op.pageIndex) &&
				isUnitFraction(op.left) &&
				isUnitFraction(op.top) &&
				typeof op.width === "number" &&
				Number.isFinite(op.width) &&
				op.width > 0.02 &&
				op.width <= 1 &&
				typeof op.height === "number" &&
				Number.isFinite(op.height) &&
				op.height > 0.02 &&
				op.height <= 1 &&
				op.left + op.width <= 1.001 &&
				op.top + op.height <= 1.001
			);
		default:
			return false;
	}
}

export function isPdfApplyRequest(value: unknown): value is PdfApplyRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const req = value as Record<string, unknown>;
	if (typeof req.path !== "string" || req.path.length === 0) return false;
	if (!Array.isArray(req.operations) || req.operations.length === 0 || req.operations.length > 50) return false;
	if (!req.operations.every(isPdfEditOperation)) return false;
	if (req.expectedMtimeMs !== undefined && (typeof req.expectedMtimeMs !== "number" || !Number.isFinite(req.expectedMtimeMs))) return false;
	if (req.force !== undefined && typeof req.force !== "boolean") return false;
	return true;
}

export function isPdfExtractRequest(value: unknown): value is PdfExtractRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const req = value as Record<string, unknown>;
	if (typeof req.path !== "string" || req.path.length === 0) return false;
	if (!Array.isArray(req.pages) || req.pages.length === 0 || req.pages.length > 2000) return false;
	return req.pages.every((p) => typeof p === "number" && Number.isInteger(p) && p >= 1);
}

/** Re-export for consumers that want editability checks without importing preview internals directly. */
export { documentEditMode, type DocumentEditEvent, type DocumentEditMode, type DocumentEditRequest };
