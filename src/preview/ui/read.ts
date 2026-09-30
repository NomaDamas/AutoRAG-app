import type { PreviewDocument } from "../shared/contract";

export function readPreviewDocument(path: string, includeBytes: boolean): Promise<PreviewDocument> {
	return window.autorag.preview.read(path, includeBytes);
}
