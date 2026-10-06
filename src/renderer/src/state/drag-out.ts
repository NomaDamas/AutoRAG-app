/**
 * The Finder's row drag-out.
 *
 * A row drag leaves the app as an Electron native file drag
 * (`webContents.startDrag`, wired in the main process), because an HTML5 drag
 * can never hand the OS real files. The OS then owns the gesture; when it
 * comes back over our own window, the in-app drop targets — a folder row, a
 * folder tab, the listing background — must recognize it as this window's rows
 * and move them (⌥ copies), while a drag another app started stays out of them.
 * The paths recorded here are that recognition: the native drag carries only
 * `Files`, so {@link beginOutDrag}/{@link endOutDrag} bracket the gesture and
 * {@link isFinderRowDrag} matches only our own.
 */

import { FILES_MIME, type DropData } from "./attachments";

let outDrag: readonly string[] = [];

/** Record the rows a row drag-out carries (called once per `dragstart`). */
export function beginOutDrag(paths: readonly string[]): void {
	outDrag = [...paths];
}

/** Forget the row drag-out: a fresh gesture began, or the drag is over. */
export function endOutDrag(): void {
	outDrag = [];
}

/**
 * Whether a drag carries this window's own rows. A row drag is a native file
 * drag, so it arrives as `Files` with no custom type; the recorded paths tell
 * it apart from a drag another app started.
 */
export function isFinderRowDrag(types: ArrayLike<string>): boolean {
	return outDrag.length > 0 && Array.from(types).includes(FILES_MIME);
}

/**
 * The absolute paths an in-app drop carries, or [] when the drop is not this
 * window's row drag. File items that resolve to disk paths must be exactly the
 * recorded rows, so a drag another app started is never mistaken for ours; a
 * synthetic item (a File with no path on disk) falls back to the recorded rows.
 */
export function readFinderRowDragPaths<F extends { readonly name: string }>(
	data: DropData<F>,
	pathForFile: (file: F) => string,
): readonly string[] {
	if (!isFinderRowDrag(data.types)) return [];
	const resolved = Array.from(data.items)
		.filter((item) => item.kind === "file")
		.map((item) => item.getAsFile())
		.filter((file): file is F => file !== null)
		.map(pathForFile)
		.filter((path) => path !== "");
	if (resolved.length > 0) {
		const carried = new Set(resolved);
		if (carried.size !== outDrag.length || !outDrag.every((path) => carried.has(path))) return [];
	}
	return outDrag;
}
