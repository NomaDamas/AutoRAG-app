import type { WebContents } from "electron";
import { DOCUMENT_EDITOR_CHANNELS, isPdfAssetReply, type PdfAssetRequest, type PdfAssetResult } from "../shared/document-editor-contract";

/** How long a PDF agent waits for the editor window to render content or find text. */
export const PDF_ASSET_TIMEOUT_MS = 30_000;

export interface PdfAssetBridge {
	/** Asks the renderer of `sender` to render `request` with the PDF editor's own renderers. */
	request(sender: WebContents | null | undefined, request: PdfAssetRequest, tag: string): Promise<PdfAssetResult>;
	/** Settles a pending request with the renderer's reply (the `pdfAssetReply` IPC handler). */
	reply(id: unknown, reply: unknown): void;
}

/**
 * The round trip PDF agents use to get text boxes, notes, stamps, watermarks, images and text-search results
 * rendered by the editor UI (identical to the toolbar's), shared by the sidebar agent and the main agent's
 * `pdf-editor` subagent.
 */
export function createPdfAssetBridge(timeoutMs = PDF_ASSET_TIMEOUT_MS): PdfAssetBridge {
	const pending = new Map<string, { resolve: (result: PdfAssetResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	let seq = 0;
	return {
		request(sender, asset, tag) {
			if (sender === undefined || sender === null || sender.isDestroyed()) {
				return Promise.reject(new Error("The Dazzi window is closed, so this PDF content cannot be rendered."));
			}
			seq += 1;
			const id = `asset-${tag}-${seq}`;
			const { promise, resolve, reject } = Promise.withResolvers<PdfAssetResult>();
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error("The PDF editor did not answer in time. Keep Dazzi open while the AI edits the PDF."));
			}, timeoutMs);
			pending.set(id, { resolve, reject, timer });
			sender.send(DOCUMENT_EDITOR_CHANNELS.pdfAssetRequest, { id, request: asset });
			return promise;
		},
		reply(id, reply) {
			if (typeof id !== "string") return;
			const entry = pending.get(id);
			if (entry === undefined) return;
			pending.delete(id);
			clearTimeout(entry.timer);
			if (!isPdfAssetReply(reply)) entry.reject(new Error("The PDF editor sent an invalid answer."));
			else if (reply.ok) entry.resolve(reply.result);
			else entry.reject(new Error(reply.error));
		},
	};
}
