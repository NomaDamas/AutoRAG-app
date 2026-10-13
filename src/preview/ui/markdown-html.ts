import { previewStreamUrl } from "../shared/contract";
import { resolveRelative } from "../shared/location";

/** Elements removed with everything inside them. */
const DROP: Partial<Record<string, true>> = {
	SCRIPT: true,
	STYLE: true,
	IFRAME: true,
	FRAME: true,
	FRAMESET: true,
	OBJECT: true,
	EMBED: true,
	APPLET: true,
	FORM: true,
	BUTTON: true,
	TEXTAREA: true,
	SELECT: true,
	LINK: true,
	META: true,
	BASE: true,
	SVG: true,
	MATH: true,
	TEMPLATE: true,
	NOSCRIPT: true,
	AUDIO: true,
	VIDEO: true,
	CANVAS: true,
	DIALOG: true,
};

/** Elements kept, with the attributes each may carry. Anything else is unwrapped to its children. */
const ALLOW: Partial<Record<string, readonly string[]>> = {
	A: ["href", "title"],
	IMG: ["src", "alt", "title", "width", "height"],
	P: ["align"],
	DIV: ["align"],
	SPAN: [],
	H1: ["align"],
	H2: ["align"],
	H3: ["align"],
	H4: ["align"],
	H5: ["align"],
	H6: ["align"],
	BLOCKQUOTE: [],
	PRE: [],
	CODE: ["class"],
	EM: [],
	STRONG: [],
	B: [],
	I: [],
	U: [],
	S: [],
	DEL: [],
	INS: [],
	MARK: [],
	SUB: [],
	SUP: [],
	KBD: [],
	SMALL: [],
	BR: [],
	HR: [],
	UL: [],
	OL: ["start"],
	LI: [],
	TABLE: [],
	THEAD: [],
	TBODY: [],
	TR: [],
	TH: ["align", "colspan", "rowspan"],
	TD: ["align", "colspan", "rowspan"],
	DETAILS: ["open"],
	SUMMARY: [],
	DL: [],
	DT: [],
	DD: [],
	INPUT: ["type", "checked", "disabled"],
};

const SAFE_HREF = /^(https?:|mailto:|#)/i;
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif);/i;

function cleanAttributes(element: Element, tag: string, folder: string | null): void {
	const allowed = ALLOW[tag] ?? [];
	for (const name of element.getAttributeNames()) {
		if (!allowed.includes(name)) element.removeAttribute(name);
	}
	if (tag === "A") {
		const href = element.getAttribute("href");
		if (href !== null && !SAFE_HREF.test(href.trim())) element.removeAttribute("href");
	}
	if (tag === "IMG") {
		const src = element.getAttribute("src") ?? "";
		const local = folder === null ? null : resolveRelative(folder, src);
		if (local !== null) element.setAttribute("src", previewStreamUrl(local));
		else if (!DATA_IMAGE.test(src)) element.removeAttribute("src");
	}
}

function clean(parent: Node, folder: string | null): void {
	for (const node of Array.from(parent.childNodes)) {
		if (node.nodeType === node.COMMENT_NODE) {
			node.remove();
			continue;
		}
		if (!(node instanceof Element)) continue;
		const element = node;
		const tag = element.tagName.toUpperCase();
		if (DROP[tag] === true) {
			element.remove();
			continue;
		}
		if (tag === "INPUT" && (element.getAttribute("type") !== "checkbox" || !element.hasAttribute("disabled"))) {
			element.remove();
			continue;
		}
		clean(element, folder);
		if (ALLOW[tag] === undefined) {
			element.replaceWith(...Array.from(element.childNodes));
			continue;
		}
		cleanAttributes(element, tag, folder);
	}
}

/**
 * Makes marked's HTML (or an evidence chunk's HTML) safe to insert into the
 * page. Markdown may embed raw HTML, so the markup is parsed into an inert
 * document (nothing loads or runs there), reduced to an allowlist of elements
 * and attributes, and its relative images are pointed at the preview protocol;
 * with no `folder` to resolve against they are dropped. Remote images are
 * dropped: the preview never reaches the network.
 */
export function sanitizeMarkdownHtml(html: string, folder: string | null): string {
	const inert = new DOMParser().parseFromString(`<!doctype html><body>${html}`, "text/html");
	clean(inert.body, folder);
	return inert.body.innerHTML;
}
