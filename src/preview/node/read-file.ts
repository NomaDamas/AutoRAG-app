import { open, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { t } from "../../shared/i18n/core";
import type { PreviewDocument } from "../shared/contract";
import { mimeForExtension } from "../shared/registry";

/** Documents parsed whole (PDF, Office, archives) are read up to this size. */
export const PREVIEW_BYTE_CAP = 32 * 1024 * 1024;
/** Text, code, Markdown, and HTML show at most their first 4MB: more would only slow the window down. */
export const TEXT_BYTE_CAP = 4 * 1024 * 1024;
/** Enough of an unknown file to tell text from binary. */
export const SNIFF_BYTES = 64 * 1024;

export class PreviewReadError extends Error {
	readonly code: "not-absolute" | "not-file" | "missing";

	constructor(code: PreviewReadError["code"], message: string) {
		super(message);
		this.name = "PreviewReadError";
		this.code = code;
	}
}

function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** The first `length` bytes of a file. */
export async function readHead(filePath: string, length: number): Promise<Uint8Array> {
	const handle = await open(filePath, "r");
	try {
		const buffer = new Uint8Array(length);
		const { bytesRead } = await handle.read(buffer, 0, length, 0);
		return bytesRead === length ? buffer : buffer.slice(0, bytesRead);
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
		throw error;
	}
	if (!followed.isFile()) throw new PreviewReadError("not-file", t("quickLook.errors.notFile"));
	const ext = extname(filePath).slice(1).toLowerCase();
	const truncated = limit > 0 && followed.size > limit;
	const bytes = limit === 0 || (truncated && whole) ? null : await readHead(filePath, Math.min(followed.size, limit));
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
	};
}
