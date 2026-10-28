/**
 * Putting files on the operating system's clipboard.
 *
 * Electron maps the `text/uri-list` MIME type to the platform's "copied files"
 * format (`CF_HDROP` on Windows, `NSFilenamesPboardType` plus `public.file-url`
 * on macOS, `text/uri-list` on Linux), so a browser, a chat window or Finder
 * pastes the files themselves. Plain text carries the file names, as Finder's
 * own copy does, so a text field pastes a name instead of a path.
 */

import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import type { Clipboard, ClipboardItem } from "electron";

export const URI_LIST_TYPE = "text/uri-list";

/** The ClipboardItem entries that make `paths` paste as files elsewhere. */
export function filesClipboardPayload(paths: readonly string[]): Record<"text/uri-list" | "text/plain", string> {
	return {
		[URI_LIST_TYPE]: paths.map((path) => pathToFileURL(path).href).join("\r\n"),
		"text/plain": paths.map((path) => basename(path)).join("\n"),
	};
}

export interface OsClipboard {
	writeText(text: string): void;
	writeFiles(paths: readonly string[]): Promise<void>;
}

/** The OS clipboard the fs service writes through; Electron's own is injected so the module stays Electron-free. */
export function createOsClipboard(electron: { readonly clipboard: Pick<Clipboard, "writeText" | "write">; readonly ClipboardItem: typeof ClipboardItem }): OsClipboard {
	return {
		writeText: (text) => void electron.clipboard.writeText(text),
		writeFiles: (paths) => electron.clipboard.write([new electron.ClipboardItem(filesClipboardPayload(paths))]),
	};
}
