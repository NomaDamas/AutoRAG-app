import { useEffect, useState } from "react";
import { previewStreamUrl } from "../../../preview/shared/contract";
import { hwpFirstPageUrl } from "../../../preview/ui/rhwp";
import type { FinderEntry } from "../data/entries";
import { hasFileVersion } from "../data/entries";
import { hostPlatform } from "./shortcuts";

/**
 * First-page tiles for PDF and HWP/HWPX where the OS draws none.
 *
 * macOS Quick Look thumbnails both. Windows has no PDF or HWP thumbnail provider unless a reader installs one
 * (`nativeImage.createThumbnailFromPath` fails with "Failed to get thumbnail from local thumbnail cache reference"),
 * so those rows showed a letter tile although the Quick Look window and the Info panel can draw the document. The
 * same engines (pdf.js, rhwp) draw the first page here, into a small PNG. Linux keeps its type icon from the main
 * process; only a row the OS left without any icon is drawn.
 */

/** One page render at a time per slot: a folder of PDFs must not starve the listing of CPU. */
const CONCURRENCY = 2;
const CACHE_LIMIT = 400;

const FIRST_PAGE_EXTENSION = /\.(pdf|hwpx?)$/i;

let pdfWorkerReady = false;
let running = 0;
const waiting: Array<() => void> = [];
const cache = new Map<string, Promise<string | null>>();

async function slot<T>(work: () => Promise<T>): Promise<T> {
	if (running >= CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
	running += 1;
	try {
		return await work();
	} finally {
		running -= 1;
		waiting.shift()?.();
	}
}

async function pdfFirstPage(path: string, width: number): Promise<string | null> {
	const pdfjs = await import("pdfjs-dist");
	if (!pdfWorkerReady) {
		const { default: workerUrl } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
		pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
		pdfWorkerReady = true;
	}
	const task = pdfjs.getDocument({ url: previewStreamUrl(path), disableAutoFetch: true });
	try {
		const page = await (await task.promise).getPage(1);
		const natural = page.getViewport({ scale: 1 });
		const viewport = page.getViewport({ scale: width / natural.width });
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.ceil(viewport.width));
		canvas.height = Math.max(1, Math.ceil(viewport.height));
		await page.render({ canvas, viewport }).promise;
		return canvas.toDataURL("image/png");
	} finally {
		void task.destroy();
	}
}

/** rhwp draws SVG; a tile is a few KB of PNG instead of a 100KB+ SVG data URL per row. */
async function hwpFirstPage(path: string, width: number): Promise<string | null> {
	const svg = await hwpFirstPageUrl(path);
	if (svg === null) return null;
	const image = new Image();
	image.src = svg;
	await image.decode();
	if (image.naturalWidth === 0 || image.naturalHeight === 0) return null;
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = Math.max(1, Math.round((width * image.naturalHeight) / image.naturalWidth));
	const context = canvas.getContext("2d");
	if (context === null) return null;
	context.fillStyle = "#fff";
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.drawImage(image, 0, 0, canvas.width, canvas.height);
	return canvas.toDataURL("image/png");
}

/** A PNG data URL of the document's first page, or null when it cannot be drawn (cached either way). */
export function firstPageTile(path: string, mtimeMs: number, width: number): Promise<string | null> {
	const key = `${path}\u0000${mtimeMs}\u0000${width}`;
	const cached = cache.get(key);
	if (cached !== undefined) return cached;
	const draw = /\.pdf$/i.test(path) ? pdfFirstPage : hwpFirstPage;
	const pending = slot(() => draw(path, width)).catch((error: unknown) => {
		console.warn(`first-page tile for ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	});
	cache.set(key, pending);
	while (cache.size > CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
	return pending;
}

/** True for a row this module draws when the OS gave it no tile icon. */
export function wantsFirstPageTile(entry: FinderEntry): boolean {
	return hostPlatform() !== "darwin" && entry.kind === "file" && entry.iconUrl === undefined && hasFileVersion(entry) && FIRST_PAGE_EXTENSION.test(entry.name);
}

/** The row's first-page tile once drawn; null while drawing, when the OS already supplied an icon, or on failure. */
export function useFirstPageTile(entry: FinderEntry, width: number): string | null {
	const wanted = wantsFirstPageTile(entry);
	const [url, setUrl] = useState<string | null>(null);
	useEffect(() => {
		setUrl(null);
		if (!wanted) return;
		let cancelled = false;
		void firstPageTile(entry.path, entry.mtimeMs, width).then((next) => {
			if (!cancelled) setUrl(next);
		});
		return () => {
			cancelled = true;
		};
	}, [wanted, entry.path, entry.mtimeMs, width]);
	return url;
}
