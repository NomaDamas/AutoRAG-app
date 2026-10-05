import { useCallback, useEffect, useState, type ReactElement } from "react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { previewStreamUrl, type PreviewDocument } from "../shared/contract";
import type { Size } from "../shared/fit";
import { FallbackView, Status } from "./fallback";
import { PagedView, type DrawPage } from "./paged";

let workerReady = false;

function ensurePdfWorker(): void {
	if (workerReady) return;
	GlobalWorkerOptions.workerSrc = workerUrl;
	workerReady = true;
}

/**
 * PDF in the shared paged layout. Pages stream through the range-capable
 * protocol, so a large document opens on its first page; every other page
 * assumes the first page's size until it renders.
 */
export function PdfView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const [opened, setOpened] = useState<{ readonly pdf: PDFDocumentProxy; readonly boxes: readonly Size[] } | null>(null);
	const [error, setError] = useState<string | null>(null);

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
				if (!cancelled) setError(caught instanceof Error ? caught.message : "PDF를 열 수 없습니다");
			});
		return () => {
			cancelled = true;
			void task.destroy();
		};
	}, [file.path]);

	const pdf = opened?.pdf ?? null;
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
	if (opened === null) return <Status>불러오는 중</Status>;
	return <PagedView file={file} boxes={opened.boxes} draw={draw} />;
}
