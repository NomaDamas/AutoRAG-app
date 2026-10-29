import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { Readable } from "node:stream";
import { pathFromPreviewUrl } from "../shared/contract";
import { parseByteRange } from "../shared/range";
import { mimeForExtension } from "../shared/registry";

function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function body(filePath: string, start: number, end: number): ReadableStream<Uint8Array> {
	return Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>;
}

/**
 * Streams a local file with HTTP range support. Chromium's media pipeline only
 * marks a source seekable when the server answers ranges with 206, so video
 * and audio scrubbing depend on this; PDF.js also fetches ranges on demand.
 * The remote server reuses this through {@link previewResponseForPath}.
 */
export async function handlePreviewRequest(request: Request): Promise<Response> {
	const filePath = pathFromPreviewUrl(request.url);
	if (filePath === null || !isAbsolute(filePath)) return new Response("bad path", { status: 400 });
	return previewResponseForPath(filePath, request.headers.get("range"));
}

/** The same byte-range streaming without an Electron `Request`, for remote serving. */
export async function previewResponseForPath(filePath: string, rangeHeader: string | null, contentType?: string): Promise<Response> {
	if (!isAbsolute(filePath) || filePath.includes("\0")) return new Response("bad path", { status: 400 });
	let size: number;
	try {
		const followed = await stat(filePath);
		if (!followed.isFile()) return new Response("not a file", { status: 404 });
		size = followed.size;
	} catch (error) {
		if (isEnoent(error)) return new Response("missing", { status: 404 });
		throw error;
	}
	const headers = new Headers({
		"accept-ranges": "bytes",
		"content-type": contentType ?? mimeForExtension(extname(filePath).slice(1)),
		"cache-control": "no-store",
	});
	const header = rangeHeader;
	if (header === null) {
		headers.set("content-length", String(size));
		return new Response(size === 0 ? null : body(filePath, 0, size - 1), { status: 200, headers });
	}
	const range = parseByteRange(header, size);
	if (range === null) {
		headers.set("content-range", `bytes */${size}`);
		return new Response(null, { status: 416, headers });
	}
	headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
	headers.set("content-length", String(range.end - range.start + 1));
	return new Response(body(filePath, range.start, range.end), { status: 206, headers });
}
