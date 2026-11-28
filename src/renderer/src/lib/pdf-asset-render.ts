import { getDocument } from "pdfjs-dist";
import { i18n } from "../../../shared/i18n";
import { previewStreamUrl } from "../../../preview/shared/contract";
import { pdfRuns } from "../../../preview/shared/text-marks";
import { pdfDocumentSource } from "../../../preview/ui/pdf-config";
import type { PdfAssetRequest, PdfAssetResult, PdfTextHit } from "../../../shared/document-editor-contract";
import {
	notePalette,
	PRESET_STAMPS,
	renderNoteBoxPng,
	renderPresetStampPng,
	renderTextBoxPng,
	renderTextLinePng,
	renderWatermarkPng,
	todayIso,
	WATERMARK_PRESETS,
} from "../components/PdfEditorTools";
import { loadLocalImageAsPngDataUrl } from "./pdf-image-load";
import { canvasCharEdges, findPageTextMatches } from "./pdf-search";
import { ensurePdfWorker } from "./pdf-worker";

/**
 * Searches the PDF on disk with the same pdf.js text runs and matcher as the Find bar, and returns
 * each hit's boxes normalized to the page as viewed (0..1, top-left origin) — the coordinate space
 * every PDF edit operation uses.
 */
async function findTextInPdf(path: string, query: string, pages?: readonly number[]): Promise<readonly PdfTextHit[]> {
	ensurePdfWorker();
	// A fresh version tag so a page the agent just changed is read anew, never from cache.
	const task = getDocument(pdfDocumentSource(previewStreamUrl(path, { modifiedAt: new Date().toISOString(), size: Date.now() })));
	try {
		const doc = await task.promise;
		const wanted = pages === undefined ? null : new Set(pages);
		const hits: PdfTextHit[] = [];
		for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
			if (wanted !== null && !wanted.has(pageNumber)) continue;
			const page = await doc.getPage(pageNumber);
			const viewport = page.getViewport({ scale: 1 });
			const content = await page.getTextContent();
			const runs = pdfRuns(content.items, viewport.transform ?? [1, 0, 0, -1, 0, viewport.height], canvasCharEdges(content.styles));
			for (const match of findPageTextMatches(pageNumber - 1, runs, query)) {
				hits.push({
					pageNumber,
					pageIndex: pageNumber - 1,
					rects: match.rects.map((rect) => ({
						x: rect.x / viewport.width,
						y: rect.y / viewport.height,
						width: rect.width / viewport.width,
						height: rect.height / viewport.height,
					})),
				});
			}
		}
		return hits;
	} finally {
		void task.destroy().catch(() => undefined);
	}
}

/** Serves one PDF agent request with the exact renderers the PDF editor toolbar uses. */
export async function renderPdfAsset(request: PdfAssetRequest): Promise<PdfAssetResult> {
	switch (request.kind) {
		case "textBox": {
			const png = renderTextBoxPng(request.text, request.widthPt, request.fontSizePt, request.color);
			return { kind: "png", dataUrl: png.dataUrl, widthPt: png.widthPt, heightPt: png.heightPt, aspect: png.widthPt / Math.max(1, png.heightPt) };
		}
		case "note": {
			const png = renderNoteBoxPng(request.text, request.widthPt, request.fontSizePt, notePalette(request.noteColor));
			return { kind: "png", dataUrl: png.dataUrl, widthPt: png.widthPt, heightPt: png.heightPt, aspect: png.widthPt / Math.max(1, png.heightPt) };
		}
		case "stamp": {
			const preset = PRESET_STAMPS.find((stamp) => stamp.id === request.preset);
			const label = request.label ?? (preset === undefined ? "" : i18n.t(preset.labelKey));
			if (label.trim() === "") throw new Error("A stamp needs a preset or a label.");
			const png = renderPresetStampPng(label, request.color ?? preset?.color ?? "#B91C1C", request.withDate ? todayIso() : undefined);
			return { kind: "png", dataUrl: png.dataUrl, aspect: png.aspect };
		}
		case "watermark": {
			// A preset resolves in the app's current language (대외비 / CONFIDENTIAL / 社外秘 / 机密 …).
			const preset = WATERMARK_PRESETS.find((item) => item.id === request.preset);
			const text = request.text?.trim() || (preset === undefined ? "" : i18n.t(preset.labelKey));
			if (text === "") throw new Error("A watermark needs a preset or text.");
			return { kind: "png", dataUrl: renderWatermarkPng(text, request.color, request.angleDeg), aspect: 1 };
		}
		case "textLine": {
			const png = renderTextLinePng(request.text, request.fontSizePt, request.color);
			return { kind: "png", dataUrl: png.dataUrl, widthPt: png.widthPt, heightPt: png.heightPt, aspect: png.widthPt / Math.max(1, png.heightPt) };
		}
		case "image": {
			const png = await loadLocalImageAsPngDataUrl(request.path);
			return { kind: "png", dataUrl: png.dataUrl, aspect: png.aspect };
		}
		case "findText":
			return { kind: "textHits", hits: await findTextInPdf(request.path, request.query, request.pages) };
	}
}
