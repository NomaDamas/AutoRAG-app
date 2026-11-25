import type { DocumentInitParameters } from "pdfjs-dist/types/src/display/api";

/**
 * URLs for pdf.js runtime support assets (`cmaps/`, `standard_fonts/`, `wasm/`,
 * `iccs/`). Without `cMapUrl`, PDFs that reference predefined CJK CMaps such as
 * `UniKS-UTF16-H` with unembedded CIDFonts drop every glyph on the page;
 * without `standardFontDataUrl`, PDFs relying on the standard 14 fonts fail to
 * load their fallback font programs; `wasmUrl` and `iccUrl` enable JPEG2000,
 * JBIG2, and CMYK ICC color decoding.
 *
 * The Vite plugin `pdfjsSupportAssets` in `electron.vite.config.ts` serves these
 * four directories at `<renderer-root>/pdfjs/{cmaps,standard_fonts,wasm,iccs}/`
 * in dev and emits them into `out/renderer/pdfjs/...` for production and remote
 * serving.
 */
export interface PdfSupportUrls {
	readonly cMapUrl: string;
	readonly standardFontDataUrl: string;
	readonly wasmUrl: string;
	readonly iccUrl: string;
}

function defaultBaseUrl(): string {
	const doc = Reflect.get(globalThis, "document") as { readonly baseURI?: unknown } | undefined;
	if (typeof doc?.baseURI === "string" && doc.baseURI.length > 0) {
		return doc.baseURI;
	}
	const win = Reflect.get(globalThis, "window") as { readonly location?: { readonly href?: unknown } } | undefined;
	if (typeof win?.location?.href === "string" && win.location.href.length > 0) {
		return win.location.href;
	}
	return "http://localhost/";
}

/** Resolve trailing-slash URLs for the bundled pdf.js support directories relative to the renderer page. */
export function pdfSupportUrls(baseUrl: string = defaultBaseUrl()): PdfSupportUrls {
	return {
		cMapUrl: new URL("pdfjs/cmaps/", baseUrl).toString(),
		standardFontDataUrl: new URL("pdfjs/standard_fonts/", baseUrl).toString(),
		wasmUrl: new URL("pdfjs/wasm/", baseUrl).toString(),
		iccUrl: new URL("pdfjs/iccs/", baseUrl).toString(),
	};
}

/** Shared `pdfjs.getDocument(...)` input for every renderer surface (Quick Look, PDF editor, first-page tiles). */
export function pdfDocumentSource(url: string, baseUrl?: string): DocumentInitParameters {
	const support = pdfSupportUrls(baseUrl);
	return {
		url,
		disableAutoFetch: true,
		cMapUrl: support.cMapUrl,
		cMapPacked: true,
		standardFontDataUrl: support.standardFontDataUrl,
		wasmUrl: support.wasmUrl,
		iccUrl: support.iccUrl,
	};
}
