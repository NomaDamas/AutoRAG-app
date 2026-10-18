/**
 * What the OpenDocument readers (`odf-text.ts`, `odf-slides.ts`) walk. XML
 * parsing is injected, like `pptx-model.ts`, so these modules carry no DOM
 * global; the real `Document` satisfies `OdfDocument`.
 */
import { strFromU8, unzipSync } from "fflate";

export interface OdfNode {
	/** 1 element, 3 text. */
	readonly nodeType: number;
	readonly localName: string | null;
	readonly textContent: string | null;
	readonly childNodes: ArrayLike<OdfNode>;
	getAttribute?(name: string): string | null;
}

export interface OdfDocument {
	readonly documentElement: OdfNode | null;
}

export type ParseOdf = (text: string) => OdfDocument | null;

export const XML_CAP = 16 * 1024 * 1024;
/** One embedded picture larger than this is skipped. */
export const PICTURE_CAP = 8 * 1024 * 1024;
/** All embedded pictures together may not exceed this. */
export const PICTURES_TOTAL_CAP = 48 * 1024 * 1024;

const IMAGE_MIME: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	bmp: "image/bmp",
	webp: "image/webp",
	svg: "image/svg+xml",
};

/** The image MIME for a package entry, or null when it is not a picture the preview shows. */
export function pictureMime(entry: string): string | null {
	const dot = entry.lastIndexOf(".");
	return dot < 0 ? null : (IMAGE_MIME[entry.slice(dot + 1).toLowerCase()] ?? null);
}

export function children(node: OdfNode): readonly OdfNode[] {
	const out: OdfNode[] = [];
	for (let index = 0; index < node.childNodes.length; index += 1) {
		const child = node.childNodes[index];
		if (child !== undefined) out.push(child);
	}
	return out;
}

export function isElement(node: OdfNode): boolean {
	return node.nodeType === 1;
}

export function childrenNamed(node: OdfNode | null, localName: string): readonly OdfNode[] {
	return node === null ? [] : children(node).filter((child) => isElement(child) && child.localName === localName);
}

export function childNamed(node: OdfNode | null, localName: string): OdfNode | null {
	return childrenNamed(node, localName)[0] ?? null;
}

export function attr(node: OdfNode | null, name: string): string | null {
	return node === null || node.getAttribute === undefined ? null : node.getAttribute(name);
}

/** Every descendant element with this local name, depth first. */
export function descendantsNamed(node: OdfNode, localName: string): readonly OdfNode[] {
	const out: OdfNode[] = [];
	const walk = (current: OdfNode): void => {
		for (const child of children(current)) {
			if (!isElement(child)) continue;
			if (child.localName === localName) out.push(child);
			walk(child);
		}
	};
	walk(node);
	return out;
}

const CSS_PX_PER: Readonly<Record<string, number>> = { px: 1, pt: 96 / 72, cm: 96 / 2.54, mm: 96 / 25.4, in: 96, pc: 16 };

/** An ODF length (`2.5cm`, `12pt`) in CSS pixels; null when it is not one. */
export function lengthPx(value: string | null): number | null {
	if (value === null) return null;
	const match = /^\s*(-?\d+(?:\.\d+)?|-?\.\d+)\s*(px|pt|cm|mm|in|pc)\s*$/.exec(value);
	if (match === null) return null;
	return Number(match[1]) * (CSS_PX_PER[match[2] ?? "px"] ?? 1);
}

/** `#rrggbb` only: a value that goes into a style attribute must never carry markup or CSS. */
export function safeColor(value: string | null): string | null {
	return value !== null && /^#[0-9a-fA-F]{6}$/.test(value) ? value : null;
}

export interface OdfStyle {
	readonly parent: string | null;
	readonly text: OdfNode | null;
	readonly paragraph: OdfNode | null;
	readonly graphic: OdfNode | null;
	readonly page: OdfNode | null;
}

/** Named and automatic styles of one `content.xml`/`styles.xml` root, keyed by `style:name`. */
export function collectStyles(root: OdfNode | null, into: Map<string, OdfStyle>): void {
	if (root === null) return;
	for (const holder of [...childrenNamed(root, "automatic-styles"), ...childrenNamed(root, "styles")]) {
		for (const style of childrenNamed(holder, "style")) {
			const name = attr(style, "style:name");
			if (name === null) continue;
			into.set(name, {
				parent: attr(style, "style:parent-style-name"),
				text: childNamed(style, "text-properties"),
				paragraph: childNamed(style, "paragraph-properties"),
				graphic: childNamed(style, "graphic-properties"),
				page: childNamed(style, "drawing-page-properties"),
			});
		}
	}
}

export type StyleFacet = "text" | "paragraph" | "graphic" | "page";

/** One property through the `style:parent-style-name` chain; a cycle ends the walk. */
export function styleProp(styles: ReadonlyMap<string, OdfStyle>, name: string | null, facet: StyleFacet, key: string): string | null {
	const seen = new Set<string>();
	let current = name;
	while (current !== null && !seen.has(current)) {
		seen.add(current);
		const style = styles.get(current);
		if (style === undefined) return null;
		const value = attr(style[facet], key);
		if (value !== null) return value;
		current = style.parent;
	}
	return null;
}

/** Reads and decodes the named parts of an ODF package; null when it is not a readable ZIP. */
export function readParts(bytes: Uint8Array, wanted: (name: string) => boolean): Map<string, Uint8Array> | null {
	try {
		const files = unzipSync(bytes, {
			filter: (entry) => wanted(entry.name) && entry.originalSize <= XML_CAP && (entry.compression === 0 || entry.compression === 8),
		});
		return new Map(Object.entries(files));
	} catch {
		return null;
	}
}

export function parsePart(parts: ReadonlyMap<string, Uint8Array>, name: string, parseXml: ParseOdf): OdfNode | null {
	const data = parts.get(name);
	if (data === undefined) return null;
	try {
		return parseXml(strFromU8(data))?.documentElement ?? null;
	} catch {
		return null;
	}
}
