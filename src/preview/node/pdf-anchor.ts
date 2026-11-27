import { loadDazziNativeCore } from "../../main/dazzi-native-core";
import { withReadableFile } from "./provider-access";

const DEFAULT_MAX_CANDIDATES = 6;

/**
 * Locate 1-based candidate page numbers in `path` that likely contain any of
 * `excerpts`, using the bundled Rust PDF scanner (`findPdfAnchorPagesNative`)
 * on the libuv thread pool.
 *
 * Returns an empty array if the PDF is encrypted, scanned-only, or yields no
 * literal substring match, so `PdfView` cleanly falls back to its full
 * `pdf.js` scan without losing accuracy.
 */
export async function findPdfAnchorPages(
	path: string,
	excerpts: readonly string[],
	maxCandidates = DEFAULT_MAX_CANDIDATES,
): Promise<readonly number[]> {
	if (excerpts.length === 0) return [];
	const native = loadDazziNativeCore();
	if (native === null) return [];
	try {
		return await withReadableFile(path, async (localPath) => {
			return native.findPdfAnchorPagesNative(localPath, excerpts, maxCandidates);
		});
	} catch (error) {
		console.warn(`[dazzi-core] findPdfAnchorPagesNative failed for ${path}:`, error instanceof Error ? error.message : error);
		return [];
	}
}
