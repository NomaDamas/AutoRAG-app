import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { degrees, PDFDocument, type PDFPage } from "pdf-lib";
import type {
	DocumentEditorPdfPayload,
	PdfApplyRequest,
	PdfApplyResult,
	PdfEditOperation,
	PdfExtractRequest,
	PdfExtractResult,
	PdfRestoreResult,
} from "../shared/document-editor-contract";

const MAX_PDF_EDIT_BYTES = 128 * 1024 * 1024;
const MAX_SNAPSHOTS = 40;

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

async function applyOperation(pdfDoc: PDFDocument, op: PdfEditOperation): Promise<void> {
	const count = pdfDoc.getPageCount();
	switch (op.kind) {
		case "stampImage": {
			if (op.pageIndex < 0 || op.pageIndex >= count) throw new Error(`Page index ${op.pageIndex} out of range.`);
			const page = pdfDoc.getPage(op.pageIndex);
			const image = await pdfDoc.embedPng(decodePngDataUrl(op.pngDataUrl));
			const angle = ((page.getRotation().angle % 360) + 360) % 360;
			const coords = visualRectToPdfCoords(page, { x: op.x, y: op.y, width: op.width, height: op.height });
			if (angle === 0) {
				page.drawImage(image, coords);
			} else if (angle === 90) {
				page.drawImage(image, {
					x: coords.x + coords.width,
					y: coords.y,
					width: coords.height,
					height: coords.width,
					rotate: degrees(90),
				});
			} else if (angle === 180) {
				page.drawImage(image, {
					x: coords.x + coords.width,
					y: coords.y + coords.height,
					width: coords.width,
					height: coords.height,
					rotate: degrees(180),
				});
			} else {
				page.drawImage(image, {
					x: coords.x,
					y: coords.y + coords.height,
					width: coords.height,
					height: coords.width,
					rotate: degrees(270),
				});
			}
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

export interface PdfEditorIo {
	open(filePath: string): Promise<DocumentEditorPdfPayload>;
	apply(request: PdfApplyRequest): Promise<PdfApplyResult>;
	extract(request: PdfExtractRequest): Promise<PdfExtractResult>;
	restore(snapshotId: string): Promise<PdfRestoreResult>;
	dispose(): Promise<void>;
}

/**
 * Main-process PDF editor service backed by `pdf-lib`.
 * Keeps per-edit binary snapshots under `backupDir` so the user can undo
 * signature stamps, crops, rotations, reorders, and page deletions cleanly.
 */
export function createPdfEditorIo(backupDir: string): PdfEditorIo {
	const snapshots = new Map<string, SnapshotRecord>();

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

		apply: async (request) => {
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
			return {
				ok: true,
				size: saved.size,
				modifiedAt: saved.mtime.toISOString(),
				mtimeMs: saved.mtimeMs,
				pageCount: pdfDoc.getPageCount(),
				snapshotId,
			};
		},

		extract: async (request) => {
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
		},

		restore: async (snapshotId) => {
			const record = snapshots.get(snapshotId);
			if (record === undefined) return { ok: false };
			const bytes = await readFile(record.backupPath);
			await writeAtomic(record.path, bytes);
			snapshots.delete(snapshotId);
			await rm(record.backupPath, { force: true }).catch(() => undefined);
			const saved = await stat(record.path);
			const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
			return {
				ok: true,
				size: saved.size,
				modifiedAt: saved.mtime.toISOString(),
				mtimeMs: saved.mtimeMs,
				pageCount: doc.getPageCount(),
			};
		},

		dispose: async () => {
			snapshots.clear();
			await rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
		},
	};
}
