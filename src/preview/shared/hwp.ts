import { HwpDocument } from "@rhwp/core";
import type { Size } from "./fit";

/**
 * rhwp's WebAssembly loader. Every rhwp use goes through this module: in dev,
 * Vite can stamp two imports of `@rhwp/core` with different `?v=` hashes,
 * and a second module instance would be uninitialised.
 */
export { default as initRhwp } from "@rhwp/core";

/**
 * One open HWP 5 / HWPX / HWP 3 document, paginated by rhwp: the size of
 * every page in CSS pixels and each page as a standalone SVG.
 * `initRhwp` must have resolved before `openHwp` runs.
 */
export interface HwpPages {
	readonly boxes: readonly Size[];
	svg(index: number): string;
	/** Releases the document's WebAssembly memory; the object is unusable afterwards. */
	close(): void;
}

/** rhwp throws plain strings (Korean messages with an error code); the viewer expects `Error`s. */
function rhwp<T>(run: () => T): T {
	try {
		return run();
	} catch (caught) {
		if (typeof caught === "string") throw new Error(caught);
		throw caught;
	}
}

function pageBox(info: string): Size {
	const parsed: unknown = JSON.parse(info);
	if (typeof parsed === "object" && parsed !== null && "width" in parsed && "height" in parsed) {
		const { width, height } = parsed;
		if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) return { width, height };
	}
	throw new Error(`rhwp page info has no page size: ${info}`);
}

export function openHwp(bytes: Uint8Array): HwpPages {
	const document = rhwp(() => new HwpDocument(bytes));
	let boxes: Size[];
	try {
		boxes = Array.from({ length: document.pageCount() }, (_unused, index) => pageBox(rhwp(() => document.getPageInfo(index))));
	} catch (caught) {
		document.free();
		throw caught;
	}
	return {
		boxes,
		svg: (index) => rhwp(() => document.renderPageSvg(index)),
		close: () => document.free(),
	};
}
