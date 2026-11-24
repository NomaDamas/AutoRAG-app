import { rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";
import { decodeText, lineEnding } from "../preview/shared/code";
import { PREVIEW_BYTE_CAP, readPreviewFile, TEXT_BYTE_CAP } from "../preview/node/read-file";
import {
	documentEditorSurface,
	wysiwygFormatForExtension,
	type DocumentEditorLoad,
	type DocumentEditorSaveRequest,
	type DocumentEditorSaveResult,
	type DocumentLineEnding,
} from "../shared/document-editor-contract";

/** Largest text file the in-app editor loads and writes directly. */
export const MAX_EDITOR_TEXT_BYTES = TEXT_BYTE_CAP;

function applyLineEnding(text: string, ending: DocumentLineEnding): string {
	const normalized = text.replace(/\r\n?/g, "\n");
	if (ending === "CRLF") return normalized.replace(/\n/g, "\r\n");
	if (ending === "CR") return normalized.replace(/\n/g, "\r");
	return normalized;
}

function assertAbsolutePath(filePath: string): void {
	if (!isAbsolute(filePath) || filePath.includes("\0")) {
		throw new Error("Document editor requires an absolute file path.");
	}
}

/**
 * Reads a file for the Document Editor tab.
 * Text files decode into UTF-8/normalized `\n` strings with encoding/line-ending metadata;
 * package documents (Office, HWP/HWPX, OpenDocument) load their PreviewDocument payload.
 */
export async function openDocumentForEditor(filePath: string): Promise<DocumentEditorLoad> {
	assertAbsolutePath(filePath);
	const ext = extname(filePath).slice(1).toLowerCase();
	const surface = documentEditorSurface(ext);
	if (surface === null) {
		throw new Error(`Dazzi cannot edit ${ext ? `.${ext}` : "this kind of"} files.`);
	}
	const info = await stat(filePath);
	if (!info.isFile()) {
		throw new Error(`${filePath} is not a file.`);
	}
	if (surface === "package") {
		const document = await readPreviewFile(filePath, PREVIEW_BYTE_CAP, true);
		return {
			kind: "package",
			surface: "package",
			path: filePath,
			name: basename(filePath),
			ext,
			document,
			mtimeMs: info.mtimeMs,
		};
	}
	const doc = await readPreviewFile(filePath, MAX_EDITOR_TEXT_BYTES, false);
	const bytes = doc.bytes ?? new Uint8Array();
	const decoded = decodeText(bytes);
	return {
		kind: "text",
		surface,
		wysiwygFormat: surface === "wysiwyg" ? wysiwygFormatForExtension(ext) : null,
		path: filePath,
		name: basename(filePath),
		ext,
		text: decoded.text.replace(/\r\n?/g, "\n"),
		encoding: decoded.encoding,
		ending: lineEnding(decoded.text),
		size: doc.size,
		modifiedAt: doc.modifiedAt,
		mtimeMs: info.mtimeMs,
		truncated: doc.truncated,
	};
}

/**
 * Atomically writes edited text back to disk, preserving line endings and
 * checking `expectedMtimeMs` against external edits unless `force` is set.
 */
export async function saveDocumentText(request: DocumentEditorSaveRequest): Promise<DocumentEditorSaveResult> {
	assertAbsolutePath(request.path);
	const ext = extname(request.path).slice(1).toLowerCase();
	const surface = documentEditorSurface(ext);
	if (surface !== "wysiwyg" && surface !== "code") {
		throw new Error(`Dazzi cannot save ${ext ? `.${ext}` : "this kind of"} files as text.`);
	}
	const current = await stat(request.path);
	if (!current.isFile()) {
		throw new Error(`${request.path} is not a file.`);
	}
	if (request.force !== true && request.expectedMtimeMs !== undefined && Math.abs(current.mtimeMs - request.expectedMtimeMs) > 2) {
		return { ok: false, reason: "conflict", diskMtimeMs: current.mtimeMs };
	}
	const ending = request.ending ?? "LF";
	const payload = Buffer.from(applyLineEnding(request.text, ending), "utf8");
	if (payload.byteLength > MAX_EDITOR_TEXT_BYTES) {
		throw new Error("Document is too large to save in the text editor.");
	}
	const dir = dirname(request.path);
	const tempPath = join(dir, `.dazzi-edit-${randomBytes(6).toString("hex")}.tmp`);
	try {
		await writeFile(tempPath, payload);
		await rename(tempPath, request.path);
	} catch (error) {
		// Fallback for cross-device / restricted rename environments
		await writeFile(request.path, payload).catch(() => {
			throw error;
		});
	}
	const saved = await stat(request.path);
	return {
		ok: true,
		size: saved.size,
		modifiedAt: saved.mtime.toISOString(),
		mtimeMs: saved.mtimeMs,
	};
}
