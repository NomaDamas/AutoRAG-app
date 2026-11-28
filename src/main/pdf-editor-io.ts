import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import {
	degrees,
	LineCapStyle,
	PDFCheckBox,
	PDFDocument,
	PDFDropdown,
	PDFOptionList,
	type PDFPage,
	PDFRadioGroup,
	PDFTextField,
	rgb,
	StandardFonts,
} from "pdf-lib";
import { imageSize } from "./attachment-images";
import type {
	DocumentEditorPdfPayload,
	PdfApplyRequest,
	PdfApplyResult,
	PdfBlankPageSize,
	PdfChangedEvent,
	PdfEditOperation,
	PdfExtractRequest,
	PdfExtractResult,
	PdfFormField,
	PdfFormSaveRequest,
	PdfMetadata,
	PdfPageNumberFormat,
	PdfPageNumberPosition,
	PdfRestoreResult,
	PdfSplitOutputFile,
	PdfSplitRequest,
	PdfSplitResult,
} from "../shared/document-editor-contract";

const execFileAsync = promisify(execFile);
const MAX_PDF_EDIT_BYTES = 128 * 1024 * 1024;
const MAX_SNAPSHOTS = 40;
const RENDER_DEFAULT_DPI = 144;
const RENDER_MIN_DPI = 72;
const RENDER_MAX_DPI = 220;
const RENDER_DEFAULT_MAX_EDGE = 1600;
const RENDER_TIMEOUT_MS = 30_000;
const A4_SIZE: readonly [number, number] = [595.28, 841.89];
const LETTER_SIZE: readonly [number, number] = [612, 792];

const JXA_RENDER_PDF_PAGE_SCRIPT = [
	'ObjC.import("PDFKit");',
	'ObjC.import("AppKit");',
	"function run(argv) {",
	"  const pdfPath = argv[0];",
	"  const pageIdx = parseInt(argv[1], 10);",
	"  const scale = parseFloat(argv[2]);",
	"  const outPath = argv[3];",
	"  const url = $.NSURL.fileURLWithPath(pdfPath);",
	"  const doc = $.PDFDocument.alloc.initWithURL(url);",
	'  if (!doc) throw new Error("Cannot open PDF");',
	"  const page = doc.pageAtIndex(pageIdx);",
	'  if (!page) throw new Error("Page out of range");',
	"  const bounds = page.boundsForBox($.kPDFDisplayBoxCropBox);",
	"  const rot = ((page.rotation % 360) + 360) % 360;",
	"  const swap = rot === 90 || rot === 270;",
	"  const w = Math.max(1, Math.round((swap ? bounds.size.height : bounds.size.width) * scale));",
	"  const h = Math.max(1, Math.round((swap ? bounds.size.width : bounds.size.height) * scale));",
	"  const img = page.thumbnailOfSizeForBox($.NSMakeSize(w, h), $.kPDFDisplayBoxCropBox);",
	"  const tiff = img.TIFFRepresentation;",
	"  const rep = $.NSBitmapImageRep.imageRepWithData(tiff);",
	"  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));",
	"  if (!png.writeToFileAtomically(outPath, true)) throw new Error(\"Failed to write rendered PNG\");",
	'  return w + "x" + h;',
	"}",
].join("\n");

async function firstAvailableBinary(candidates: readonly string[]): Promise<string | null> {
	for (const candidate of candidates) {
		if (candidate.includes("/") || candidate.includes("\\")) {
			try {
				await access(candidate);
				return candidate;
			} catch {
				// Not present at absolute path
			}
		} else {
			try {
				await execFileAsync(process.platform === "win32" ? "where" : "which", [candidate], { timeout: 3_000 });
				return candidate;
			} catch {
				// Not on PATH
			}
		}
	}
	return null;
}

async function rasterizePdfPage(pdfPath: string, pageNumber: number, dpi: number, workDir: string): Promise<Buffer> {
	const errors: string[] = [];

	// 1. Poppler pdftoppm (fast, accurate across macOS / Linux / Windows when installed)
	const pdftoppm = await firstAvailableBinary(
		process.platform === "darwin"
			? ["pdftoppm", "/opt/homebrew/bin/pdftoppm", "/usr/local/bin/pdftoppm"]
			: process.platform === "win32"
				? ["pdftoppm.exe", "pdftoppm"]
				: ["pdftoppm", "/usr/bin/pdftoppm", "/usr/local/bin/pdftoppm"],
	);
	if (pdftoppm !== null) {
		const outBase = join(workDir, `page-${pageNumber}`);
		const outPng = `${outBase}.png`;
		try {
			await execFileAsync(
				pdftoppm,
				["-png", "-r", String(dpi), "-f", String(pageNumber), "-l", String(pageNumber), "-singlefile", pdfPath, outBase],
				{ timeout: RENDER_TIMEOUT_MS },
			);
			return await readFile(outPng);
		} catch (error) {
			errors.push(`pdftoppm: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// 2. macOS built-in Quartz / PDFKit via JXA (zero external dependencies on every Mac)
	if (process.platform === "darwin") {
		const outPng = join(workDir, `jxa-page-${pageNumber}.png`);
		try {
			const scale = Number((dpi / 72).toFixed(4));
			await execFileAsync(
				"/usr/bin/osascript",
				["-l", "JavaScript", "-e", JXA_RENDER_PDF_PAGE_SCRIPT, pdfPath, String(pageNumber - 1), String(scale), outPng],
				{ timeout: RENDER_TIMEOUT_MS },
			);
			return await readFile(outPng);
		} catch (error) {
			errors.push(`PDFKit: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// 3. MuPDF mutool fallback (cross-platform when installed)
	const mutool = await firstAvailableBinary(
		process.platform === "darwin"
			? ["mutool", "/opt/homebrew/bin/mutool", "/usr/local/bin/mutool"]
			: process.platform === "win32"
				? ["mutool.exe", "mutool"]
				: ["mutool", "/usr/bin/mutool"],
	);
	if (mutool !== null) {
		const outPng = join(workDir, `mutool-page-${pageNumber}.png`);
		try {
			await execFileAsync(mutool, ["draw", "-F", "png", "-r", String(dpi), "-o", outPng, pdfPath, String(pageNumber)], {
				timeout: RENDER_TIMEOUT_MS,
			});
			return await readFile(outPng);
		} catch (error) {
			errors.push(`mutool: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	throw new Error(
		errors.length > 0
			? `Could not render PDF page ${pageNumber} to PNG (${errors.join("; ")}).`
			: `No PDF rasterizer (pdftoppm, PDFKit, or mutool) is available to render page ${pageNumber}.`,
	);
}

interface SnapshotRecord {
	readonly id: string;
	readonly path: string;
	readonly backupPath: string;
}

function assertPdfPath(filePath: string): void {
	if (!isAbsolute(filePath) || filePath.includes("\0")) {
		throw new Error("PDF editor requires an absolute file path.");
	}
	if (extname(filePath).toLowerCase() !== ".pdf") {
		throw new Error("Target file must be a .pdf document.");
	}
}

async function writeAtomic(filePath: string, bytes: Uint8Array): Promise<void> {
	const dir = dirname(filePath);
	const tmp = join(dir, `.dazzi-pdf-${randomBytes(6).toString("hex")}.tmp`);
	try {
		await writeFile(tmp, bytes);
		await rename(tmp, filePath);
	} catch (error) {
		await rm(tmp, { force: true }).catch(() => undefined);
		await writeFile(filePath, bytes).catch(() => {
			throw error;
		});
	}
}

function parseHexRgb(hex: string): ReturnType<typeof rgb> {
	const clean = hex.replace(/^#/, "");
	const r = Number.parseInt(clean.slice(0, 2), 16) / 255;
	const g = Number.parseInt(clean.slice(2, 4), 16) / 255;
	const b = Number.parseInt(clean.slice(4, 6), 16) / 255;
	return rgb(
		Number.isFinite(r) ? r : 0,
		Number.isFinite(g) ? g : 0,
		Number.isFinite(b) ? b : 0,
	);
}

/**
 * Visible page box in PDF coordinates (origin bottom-left).
 * Falls back from CropBox to MediaBox when CropBox is absent.
 */
function visibleBox(page: PDFPage): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
	const crop = page.getCropBox();
	if (crop.width > 0 && crop.height > 0) return crop;
	return page.getMediaBox();
}

/**
 * Maps a top-left-origin normalized point `(x, y)` in the viewer's visual
 * orientation into PDF user-space coordinates on `page`.
 */
function visualPointToPdfCoords(page: PDFPage, pt: { readonly x: number; readonly y: number }): { readonly x: number; readonly y: number } {
	const box = visibleBox(page);
	const angle = ((page.getRotation().angle % 360) + 360) % 360;
	if (angle === 0) {
		return {
			x: box.x + pt.x * box.width,
			y: box.y + (1 - pt.y) * box.height,
		};
	}
	if (angle === 90) {
		return {
			x: box.x + pt.y * box.width,
			y: box.y + pt.x * box.height,
		};
	}
	if (angle === 180) {
		return {
			x: box.x + (1 - pt.x) * box.width,
			y: box.y + pt.y * box.height,
		};
	}
	return {
		x: box.x + (1 - pt.y) * box.width,
		y: box.y + (1 - pt.x) * box.height,
	};
}

/**
 * Maps a top-left-origin normalized rectangle `(x, y, width, height)` in the
 * viewer's visual orientation into PDF user-space coordinates on `page`.
 */
function visualRectToPdfCoords(
	page: PDFPage,
	rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
	const box = visibleBox(page);
	const angle = ((page.getRotation().angle % 360) + 360) % 360;
	if (angle === 0) {
		return {
			x: box.x + rect.x * box.width,
			y: box.y + (1 - rect.y - rect.height) * box.height,
			width: rect.width * box.width,
			height: rect.height * box.height,
		};
	}
	if (angle === 90) {
		// Rotated 90° clockwise: visual top-left is user-space bottom-left.
		return {
			x: box.x + rect.y * box.width,
			y: box.y + rect.x * box.height,
			width: rect.height * box.width,
			height: rect.width * box.height,
		};
	}
	if (angle === 180) {
		return {
			x: box.x + (1 - rect.x - rect.width) * box.width,
			y: box.y + rect.y * box.height,
			width: rect.width * box.width,
			height: rect.height * box.height,
		};
	}
	// 270° clockwise
	return {
		x: box.x + (1 - rect.y - rect.height) * box.width,
		y: box.y + (1 - rect.x - rect.width) * box.height,
		width: rect.height * box.width,
		height: rect.width * box.height,
	};
}

function decodePngDataUrl(dataUrl: string): Buffer {
	const prefix = "data:image/png;base64,";
	if (!dataUrl.startsWith(prefix)) {
		throw new Error("Stamp image must be a base64 PNG data URL.");
	}
	return Buffer.from(dataUrl.slice(prefix.length), "base64");
}

function drawVisualImage(
	page: PDFPage,
	image: Awaited<ReturnType<PDFDocument["embedPng"]>>,
	rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
	opacity?: number,
): void {
	const angle = ((page.getRotation().angle % 360) + 360) % 360;
	const coords = visualRectToPdfCoords(page, rect);
	const opacityOpt = opacity === undefined ? {} : { opacity };
	if (angle === 0) {
		page.drawImage(image, { ...coords, ...opacityOpt });
	} else if (angle === 90) {
		page.drawImage(image, {
			x: coords.x + coords.width,
			y: coords.y,
			width: coords.height,
			height: coords.width,
			rotate: degrees(90),
			...opacityOpt,
		});
	} else if (angle === 180) {
		page.drawImage(image, {
			x: coords.x + coords.width,
			y: coords.y + coords.height,
			width: coords.width,
			height: coords.height,
			rotate: degrees(180),
			...opacityOpt,
		});
	} else {
		page.drawImage(image, {
			x: coords.x,
			y: coords.y + coords.height,
			width: coords.height,
			height: coords.width,
			rotate: degrees(270),
			...opacityOpt,
		});
	}
}

function formatPageNumberText(format: PdfPageNumberFormat, num: number, total: number): string {
	if (format === "ofTotal") return `${num} / ${total}`;
	if (format === "dash") return `- ${num} -`;
	return String(num);
}

/** Keeps characters representable in WinAnsi (StandardFonts.Helvetica) for header/footer fallback safety. */
function toWinAnsiSafe(text: string): string {
	return text.replace(/[^\x20-\x7E\xA0-\xFF]/g, " ");
}

function blankPageDimensions(pdfDoc: PDFDocument, insertAtIndex: number, size: PdfBlankPageSize | undefined): [number, number] {
	if (size === "a4") return [A4_SIZE[0], A4_SIZE[1]];
	if (size === "letter") return [LETTER_SIZE[0], LETTER_SIZE[1]];
	const count = pdfDoc.getPageCount();
	if (count === 0) return [A4_SIZE[0], A4_SIZE[1]];
	const refIdx = Math.min(count - 1, Math.max(0, insertAtIndex > 0 ? insertAtIndex - 1 : 0));
	const { width, height } = pdfDoc.getPage(refIdx).getSize();
	return [width, height];
}

function resolveTargetPages(count: number, indices: readonly number[] | undefined): number[] {
	if (indices === undefined) {
		return Array.from({ length: count }, (_v, i) => i);
	}
	const unique: number[] = [];
	const seen = new Set<number>();
	for (const idx of indices) {
		if (idx < 0 || idx >= count) throw new Error(`Page index ${idx} out of range.`);
		if (!seen.has(idx)) {
			seen.add(idx);
			unique.push(idx);
		}
	}
	return unique;
}

/**
 * Parses a 1-based range string like `"1-3, 4-5, 7"` into arrays of 1-based page numbers.
 */
export function parseSplitRanges(spec: string, totalPages: number): number[][] {
	const groups: number[][] = [];
	const tokens = spec
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (tokens.length === 0) throw new Error("Page ranges cannot be empty.");
	for (const token of tokens) {
		const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(token);
		if (rangeMatch !== null) {
			const start = Number.parseInt(rangeMatch[1]!, 10);
			const end = Number.parseInt(rangeMatch[2]!, 10);
			if (start < 1 || end < 1 || start > totalPages || end > totalPages || start > end) {
				throw new Error(`Invalid page range "${token}" (document has ${totalPages} pages).`);
			}
			const pages: number[] = [];
			for (let p = start; p <= end; p += 1) pages.push(p);
			groups.push(pages);
			continue;
		}
		const singleMatch = /^(\d+)$/.exec(token);
		if (singleMatch !== null) {
			const p = Number.parseInt(singleMatch[1]!, 10);
			if (p < 1 || p > totalPages) {
				throw new Error(`Page ${p} is out of range (1..${totalPages}).`);
			}
			groups.push([p]);
			continue;
		}
		throw new Error(`Invalid page range syntax: "${token}". Use formats like "1-3, 4-5, 7".`);
	}
	return groups;
}

async function applyOperation(pdfDoc: PDFDocument, op: PdfEditOperation): Promise<void> {
	const count = pdfDoc.getPageCount();
	switch (op.kind) {
		case "stampImage": {
			if (op.pageIndex < 0 || op.pageIndex >= count) throw new Error(`Page index ${op.pageIndex} out of range.`);
			const page = pdfDoc.getPage(op.pageIndex);
			const image = await pdfDoc.embedPng(decodePngDataUrl(op.pngDataUrl));
			drawVisualImage(page, image, { x: op.x, y: op.y, width: op.width, height: op.height }, op.opacity);
			return;
		}
		case "rotatePage": {
			if (op.pageIndex < 0 || op.pageIndex >= count) throw new Error(`Page index ${op.pageIndex} out of range.`);
			const page = pdfDoc.getPage(op.pageIndex);
			const next = (((page.getRotation().angle + op.deltaDegrees) % 360) + 360) % 360;
			page.setRotation(degrees(next));
			return;
		}
		case "deletePage": {
			if (count <= 1) throw new Error("Cannot delete the last remaining page of a PDF.");
			if (op.pageIndex < 0 || op.pageIndex >= count) throw new Error(`Page index ${op.pageIndex} out of range.`);
			pdfDoc.removePage(op.pageIndex);
			return;
		}
		case "movePage": {
			if (op.fromIndex < 0 || op.fromIndex >= count || op.toIndex < 0 || op.toIndex >= count) {
				throw new Error("Page move index out of range.");
			}
			if (op.fromIndex === op.toIndex) return;
			const page = pdfDoc.getPage(op.fromIndex);
			pdfDoc.removePage(op.fromIndex);
			pdfDoc.insertPage(op.toIndex, page);
			return;
		}
		case "cropPage": {
			if (op.pageIndex < 0 || op.pageIndex >= count) throw new Error(`Page index ${op.pageIndex} out of range.`);
			const page = pdfDoc.getPage(op.pageIndex);
			const coords = visualRectToPdfCoords(page, {
				x: op.left,
				y: op.top,
				width: op.width,
				height: op.height,
			});
			page.setCropBox(coords.x, coords.y, coords.width, coords.height);
			return;
		}
		case "duplicatePage": {
			if (op.pageIndex < 0 || op.pageIndex >= count) throw new Error(`Page index ${op.pageIndex} out of range.`);
			const [copied] = await pdfDoc.copyPages(pdfDoc, [op.pageIndex]);
			if (copied !== undefined) {
				pdfDoc.insertPage(op.pageIndex + 1, copied);
			}
			return;
		}
		case "insertBlankPage": {
			const idx = Math.min(count, Math.max(0, op.insertAtIndex));
			const dims = blankPageDimensions(pdfDoc, idx, op.size);
			pdfDoc.insertPage(idx, dims);
			return;
		}
		case "mergePdfs": {
			let insertIdx = op.insertAtIndex === undefined ? count : Math.min(count, Math.max(0, op.insertAtIndex));
			for (const srcPath of op.sourcePaths) {
				assertPdfPath(srcPath);
				const srcInfo = await stat(srcPath);
				if (!srcInfo.isFile()) throw new Error(`${srcPath} is not a file.`);
				if (srcInfo.size > MAX_PDF_EDIT_BYTES) throw new Error(`${basename(srcPath)} is too large to merge.`);
				const srcBytes = await readFile(srcPath);
				const srcDoc = await PDFDocument.load(srcBytes, { ignoreEncryption: false });
				const copied = await pdfDoc.copyPages(srcDoc, srcDoc.getPageIndices());
				for (const page of copied) {
					pdfDoc.insertPage(insertIdx, page);
					insertIdx += 1;
				}
			}
			return;
		}
		case "highlightRect": {
			if (op.pageIndex < 0 || op.pageIndex >= count) throw new Error(`Page index ${op.pageIndex} out of range.`);
			const page = pdfDoc.getPage(op.pageIndex);
			const coords = visualRectToPdfCoords(page, { x: op.x, y: op.y, width: op.width, height: op.height });
			page.drawRectangle({
				x: coords.x,
				y: coords.y,
				width: coords.width,
				height: coords.height,
				color: parseHexRgb(op.color),
				opacity: op.opacity ?? 0.35,
			});
			return;
		}
		case "redactRect": {
			if (op.pageIndex < 0 || op.pageIndex >= count) throw new Error(`Page index ${op.pageIndex} out of range.`);
			const page = pdfDoc.getPage(op.pageIndex);
			const coords = visualRectToPdfCoords(page, { x: op.x, y: op.y, width: op.width, height: op.height });
			page.drawRectangle({
				x: coords.x,
				y: coords.y,
				width: coords.width,
				height: coords.height,
				color: parseHexRgb(op.color),
				opacity: 1,
			});
			return;
		}
		case "drawShape": {
			if (op.pageIndex < 0 || op.pageIndex >= count) throw new Error(`Page index ${op.pageIndex} out of range.`);
			const page = pdfDoc.getPage(op.pageIndex);
			const strokeColor = parseHexRgb(op.strokeColor);
			const opacity = op.opacity ?? 1;
			if (op.shape === "rect" || op.shape === "ellipse") {
				const left = Math.min(op.x1, op.x2);
				const top = Math.min(op.y1, op.y2);
				const width = Math.max(0.002, Math.abs(op.x2 - op.x1));
				const height = Math.max(0.002, Math.abs(op.y2 - op.y1));
				const coords = visualRectToPdfCoords(page, { x: left, y: top, width, height });
				const fillOpt = op.fillColor === undefined ? {} : { color: parseHexRgb(op.fillColor), opacity };
				if (op.shape === "rect") {
					page.drawRectangle({
						x: coords.x,
						y: coords.y,
						width: coords.width,
						height: coords.height,
						borderColor: strokeColor,
						borderWidth: op.strokeWidthPt,
						borderOpacity: opacity,
						...fillOpt,
					});
				} else {
					page.drawEllipse({
						x: coords.x + coords.width / 2,
						y: coords.y + coords.height / 2,
						xScale: coords.width / 2,
						yScale: coords.height / 2,
						borderColor: strokeColor,
						borderWidth: op.strokeWidthPt,
						borderOpacity: opacity,
						...fillOpt,
					});
				}
				return;
			}
			const start = visualPointToPdfCoords(page, { x: op.x1, y: op.y1 });
			const end = visualPointToPdfCoords(page, { x: op.x2, y: op.y2 });
			const dx = end.x - start.x;
			const dy = end.y - start.y;
			const len = Math.hypot(dx, dy);
			if (op.shape === "arrow" && len > 2) {
				// A filled triangular head; the shaft stops inside its base so the stroke never pokes through the tip.
				const angle = Math.atan2(dy, dx);
				const headLen = Math.min(len * 0.4, Math.max(9, op.strokeWidthPt * 4.2));
				const halfWidth = Math.max(4.5, headLen * 0.55);
				const base = { x: end.x - headLen * Math.cos(angle), y: end.y - headLen * Math.sin(angle) };
				const nx = -Math.sin(angle) * halfWidth;
				const ny = Math.cos(angle) * halfWidth;
				const shaftEnd = { x: end.x - headLen * 0.85 * Math.cos(angle), y: end.y - headLen * 0.85 * Math.sin(angle) };
				page.drawLine({ start, end: shaftEnd, thickness: op.strokeWidthPt, color: strokeColor, opacity, lineCap: LineCapStyle.Round });
				// drawSvgPath maps path (sx, sy) to page (x + sx, y - sy): pass PDF coordinates with y negated.
				const pts = [end, { x: base.x + nx, y: base.y + ny }, { x: base.x - nx, y: base.y - ny }];
				page.drawSvgPath(`M ${pts.map((pt) => `${pt.x} ${-pt.y}`).join(" L ")} Z`, { x: 0, y: 0, color: strokeColor, opacity });
				return;
			}
			page.drawLine({ start, end, thickness: op.strokeWidthPt, color: strokeColor, opacity, lineCap: LineCapStyle.Round });
			return;
		}
		case "freehandPath": {
			if (op.pageIndex < 0 || op.pageIndex >= count) throw new Error(`Page index ${op.pageIndex} out of range.`);
			const page = pdfDoc.getPage(op.pageIndex);
			const strokeColor = parseHexRgb(op.strokeColor);
			const opacity = op.opacity ?? 1;
			let prev = visualPointToPdfCoords(page, op.points[0]!);
			for (let i = 1; i < op.points.length; i += 1) {
				const curr = visualPointToPdfCoords(page, op.points[i]!);
				page.drawLine({
					start: prev,
					end: curr,
					thickness: op.strokeWidthPt,
					color: strokeColor,
					opacity,
					lineCap: LineCapStyle.Round,
				});
				prev = curr;
			}
			return;
		}
		case "addText": {
			if (op.pageIndex < 0 || op.pageIndex >= count) throw new Error(`Page index ${op.pageIndex} out of range.`);
			const page = pdfDoc.getPage(op.pageIndex);
			const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
			const fontSize = op.fontSize ?? 14;
			const color = parseHexRgb(op.color ?? "#1D1D1F");
			const lines = op.text.replace(/\r\n?/g, "\n").split("\n");
			const lineHeight = fontSize * 1.3;
			const anchor = visualPointToPdfCoords(page, { x: op.x, y: op.y });
			lines.forEach((rawLine, idx) => {
				const safe = toWinAnsiSafe(rawLine);
				if (safe.length === 0) return;
				page.drawText(safe, {
					x: anchor.x,
					y: anchor.y - fontSize - idx * lineHeight,
					size: fontSize,
					font,
					color,
				});
			});
			return;
		}
		case "addTextWatermark": {
			const targets = resolveTargetPages(count, op.pageIndices);
			const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
			const safe = toWinAnsiSafe(op.text.trim());
			if (safe.length === 0) throw new Error("Watermark text must contain printable ASCII/Latin characters (use PNG watermark for CJK).");
			const fontSize = op.fontSize ?? 54;
			const opacity = op.opacity ?? 0.22;
			const angleDeg = op.angleDegrees ?? 35;
			const color = parseHexRgb(op.color ?? "#64748B");
			const textW = font.widthOfTextAtSize(safe, fontSize);
			const rad = (angleDeg * Math.PI) / 180;
			for (const idx of targets) {
				const page = pdfDoc.getPage(idx);
				const box = visibleBox(page);
				const cx = box.x + box.width / 2;
				const cy = box.y + box.height / 2;
				page.drawText(safe, {
					x: cx - (textW / 2) * Math.cos(rad),
					y: cy - (textW / 2) * Math.sin(rad),
					size: fontSize,
					font,
					color,
					opacity,
					rotate: degrees(angleDeg),
				});
			}
			return;
		}
		case "addWatermark": {
			const targets = resolveTargetPages(count, op.pageIndices);
			const image = await pdfDoc.embedPng(decodePngDataUrl(op.pngDataUrl));
			const imgAspect = image.width / Math.max(1, image.height);
			for (const idx of targets) {
				const page = pdfDoc.getPage(idx);
				const box = visibleBox(page);
				const angle = ((page.getRotation().angle % 360) + 360) % 360;
				const visW = angle === 90 || angle === 270 ? box.height : box.width;
				const visH = angle === 90 || angle === 270 ? box.width : box.height;
				const pageAspect = visW / Math.max(1, visH);
				let fracW = op.scale;
				let fracH = (fracW * pageAspect) / Math.max(0.1, imgAspect);
				if (fracH > op.scale) {
					fracH = op.scale;
					fracW = (fracH * imgAspect) / Math.max(0.1, pageAspect);
				}
				fracW = Math.min(0.95, Math.max(0.05, fracW));
				fracH = Math.min(0.95, Math.max(0.05, fracH));
				drawVisualImage(
					page,
					image,
					{
						x: (1 - fracW) / 2,
						y: (1 - fracH) / 2,
						width: fracW,
						height: fracH,
					},
					op.opacity,
				);
			}
			return;
		}
		case "addPageNumbers": {
			const targets = resolveTargetPages(count, op.pageIndices);
			const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
			const color = parseHexRgb(op.color);
			const totalDisplay = op.startNumber + targets.length - 1;
			// A rendered line image (any script) wins over the WinAnsi-only text fallback.
			const safeHeader = op.headerImage === undefined && op.headerText ? toWinAnsiSafe(op.headerText.trim()) : "";
			const safeFooter = op.footerImage === undefined && op.footerText ? toWinAnsiSafe(op.footerText.trim()) : "";
			const headerImage = op.headerImage === undefined ? undefined : await pdfDoc.embedPng(decodePngDataUrl(op.headerImage.pngDataUrl));
			const footerImage = op.footerImage === undefined ? undefined : await pdfDoc.embedPng(decodePngDataUrl(op.footerImage.pngDataUrl));
			const margin = 24;

			targets.forEach((pageIdx, offset) => {
				const page = pdfDoc.getPage(pageIdx);
				const box = visibleBox(page);
				const numText = formatPageNumberText(op.format, op.startNumber + offset, totalDisplay);
				const numWidth = font.widthOfTextAtSize(numText, op.fontSize);

				const isTop = op.position.startsWith("top-");
				const isLeft = op.position.endsWith("-left");
				const isRight = op.position.endsWith("-right");

				const y = isTop ? box.y + box.height - margin - op.fontSize : box.y + margin;
				const x = isLeft
					? box.x + margin
					: isRight
						? box.x + box.width - margin - numWidth
						: box.x + (box.width - numWidth) / 2;

				page.drawText(numText, { x, y, size: op.fontSize, font, color });

				if (safeHeader.length > 0) {
					const hw = font.widthOfTextAtSize(safeHeader, op.fontSize);
					const hx = isTop && !isLeft ? box.x + margin : box.x + (box.width - hw) / 2;
					const hy = box.y + box.height - margin - op.fontSize;
					page.drawText(safeHeader, { x: hx, y: hy, size: op.fontSize, font, color });
				}
				if (safeFooter.length > 0) {
					const fw = font.widthOfTextAtSize(safeFooter, op.fontSize);
					const fx = !isTop && !isLeft ? box.x + margin : box.x + (box.width - fw) / 2;
					const fy = box.y + margin;
					page.drawText(safeFooter, { x: fx, y: fy, size: op.fontSize, font, color });
				}
				// Line images sit where the text would, centred on the same baseline band.
				if (headerImage !== undefined && op.headerImage !== undefined) {
					const { widthPt, heightPt } = op.headerImage;
					const hx = isTop && !isLeft ? box.x + margin : box.x + (box.width - widthPt) / 2;
					const centre = box.y + box.height - margin - op.fontSize + op.fontSize * 0.35;
					page.drawImage(headerImage, { x: hx, y: centre - heightPt / 2, width: widthPt, height: heightPt });
				}
				if (footerImage !== undefined && op.footerImage !== undefined) {
					const { widthPt, heightPt } = op.footerImage;
					const fx = !isTop && !isLeft ? box.x + margin : box.x + (box.width - widthPt) / 2;
					const centre = box.y + margin + op.fontSize * 0.35;
					page.drawImage(footerImage, { x: fx, y: centre - heightPt / 2, width: widthPt, height: heightPt });
				}
			});
			return;
		}
		case "setMetadata": {
			pdfDoc.setTitle(op.metadata.title);
			pdfDoc.setAuthor(op.metadata.author);
			pdfDoc.setSubject(op.metadata.subject);
			const kw = op.metadata.keywords.trim();
			pdfDoc.setKeywords(kw.length > 0 ? [kw] : []);
			return;
		}
		case "flattenForm": {
			pdfDoc.getForm().flatten();
			return;
		}
	}
}

async function uniqueSiblingPath(sourcePath: string, suffix: string): Promise<string> {
	const dir = dirname(sourcePath);
	const stem = basename(sourcePath, extname(sourcePath));
	const baseCandidate = join(dir, `${stem}-${suffix}.pdf`);
	const exists = async (candidate: string): Promise<boolean> =>
		access(candidate).then(
			() => true,
			() => false,
		);
	if (!(await exists(baseCandidate))) return baseCandidate;
	for (let n = 2; n < 1000; n += 1) {
		const next = join(dir, `${stem}-${suffix} (${n}).pdf`);
		if (!(await exists(next))) return next;
	}
	return join(dir, `${stem}-${suffix}-${randomBytes(4).toString("hex")}.pdf`);
}

function pageRangeLabel(pages: readonly number[]): string {
	const unique = [...new Set(pages)].sort((a, b) => a - b);
	if (unique.length === 1) return `p${unique[0]}`;
	const first = unique[0]!;
	const last = unique.at(-1)!;
	return `p${first}-${last}`;
}

export interface PdfPageSummary {
	readonly pageNumber: number;
	readonly widthPt: number;
	readonly heightPt: number;
	readonly rotationDegrees: number;
	readonly cropBox: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface PdfInspection {
	readonly path: string;
	readonly pageCount: number;
	readonly size: number;
	readonly modifiedAt: string;
	readonly mtimeMs: number;
	readonly metadata: PdfMetadata;
	readonly pages: readonly PdfPageSummary[];
	readonly formFields: readonly PdfFormField[];
}

export interface PdfRenderPageOptions {
	readonly dpi?: number;
	readonly maxEdgePx?: number;
}

export interface PdfRenderedPage {
	readonly pageNumber: number;
	readonly pageIndex: number;
	readonly pageCount: number;
	readonly widthPt: number;
	readonly heightPt: number;
	readonly rotation: number;
	readonly imageWidthPx: number;
	readonly imageHeightPx: number;
	readonly png: Buffer;
}

export interface PdfEditorIo {
	open(filePath: string): Promise<DocumentEditorPdfPayload>;
	inspect(filePath: string): Promise<PdfInspection>;
	renderPageToPng(filePath: string, pageNumber: number, options?: PdfRenderPageOptions): Promise<PdfRenderedPage>;
	/** The page's visible size in points as the viewer shows it (crop box, rotation applied). */
	pageVisualSize(filePath: string, pageIndex: number): Promise<{ readonly widthPt: number; readonly heightPt: number; readonly pageCount: number }>;
	apply(request: PdfApplyRequest, source?: "human" | "ai"): Promise<PdfApplyResult>;
	extract(request: PdfExtractRequest): Promise<PdfExtractResult>;
	split(request: PdfSplitRequest): Promise<PdfSplitResult>;
	readMetadata(filePath: string): Promise<PdfMetadata>;
	readFormFields(filePath: string): Promise<readonly PdfFormField[]>;
	saveFormFields(request: PdfFormSaveRequest, source?: "human" | "ai"): Promise<PdfApplyResult>;
	restore(snapshotId: string): Promise<PdfRestoreResult>;
	/** Returns the raw bytes saved for a snapshot id (before that edit ran), or null if evicted. */
	readSnapshot(snapshotId: string): Promise<Buffer | null>;
	/** Run an exclusive read/write callback under the same per-file mutex used by apply/restore. */
	withLock<T>(filePath: string, fn: () => Promise<T>): Promise<T>;
	onChanged(listener: (event: PdfChangedEvent) => void): () => void;
	dispose(): Promise<void>;
}

/**
 * Main-process PDF editor service backed by `pdf-lib`.
 * Serializes mutations per PDF path so simultaneous human UI edits and AI agent
 * tool calls compose sequentially without overwriting or corrupting each other.
 * Emits `onChanged` events after every committed write or undo so open editor
 * tabs live-reload automatically.
 */
export function createPdfEditorIo(backupDir: string): PdfEditorIo {
	const snapshots = new Map<string, SnapshotRecord>();
	const locks = new Map<string, Promise<unknown>>();
	const listeners = new Set<(event: PdfChangedEvent) => void>();

	function emitChanged(event: PdfChangedEvent): void {
		for (const listener of listeners) {
			try {
				listener(event);
			} catch {
				// Never let a listener failure break PDF I/O.
			}
		}
	}

	/** Serializes all read-modify-write operations on the same PDF file path. */
	function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
		const prev = locks.get(filePath) ?? Promise.resolve();
		const next = prev.catch(() => undefined).then(fn);
		const tail = next.then(
			() => undefined,
			() => undefined,
		);
		locks.set(filePath, tail);
		void tail.finally(() => {
			if (locks.get(filePath) === tail) locks.delete(filePath);
		});
		return next;
	}

	async function recordSnapshot(filePath: string, originalBytes: Buffer): Promise<string> {
		await mkdir(backupDir, { recursive: true });
		const id = `pdf-snap-${Date.now()}-${randomBytes(4).toString("hex")}`;
		const backupPath = join(backupDir, `${id}.pdf`);
		await writeFile(backupPath, originalBytes);
		snapshots.set(id, { id, path: filePath, backupPath });
		while (snapshots.size > MAX_SNAPSHOTS) {
			const oldestKey = snapshots.keys().next().value;
			if (oldestKey === undefined) break;
			const oldest = snapshots.get(oldestKey);
			snapshots.delete(oldestKey);
			if (oldest !== undefined) await rm(oldest.backupPath, { force: true }).catch(() => undefined);
		}
		return id;
	}

	function extractFormFields(doc: PDFDocument): PdfFormField[] {
		const form = doc.getForm();
		const result: PdfFormField[] = [];
		for (const field of form.getFields()) {
			const name = field.getName();
			const readOnly = field.isReadOnly();
			if (field instanceof PDFTextField) {
				result.push({ name, kind: "text", value: field.getText() ?? "", readOnly });
			} else if (field instanceof PDFCheckBox) {
				result.push({ name, kind: "checkbox", value: field.isChecked(), readOnly });
			} else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
				const selected = field.getSelected();
				result.push({
					name,
					kind: "dropdown",
					value: selected[0] ?? "",
					options: field.getOptions(),
					readOnly,
				});
			} else if (field instanceof PDFRadioGroup) {
				result.push({
					name,
					kind: "radio",
					value: field.getSelected() ?? "",
					options: field.getOptions(),
					readOnly,
				});
			}
		}
		return result;
	}

	return {
		open: async (filePath) => {
			assertPdfPath(filePath);
			const info = await stat(filePath);
			if (!info.isFile()) throw new Error(`${filePath} is not a file.`);
			if (info.size > MAX_PDF_EDIT_BYTES) throw new Error("PDF is too large to edit here.");
			const bytes = await readFile(filePath);
			let pageCount = 0;
			let encrypted = false;
			try {
				const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
				pageCount = doc.getPageCount();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (/encrypt/iu.test(message)) {
					encrypted = true;
				} else {
					throw error;
				}
			}
			return {
				kind: "pdf",
				surface: "pdf",
				path: filePath,
				name: basename(filePath),
				ext: "pdf",
				size: info.size,
				modifiedAt: info.mtime.toISOString(),
				mtimeMs: info.mtimeMs,
				pageCount,
				encrypted,
			};
		},

		inspect: async (filePath) => {
			assertPdfPath(filePath);
			const info = await stat(filePath);
			if (!info.isFile()) throw new Error(`${filePath} is not a file.`);
			if (info.size > MAX_PDF_EDIT_BYTES) throw new Error("PDF is too large to inspect here.");
			const bytes = await readFile(filePath);
			const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
			const pages: PdfPageSummary[] = doc.getPages().map((page, idx) => {
				const { width, height } = page.getSize();
				const crop = visibleBox(page);
				return {
					pageNumber: idx + 1,
					widthPt: Math.round(width * 100) / 100,
					heightPt: Math.round(height * 100) / 100,
					rotationDegrees: ((page.getRotation().angle % 360) + 360) % 360,
					cropBox: {
						x: Math.round(crop.x * 100) / 100,
						y: Math.round(crop.y * 100) / 100,
						width: Math.round(crop.width * 100) / 100,
						height: Math.round(crop.height * 100) / 100,
					},
				};
			});
			return {
				path: filePath,
				pageCount: doc.getPageCount(),
				size: info.size,
				modifiedAt: info.mtime.toISOString(),
				mtimeMs: info.mtimeMs,
				metadata: {
					title: doc.getTitle() ?? "",
					author: doc.getAuthor() ?? "",
					subject: doc.getSubject() ?? "",
					keywords: (doc.getKeywords() ?? "").trim(),
				},
				pages,
				formFields: extractFormFields(doc),
			};
		},

		apply: (request, source = "human") =>
			withFileLock(request.path, async () => {
				assertPdfPath(request.path);
				const info = await stat(request.path);
				if (!info.isFile()) throw new Error(`${request.path} is not a file.`);
				if (info.size > MAX_PDF_EDIT_BYTES) throw new Error("PDF is too large to edit here.");
				if (request.force !== true && request.expectedMtimeMs !== undefined && Math.abs(info.mtimeMs - request.expectedMtimeMs) > 2) {
					return { ok: false, reason: "conflict", diskMtimeMs: info.mtimeMs };
				}
				const originalBytes = await readFile(request.path);
				const pdfDoc = await PDFDocument.load(originalBytes, { ignoreEncryption: false });
				for (const op of request.operations) {
					await applyOperation(pdfDoc, op);
				}
				const nextBytes = await pdfDoc.save();
				const snapshotId = await recordSnapshot(request.path, originalBytes);
				await writeAtomic(request.path, nextBytes);
				const saved = await stat(request.path);
				const pageCount = pdfDoc.getPageCount();
				const modifiedAt = saved.mtime.toISOString();
				emitChanged({
					path: request.path,
					size: saved.size,
					modifiedAt,
					mtimeMs: saved.mtimeMs,
					pageCount,
					source,
					snapshotId,
				});
				return {
					ok: true,
					size: saved.size,
					modifiedAt,
					mtimeMs: saved.mtimeMs,
					pageCount,
					snapshotId,
				};
			}),

		extract: (request) =>
			withFileLock(request.path, async () => {
				assertPdfPath(request.path);
				const info = await stat(request.path);
				if (!info.isFile()) throw new Error(`${request.path} is not a file.`);
				if (info.size > MAX_PDF_EDIT_BYTES) throw new Error("PDF is too large to extract from here.");
				const originalBytes = await readFile(request.path);
				const src = await PDFDocument.load(originalBytes, { ignoreEncryption: false });
				const total = src.getPageCount();
				const indices = request.pages.map((p) => p - 1);
				for (const idx of indices) {
					if (idx < 0 || idx >= total) throw new Error(`Page ${idx + 1} is out of range (1..${total}).`);
				}
				const out = await PDFDocument.create();
				const copied = await out.copyPages(src, indices);
				for (const page of copied) out.addPage(page);
				const outputPath = await uniqueSiblingPath(request.path, pageRangeLabel(request.pages));
				await writeAtomic(outputPath, await out.save());
				return {
					outputPath,
					name: basename(outputPath),
					pageCount: out.getPageCount(),
				};
			}),

		split: (request) =>
			withFileLock(request.path, async () => {
				assertPdfPath(request.path);
				const info = await stat(request.path);
				if (!info.isFile()) throw new Error(`${request.path} is not a file.`);
				if (info.size > MAX_PDF_EDIT_BYTES) throw new Error("PDF is too large to split here.");
				const originalBytes = await readFile(request.path);
				const src = await PDFDocument.load(originalBytes, { ignoreEncryption: false });
				const total = src.getPageCount();

				let groups: number[][];
				if (request.mode === "singlePages") {
					groups = Array.from({ length: total }, (_v, i) => [i + 1]);
				} else if (request.mode === "everyN") {
					const size = Math.max(1, request.chunkSize ?? 1);
					groups = [];
					for (let start = 1; start <= total; start += size) {
						const pages: number[] = [];
						for (let p = start; p < start + size && p <= total; p += 1) pages.push(p);
						groups.push(pages);
					}
				} else {
					groups = parseSplitRanges(request.rangesSpec ?? "", total);
				}

				const outputs: PdfSplitOutputFile[] = [];
				for (let i = 0; i < groups.length; i += 1) {
					const pages = groups[i]!;
					const out = await PDFDocument.create();
					const copied = await out.copyPages(
						src,
						pages.map((p) => p - 1),
					);
					for (const page of copied) out.addPage(page);
					const suffix = groups.length > 1 ? `part${i + 1}-${pageRangeLabel(pages)}` : pageRangeLabel(pages);
					const outputPath = await uniqueSiblingPath(request.path, suffix);
					await writeAtomic(outputPath, await out.save());
					outputs.push({
						outputPath,
						name: basename(outputPath),
						pageCount: out.getPageCount(),
					});
				}
				return { outputs };
			}),

		readMetadata: async (filePath) => {
			assertPdfPath(filePath);
			const bytes = await readFile(filePath);
			const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
			return {
				title: doc.getTitle() ?? "",
				author: doc.getAuthor() ?? "",
				subject: doc.getSubject() ?? "",
				keywords: (doc.getKeywords() ?? "").trim(),
			};
		},

		readFormFields: async (filePath) => {
			assertPdfPath(filePath);
			const bytes = await readFile(filePath);
			const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
			return extractFormFields(doc);
		},

		saveFormFields: (request, source = "human") =>
			withFileLock(request.path, async () => {
				assertPdfPath(request.path);
				const info = await stat(request.path);
				if (!info.isFile()) throw new Error(`${request.path} is not a file.`);
				if (info.size > MAX_PDF_EDIT_BYTES) throw new Error("PDF is too large to edit here.");
				if (request.force !== true && request.expectedMtimeMs !== undefined && Math.abs(info.mtimeMs - request.expectedMtimeMs) > 2) {
					return { ok: false, reason: "conflict", diskMtimeMs: info.mtimeMs };
				}
				const originalBytes = await readFile(request.path);
				const pdfDoc = await PDFDocument.load(originalBytes, { ignoreEncryption: false });
				const form = pdfDoc.getForm();
				for (const field of form.getFields()) {
					const name = field.getName();
					if (!(name in request.values)) continue;
					const nextVal = request.values[name];
					if (field.isReadOnly()) continue;
					if (field instanceof PDFTextField && typeof nextVal === "string") {
						field.setText(nextVal);
					} else if (field instanceof PDFCheckBox && typeof nextVal === "boolean") {
						if (nextVal) field.check();
						else field.uncheck();
					} else if ((field instanceof PDFDropdown || field instanceof PDFOptionList) && typeof nextVal === "string") {
						if (nextVal === "") field.clear();
						else field.select(nextVal);
					} else if (field instanceof PDFRadioGroup && typeof nextVal === "string") {
						if (nextVal === "") field.clear();
						else field.select(nextVal);
					}
				}
				if (request.flatten === true) {
					form.flatten();
				}
				const nextBytes = await pdfDoc.save();
				const snapshotId = await recordSnapshot(request.path, originalBytes);
				await writeAtomic(request.path, nextBytes);
				const saved = await stat(request.path);
				const pageCount = pdfDoc.getPageCount();
				const modifiedAt = saved.mtime.toISOString();
				emitChanged({
					path: request.path,
					size: saved.size,
					modifiedAt,
					mtimeMs: saved.mtimeMs,
					pageCount,
					source,
					snapshotId,
				});
				return {
					ok: true,
					size: saved.size,
					modifiedAt,
					mtimeMs: saved.mtimeMs,
					pageCount,
					snapshotId,
				};
			}),

		restore: async (snapshotId) => {
			const record = snapshots.get(snapshotId);
			if (record === undefined) return { ok: false };
			return withFileLock(record.path, async () => {
				const active = snapshots.get(snapshotId);
				if (active === undefined) return { ok: false };
				const bytes = await readFile(active.backupPath);
				await writeAtomic(active.path, bytes);
				snapshots.delete(snapshotId);
				await rm(active.backupPath, { force: true }).catch(() => undefined);
				const saved = await stat(active.path);
				const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
				const pageCount = doc.getPageCount();
				const modifiedAt = saved.mtime.toISOString();
				emitChanged({
					path: active.path,
					size: saved.size,
					modifiedAt,
					mtimeMs: saved.mtimeMs,
					pageCount,
					source: "undo",
				});
				return {
					ok: true,
					size: saved.size,
					modifiedAt,
					mtimeMs: saved.mtimeMs,
					pageCount,
				};
			});
		},

		readSnapshot: async (snapshotId) => {
			const record = snapshots.get(snapshotId);
			if (record === undefined) return null;
			return readFile(record.backupPath).catch(() => null);
		},

		pageVisualSize: async (filePath, pageIndex) => {
			assertPdfPath(filePath);
			const doc = await PDFDocument.load(await readFile(filePath), { ignoreEncryption: false });
			const pageCount = doc.getPageCount();
			if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) {
				throw new Error(`Page index ${pageIndex} is out of range (PDF has ${pageCount} page${pageCount === 1 ? "" : "s"}; pageIndex is 0-based).`);
			}
			const page = doc.getPage(pageIndex);
			const box = visibleBox(page);
			const rotation = ((page.getRotation().angle % 360) + 360) % 360;
			const swap = rotation === 90 || rotation === 270;
			return { widthPt: swap ? box.height : box.width, heightPt: swap ? box.width : box.height, pageCount };
		},

		renderPageToPng: async (filePath, pageNumber, options) => {
			assertPdfPath(filePath);
			if (!Number.isInteger(pageNumber) || pageNumber < 1) {
				throw new Error(`Invalid 1-based page number: ${pageNumber}`);
			}
			const workDir = await mkdtemp(join(tmpdir(), "dazzi-pdf-render-"));
			try {
				// Snapshot current PDF bytes under the per-file mutex so concurrent edits never cause a torn read.
				const snapshot = await withFileLock(filePath, async () => {
					const info = await stat(filePath);
					if (!info.isFile()) throw new Error(`${filePath} is not a file.`);
					if (info.size > MAX_PDF_EDIT_BYTES) throw new Error("PDF is too large to render here.");
					const bytes = await readFile(filePath);
					const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
					const pageCount = doc.getPageCount();
					if (pageNumber > pageCount) {
						throw new Error(`Page ${pageNumber} is out of range (PDF has ${pageCount} page${pageCount === 1 ? "" : "s"}).`);
					}
					const page = doc.getPage(pageNumber - 1);
					const box = visibleBox(page);
					const rotation = ((page.getRotation().angle % 360) + 360) % 360;
					const swap = rotation === 90 || rotation === 270;
					const widthPt = Number((swap ? box.height : box.width).toFixed(2));
					const heightPt = Number((swap ? box.width : box.height).toFixed(2));
					const tmpPdf = join(workDir, "source.pdf");
					await writeFile(tmpPdf, bytes);
					return { tmpPdf, pageCount, widthPt, heightPt, rotation };
				});

				const requestedDpi = Math.min(
					RENDER_MAX_DPI,
					Math.max(RENDER_MIN_DPI, Math.round(options?.dpi ?? RENDER_DEFAULT_DPI)),
				);
				const maxEdgePx = Math.min(2000, Math.max(400, Math.round(options?.maxEdgePx ?? RENDER_DEFAULT_MAX_EDGE)));
				const maxPt = Math.max(1, snapshot.widthPt, snapshot.heightPt);
				const cappedDpi = Math.max(RENDER_MIN_DPI, Math.min(requestedDpi, Math.floor((maxEdgePx * 72) / maxPt)));

				let png = await rasterizePdfPage(snapshot.tmpPdf, pageNumber, cappedDpi, workDir);
				let dims = imageSize(png);
				if (dims === null) {
					throw new Error(`Rendered page ${pageNumber} did not produce a valid PNG image.`);
				}
				if (dims.width > maxEdgePx || dims.height > maxEdgePx || Math.ceil((png.length * 4) / 3) >= 4.5 * 1024 * 1024) {
					const resized = await resizeImage(png, "image/png");
					if (resized !== null && resized.mimeType === "image/png") {
						png = Buffer.from(resized.data, "base64");
						dims = imageSize(png) ?? dims;
					}
				}

				return {
					pageNumber,
					pageIndex: pageNumber - 1,
					pageCount: snapshot.pageCount,
					widthPt: snapshot.widthPt,
					heightPt: snapshot.heightPt,
					rotation: snapshot.rotation,
					imageWidthPx: dims.width,
					imageHeightPx: dims.height,
					png,
				};
			} finally {
				await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
			}
		},

		withLock: withFileLock,

		onChanged: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		dispose: async () => {
			snapshots.clear();
			listeners.clear();
			await rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
		},
	};
}
