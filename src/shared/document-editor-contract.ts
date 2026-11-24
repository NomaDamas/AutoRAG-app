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
	aiStart: "documentEditor:aiStart",
	aiCancel: "documentEditor:aiCancel",
	aiUndo: "documentEditor:aiUndo",
	aiEvent: "documentEditor:aiEvent",
} as const;

/**
 * Which editor surface a file gets inside a Document Editor tab:
 * - `wysiwyg`: TipTap rich-text WYSIWYG with Markdown/HTML/source toggle (`.md`, `.markdown`, `.mdx`, `.html`, `.htm`, `.xhtml`, `.txt`, `.text`).
 * - `code`: Monospace text/code editor with line numbers and syntax preview (code, JSON, YAML, CSV/TSV, logs, configs).
 * - `package`: Visual preview + mark-up canvas + AI in-place editing (Office Open XML, HWP/HWPX, OpenDocument).
 */
export type DocumentEditorSurface = "wysiwyg" | "code" | "package";

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
	const mode = documentEditMode(ext);
	if (mode === null) return null;
	if (mode === "package") return "package";
	if (wysiwygFormatForExtension(ext) !== null) return "wysiwyg";
	const viewer = viewerForExtension(ext);
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

export type DocumentEditorLoad = DocumentEditorTextPayload | DocumentEditorPackagePayload;

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

/** Re-export for consumers that want editability checks without importing preview internals directly. */
export { documentEditMode, type DocumentEditEvent, type DocumentEditMode, type DocumentEditRequest };
