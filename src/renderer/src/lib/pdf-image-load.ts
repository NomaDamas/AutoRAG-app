import * as UTIF from "utif";
import { previewStreamUrl } from "../../../preview/shared/contract";

/** Extensions Chromium cannot decode by itself; the main process (native core / `sips`) decodes them first. */
const MAIN_DECODED_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["tif", "tiff", "heic", "heif"]);

interface DecodedSource {
	readonly source: CanvasImageSource;
	readonly width: number;
	readonly height: number;
	release(): void;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(bytes.byteLength);
	out.set(bytes);
	return out;
}

async function decodeBlob(blob: Blob): Promise<DecodedSource> {
	const url = URL.createObjectURL(blob);
	try {
		const img = await new Promise<HTMLImageElement>((resolve, reject) => {
			const el = new Image();
			el.onload = () => resolve(el);
			el.onerror = () => reject(new Error("Could not decode image."));
			el.src = url;
		});
		return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
	} catch (error) {
		URL.revokeObjectURL(url);
		throw error;
	}
}

/** Same in-page TIFF decode Quick Look uses (first page, RGBA8 — the alpha channel is kept). */
function decodeTiffBytes(bytes: Uint8Array): DecodedSource {
	const pages = UTIF.decode(bytes);
	const page = pages[0];
	if (page === undefined) throw new Error("This TIFF image has no pages.");
	UTIF.decodeImage(bytes, page);
	const rgba = UTIF.toRGBA8(page);
	const canvas = document.createElement("canvas");
	canvas.width = page.width;
	canvas.height = page.height;
	const ctx = canvas.getContext("2d");
	if (ctx === null) throw new Error("Could not decode image.");
	const image = ctx.createImageData(page.width, page.height);
	image.data.set(rgba);
	ctx.putImageData(image, 0, 0);
	return { source: canvas, width: page.width, height: page.height, release: () => undefined };
}

async function decodeViaMain(filePath: string): Promise<DecodedSource> {
	const api = window.autorag?.documentEditor;
	if (api?.pdfDecodeImage === undefined) throw new Error("Could not decode image.");
	const decoded = await api.pdfDecodeImage(filePath);
	if (decoded.mime === "image/png" || decoded.mime === "image/jpeg") {
		return decodeBlob(new Blob([copyBytes(decoded.bytes)], { type: decoded.mime }));
	}
	if (decoded.mime === "image/tiff") return decodeTiffBytes(decoded.bytes);
	const mod = await import("heic-to/csp");
	const png = await mod.heicTo({ blob: new Blob([copyBytes(decoded.bytes)]), type: "image/png" });
	return decodeBlob(png);
}

/**
 * Loads a local picture (PNG, JPEG, WebP, GIF, BMP, SVG, TIFF, HEIC) into a bounded PNG data URL
 * for `pdf-lib` embedding. Everything is drawn onto a transparent canvas and exported as PNG, so
 * transparent PNG/TIFF backgrounds stay transparent on the PDF page (pdf-lib writes the alpha as
 * an SMask). Never opens a native OS file picker.
 */
export async function loadLocalImageAsPngDataUrl(
	filePath: string,
	maxDim = 1600,
): Promise<{ readonly dataUrl: string; readonly aspect: number }> {
	const ext = (filePath.split(".").at(-1) ?? "").toLowerCase();
	let decoded: DecodedSource;
	if (MAIN_DECODED_IMAGE_EXTENSIONS.has(ext)) {
		decoded = await decodeViaMain(filePath);
	} else {
		const response = await fetch(previewStreamUrl(filePath));
		if (!response.ok) throw new Error(`Could not read image (${response.status}).`);
		decoded = await decodeBlob(await response.blob());
	}
	try {
		const natW = Math.max(1, decoded.width);
		const natH = Math.max(1, decoded.height);
		const scale = Math.min(1, maxDim / Math.max(natW, natH));
		const w = Math.max(1, Math.round(natW * scale));
		const h = Math.max(1, Math.round(natH * scale));
		const canvas = document.createElement("canvas");
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext("2d");
		if (ctx === null) throw new Error("Could not decode image.");
		ctx.clearRect(0, 0, w, h);
		ctx.drawImage(decoded.source, 0, 0, w, h);
		return { dataUrl: canvas.toDataURL("image/png"), aspect: w / Math.max(1, h) };
	} finally {
		decoded.release();
	}
}
