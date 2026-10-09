import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { BundleSummary } from "../shared/contract";

/**
 * The icon provider's preview tier, as the Quick Look window needs it: the
 * same 640px `autorag-thumb://` URL the Inspector paper shows, generated on
 * demand by the main process's provider (`src/main/file-icon.ts`).
 */
export interface BundleIconSource {
	preview(target: { readonly path: string; readonly ext: string; readonly mtimeMs: number }): Promise<string | null>;
}

/**
 * One macOS application bundle as the preview panel shows it. The bundle is a
 * directory, so the stat only supplies its date; the icon comes from the
 * provider's preview tier — the app's own icon, exactly like a document's
 * thumbnail — and the panel walks the bundle for its total size the same way
 * the folder panel does. An icon the OS cannot produce degrades to the glyph
 * and is logged verbatim, never failing the preview.
 */
export async function summarizeBundle(
	path: string,
	icons: BundleIconSource | null,
	warn: (message: string) => void = (message) => console.warn(message),
): Promise<BundleSummary> {
	const info = await stat(path);
	const modifiedAt = info.mtime.toISOString();
	let iconUrl: string | null = null;
	if (icons !== null) {
		try {
			iconUrl = await icons.preview({ path, ext: "app", mtimeMs: info.mtimeMs });
		} catch (error) {
			warn(`quick-look: icon for ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { name: basename(path), path, modifiedAt, iconUrl };
}
