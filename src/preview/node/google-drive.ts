import type { IconPreviewCache, IconProvider, IconTarget } from "../../main/file-icon";
import { isGoogleDriveExtension } from "../shared/google-drive";

/** What the panel waits for Drive's file provider before it opens without a picture. */
export const DRIVE_THUMBNAIL_BUDGET_MS = 2000;

export type DriveThumbnailSource = Pick<IconProvider, "preview"> & Partial<Pick<IconPreviewCache, "cachedPreview">>;

/**
 * The picture the OS drew for a Drive pointer file, as an `autorag-thumb://`
 * URL: the one an earlier selection already made when there is one, otherwise
 * a fresh one from Drive for desktop's file provider. A provider slower than
 * `budgetMs` leaves the panel without a picture rather than holding Space; the
 * generation still finishes and is cached for the next open.
 */
export async function driveThumbnail(
	target: IconTarget,
	icons: DriveThumbnailSource | null,
	budgetMs: number = DRIVE_THUMBNAIL_BUDGET_MS,
): Promise<string | null> {
	if (icons === null || !isGoogleDriveExtension(target.ext)) return null;
	const cached = icons.cachedPreview?.(target) ?? null;
	if (cached !== null) return cached;
	const expired = Promise.withResolvers<null>();
	const timer = setTimeout(() => expired.resolve(null), budgetMs);
	try {
		return await Promise.race([icons.preview(target), expired.promise]);
	} catch (error) {
		console.warn(`quick-look: Google Drive thumbnail for ${target.path} failed: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	} finally {
		clearTimeout(timer);
	}
}
