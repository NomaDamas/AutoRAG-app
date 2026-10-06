import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { HwpDocument, initSync } from "@rhwp/core";

let ready = false;

/** Instantiates the rhwp WebAssembly module synchronously from node_modules (tests and QA scripts only). */
export function initRhwpForNode(): void {
	if (ready) return;
	const wasm = createRequire(import.meta.url).resolve("@rhwp/core/rhwp_bg.wasm");
	initSync({ module: readFileSync(wasm) });
	ready = true;
}

/**
 * A real HWP 5 (or HWPX) document with one page per entry of `pages`, each
 * page holding its line of text and ending in a hard page break. Built with
 * rhwp's own writer, so the bytes are what Hancom Office would read.
 */
export function buildHwp(pages: readonly string[], format: "hwp" | "hwpx" = "hwp"): Uint8Array {
	initRhwpForNode();
	const document = HwpDocument.createEmpty();
	try {
		document.createBlankDocument();
		pages.forEach((text, index) => {
			document.insertText(0, index, 0, text);
			if (index < pages.length - 1) document.insertPageBreak(0, index, text.length);
		});
		return format === "hwp" ? document.exportHwp() : document.exportHwpx();
	} finally {
		document.free();
	}
}

/** The characters an rhwp page SVG draws, in order (rhwp emits one `<text>` per glyph run). */
export function svgText(svg: string): string {
	return Array.from(svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g), (match) => match[1] ?? "").join("");
}
