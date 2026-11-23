/**
 * Images pasted into an AI Agent composer.
 *
 * A screenshot on the clipboard is an image `File` with no path on disk. {@link imageFilesFromPaste} picks those out of
 * a paste, and {@link attachPastedImages} hands each to the main process, which keeps it as a file and answers with the
 * ordinary file attachment that stands for it. A model that takes no images makes the main process answer null, and
 * the paste then does nothing, silently.
 */

import type { ChatAttachment } from "../../../shared/search-contract";

/** The slice of a paste event's `clipboardData` this reads, so the helper is testable without a DOM. */
export interface PasteData<F> {
	getData(format: string): string;
	readonly items: ArrayLike<{ readonly kind: string; readonly type: string; getAsFile(): F | null }>;
}

/** What the main process keeps: the types every model that takes images takes. */
const PASTABLE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * The image files a paste carries. A paste that also carries text is a text paste (copying spreadsheet cells puts a
 * picture of them next to their text), so it yields none and the field pastes the text as usual.
 */
export function imageFilesFromPaste<F>(data: PasteData<F> | null): readonly F[] {
	if (data === null || data.getData("text/plain") !== "") return [];
	return Array.from(data.items).flatMap((item) => {
		if (item.kind !== "file" || !PASTABLE_TYPES.has(item.type)) return [];
		const file = item.getAsFile();
		return file === null ? [] : [file];
	});
}

/** A file's bytes as base64, for the IPC call. */
export function base64Of(bytes: ArrayBuffer): string {
	const view = new Uint8Array(bytes);
	let binary = "";
	for (let offset = 0; offset < view.length; offset += 0x8000) binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
	return btoa(binary);
}

interface PastedFile {
	readonly type: string;
	arrayBuffer(): Promise<ArrayBuffer>;
}

/** The attachments for `files`, in order; an image the main process did not keep is left out. Never rejects. */
export async function attachPastedImages(
	files: readonly PastedFile[],
	keep: (mimeType: string, base64: string) => Promise<ChatAttachment | null>,
): Promise<readonly ChatAttachment[]> {
	const kept = await Promise.all(
		files.map(async (file) => {
			try {
				return await keep(file.type, base64Of(await file.arrayBuffer()));
			} catch {
				return null;
			}
		}),
	);
	return kept.filter((attachment): attachment is ChatAttachment => attachment !== null);
}
