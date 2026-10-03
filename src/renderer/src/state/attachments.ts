/**
 * Drag-and-drop attachments for the AI dock.
 *
 * Three sources land on the dock: the Finder's own rows (written by
 * {@link writeFinderDrag}), files and folders dragged from another app such as
 * macOS Finder, and links dragged from a browser. They all become
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
 * Fill a Finder row drag: the rows for the AI dock, plus file URLs and plain
 * paths so text fields and other apps receive something sensible.
 */
export function writeFinderDrag(data: DragDataWriter, entries: readonly FinderDragEntry[]): void {
	data.effectAllowed = "copy";
	data.setData(
		FINDER_DRAG_TYPE,
		JSON.stringify(entries.map(({ path, name, kind }) => ({ path, name, kind }))),
	);
	data.setData(URI_LIST, entries.map((entry) => `file://${entry.path.split("/").map(encodeURIComponent).join("/")}`).join("\r\n"));
	data.setData("text/plain", entries.map((entry) => entry.path).join("\n"));
}

function decoded(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

/** A dropped `text/uri-list` line as an attachment: file URLs become files, web links become URLs. */
function attachmentFromUrl(raw: string): ChatAttachment | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol === "file:") {
		const path = decoded(url.pathname);
		return isAbsolutePath(path) ? { kind: "file", id: path, name: basename(path) } : null;
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
		if (path === "") continue;
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
