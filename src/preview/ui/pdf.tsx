import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { previewStreamUrl, type PreviewDocument } from "../shared/contract";
import type { Size } from "../shared/fit";
import { locateMarks, pdfRuns, type TextRun } from "../shared/text-marks";
import { FallbackView, Status } from "./fallback";
import { PagedView, type DrawPage, type EvidenceMarks } from "./paged";

let workerReady = false;

function ensurePdfWorker(): void {
	if (workerReady) return;
	GlobalWorkerOptions.workerSrc = workerUrl;
	workerReady = true;
}

/** Every page's text runs. pdf.js fetches the ranges it needs; auto-fetch stays off for the drawing. */
async function pdfText(pdf: PDFDocumentProxy): Promise<readonly (readonly TextRun[])[]> {
	return Promise.all(
		Array.from({ length: pdf.numPages }, async (_unused, index) => {
			const page = await pdf.getPage(index + 1);
			return pdfRuns((await page.getTextContent()).items, page.getViewport({ scale: 1 }).transform);
		}),
	);
}

/**
 * PDF in the shared paged layout. Pages stream through the range-capable
 * protocol, so a large document opens on its first page; every other page
 * assumes the first page's size until it renders. With an `anchor` (AI Search
 * evidence) the text of every page is read once and the cited passage is
 * marked and scrolled to.
 */
export function PdfView({ file, anchor = null }: { readonly file: PreviewDocument; readonly anchor?: readonly string[] | null }): ReactElement {
	const { t } = useTranslation();
	const [opened, setOpened] = useState<{ readonly pdf: PDFDocumentProxy; readonly boxes: readonly Size[] } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [evidence, setEvidence] = useState<EvidenceMarks | null>(null);

	useEffect(() => {
		ensurePdfWorker();
		let cancelled = false;
		const task = getDocument({ url: previewStreamUrl(file.path), disableAutoFetch: true });
		void task.promise
			.then(async (loaded) => {
				const first = (await loaded.getPage(1)).getViewport({ scale: 1 });
				if (cancelled) return;
				const box = { width: first.width, height: first.height };
				setOpened({ pdf: loaded, boxes: Array.from({ length: loaded.numPages }, () => box) });
			})
			.catch((caught: unknown) => {
				if (!cancelled) setError(caught instanceof Error ? caught.message : t("quickLook.pdf.openFailed"));
			});
		return () => {
			cancelled = true;
			void task.destroy();
		};
	}, [file.path]);

	const pdf = opened?.pdf ?? null;
	useEffect(() => {
		if (pdf === null || anchor === null || anchor.length === 0) {
			setEvidence(null);
			return;
		}
		let cancelled = false;
		setEvidence({ state: "searching" });
		void pdfText(pdf)
			.then((pages) => {
				if (cancelled) return;
				const marks = locateMarks(pages, anchor);
				setEvidence(marks === null ? { state: "missing" } : { state: "found", pages: [marks, ...marks.next] });
			})
			.catch((caught: unknown) => {
				// A page whose text cannot be read still draws; the panel opens at the top.
				console.warn(`quick-look: PDF text for ${file.path} failed: ${caught instanceof Error ? caught.message : String(caught)}`);
				if (!cancelled) setEvidence({ state: "missing" });
			});
		return () => {
			cancelled = true;
		};
	}, [pdf, anchor, file.path]);

	const draw = useCallback<DrawPage>(
		(index, width, onBox) => {
			if (pdf === null) throw new Error("PDF is not open");
			let task: RenderTask | null = null;
			const done = pdf.getPage(index + 1).then(async (page) => {
				const natural = page.getViewport({ scale: 1 });
				onBox({ width: natural.width, height: natural.height });
				const viewport = page.getViewport({ scale: (width * Math.min(2, window.devicePixelRatio || 1)) / natural.width });
				const canvas = document.createElement("canvas");
				canvas.width = Math.floor(viewport.width);
				canvas.height = Math.floor(viewport.height);
				task = page.render({ canvas, viewport });
				await task.promise;
				return canvas;
			});
			// A cancelled render rejects with RenderingCancelledException; the caller already ignores it.
			return { done, cancel: () => task?.cancel() };
		},
		[pdf],
	);

	if (error !== null) return <FallbackView file={file} note={error} />;
	if (opened === null) return <Status>{t("quickLook.status.loading")}</Status>;
	return <PagedView file={file} boxes={opened.boxes} draw={draw} evidence={evidence} />;
}
