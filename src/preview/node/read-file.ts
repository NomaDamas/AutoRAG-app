import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import type { PreviewDocument } from "../shared/contract";
import { mimeForExtension } from "../shared/registry";

export const PREVIEW_BYTE_CAP = 32 * 1024 * 1024;

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

export async function readPreviewFile(filePath: string, includeBytes: boolean): Promise<PreviewDocument> {
	if (!isAbsolute(filePath) || filePath.includes("\0")) {
		throw new PreviewReadError("not-absolute", "미리보기 경로가 올바르지 않습니다");
	}
	let followed;
	try {
		followed = await stat(filePath);
	} catch (error) {
		if (isEnoent(error)) throw new PreviewReadError("missing", "파일을 찾을 수 없습니다");
		throw error;
	}
	if (!followed.isFile()) throw new PreviewReadError("not-file", "폴더는 미리볼 수 없습니다");
	const ext = extname(filePath).slice(1).toLowerCase();
	const tooBig = includeBytes && followed.size > PREVIEW_BYTE_CAP;
	const bytes = includeBytes && !tooBig ? new Uint8Array(await readFile(filePath)) : null;
	return {
		name: basename(filePath),
		path: filePath,
		ext,
		size: followed.size,
		modifiedAt: followed.mtime.toISOString(),
		mime: mimeForExtension(ext),
		truncated: tooBig,
		bytes,
	};
}
