export interface PreviewLoaderDeps {
	readonly platform: string;
	/** The OS preview (`fs:previewIcon`). */
	readonly os: (path: string, mtimeMs: number) => Promise<string | null>;
	/** A pdf.js first page of the PDF at the Info panel's paper width. */
	readonly page: (path: string, mtimeMs: number) => Promise<string | null>;
	/** An rhwp first page (SVG data URL). */
	readonly hwp: (path: string) => Promise<string | null>;
}

/**
 * How the Info panel gets the preview paper for `path`. HWP/HWPX are drawn by rhwp everywhere. A PDF is drawn by
 * pdf.js off macOS and only falls back to the OS answer: Windows has no PDF thumbnailer, and its `previewIcon`
 * answers with the generic 32px type icon (not null), which the panel then stretched over the whole paper.
 */
export function previewLoaderFor(path: string, deps: PreviewLoaderDeps): (path: string, mtimeMs: number) => Promise<string | null> {
	if (/\.hwpx?$/i.test(path)) return (file) => deps.hwp(file);
	if (/\.pdf$/i.test(path) && deps.platform !== "darwin") {
		return async (file, mtimeMs) => (await deps.page(file, mtimeMs)) ?? deps.os(file, mtimeMs);
	}
	return deps.os;
}
