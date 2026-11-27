import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getDocument, GlobalWorkerOptions, PasswordResponses, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { previewStreamUrl, type PreviewDocument } from "../shared/contract";
import type { Size } from "../shared/fit";
import { locateMarks, pdfRuns, type TextRun } from "../shared/text-marks";
import { FallbackView, Status } from "./fallback";
import { PagedView, type DrawPage, type EvidenceMarks } from "./paged";
import { ChromeProvider, useChrome } from "./chrome";
import { PasswordView } from "./password";
import { pdfDocumentSource } from "./pdf-config";

let workerReady = false;

function ensurePdfWorker(): void {
	if (workerReady) return;
	GlobalWorkerOptions.workerSrc = workerUrl;
	workerReady = true;
}

/**
 * The password prompt already sized the window. The pages that replace it send the
 * size they want through `resize`, since only a load's first `report` counts.
 */
function ResizeOnReport({ children }: { readonly children: ReactNode }): ReactElement {
	const chrome = useChrome();
	const { resize } = chrome;
	const report = useCallback((size: Size) => resize(size), [resize]);
	const value = useMemo(() => ({ ...chrome, report }), [chrome, report]);
	return <ChromeProvider value={value}>{children}</ChromeProvider>;
}

/** Text runs for one 1-based PDF page number. */
async function pdfPageText(pdf: PDFDocumentProxy, pageNumber: number): Promise<readonly TextRun[]> {
	const page = await pdf.getPage(pageNumber);
	return pdfRuns((await page.getTextContent()).items, page.getViewport({ scale: 1 }).transform);
}

/**
 * Every page's text runs. pdf.js fetches the ranges it needs; auto-fetch stays off for the drawing.
 */
async function pdfText(pdf: PDFDocumentProxy): Promise<readonly (readonly TextRun[])[]> {
	return Promise.all(
		Array.from({ length: pdf.numPages }, (_unused, index) => pdfPageText(pdf, index + 1)),
	);
}

/**
 * Locate anchor excerpts on a candidate subset of 1-based page numbers first (identified in
 * main by the Rust `lopdf` scanner) so a 900-page PDF highlights in tens of milliseconds
 * instead of extracting text from every page. Returns null if none of the candidates match,
 * letting the caller fall back to the full `pdfText` scan with zero accuracy loss.
 */
async function locateOnCandidatePages(
	pdf: PDFDocumentProxy,
	candidatePages: readonly number[],
	anchor: readonly string[],
): Promise<ReturnType<typeof locateMarks>> {
	const valid = [...new Set(candidatePages.filter((n) => Number.isInteger(n) && n >= 1 && n <= pdf.numPages))];
	if (valid.length === 0) return null;
	// Also include the next page after each candidate so an excerpt spanning a page break still resolves whole.
	const expandedSet = new Set<number>();
	for (const n of valid) {
		expandedSet.add(n);
		if (n + 1 <= pdf.numPages) expandedSet.add(n + 1);
	}
	const ordered = [...expandedSet].sort((a, b) => a - b);
	const subsetRuns = await Promise.all(ordered.map((pageNum) => pdfPageText(pdf, pageNum)));
	// Build a sparse page array indexed by 0-based PDF page index so `locateMarks` emits real page indices directly.
	const sparse: (readonly TextRun[])[] = Array.from({ length: pdf.numPages }, () => []);
	for (let i = 0; i < ordered.length; i += 1) {
		sparse[ordered[i]! - 1] = subsetRuns[i]!;
	}
	return locateMarks(sparse, anchor);
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
	const { bridge } = useChrome();
	const [opened, setOpened] = useState<{ readonly pdf: PDFDocumentProxy; readonly boxes: readonly Size[] } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [evidence, setEvidence] = useState<EvidenceMarks | null>(null);
	// An encrypted PDF asks pdf.js for the password; `attempt` remounts the prompt so a refused one starts clean.
	const [prompt, setPrompt] = useState<{ readonly attempt: number; readonly incorrect: boolean; readonly unlock: (password: string) => void } | null>(null);
	const [asked, setAsked] = useState(false);

	const url = previewStreamUrl(file.path, file);
	useEffect(() => {
		ensurePdfWorker();
		let cancelled = false;
		let attempts = 0;
		const task = getDocument(pdfDocumentSource(url));
		task.onPassword = (unlock: (password: string) => void, reason: number) => {
			attempts += 1;
			if (!cancelled) {
				setAsked(true);
				setPrompt({ attempt: attempts, incorrect: reason === PasswordResponses.INCORRECT_PASSWORD, unlock });
			}
		};
		void task.promise
			.then(async (loaded) => {
				const first = (await loaded.getPage(1)).getViewport({ scale: 1 });
				if (cancelled) return;
				setPrompt(null);
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
	}, [url]);

	const pdf = opened?.pdf ?? null;
	useEffect(() => {
		if (pdf === null || anchor === null || anchor.length === 0) {
			setEvidence(null);
			return;
		}
		let cancelled = false;
		setEvidence({ state: "searching" });
		void (async () => {
			try {
				// Fast path for multi-page PDFs: ask main's Rust scanner for candidate pages first
				// so only those pages need `pdf.js` `getTextContent()`.
				if (pdf.numPages > 8 && bridge.pdfAnchorPages !== undefined) {
					const candidates = await bridge.pdfAnchorPages(file.path, anchor).catch(() => [] as readonly number[]);
					if (cancelled) return;
					if (candidates.length > 0) {
						const fastMarks = await locateOnCandidatePages(pdf, candidates, anchor);
						if (cancelled) return;
						if (fastMarks !== null) {
							setEvidence({ state: "found", pages: [fastMarks, ...fastMarks.next] });
							return;
						}
					}
				}
				const pages = await pdfText(pdf);
				if (cancelled) return;
				const marks = locateMarks(pages, anchor);
				setEvidence(marks === null ? { state: "missing" } : { state: "found", pages: [marks, ...marks.next] });
			} catch (caught: unknown) {
				// A page whose text cannot be read still draws; the panel opens at the top.
				console.warn(`quick-look: PDF text for ${file.path} failed: ${caught instanceof Error ? caught.message : String(caught)}`);
				if (!cancelled) setEvidence({ state: "missing" });
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [pdf, anchor, file.path, bridge]);

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
	if (prompt !== null) return <PasswordView key={prompt.attempt} file={file} incorrect={prompt.incorrect} onSubmit={prompt.unlock} />;
	if (opened === null) return <Status>{t("quickLook.status.loading")}</Status>;
	const pages = <PagedView file={file} boxes={opened.boxes} draw={draw} evidence={evidence} />;
	return asked ? <ResizeOnReport>{pages}</ResizeOnReport> : pages;
}
