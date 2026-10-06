/**
 * Native drag-out for Finder rows.
 *
 * An HTML5 drag from a page can never hand the OS real files, so the renderer
 * calls {@link FS_CHANNELS.startDrag} from `dragstart` (after
 * `preventDefault()`) and the main process starts an Electron native file drag
 * (`webContents.startDrag`). This module holds the part worth testing without
 * Electron: turning the untrusted renderer payload into validated absolute
 * paths.
 */

import { isAbsolute } from "node:path";

/**
 * The absolute file paths a drag-out carries, or null when the payload is not
 * exactly a non-empty list of absolute path strings. Every path came from the
 * renderer, so a malformed one is rejected wholesale rather than partly trusted
 * — a partial drag is worse than no drag.
 */
export function dragOutPaths(value: unknown): readonly string[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const paths: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || entry.length === 0 || !isAbsolute(entry)) return null;
		paths.push(entry);
	}
	return paths;
}
