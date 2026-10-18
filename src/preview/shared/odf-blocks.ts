/**
 * The block model shared by the `.odt` and `.odp` viewers: headings,
 * paragraphs with styled runs, lists, tables, and inline pictures, read from
 * `office:text` or a `draw:text-box`. Pictures are package entry names, so a
 * large document is cheap to model and inflated only when drawn.
 */
import { attr, childNamed, children, childrenNamed, isElement, lengthPx, safeColor, styleProp, type OdfNode, type OdfStyle } from "./odf-xml";

export interface OdfRun {
	/** `\n` is a line break, `\t` a tab. */
	readonly text: string;
	readonly bold: boolean;
	readonly italic: boolean;
	readonly underline: boolean;
	readonly strike: boolean;
	/** `#rrggbb` or null for the viewer's default. */
	readonly color: string | null;
	/** CSS px or null for the viewer's default. */
	readonly size: number | null;
}

export type OdfAlign = "left" | "center" | "right" | "justify";

export interface OdfImage {
	readonly entry: string;
	readonly width: number | null;
	readonly height: number | null;
}

export interface OdfParagraph {
	readonly kind: "paragraph";
	/** 0 for a body paragraph, 1-6 for a heading. */
	readonly level: number;
	readonly align: OdfAlign | null;
	readonly runs: readonly OdfRun[];
	readonly images: readonly OdfImage[];
}

export interface OdfList {
	readonly kind: "list";
	readonly items: readonly (readonly OdfBlock[])[];
}

export interface OdfCell {
	readonly colSpan: number;
	readonly rowSpan: number;
	readonly blocks: readonly OdfBlock[];
}

export interface OdfTable {
	readonly kind: "table";
	readonly rows: readonly (readonly OdfCell[])[];
}

export type OdfBlock = OdfParagraph | OdfList | OdfTable;

/** A document this large is cut off rather than stalling the window. */
export const MAX_BLOCKS = 20000;
const MAX_SPAN = 1000;
const MAX_SPACES = 500;

export interface BlockContext {
	readonly styles: ReadonlyMap<string, OdfStyle>;
	/** Blocks modelled so far; bounded by `MAX_BLOCKS`. */
	count: number;
}

type RunProps = Omit<OdfRun, "text">;

export const PLAIN_RUN: RunProps = { bold: false, italic: false, underline: false, strike: false, color: null, size: null };

/** Text properties of style `name` laid over `base`. */
export function textProps(ctx: BlockContext, name: string | null, base: RunProps): RunProps {
	if (name === null) return base;
	const prop = (key: string): string | null => styleProp(ctx.styles, name, "text", key);
	const weight = prop("fo:font-weight");
	const fontStyle = prop("fo:font-style");
	const underline = prop("style:text-underline-style");
	const strike = prop("style:text-line-through-style");
	const size = lengthPx(prop("fo:font-size"));
	return {
		bold: weight === null ? base.bold : weight === "bold" || Number(weight) >= 600,
		italic: fontStyle === null ? base.italic : fontStyle === "italic" || fontStyle === "oblique",
		underline: underline === null ? base.underline : underline !== "none",
		strike: strike === null ? base.strike : strike !== "none",
		color: safeColor(prop("fo:color")) ?? base.color,
		size: size !== null && size > 0 ? size : base.size,
	};
}

function alignOf(ctx: BlockContext, name: string | null): OdfAlign | null {
	switch (styleProp(ctx.styles, name, "paragraph", "fo:text-align")) {
		case "center":
			return "center";
		case "end":
		case "right":
			return "right";
		case "justify":
			return "justify";
		case "start":
		case "left":
			return "left";
		default:
			return null;
	}
}

function imageOf(frame: OdfNode): OdfImage | null {
	const image = childNamed(frame, "image");
	const href = attr(image, "xlink:href");
	if (href === null || href === "" || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/") || href.split("/").includes("..")) return null;
	return { entry: href.replace(/^\.\//, ""), width: lengthPx(attr(frame, "svg:width")), height: lengthPx(attr(frame, "svg:height")) };
}

function pushRun(runs: OdfRun[], text: string, props: RunProps): void {
	if (text !== "") runs.push({ text, ...props });
}

function inlineRuns(node: OdfNode, ctx: BlockContext, props: RunProps, runs: OdfRun[], images: OdfImage[]): void {
	for (const child of children(node)) {
		if (!isElement(child)) {
			// Whitespace in ODF XML is collapsed; explicit spaces use `text:s`.
			pushRun(runs, (child.textContent ?? "").replace(/\s+/g, " "), props);
			continue;
		}
		switch (child.localName) {
			case "span":
				inlineRuns(child, ctx, textProps(ctx, attr(child, "text:style-name"), props), runs, images);
				break;
			case "a":
			case "ruby":
			case "ruby-base":
			case "meta":
			case "meta-field":
			case "bookmark-ref":
			case "reference-ref":
				inlineRuns(child, ctx, props, runs, images);
				break;
			case "line-break":
				pushRun(runs, "\n", props);
				break;
			case "tab":
				pushRun(runs, "\t", props);
				break;
			case "s": {
				const count = Number(attr(child, "text:c") ?? "1");
				pushRun(runs, " ".repeat(Number.isFinite(count) ? Math.max(1, Math.min(MAX_SPACES, Math.floor(count))) : 1), props);
				break;
			}
			case "frame": {
				const image = imageOf(child);
				if (image !== null) images.push(image);
				break;
			}
			default:
				// Notes, annotations, change tracking, and fields carry no body text.
				break;
		}
	}
}

/** `text:p`/`text:h` as a paragraph; `base` is the shape's default text style (an `.odp` frame). */
export function readParagraph(node: OdfNode, ctx: BlockContext, base: RunProps = PLAIN_RUN): OdfParagraph {
	const styleName = attr(node, "text:style-name");
	const runs: OdfRun[] = [];
	const images: OdfImage[] = [];
	inlineRuns(node, ctx, textProps(ctx, styleName, base), runs, images);
	const level = node.localName === "h" ? Math.max(1, Math.min(6, Math.floor(Number(attr(node, "text:outline-level") ?? "1")) || 1)) : 0;
	return { kind: "paragraph", level, align: alignOf(ctx, styleName), runs, images };
}

function span(node: OdfNode, name: string): number {
	const value = Number(attr(node, name) ?? "1");
	return Number.isFinite(value) ? Math.max(1, Math.min(MAX_SPAN, Math.floor(value))) : 1;
}

function readTable(node: OdfNode, ctx: BlockContext, base: RunProps): OdfTable {
	const rows: OdfCell[][] = [];
	const addRows = (holder: OdfNode): void => {
		for (const child of children(holder)) {
			if (!isElement(child) || ctx.count >= MAX_BLOCKS) continue;
			if (child.localName === "table-row") {
				const cells: OdfCell[] = [];
				for (const cell of childrenNamed(child, "table-cell")) {
					cells.push({ colSpan: span(cell, "table:number-columns-spanned"), rowSpan: span(cell, "table:number-rows-spanned"), blocks: readBlocks(cell, ctx, base) });
				}
				rows.push(cells);
			} else if (child.localName === "table-header-rows" || child.localName === "table-row-group" || child.localName === "table-rows") {
				addRows(child);
			}
		}
	};
	addRows(node);
	return { kind: "table", rows };
}

/** The blocks under a container (`office:text`, `draw:text-box`, a list item, a table cell, a section). */
export function readBlocks(container: OdfNode, ctx: BlockContext, base: RunProps = PLAIN_RUN): readonly OdfBlock[] {
	const out: OdfBlock[] = [];
	for (const child of children(container)) {
		if (!isElement(child)) continue;
		if (ctx.count >= MAX_BLOCKS) break;
		switch (child.localName) {
			case "p":
			case "h":
				ctx.count += 1;
				out.push(readParagraph(child, ctx, base));
				break;
			case "list": {
				ctx.count += 1;
				const items = childrenNamed(child, "list-item")
					.concat(childrenNamed(child, "list-header"))
					.map((item) => readBlocks(item, ctx, base));
				out.push({ kind: "list", items });
				break;
			}
			case "table":
				ctx.count += 1;
				out.push(readTable(child, ctx, base));
				break;
			case "section":
			case "index-body":
			case "table-of-content":
			case "alphabetical-index":
			case "illustration-index":
			case "user-index":
				out.push(...readBlocks(child, ctx, base));
				break;
			default:
				break;
		}
	}
	return out;
}
