export const PREVIEW_CHANNELS = {
	read: "preview:read",
} as const;

/**
 * One file the preview can render. `bytes` is null when the viewer streams
 * the custom protocol instead, or when the file is over the byte cap.
 */
export interface PreviewDocument {
	readonly name: string;
	readonly path: string;
	readonly ext: string;
	readonly size: number;
	readonly modifiedAt: string;
	readonly mime: string;
	readonly truncated: boolean;
	readonly bytes: Uint8Array | null;
}

export interface PreviewBridge {
	read(path: string, includeBytes: boolean): Promise<PreviewDocument>;
}

export function isPreviewDocument(value: unknown): value is PreviewDocument {
	if (typeof value !== "object" || value === null) return false;
	if (!("name" in value) || typeof value.name !== "string") return false;
	if (!("path" in value) || typeof value.path !== "string") return false;
	if (!("ext" in value) || typeof value.ext !== "string") return false;
	if (!("size" in value) || typeof value.size !== "number") return false;
	if (!("modifiedAt" in value) || typeof value.modifiedAt !== "string") return false;
	if (!("mime" in value) || typeof value.mime !== "string") return false;
	if (!("truncated" in value) || typeof value.truncated !== "boolean") return false;
	if (!("bytes" in value)) return false;
	return value.bytes === null || value.bytes instanceof Uint8Array;
}

export const PREVIEW_SCHEME = "autorag-preview";

export function previewStreamUrl(filePath: string): string {
	const url = new URL(`${PREVIEW_SCHEME}://local/`);
	url.searchParams.set("path", filePath);
	return url.toString();
}

export function pathFromPreviewUrl(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch (error) {
		if (error instanceof TypeError) return null;
		throw error;
	}
	if (url.protocol !== `${PREVIEW_SCHEME}:`) return null;
	const path = url.searchParams.get("path");
	if (path === null || path.length === 0 || path.includes("\0")) return null;
	return path;
}
