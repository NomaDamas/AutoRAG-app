/**
 * Draws ODF blocks and `.odp` slides as inert DOM. The DOM is injected
 * (`OdfDom`) so this module carries no DOM types; every string is set through
 * `textContent`/`setAttribute`, never HTML, and every value that reaches a
 * style attribute is a number or a validated `#rrggbb`.
 */
import type { OdfBlock, OdfCell, OdfImage, OdfParagraph, OdfRun } from "./odf-blocks";
import type { OdpDeck, OdpShape } from "./odp-model";

export interface OdfDomElement {
	textContent: string | null;
	setAttribute(name: string, value: string): void;
	appendChild(child: OdfDomElement): void;
}

export interface OdfDom {
	createElement(tag: string): OdfDomElement;
}

/** Entry name -> URL the picture can be loaded from, or null when it is unavailable. */
export type ResolvePicture = (entry: string) => string | null;

const FONT_STACK = '"Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif';

function make(dom: OdfDom, tag: string, style = ""): OdfDomElement {
	const node = dom.createElement(tag);
	if (style !== "") node.setAttribute("style", style);
	return node;
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

function runStyle(run: OdfRun): string {
	let style = "";
	if (run.bold) style += "font-weight:700;";
	if (run.italic) style += "font-style:italic;";
	const decorations = [run.underline ? "underline" : "", run.strike ? "line-through" : ""].filter((part) => part !== "");
	if (decorations.length > 0) style += `text-decoration:${decorations.join(" ")};`;
	if (run.color !== null) style += `color:${run.color};`;
	if (run.size !== null) style += `font-size:${round(run.size)}px;`;
	return style;
}

function picture(dom: OdfDom, image: OdfImage, resolve: ResolvePicture): OdfDomElement | null {
	const url = resolve(image.entry);
	if (url === null) return null;
	const node = make(dom, "img", `max-width:100%;${image.width !== null ? `width:${round(image.width)}px;` : ""}${image.height !== null ? `height:${round(image.height)}px;` : ""}`);
	node.setAttribute("src", url);
	node.setAttribute("alt", "");
	return node;
}

function paragraph(dom: OdfDom, block: OdfParagraph, resolve: ResolvePicture): OdfDomElement {
	const node = make(dom, block.level === 0 ? "p" : `h${block.level}`, `margin:0 0 .6em;${block.align === null ? "" : `text-align:${block.align};`}white-space:pre-wrap;`);
	for (const run of block.runs) {
		const span = make(dom, "span", runStyle(run));
		span.textContent = run.text;
		node.appendChild(span);
	}
	for (const image of block.images) {
		const img = picture(dom, image, resolve);
		if (img !== null) node.appendChild(img);
	}
	if (block.runs.length === 0 && block.images.length === 0) node.appendChild(make(dom, "br"));
	return node;
}

function cell(dom: OdfDom, source: OdfCell, resolve: ResolvePicture): OdfDomElement {
	const node = make(dom, "td", "border:1px solid #bbb;padding:4px 8px;vertical-align:top;");
	if (source.colSpan > 1) node.setAttribute("colspan", String(source.colSpan));
	if (source.rowSpan > 1) node.setAttribute("rowspan", String(source.rowSpan));
	for (const child of renderBlocks(dom, source.blocks, resolve)) node.appendChild(child);
	return node;
}

/** The DOM for a block sequence, in order. */
export function renderBlocks(dom: OdfDom, blocks: readonly OdfBlock[], resolve: ResolvePicture): readonly OdfDomElement[] {
	return blocks.map((block): OdfDomElement => {
		if (block.kind === "paragraph") return paragraph(dom, block, resolve);
		if (block.kind === "list") {
			const list = make(dom, "ul", "margin:0 0 .6em;padding-left:1.6em;");
			for (const item of block.items) {
				const li = make(dom, "li");
				for (const child of renderBlocks(dom, item, resolve)) li.appendChild(child);
				list.appendChild(li);
			}
			return list;
		}
		const table = make(dom, "table", "border-collapse:collapse;margin:0 0 .8em;");
		const body = make(dom, "tbody");
		for (const row of block.rows) {
			const tr = make(dom, "tr");
			for (const source of row) tr.appendChild(cell(dom, source, resolve));
			body.appendChild(tr);
		}
		table.appendChild(body);
		return table;
	});
}

/** An `.odt` as one white page column of inert DOM. */
export function renderOdt(dom: OdfDom, blocks: readonly OdfBlock[], resolve: ResolvePicture): OdfDomElement {
	const page = make(dom, "div", `box-sizing:border-box;max-width:794px;margin:0 auto;padding:48px 56px;background:#fff;color:#111;font:14px/1.5 ${FONT_STACK};`);
	for (const child of renderBlocks(dom, blocks, resolve)) page.appendChild(child);
	return page;
}

const ANCHOR: Readonly<Record<OdpShape["anchor"], string>> = { top: "flex-start", middle: "center", bottom: "flex-end" };

function shape(dom: OdfDom, source: OdpShape, resolve: ResolvePicture): OdfDomElement {
	const geometry = source.geometry === "ellipse" ? "border-radius:50%;" : "";
	const fill = source.fill === null ? "" : `background:${source.fill};`;
	const border = source.stroke !== null && source.geometry !== "line" ? `border:1px solid ${source.stroke};` : "";
	const rotation = source.rot === 0 ? "" : `transform:rotate(${round(source.rot)}deg);`;
	const node = make(
		dom,
		"div",
		`position:absolute;box-sizing:border-box;overflow:hidden;left:${round(source.x)}px;top:${round(source.y)}px;width:${round(source.w)}px;height:${round(source.h)}px;display:flex;flex-direction:column;justify-content:${ANCHOR[source.anchor]};${fill}${border}${geometry}${rotation}`,
	);
	if (source.geometry === "line") {
		const line = make(dom, "div", `width:100%;height:100%;border-top:1px solid ${source.stroke ?? "#000000"};`);
		node.appendChild(line);
	}
	if (source.picture !== null) {
		const url = resolve(source.picture);
		if (url !== null) {
			const img = make(dom, "img", "width:100%;height:100%;object-fit:contain;");
			img.setAttribute("src", url);
			img.setAttribute("alt", "");
			node.appendChild(img);
		}
	}
	for (const child of renderBlocks(dom, source.blocks, resolve)) node.appendChild(child);
	return node;
}

/** Slide `index` at the deck's natural pixel size. */
export function renderOdpSlide(dom: OdfDom, deck: OdpDeck, index: number, resolve: ResolvePicture): OdfDomElement {
	const slide = deck.slides[index];
	const root = make(
		dom,
		"div",
		`position:relative;overflow:hidden;width:${round(deck.width)}px;height:${round(deck.height)}px;background:${slide?.background ?? "#ffffff"};color:#000;font:18px/1.25 ${FONT_STACK};`,
	);
	for (const item of slide?.shapes ?? []) root.appendChild(shape(dom, item, resolve));
	return root;
}
