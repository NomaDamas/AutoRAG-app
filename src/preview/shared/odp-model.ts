/**
 * The `.odp` model: every `draw:page` of `content.xml` as absolutely
 * positioned shapes on a page of the master's size, in CSS px. Pictures are
 * package entry names, inflated only when a slide is drawn. XML parsing is
 * injected (`ParseOdf`), like `pptx-model.ts`.
 */
import { type BlockContext, type OdfBlock, PLAIN_RUN, readBlocks, textProps } from "./odf-blocks";
import {
	attr,
	childNamed,
	children,
	childrenNamed,
	collectStyles,
	isElement,
	lengthPx,
	parsePart,
	readParts,
	safeColor,
	styleProp,
	type OdfNode,
	type OdfStyle,
	type ParseOdf,
} from "./odf-xml";

const DEFAULT_WIDTH = 1058;
const DEFAULT_HEIGHT = 794;
/** A deck this long is cut; the rail could not show it anyway. */
export const MAX_SLIDES = 500;
const MAX_SHAPES = 2000;

export interface OdpShape {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
	/** Degrees clockwise. */
	readonly rot: number;
	readonly fill: string | null;
	readonly stroke: string | null;
	/** `rect`, `ellipse`, or `line` for a drawn shape; `frame` for a text box or picture. */
	readonly geometry: "rect" | "ellipse" | "line" | "frame";
	readonly blocks: readonly OdfBlock[];
	/** Package entry of a picture frame. */
	readonly picture: string | null;
	/** Vertical text anchor: `top`, `middle`, or `bottom`. */
	readonly anchor: "top" | "middle" | "bottom";
}

export interface OdpSlide {
	readonly background: string | null;
	readonly shapes: readonly OdpShape[];
	/** Picture entries this slide needs. */
	readonly media: readonly string[];
}

export interface OdpDeck {
	/** Natural page size in CSS px. */
	readonly width: number;
	readonly height: number;
	readonly slides: readonly OdpSlide[];
}

function pageSize(styles: readonly OdfNode[], masters: readonly OdfNode[], pageMaster: string | null): { readonly width: number; readonly height: number } {
	const master = masters.find((candidate) => attr(candidate, "style:name") === pageMaster) ?? masters[0];
	const layoutName = attr(master ?? null, "style:page-layout-name");
	for (const layout of styles) {
		if (layoutName !== null && attr(layout, "style:name") !== layoutName) continue;
		const props = childNamed(layout, "page-layout-properties");
		const width = lengthPx(attr(props, "fo:page-width"));
		const height = lengthPx(attr(props, "fo:page-height"));
		if (width !== null && height !== null && width > 0 && height > 0) return { width, height };
	}
	return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
}

function transformOf(node: OdfNode): { readonly rot: number; readonly dx: number; readonly dy: number } | null {
	const raw = attr(node, "draw:transform");
	if (raw === null) return null;
	const rotate = /rotate\s*\(\s*(-?[\d.]+)\s*\)/.exec(raw);
	const translate = /translate\s*\(\s*(-?[\d.]+)([a-z]*)\s+(-?[\d.]+)([a-z]*)\s*\)/.exec(raw);
	const rot = rotate === null ? 0 : -(Number(rotate[1]) * 180) / Math.PI;
	const dx = translate === null ? 0 : (lengthPx(`${translate[1]}${translate[2] || "px"}`) ?? 0);
	const dy = translate === null ? 0 : (lengthPx(`${translate[3]}${translate[4] || "px"}`) ?? 0);
	return { rot: Number.isFinite(rot) ? rot : 0, dx, dy };
}

interface Walk {
	readonly ctx: BlockContext;
	shapes: OdpShape[];
	media: Set<string>;
}

function readShape(node: OdfNode, walk: Walk): void {
	if (walk.shapes.length >= MAX_SHAPES) return;
	const name = node.localName;
	if (name === "g") {
		for (const child of children(node)) if (isElement(child)) readShape(child, walk);
		return;
	}
	if (name !== "frame" && name !== "custom-shape" && name !== "rect" && name !== "ellipse" && name !== "circle" && name !== "line") return;
	// A placeholder in a master is a prompt for the slide, not content.
	if (attr(node, "presentation:placeholder") === "true") return;
	const style = attr(node, "draw:style-name") ?? attr(node, "presentation:style-name");
	const transform = transformOf(node);
	let x = lengthPx(attr(node, "svg:x")) ?? 0;
	let y = lengthPx(attr(node, "svg:y")) ?? 0;
	let w = lengthPx(attr(node, "svg:width")) ?? 0;
	let h = lengthPx(attr(node, "svg:height")) ?? 0;
	if (name === "line") {
		const x1 = lengthPx(attr(node, "svg:x1")) ?? 0;
		const y1 = lengthPx(attr(node, "svg:y1")) ?? 0;
		const x2 = lengthPx(attr(node, "svg:x2")) ?? 0;
		const y2 = lengthPx(attr(node, "svg:y2")) ?? 0;
		x = Math.min(x1, x2);
		y = Math.min(y1, y2);
		w = Math.abs(x2 - x1);
		h = Math.abs(y2 - y1);
	}
	if (transform !== null) {
		x += transform.dx;
		y += transform.dy;
	}
	const fillMode = styleProp(walk.ctx.styles, style, "graphic", "draw:fill");
	const strokeMode = styleProp(walk.ctx.styles, style, "graphic", "draw:stroke");
	const fill = fillMode === "solid" ? safeColor(styleProp(walk.ctx.styles, style, "graphic", "draw:fill-color")) : null;
	const stroke = strokeMode === "solid" || name === "line" ? (safeColor(styleProp(walk.ctx.styles, style, "graphic", "svg:stroke-color")) ?? "#000000") : null;
	const anchorRaw = styleProp(walk.ctx.styles, style, "graphic", "draw:textarea-vertical-align");
	const anchor = anchorRaw === "middle" || anchorRaw === "bottom" ? anchorRaw : "top";
	const textBox = name === "frame" ? childNamed(node, "text-box") : node;
	const image = name === "frame" ? childNamed(node, "image") : null;
	const href = attr(image, "xlink:href");
	const picture = href !== null && href !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("/") && !href.split("/").includes("..") ? href.replace(/^\.\//, "") : null;
	if (picture !== null) walk.media.add(picture);
	const base = textProps(walk.ctx, style, PLAIN_RUN);
	const blocks = textBox === null ? [] : readBlocks(textBox, walk.ctx, base);
	if (name === "frame" && picture === null && blocks.length === 0) return;
	walk.shapes.push({
		x,
		y,
		w,
		h,
		rot: transform?.rot ?? 0,
		fill,
		stroke,
		geometry: name === "frame" ? "frame" : name === "ellipse" || name === "circle" ? "ellipse" : name === "line" ? "line" : "rect",
		blocks,
		picture,
		anchor,
	});
}

function readShapes(container: OdfNode, walk: Walk): void {
	for (const child of children(container)) if (isElement(child)) readShape(child, walk);
}

function backgroundOf(styles: ReadonlyMap<string, OdfStyle>, name: string | null): string | null {
	if (styleProp(styles, name, "page", "draw:fill") !== "solid") return null;
	return safeColor(styleProp(styles, name, "page", "draw:fill-color"));
}

export function buildOdpDeck(bytes: Uint8Array, parseXml: ParseOdf): OdpDeck | null {
	const parts = readParts(bytes, (name) => name === "content.xml" || name === "styles.xml");
	if (parts === null) return null;
	const content = parsePart(parts, "content.xml", parseXml);
	const body = childNamed(childNamed(content, "body"), "presentation");
	if (content === null || body === null) return null;
	const stylesRoot = parsePart(parts, "styles.xml", parseXml);
	const styles = new Map<string, OdfStyle>();
	collectStyles(stylesRoot, styles);
	collectStyles(content, styles);
	const layouts = [...childrenNamed(stylesRoot, "automatic-styles"), ...childrenNamed(content, "automatic-styles")].flatMap((holder) => childrenNamed(holder, "page-layout"));
	const masters = childrenNamed(childNamed(stylesRoot, "master-styles"), "master-page");
	const pages = childrenNamed(body, "page").slice(0, MAX_SLIDES);
	if (pages.length === 0) return null;
	const { width, height } = pageSize(layouts, masters, attr(pages[0] ?? null, "draw:master-page-name"));
	const slides = pages.map((page): OdpSlide => {
		const walk: Walk = { ctx: { styles, count: 0 }, shapes: [], media: new Set() };
		const masterName = attr(page, "draw:master-page-name");
		const master = masters.find((candidate) => attr(candidate, "style:name") === masterName);
		if (master !== undefined) readShapes(master, walk);
		readShapes(page, walk);
		const pageStyle = attr(page, "draw:style-name");
		const background = backgroundOf(styles, pageStyle) ?? backgroundOf(styles, attr(master ?? null, "draw:style-name"));
		return { background, shapes: walk.shapes, media: [...walk.media] };
	});
	return { width, height, slides };
}
