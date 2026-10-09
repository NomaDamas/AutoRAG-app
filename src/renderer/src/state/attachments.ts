/**
 * Drag-and-drop attachments for AI Search.
 *
 * Three sources land on an AI Search tab, its strip tab, or the sidebar item:
 * the Finder's own rows (written by {@link writeFinderDrag}), files and folders
 * dragged from another app such as macOS Finder, and links dragged from a
 * browser. They all become
 * {@link ChatAttachment}s the main process hands to the agent.
 *
 * The shapes below are the slices of the DOM DataTransfer API these helpers
 * read, so the module stays testable without a DOM.
 */

import type { ChatAttachment } from "../../../shared/search-contract";
import { basename, isAbsolutePath } from "./paths";

/** The Finder's row drag payload: JSON `FinderDragEntry[]`. */
export const FINDER_DRAG_TYPE = "application/x-autorag-finder-entries";

const URI_LIST = "text/uri-list";
const FILES = "Files";

export interface FinderDragEntry {
	readonly path: string;
	readonly name: string;
	readonly kind: "file" | "folder";
}

/** The writable half of a DataTransfer at dragstart. */
export interface DragDataWriter {
	effectAllowed: string;
	setData(format: string, data: string): void;
}

export interface DropItem<F> {
	readonly kind: string;
	getAsFile(): F | null;
	webkitGetAsEntry?(): { readonly isDirectory: boolean } | null;
}

/** The readable half of a DataTransfer at drop. */
export interface DropData<F> {
	readonly types: ArrayLike<string>;
	getData(format: string): string;
	readonly items: ArrayLike<DropItem<F>>;
}

/**
 * Whether a drag can carry an attachment. Only `types` is readable before the
 * drop, so this decides on the formats alone; bare text drags stay with the
 * page's default text handling.
 */
export function isAttachmentDrag(types: ArrayLike<string>): boolean {
	return Array.from(types).some((type) => type === FILES || type === URI_LIST || type === FINDER_DRAG_TYPE);
}

/**
 * Whether a Finder drop target (a folder row, a tab, the listing background)
 * should accept the drag to copy or move local files. A superset of
 * {@link isFinderDrag}: it also matches OS files and file links, but a web
 * link rides the same URI list, so the drop handler still reads the paths with
 * {@link readDropPaths} and does nothing when none resolve to disk.
 */
export function isFileTransferDrag(types: ArrayLike<string>): boolean {
	return Array.from(types).some((type) => type === FILES || type === URI_LIST || type === FINDER_DRAG_TYPE);
}

/**
 * Whether a drag carries the Finder's own rows, as opposed to OS files or
 * links. The in-app drop targets (folder rows, tabs) accept only this, so an
 * OS drag keeps falling through to the default browser handling.
 */
export function isFinderDrag(types: ArrayLike<string>): boolean {
	return Array.from(types).some((type) => type === FINDER_DRAG_TYPE);
}

/** The absolute paths a Finder row drag carries; [] when the payload is absent or malformed. */
export function readFinderDragPaths(data: Pick<DropData<unknown>, "types" | "getData">): readonly string[] {
	if (!isFinderDrag(data.types)) return [];
	return finderEntries(data.getData(FINDER_DRAG_TYPE)).map((attachment) => attachment.id);
}

/** The rows a drag carries: the whole selection when the grabbed row is in it, else just that row. */
export function finderDragEntries<E extends FinderDragEntry>(
	entry: E,
	selectedKeys: readonly string[],
	visibleEntries: readonly E[],
): readonly E[] {
	if (!selectedKeys.includes(entry.path)) return [entry];
	const selected = visibleEntries.filter((candidate) => selectedKeys.includes(candidate.path));
	return selected.length === 0 ? [entry] : selected;
}

/**
 * Fill a Finder row drag: the rows for AI Search, plus file URLs and plain
 * paths so text fields and other apps receive something sensible.
 *
 * The drag can both copy and move: an in-app drop onto a folder or tab moves
 * the rows (⌥ copies), while a drop on AI Search or another app copies.
 */
export function writeFinderDrag(data: DragDataWriter, entries: readonly FinderDragEntry[]): void {
	data.effectAllowed = "copyMove";
	data.setData(
		FINDER_DRAG_TYPE,
		JSON.stringify(entries.map(({ path, name, kind }) => ({ path, name, kind }))),
	);
	data.setData(URI_LIST, entries.map((entry) => fileUrlFromPath(entry.path)).join("\r\n"));
	data.setData("text/plain", entries.map((entry) => entry.path).join("\n"));
}

/**
 * The `file:` URL for an absolute path: `/Users/a b` -> `file:///Users/a%20b`,
 * `C:\a b` -> `file:///C:/a%20b`, `\\srv\share\a` -> `file://srv/share/a`.
 */
export function fileUrlFromPath(path: string): string {
	const unc = /^(?:\\\\|\/\/)([^\\/]+)(.*)$/u.exec(path);
	const rest = (unc === null ? path : (unc[2] ?? "")).replaceAll("\\", "/");
	const encoded = rest.split("/").map(encodeURIComponent).join("/");
	if (unc !== null) return `file://${unc[1]}${encoded}`;
	// A drive path has no leading slash: `C:/a` -> `/C:/a`, with the colon kept literal.
	if (/^[A-Za-z]:\//u.test(rest)) return `file:///${rest.slice(0, 2)}${rest.slice(2).split("/").map(encodeURIComponent).join("/")}`;
	return `file://${encoded}`;
}

function decoded(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

/**
 * The absolute path a `file:` URL names, or null for any other scheme or a
 * relative path. `file:///C:/a%20b` -> `C:\a b`; `file://srv/share/a` ->
 * `\\srv\share\a`; `file:///Users/a` -> `/Users/a`.
 */
function fileUrlPath(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== "file:") return null;
	const pathname = decoded(url.pathname);
	let path = pathname;
	if (/^\/[A-Za-z]:\//u.test(pathname)) path = pathname.slice(1).replaceAll("/", "\\");
	else if (url.host !== "") path = `\\\\${url.host}${pathname.replaceAll("/", "\\")}`;
	return isAbsolutePath(path) ? path : null;
}

/** A dropped `text/uri-list` line as an attachment: file URLs become files, web links become URLs. */
function attachmentFromUrl(raw: string): ChatAttachment | null {
	const path = fileUrlPath(raw);
	if (path !== null) return { kind: "file", id: path, name: basename(path) };
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	const route = decoded(url.pathname).replace(/\/+$/u, "");
	return { kind: "url", id: url.href, name: `${url.host}${route}` };
}

function finderEntries(json: string): readonly ChatAttachment[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.flatMap((value: unknown): ChatAttachment[] => {
		if (typeof value !== "object" || value === null) return [];
		const { path, name, kind } = value as Record<string, unknown>;
		if (typeof path !== "string" || typeof name !== "string" || !isAbsolutePath(path)) return [];
		return [{ kind: kind === "folder" ? "folder" : "file", id: path, name }];
	});
}

/** Append `added` after `current`, keeping the first attachment for each path or URL. */
export function mergeAttachments(
	current: readonly ChatAttachment[],
	added: readonly ChatAttachment[],
): readonly ChatAttachment[] {
	const seen = new Set<string>();
	const out: ChatAttachment[] = [];
	for (const attachment of [...current, ...added]) {
		if (seen.has(attachment.id)) continue;
		seen.add(attachment.id);
		out.push(attachment);
	}
	return out;
}

/**
 * Attachments carried by a drop. `pathForFile` resolves a dropped file to its
 * absolute path (Electron's `webUtils.getPathForFile`); a file without one —
 * an image dragged out of a web page — is skipped, and its link, if the drag
 * carried one, arrives through the URI list instead.
 */
export function attachmentsFromDrop<F extends { readonly name: string }>(
	data: DropData<F>,
	pathForFile: (file: F) => string,
): readonly ChatAttachment[] {
	const types = Array.from(data.types);
	const found: ChatAttachment[] = [];
	if (types.includes(FINDER_DRAG_TYPE)) found.push(...finderEntries(data.getData(FINDER_DRAG_TYPE)));
	for (const item of Array.from(data.items)) {
		if (item.kind !== "file") continue;
		const file = item.getAsFile();
		if (file === null) continue;
		const path = pathForFile(file);
		if (path === "" || !isAbsolutePath(path)) continue;
		const folder = item.webkitGetAsEntry?.()?.isDirectory === true;
		found.push({ kind: folder ? "folder" : "file", id: path, name: file.name === "" ? basename(path) : file.name });
	}
	if (types.includes(URI_LIST)) {
		for (const line of data.getData(URI_LIST).split(/\r?\n/u)) {
			const raw = line.trim();
			if (raw === "" || raw.startsWith("#")) continue;
			const attachment = attachmentFromUrl(raw);
			if (attachment !== null) found.push(attachment);
		}
	}
	return mergeAttachments([], found);
}

/**
 * The local absolute paths a Finder drop target should copy or move. Rows from
 * another app arrive as `Files` items resolved through `pathForFile` (Electron's
 * `webUtils.getPathForFile`), file links through the URI list; both are kept
 * only when they name a real absolute path (each attachment id is one), so a
 * web link or a pathless blob never becomes a transfer. Order is the drop's,
 * first occurrence per path.
 */
export function readDropPaths<F extends { readonly name: string }>(
	data: DropData<F>,
	pathForFile: (file: F) => string,
): readonly string[] {
	return attachmentsFromDrop(data, pathForFile)
		.filter((attachment) => attachment.kind !== "url")
		.map((attachment) => attachment.id);
}
