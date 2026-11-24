/**
 * Mark-up-and-edit in Quick Look: the person draws on the shown document (a pen
 * stroke, a box, an underline), writes what should change, and the
 * `document-edit` helper agent edits that one file in place.
 *
 * Marks are stored relative to the box they were drawn on (a page card's
 * `[data-page]` element, or the document's scrolled content when it has no
 * pages), as fractions of its width and height, so they stay on the same spot
 * while the panel scrolls or zooms.
 */
import { viewerForExtension } from "./registry";

export const ANNOTATION_TOOLS = ["pen", "box", "underline"] as const;
export type AnnotationTool = (typeof ANNOTATION_TOOLS)[number];

export interface Point {
	readonly x: number;
	readonly y: number;
}

export interface Box {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

export interface Bounds {
	readonly left: number;
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
}

export interface AnnotationMark {
	readonly tool: AnnotationTool;
	/** 1-based page or slide the mark was drawn on; null for a document without pages. */
	readonly page: number | null;
	/** The stroke, as fractions of the box it was drawn on (see the file comment). */
	readonly points: readonly Point[];
	/** The text the page shows under the mark; empty when the page is a picture. */
	readonly text: string;
}

export interface DocumentEditRequest {
	readonly path: string;
	readonly instruction: string;
	readonly marks: readonly AnnotationMark[];
}

export type DocumentEditEvent =
	| { readonly type: "started"; readonly runId: string; readonly path: string }
	| { readonly type: "progress"; readonly runId: string; readonly text: string }
	| { readonly type: "draft"; readonly runId: string; readonly text: string }
	| { readonly type: "done"; readonly runId: string; readonly path: string; readonly changed: boolean; readonly reply: string }
	| { readonly type: "error"; readonly runId: string; readonly message: string }
	| { readonly type: "cancelled"; readonly runId: string }
	| { readonly type: "undone"; readonly runId: string; readonly path: string };

/**
 * How the agent may change a file: `text` edits the file itself; `package`
 * (Office Open XML, HWP/HWPX, OpenDocument) also gets a shell in a scratch
 * folder to unpack, edit, and repack it. Null: no pen button.
 */
export type DocumentEditMode = "text" | "package";

const PACKAGE_EXTENSIONS: Readonly<Record<string, true>> = Object.fromEntries(
	["docx", "docm", "dotx", "pptx", "pptm", "potx", "ppsx", "xlsx", "xlsm", "hwp", "hwpx", "odt", "odp", "ods"].map((ext) => [ext, true]),
);
const TEXT_VIEWERS: Readonly<Record<string, true>> = { text: true, markdown: true, html: true };
const TEXT_EXTENSIONS: Readonly<Record<string, true>> = { csv: true, tsv: true };

export function documentEditMode(ext: string): DocumentEditMode | null {
	const lower = ext.toLowerCase();
	if (lower === "") return null;
	if (PACKAGE_EXTENSIONS[lower] === true) return "package";
	if (TEXT_EXTENSIONS[lower] === true || TEXT_VIEWERS[viewerForExtension(lower)] === true) return "text";
	return null;
}

export const MAX_INSTRUCTION = 8000;
export const MAX_MARKS = 100;
const MAX_POINTS = 2000;
const MAX_MARK_TEXT = 2000;

export function toAnchor(point: Point, box: Box): Point {
	return { x: (point.x - box.left) / box.width, y: (point.y - box.top) / box.height };
}

export function fromAnchor(point: Point, box: Box): Point {
	return { x: box.left + point.x * box.width, y: box.top + point.y * box.height };
}

export function markBounds(points: readonly Point[]): Bounds {
	let left = Number.POSITIVE_INFINITY;
	let top = Number.POSITIVE_INFINITY;
	let right = Number.NEGATIVE_INFINITY;
	let bottom = Number.NEGATIVE_INFINITY;
	for (const { x, y } of points) {
		left = Math.min(left, x);
		top = Math.min(top, y);
		right = Math.max(right, x);
		bottom = Math.max(bottom, y);
	}
	return { left, top, right, bottom };
}

export type MarkShape =
	| { readonly kind: "rect"; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
	| { readonly kind: "line"; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }
	| { readonly kind: "path"; readonly d: string };

/** The SVG shape of a mark, from its points in screen pixels. */
export function markShape(tool: AnnotationTool, points: readonly Point[]): MarkShape {
	const first = points[0] ?? { x: 0, y: 0 };
	const last = points[points.length - 1] ?? first;
	if (tool === "box") {
		return { kind: "rect", x: Math.min(first.x, last.x), y: Math.min(first.y, last.y), width: Math.abs(last.x - first.x), height: Math.abs(last.y - first.y) };
	}
	// An underline stays level with where it started, whatever the hand did.
	if (tool === "underline") return { kind: "line", x1: first.x, y1: first.y, x2: last.x, y2: first.y };
	return { kind: "path", d: points.map((point, index) => `${index === 0 ? "M" : "L"}${Math.round(point.x * 10) / 10} ${Math.round(point.y * 10) / 10}`).join("") };
}

/** The text a line sits under: an underline marks the line just above it. */
const UNDERLINE_REACH = 24;

/** The screen area whose text a mark covers, from the mark's screen bounds. */
export function textProbeRect(tool: AnnotationTool, bounds: Bounds): Bounds {
	if (tool === "underline") return { left: bounds.left, top: bounds.top - UNDERLINE_REACH, right: bounds.right, bottom: bounds.bottom + 2 };
	return bounds;
}

export function intersects(a: Bounds, b: Bounds): boolean {
	return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isFinitePoint(value: unknown): value is Point {
	const point = record(value);
	return point !== null && Number.isFinite(point.x) && Number.isFinite(point.y);
}

export function isAnnotationMark(value: unknown): value is AnnotationMark {
	const mark = record(value);
	if (mark === null) return false;
	if (!(ANNOTATION_TOOLS as readonly unknown[]).includes(mark.tool)) return false;
	if (!(mark.page === null || (Number.isInteger(mark.page) && (mark.page as number) > 0))) return false;
	if (typeof mark.text !== "string" || mark.text.length > MAX_MARK_TEXT) return false;
	const points = mark.points;
	return Array.isArray(points) && points.length > 0 && points.length <= MAX_POINTS && points.every(isFinitePoint);
}

export function isDocumentEditRequest(value: unknown): value is DocumentEditRequest {
	const request = record(value);
	if (request === null) return false;
	if (typeof request.path !== "string" || request.path === "") return false;
	if (typeof request.instruction !== "string" || request.instruction.trim() === "" || request.instruction.length > MAX_INSTRUCTION) return false;
	return Array.isArray(request.marks) && request.marks.length <= MAX_MARKS && request.marks.every(isAnnotationMark);
}

export function isDocumentEditEvent(value: unknown): value is DocumentEditEvent {
	const event = record(value);
	if (event === null || typeof event.runId !== "string") return false;
	switch (event.type) {
		case "started":
		case "undone":
			return typeof event.path === "string";
		case "progress":
		case "draft":
			return typeof event.text === "string";
		case "done":
			return typeof event.path === "string" && typeof event.changed === "boolean" && typeof event.reply === "string";
		case "error":
			return typeof event.message === "string";
		case "cancelled":
			return true;
		default:
			return false;
	}
}

const QUOTED_TEXT = 500;
const TOOL_PHRASE: Readonly<Record<AnnotationTool, string>> = { pen: "pen stroke over", box: "box around", underline: "underline under" };
const TOOL_NAME: Readonly<Record<AnnotationTool, string>> = { pen: "pen stroke", box: "box", underline: "underline" };

function percent(value: number): number {
	return Math.round(Math.min(1, Math.max(0, value)) * 100);
}

/** The marks as the agent reads them: page, kind, the text under each, and where it sits. */
export function describeMarks(marks: readonly AnnotationMark[]): string {
	if (marks.length === 0) return "(no marks; the instruction applies to the whole document)";
	return marks
		.map((mark, index) => {
			const where = mark.page === null ? "Document" : `Page ${mark.page}`;
			const text = mark.text.trim().replace(/\s+/gu, " ");
			const quoted = text.length > QUOTED_TEXT ? `${text.slice(0, QUOTED_TEXT)}…` : text;
			const what = quoted === "" ? `${TOOL_NAME[mark.tool]} (no text under it; see the screenshot)` : `${TOOL_PHRASE[mark.tool]} "${quoted}"`;
			const b = markBounds(mark.points);
			const area = `(x ${percent(b.left)}–${percent(b.right)}%, y ${percent(b.top)}–${percent(b.bottom)}% of the ${mark.page === null ? "document" : "page"})`;
			return `${index + 1}. ${where} — ${what} ${area}`;
		})
		.join("\n");
}
