import { GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

let pdfWorkerReady = false;

/** Points pdf.js at its bundled worker once per renderer. */
export function ensurePdfWorker(): void {
	if (pdfWorkerReady) return;
	GlobalWorkerOptions.workerSrc = workerUrl;
	pdfWorkerReady = true;
}
