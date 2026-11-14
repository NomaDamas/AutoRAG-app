import { open, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { t } from "../../shared/i18n/core";
import type { PreviewDocument } from "../shared/contract";
import { mimeForExtension } from "../shared/registry";
import { readCoordinatedHead } from "./coordinated-read";

/** Documents parsed whole (PDF, Office, archives) are read up to this size. */
export const PREVIEW_BYTE_CAP = 32 * 1024 * 1024;
/** Text, code, Markdown, and HTML show at most their first 4MB: more would only slow the window down. */
export const TEXT_BYTE_CAP = 4 * 1024 * 1024;
/** Enough of an unknown file to tell text from binary. */
export const SNIFF_BYTES = 64 * 1024;

export class PreviewReadError extends Error {
	readonly code: "not-absolute" | "not-file" | "missing" | "unreadable";

	constructor(code: PreviewReadError["code"], message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PreviewReadError";
		this.code = code;
	}
}

function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** The first `length` bytes of a file, coordinating on macOS if a file provider refuses POSIX access. */
export async function readHead(filePath: string, length: number): Promise<Uint8Array> {
	try {
		return await readPosixHead(filePath, length);
	} catch (error) {
		// Darwin EDEADLK (11) is not mapped by libuv, which can expose it as "Unknown system error -11".
		if (process.platform === "darwin" && typeof error === "object" && error !== null &&
			(("code" in error && error.code === "EDEADLK") || ("errno" in error && error.errno === -11))) {
			return readCoordinatedHead(filePath, length);
		}
		throw error;
	}
}

async function readPosixHead(filePath: string, length: number): Promise<Uint8Array> {
	const handle = await open(filePath, "r");
	try {
		const buffer = new Uint8Array(length);
		let offset = 0;
		while (offset < length) {
			const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		return buffer.subarray(0, offset);
	} finally {
		await handle.close();
	}
}

/**
 * Reads a file for the preview. `limit` is how many bytes the viewer may get:
 * 0 sends none (media and fonts stream the protocol instead), and a file
 * larger than the limit is marked `truncated` and arrives cut at the limit,
 * or without bytes when `whole` says a prefix is useless to its viewer.
 */
export async function readPreviewFile(filePath: string, limit: number, whole = false): Promise<PreviewDocument> {
	if (!isAbsolute(filePath) || filePath.includes("\0")) {
		throw new PreviewReadError("not-absolute", t("quickLook.errors.notAbsolute"));
	}
	let followed;
	try {
		followed = await stat(filePath);
	} catch (error) {
		if (isEnoent(error)) throw new PreviewReadError("missing", t("quickLook.errors.missing"));
		throw new PreviewReadError("unreadable", t("quickLook.documents.readFailed"), { cause: error });
	}
	if (!followed.isFile()) throw new PreviewReadError("not-file", t("quickLook.errors.notFile"));
	const ext = extname(filePath).slice(1).toLowerCase();
	const truncated = limit > 0 && followed.size > limit;
	let bytes: Uint8Array | null;
	try {
		bytes = limit === 0 || (truncated && whole) ? null : await readHead(filePath, Math.min(followed.size, limit));
	} catch (error) {
		if (isEnoent(error)) throw new PreviewReadError("missing", t("quickLook.errors.missing"), { cause: error });
		throw new PreviewReadError("unreadable", t("quickLook.documents.readFailed"), { cause: error });
	}
	return {
		name: basename(filePath),
		path: filePath,
		ext,
		size: followed.size,
		modifiedAt: followed.mtime.toISOString(),
		mime: mimeForExtension(ext),
		truncated,
		bytes,
		pages: null,
		office: null,
		thumbnail: null,
		slidesRendering: false,
	};
}
