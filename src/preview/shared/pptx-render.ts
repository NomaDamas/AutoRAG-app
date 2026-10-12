/**
 * Draws a `PptxDeck` slide as a DOM tree: one absolutely positioned element per
 * shape, at the slide's natural pixel size (`EMU_PER_PX`). The DOM is injected
 * (`PptxDom`) so this module carries no DOM types — `ui/pptx.tsx` passes
 * `document` — and every string is set through `textContent`/`setAttribute`,
 * never HTML. Text is real, selectable DOM text, so a slide scales with CSS.
 */
import { t } from "../../shared/i18n/core";
import { assertNever } from "./assert";
import { EMU_PER_PX, type PptxNode, type PptxParagraph, type PptxRun, type PptxSlide, type PptxText, type PptxTransform, type PptxDeck } from "./pptx-model";

/** The minimal element surface the renderer uses; the DOM satisfies it. */
export interface PptxDomElement {
	readonly localName: string;
	readonly childNodes: ArrayLike<PptxDomElement>;
	textContent: string | null;
	setAttribute(name: string, value: string): void;
	getAttribute(name: string): string | null;
	appendChild(child: PptxDomElement): void;
}

export interface PptxDom {
	createElement(tag: string): PptxDomElement;
}

const FONT_FALLBACK = ['"Apple SD Gothic Neo"', '"Malgun Gothic"', '"Noto Sans KR"', "sans-serif"];
const CJK_FONT = FONT_FALLBACK.join(", ");

function px(emu: number): number {
	return Math.round((emu / EMU_PER_PX) * 100) / 100;
}

function deg(value: number): number {
	return Math.round(value * 100) / 100;
}

function element(dom: PptxDom, className: string, style: string): PptxDomElement {
	const node = dom.createElement("div");
	node.setAttribute("class", className);
	node.setAttribute("style", style);
	return node;
}

function boxStyle(transform: PptxTransform): string {
	return `position:absolute;left:${px(transform.x)}px;top:${px(transform.y)}px;width:${px(transform.w)}px;height:${px(transform.h)}px;`;
}

function rotationStyle(transform: PptxTransform): string {
	const flip = `${transform.flipH ? " scaleX(-1)" : ""}${transform.flipV ? " scaleY(-1)" : ""}`;
	if (transform.rot === 0 && flip === "") return "";
	return `transform:rotate(${deg(transform.rot)}deg)${flip};transform-origin:center;`;
}

function runFontFamily(run: PptxRun): string {
	const names: string[] = [];
	if (run.latin !== null) names.push(`"${run.latin}"`);
	if (run.ea !== null && run.ea !== run.latin) names.push(`"${run.ea}"`);
	names.push(...FONT_FALLBACK);
	return names.join(", ");
}

function appendRun(content: PptxDomElement, run: PptxRun, dom: PptxDom): void {
	const decoration = `${run.underline ? "text-decoration:underline;" : ""}`;
	const style = `font-size:${Math.round((run.size * 96) / 72 * 100) / 100}px;color:${run.color};font-family:${runFontFamily(run)};${run.bold ? "font-weight:700;" : ""}${run.italic ? "font-style:italic;" : ""}${decoration}`;
	const parts = run.text.split("\n");
	parts.forEach((part, index) => {
		if (index > 0) content.appendChild(dom.createElement("br"));
		if (part === "") return;
		const span = dom.createElement("span");
		span.setAttribute("style", style);
		span.textContent = part;
		content.appendChild(span);
	});
}

function alignCss(align: PptxParagraph["align"]): string {
	switch (align) {
		case "ctr":
			return "center";
		case "r":
			return "right";
		case "just":
		case "dist":
			return "justify";
		default:
			return "left";
	}
}

function renderParagraph(paragraph: PptxParagraph, dom: PptxDom): PptxDomElement {
	const row = element(
		dom,
		"pptx-para",
		`display:flex;flex-direction:row;align-items:flex-start;text-align:${alignCss(paragraph.align)};padding-left:${px(paragraph.indent)}px;margin-top:${px(paragraph.spaceBefore)}px;margin-bottom:${px(paragraph.spaceAfter)}px;`,
	);
	if (paragraph.bullet !== null) {
		const bullet = dom.createElement("span");
		bullet.setAttribute("style", "flex:0 0 14px;white-space:pre;");
		bullet.textContent = paragraph.bullet;
		row.appendChild(bullet);
	}
	const content = dom.createElement("span");
	content.setAttribute("style", `flex:1 1 auto;text-align:${alignCss(paragraph.align)};white-space:pre-wrap;word-break:break-word;`);
	for (const run of paragraph.runs) appendRun(content, run, dom);
	row.appendChild(content);
	return row;
}

function renderText(text: PptxText, dom: PptxDom, absolute: boolean): PptxDomElement {
	const justify = text.anchor === "ctr" ? "center" : text.anchor === "b" ? "flex-end" : "flex-start";
	const placement = absolute ? "position:absolute;left:0;top:0;right:0;bottom:0;" : "position:relative;width:100%;height:100%;";
	const container = element(
		dom,
		"pptx-text",
		`${placement}padding:${px(text.inset.t)}px ${px(text.inset.r)}px ${px(text.inset.b)}px ${px(text.inset.l)}px;box-sizing:border-box;overflow:hidden;display:flex;flex-direction:column;justify-content:${justify};`,
	);
	for (const paragraph of text.paragraphs) container.appendChild(renderParagraph(paragraph, dom));
	return container;
}

function renderShape(node: Extract<PptxNode, { kind: "shape" }>, dom: PptxDom): PptxDomElement {
	const background = node.fill === null ? "" : `background:${node.fill.color};`;
	const border = node.line === null ? "" : `border:${Math.max(1, px(node.line.width))}px solid ${node.line.color};`;
	const radius =
		node.geometry === "ellipse"
			? "border-radius:50%;"
			: node.geometry === "roundRect"
				? `border-radius:${Math.min(12, Math.round(px(Math.min(node.transform.w, node.transform.h) * 0.12)))}px;`
				: "";
	const shape = element(dom, "pptx-shape", `${boxStyle(node.transform)}box-sizing:border-box;${background}${border}${radius}${rotationStyle(node.transform)}`);
	if (node.text !== null) shape.appendChild(renderText(node.text, dom, true));
	return shape;
}

function renderPicture(
	node: Extract<PptxNode, { kind: "picture" }>,
	dom: PptxDom,
	resolveImage: (entry: string) => string | null,
): PptxDomElement {
	const container = element(dom, "pptx-picture", `${boxStyle(node.transform)}overflow:hidden;${rotationStyle(node.transform)}`);
	const url = resolveImage(node.entry);
	if (url === null) {
		container.setAttribute("style", `${container.getAttribute("style") ?? ""}display:flex;align-items:center;justify-content:center;border:1px dashed rgba(0,0,0,0.35);color:#777;font-size:12px;box-sizing:border-box;`);
		container.textContent = t("quickLook.pptx.image");
		return container;
	}
	const fullWidth = node.transform.w / Math.max(0.0001, 1 - node.crop.l - node.crop.r);
	const fullHeight = node.transform.h / Math.max(0.0001, 1 - node.crop.t - node.crop.b);
	const image = dom.createElement("img");
	image.setAttribute("src", url);
	image.setAttribute("alt", "");
	image.setAttribute(
		"style",
		`position:absolute;left:${px(-node.crop.l * fullWidth)}px;top:${px(-node.crop.t * fullHeight)}px;width:${px(fullWidth)}px;height:${px(fullHeight)}px;object-fit:fill;`,
	);
	container.appendChild(image);
	return container;
}

function renderGroup(
	node: Extract<PptxNode, { kind: "group" }>,
	dom: PptxDom,
	resolveImage: (entry: string) => string | null,
): PptxDomElement {
	const group = element(dom, "pptx-group", `${boxStyle(node.transform)}${rotationStyle(node.transform)}`);
	const scaleX = node.childExtent.w === 0 ? 1 : node.transform.w / node.childExtent.w;
	const scaleY = node.childExtent.h === 0 ? 1 : node.transform.h / node.childExtent.h;
	const inner = element(
		dom,
		"pptx-group-inner",
		`position:absolute;left:0;top:0;width:${px(node.childExtent.w)}px;height:${px(node.childExtent.h)}px;transform-origin:top left;transform:scale(${deg(scaleX)}, ${deg(scaleY)}) translate(${px(-node.childOffset.x)}px, ${px(-node.childOffset.y)}px);`,
	);
	for (const child of node.children) inner.appendChild(renderNode(child, dom, resolveImage));
	group.appendChild(inner);
	return group;
}

function renderCell(cell: Extract<PptxNode, { kind: "table" }>["rows"][number]["cells"][number], column: number, row: number, dom: PptxDom): PptxDomElement {
	const background = cell.fill === null ? "" : `background:${cell.fill.color};`;
	const elementNode = element(
		dom,
		"pptx-cell",
		`grid-column:${column + 1} / span ${cell.gridSpan};grid-row:${row + 1} / span ${cell.rowSpan};box-sizing:border-box;overflow:hidden;padding:4px;outline:0.5px solid rgba(0,0,0,0.18);${background}`,
	);
	if (cell.text !== null) elementNode.appendChild(renderText(cell.text, dom, false));
	return elementNode;
}

function renderTable(node: Extract<PptxNode, { kind: "table" }>, dom: PptxDom): PptxDomElement {
	const columns = node.columns.length === 0 ? "1fr" : node.columns.map((width) => `${px(width)}px`).join(" ");
	const rows = node.rows.length === 0 ? "1fr" : node.rows.map((row) => `${px(row.height)}px`).join(" ");
	const table = element(
		dom,
		"pptx-table",
		`${boxStyle(node.transform)}display:grid;grid-template-columns:${columns};grid-template-rows:${rows};${rotationStyle(node.transform)}`,
	);
	const occupied = new Set<string>();
	node.rows.forEach((row, rowIndex) => {
		let column = 0;
		for (const cell of row.cells) {
			while (occupied.has(`${rowIndex},${column}`)) column += 1;
			for (let r = rowIndex; r < rowIndex + cell.rowSpan; r += 1) {
				for (let c = column; c < column + cell.gridSpan; c += 1) occupied.add(`${r},${c}`);
			}
			table.appendChild(renderCell(cell, column, rowIndex, dom));
			column += cell.gridSpan;
		}
	});
	return table;
}

function placeholderBox(dom: PptxDom, transform: PptxTransform, label: string): PptxDomElement {
	const box = element(
		dom,
		"pptx-placeholder",
		`${boxStyle(transform)}display:flex;align-items:center;justify-content:center;box-sizing:border-box;border:1px dashed rgba(0,0,0,0.35);background:rgba(127,127,127,0.08);color:#666;font-size:12px;text-align:center;padding:2px;`,
	);
	box.textContent = label;
	return box;
}

function renderNode(node: PptxNode, dom: PptxDom, resolveImage: (entry: string) => string | null): PptxDomElement {
	switch (node.kind) {
		case "shape":
			return renderShape(node, dom);
		case "picture":
			return renderPicture(node, dom, resolveImage);
		case "group":
			return renderGroup(node, dom, resolveImage);
		case "table":
			return renderTable(node, dom);
		case "placeholder":
			return placeholderBox(dom, node.transform, node.label);
		default:
			return assertNever(node);
	}
}

function errorCard(slide: PptxSlide | undefined, dom: PptxDom): PptxDomElement {
	const card = element(
		dom,
		"pptx-error",
		"position:absolute;left:0;top:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#F4F4F5;color:#666;font-size:14px;text-align:center;padding:12px;box-sizing:border-box;",
	);
	card.textContent = slide?.error ?? t("quickLook.pptx.slideRenderFailed");
	return card;
}

/**
 * One slide as an absolutely positioned DOM tree at its natural pixel size.
 * An error slide draws an error card; a caller wraps the result to scale it.
 */
export function renderSlide(deck: PptxDeck, index: number, resolveImage: (entry: string) => string | null, dom: PptxDom): PptxDomElement {
	const slide = deck.slides[index];
	const root = element(
		dom,
		"pptx-slide",
		`position:relative;overflow:hidden;width:${px(deck.width)}px;height:${px(deck.height)}px;background:${slide?.background ?? "#FFFFFF"};font-family:${CJK_FONT};`,
	);
	if (slide === undefined || slide.error !== null) {
		root.appendChild(errorCard(slide, dom));
		return root;
	}
	for (const node of slide.nodes) root.appendChild(renderNode(node, dom, resolveImage));
	return root;
}
