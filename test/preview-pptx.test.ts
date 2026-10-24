// @vitest-environment happy-dom
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildPptxDeck, EMU_PER_PX, entryMime, type ParseXml, type PptxDeck, type XmlDocument } from "../src/preview/shared/pptx-model";
import { renderSlide, type PptxDom, type PptxDomElement } from "../src/preview/shared/pptx-render";

const globals = globalThis as unknown as {
	DOMParser: new () => { parseFromString(text: string, type: string): { getElementsByTagName(name: string): { readonly length: number } } };
	document: PptxDom;
};

const parseXml: ParseXml = (text) => {
	const parsed = new globals.DOMParser().parseFromString(text, "application/xml");
	return parsed.getElementsByTagName("parsererror").length > 0 ? null : (parsed as unknown as XmlDocument);
};

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const NS = `${A} ${P} ${R}`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function rels(items: readonly { readonly id: string; readonly type: string; readonly target: string }[]): Uint8Array {
	const body = items.map((item) => `<Relationship Id="${item.id}" Type="${REL}/${item.type}" Target="${item.target}"/>`).join("");
	return strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`);
}

function presentation(ids: readonly { readonly id: string; readonly rid: string }[]): Uint8Array {
	// `r:id` before `id`: happy-dom's XML parser drops a namespaced attribute
	// whose local name follows a plain attribute of the same name (`id` then
	// `r:id`); real DOM handles either order.
	const list = ids.map((entry) => `<p:sldId r:id="${entry.rid}" id="${entry.id}"/>`).join("");
	return strToU8(`<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst>${list}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`);
}

function theme(accent1 = "FF0000"): Uint8Array {
	return strToU8(
		`<?xml version="1.0"?><a:theme ${A} ${P}><a:themeElements><a:clrScheme name="T">` +
			`<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
			`<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>` +
			`<a:accent1><a:srgbClr val="${accent1}"/></a:accent1><a:accent2><a:srgbClr val="00FF00"/></a:accent2>` +
			`<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>` +
			`</a:clrScheme><a:fontScheme name="T"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface="맑은 고딕"/></a:majorFont>` +
			`<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="맑은 고딕"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`,
	);
}

function master(slideXfrm = `<a:off x="700000" y="400000"/><a:ext cx="11000000" cy="1000000"/>`): Uint8Array {
	return strToU8(
		`<?xml version="1.0"?><p:sldMaster ${NS}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>` +
			`<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>` +
			`<p:spPr><a:xfrm>${slideXfrm}</a:xfrm></p:spPr></p:sp></p:spTree></p:cSld>` +
			`<p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4000"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="Calibri"/></a:defRPr></a:lvl1pPr></p:titleStyle>` +
			`<p:bodyStyle><a:lvl1pPr marL="342900"><a:buChar char="•"/><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle>` +
			`<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`,
	);
}

const LAYOUT_XFRM = `<a:off x="100000" y="200000"/><a:ext cx="300000" cy="400000"/>`;

function layout(hasXfrm = true): Uint8Array {
	return strToU8(
		`<?xml version="1.0"?><p:sldLayout ${NS}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>` +
			`<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>` +
			(hasXfrm ? `<p:spPr><a:xfrm>${LAYOUT_XFRM}</a:xfrm></p:spPr>` : "") +
			`</p:sp></p:spTree></p:cSld></p:sldLayout>`,
	);
}

function slide(body: string, relsBody = ""): Uint8Array {
	return strToU8(`<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree>${body}</p:spTree></p:cSld>${relsBody}</p:sld>`);
}

function titleShape(text: string, extraSpPr = ""): string {
	return (
		`<p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>` +
		(extraSpPr === "" ? "" : `<p:spPr>${extraSpPr}</p:spPr>`) +
		`<p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
	);
}

const EMPTY_TREE = `<p:nvGrpSpPr/><p:grpSpPr/>`;

/** A minimal but internally consistent deck. Overrides replace individual parts. */
function deckZip(overrides: Readonly<Record<string, Uint8Array>> = {}): Uint8Array {
	const parts: Record<string, Uint8Array> = {
		"ppt/presentation.xml": presentation([
			{ id: "256", rid: "rId2" },
			{ id: "257", rid: "rId3" },
		]),
		"ppt/_rels/presentation.xml.rels": rels([
			{ id: "rId1", type: "slideMaster", target: "slideMasters/slideMaster1.xml" },
			{ id: "rId2", type: "slide", target: "slides/slide2.xml" },
			{ id: "rId3", type: "slide", target: "slides/slide1.xml" },
		]),
		"ppt/theme/theme1.xml": theme(),
		"ppt/slideMasters/slideMaster1.xml": master(),
		"ppt/slideMasters/_rels/slideMaster1.xml.rels": rels([{ id: "rId1", type: "theme", target: "../theme/theme1.xml" }]),
		"ppt/slideLayouts/slideLayout1.xml": layout(),
		"ppt/slideLayouts/_rels/slideLayout1.xml.rels": rels([{ id: "rId1", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" }]),
		"ppt/slides/slide1.xml": slide(`${EMPTY_TREE}${titleShape("FIRST")}`),
		"ppt/slides/slide2.xml": slide(`${EMPTY_TREE}${titleShape("SECOND")}`),
		"ppt/slides/_rels/slide1.xml.rels": rels([{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }]),
		"ppt/slides/_rels/slide2.xml.rels": rels([{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }]),
		...overrides,
	};
	return zipSync(parts, { level: 0 });
}

function model(overrides: Readonly<Record<string, Uint8Array>> = {}): PptxDeck {
	const deck = buildPptxDeck(deckZip(overrides), parseXml);
	if (deck === null) throw new Error("deck did not build");
	return deck;
}

/** `childNodes` includes text nodes at runtime (the interface only describes elements), so skip them. */
function isElement(node: PptxDomElement): boolean {
	return "getAttribute" in node && typeof node.getAttribute === "function";
}

function byTag(node: PptxDomElement, tag: string): PptxDomElement[] {
	const out: PptxDomElement[] = [];
	const walk = (current: PptxDomElement): void => {
		for (let index = 0; index < current.childNodes.length; index += 1) {
			const child = current.childNodes[index];
			if (child === undefined || !isElement(child)) continue;
			if (child.localName === tag) out.push(child);
			walk(child);
		}
	};
	walk(node);
	return out;
}

function withClass(node: PptxDomElement, className: string): PptxDomElement[] {
	const out: PptxDomElement[] = [];
	const walk = (current: PptxDomElement): void => {
		const own = current.getAttribute("class");
		if (own !== null && own.split(/\s+/).includes(className)) out.push(current);
		for (let index = 0; index < current.childNodes.length; index += 1) {
			const child = current.childNodes[index];
			if (child !== undefined && isElement(child)) walk(child);
		}
	};
	walk(node);
	return out;
}

function render(deck: PptxDeck, index: number, images: Readonly<Record<string, string>> = {}): PptxDomElement {
	return renderSlide(
		deck,
		index,
		(entry) => images[entry] ?? null,
		globals.document,
	);
}

describe("pptx model", () => {
	it("reads slide order from the presentation relationships, not file names", () => {
		const deck = model();
		expect(deck.slides).toHaveLength(2);
		expect(deck.width).toBe(12192000);
		expect(deck.height).toBe(6858000);
		const texts = deck.slides.map((entry) => entry.nodes.flatMap((node) => (node.kind === "shape" ? [node.text?.paragraphs[0]?.runs[0]?.text ?? ""] : [])));
		expect(texts).toEqual([["SECOND"], ["FIRST"]]);
	});

	it("inherits placeholder geometry from the layout", () => {
		const deck = model();
		const first = deck.slides[0]?.nodes[0];
		expect(first?.kind).toBe("shape");
		if (first?.kind !== "shape") return;
		expect(first.transform).toMatchObject({ x: 100000, y: 200000, w: 300000, h: 400000 });
	});

	it("resolves a scheme colour through the theme with lumMod", () => {
		const shape =
			`<p:sp><p:nvSpPr><p:cNvPr id="3" name="Box"/><p:nvPr/></p:nvSpPr>` +
			`<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="ellipse"/><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr></a:solidFill></p:spPr></p:sp>`;
		const deck = model({ "ppt/slides/slide2.xml": slide(`${EMPTY_TREE}${shape}`) });
		const node = deck.slides[0]?.nodes[0];
		expect(node?.kind).toBe("shape");
		if (node?.kind !== "shape") return;
		expect(node.geometry).toBe("ellipse");
		expect(node.fill?.color).toBe("#800000");
	});

	it("keeps group child coordinates with the child offset and extent", () => {
		const group =
			`<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="G"/><p:nvPr/></p:nvGrpSpPr>` +
			`<p:grpSpPr><a:xfrm><a:off x="1000000" y="2000000"/><a:ext cx="400000" cy="300000"/><a:chOff x="100000" y="200000"/><a:chExt cx="200000" cy="150000"/></a:xfrm></p:grpSpPr>` +
			`<p:sp><p:nvSpPr><p:cNvPr id="5" name="C"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="150000" y="260000"/><a:ext cx="40000" cy="20000"/></a:xfrm></p:spPr></p:sp>` +
			`</p:grpSp>`;
		const deck = model({ "ppt/slides/slide2.xml": slide(`${EMPTY_TREE}${group}`) });
		const node = deck.slides[0]?.nodes[0];
		expect(node?.kind).toBe("group");
		if (node?.kind !== "group") return;
		expect(node.childOffset).toEqual({ x: 100000, y: 200000 });
		expect(node.childExtent).toEqual({ w: 200000, h: 150000 });
		const child = node.children[0];
		expect(child?.kind).toBe("shape");
		if (child?.kind !== "shape") return;
		// The child keeps the group's own coordinate space; the renderer scales it into the group box.
		expect(child.transform).toMatchObject({ x: 150000, y: 260000, w: 40000, h: 20000 });

		const element = render(deck, 0);
		const groups = withClass(element, "pptx-group");
		expect(groups).toHaveLength(1);
		const inner = byTag(groups[0]!, "div").find((candidate) => (candidate.getAttribute("style") ?? "").includes("scale("));
		// ext/chExt = 400000/200000 = 2, so the child box is scaled by 2.
		expect(inner?.getAttribute("style") ?? "").toContain("scale(2, 2)");
	});

	it("reads a picture's relationship, mime, and crop", () => {
		const picture =
			`<p:pic><p:nvPicPr><p:cNvPr id="6" name="P"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
			`<p:blipFill><a:blip r:embed="rId2"/><a:srcRect l="25000" b="10000"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
			`<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="476250"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr></p:pic>`;
		const overrides = {
			"ppt/slides/slide2.xml": slide(`${EMPTY_TREE}${picture}`),
			"ppt/slides/_rels/slide2.xml.rels": rels([
				{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
				{ id: "rId2", type: "image", target: "../media/image1.png" },
			]),
			"ppt/media/image1.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
		};
		const deck = model(overrides);
		const node = deck.slides[0]?.nodes[0];
		expect(node?.kind).toBe("picture");
		if (node?.kind !== "picture") return;
		expect(node.entry).toBe("ppt/media/image1.png");
		expect(node.mime).toBe("image/png");
		expect(node.crop).toEqual({ l: 0.25, t: 0, r: 0, b: 0.1 });
		expect(deck.slides[0]?.media).toEqual(["ppt/media/image1.png"]);

		const element = render(deck, 0, { "ppt/media/image1.png": "blob:image" });
		const images = byTag(element, "img");
		expect(images).toHaveLength(1);
		expect(images[0]?.getAttribute("src")).toBe("blob:image");
	});

	it("turns an unsupported picture format into a labelled placeholder", () => {
		const picture =
			`<p:pic><p:nvPicPr><p:cNvPr id="6" name="P"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
			`<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
			`<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="476250"/></a:xfrm></p:spPr></p:pic>`;
		const deck = model({
			"ppt/slides/slide2.xml": slide(`${EMPTY_TREE}${picture}`),
			"ppt/slides/_rels/slide2.xml.rels": rels([
				{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
				{ id: "rId2", type: "image", target: "../media/image1.svg" },
			]),
			"ppt/media/image1.svg": strToU8("<svg/>"),
		});
		expect(deck.slides[0]?.nodes[0]?.kind).toBe("placeholder");
		expect(deck.slides[0]?.media).toEqual([]);
	});

	it("parses a table's columns, rows, cells, and spans", () => {
		const table =
			`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="7" name="T"/><p:nvPr/></p:nvGraphicFramePr>` +
			`<p:xfrm><a:off x="0" y="0"/><a:ext cx="4000000" cy="2000000"/></p:xfrm>` +
			`<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>` +
			`<a:tblGrid><a:gridCol w="2000000"/><a:gridCol w="2000000"/></a:tblGrid>` +
			`<a:tr h="1000000"><a:tc gridSpan="2"><a:txBody><a:bodyPr/><a:p><a:r><a:t>Header</a:t></a:r></a:p></a:txBody><a:tcPr><a:solidFill><a:srgbClr val="CCCCCC"/></a:solidFill></a:tcPr></a:tc></a:tr>` +
			`<a:tr h="1000000"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>A</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>B</a:t></a:r></a:p></a:txBody></a:tc></a:tr>` +
			`</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
		const deck = model({ "ppt/slides/slide2.xml": slide(`${EMPTY_TREE}${table}`) });
		const node = deck.slides[0]?.nodes[0];
		expect(node?.kind).toBe("table");
		if (node?.kind !== "table") return;
		expect(node.columns).toEqual([2000000, 2000000]);
		expect(node.rows).toHaveLength(2);
		expect(node.rows[0]?.cells[0]?.gridSpan).toBe(2);
		expect(node.rows[1]?.cells).toHaveLength(2);

		const element = render(deck, 0);
		expect(withClass(element, "pptx-table")).toHaveLength(1);
		expect(element.textContent ?? "").toContain("Header");
	});

	it("labels charts and SmartArt instead of crashing", () => {
		const chart =
			`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="8" name="Chart 1"/><p:nvPr/></p:nvGraphicFramePr>` +
			`<p:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="1000000"/></p:xfrm>` +
			`<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId9"/></a:graphicData></a:graphic></p:graphicFrame>`;
		const deck = model({ "ppt/slides/slide2.xml": slide(`${EMPTY_TREE}${chart}`) });
		const node = deck.slides[0]?.nodes[0];
		expect(node?.kind).toBe("placeholder");
		if (node?.kind !== "placeholder") return;
		expect(node.label).toContain("차트");
	});

	it("degrades a malformed slide to an error card while the rest render", () => {
		const deck = model({ "ppt/slides/slide2.xml": strToU8("<p:sld this is not xml") });
		expect(deck.slides[0]?.error).not.toBeNull();
		expect(deck.slides[1]?.error).toBeNull();
		const broken = render(deck, 0);
		expect(withClass(broken, "pptx-error")).toHaveLength(1);
		const good = render(deck, 1);
		expect(good.textContent ?? "").toContain("FIRST");
	});

	it("keeps Korean text in real DOM text", () => {
		const deck = model({ "ppt/slides/slide2.xml": slide(`${EMPTY_TREE}${titleShape("안녕하세요 세계")}`) });
		const element = render(deck, 0);
		expect(element.textContent ?? "").toContain("안녕하세요 세계");
		expect(byTag(element, "canvas")).toHaveLength(0);
	});

	it("draws a slide in the bundled UI font before any machine font", () => {
		const deck = model({ "ppt/slides/slide2.xml": slide(`${EMPTY_TREE}${titleShape("안녕하세요")}`) });
		const element = render(deck, 0);
		const run = byTag(element, "span").find((span) => span.textContent === "안녕하세요" && (span.getAttribute("style") ?? "").includes("font-family"));
		const family = /font-family:([^;]+)/.exec(run?.getAttribute("style") ?? "")?.[1] ?? "";
		const names = family.split(",").map((name) => name.trim().replace(/^"|"$/g, ""));
		const bundled = names.indexOf("Pretendard Variable");
		expect(bundled).toBeGreaterThanOrEqual(0);
		for (const machineFont of ["Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR"]) {
			expect(bundled).toBeLessThan(names.indexOf(machineFont));
		}
		expect(names[names.length - 1]).toBe("sans-serif");
	});

	it("answers null when no presentation can be read", () => {
		expect(buildPptxDeck(new Uint8Array([1, 2, 3, 4]), parseXml)).toBeNull();
		expect(buildPptxDeck(zipSync({ "notes/a.txt": strToU8("hi") }), parseXml)).toBeNull();
	});

	it("maps entries to image mime types", () => {
		expect(entryMime("ppt/media/image1.JPEG")).toBe("image/jpeg");
		expect(entryMime("ppt/media/image1.png")).toBe("image/png");
		expect(entryMime("ppt/media/image1.bin")).toBe("application/octet-stream");
	});
});

describe("pptx render", () => {
	it("positions shapes at the slide's natural pixel size", () => {
		const box =
			`<p:sp><p:nvSpPr><p:cNvPr id="3" name="Box"/><p:nvPr/></p:nvSpPr>` +
			`<p:spPr><a:xfrm><a:off x="952500" y="190500"/><a:ext cx="1905000" cy="952500"/></a:xfrm><a:prstGeom prst="roundRect"/><a:solidFill><a:srgbClr val="3366FF"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln></p:spPr></p:sp>`;
		const deck = model({ "ppt/slides/slide2.xml": slide(`${EMPTY_TREE}${box}`) });
		const element = render(deck, 0);
		const shapes = withClass(element, "pptx-shape");
		expect(shapes).toHaveLength(1);
		const style = shapes[0]?.getAttribute("style") ?? "";
		expect(style).toContain("left:100px");
		expect(style).toContain("top:20px");
		expect(style).toContain("width:200px");
		expect(style).toContain("height:100px");
		expect(style).toContain("background:#3366FF");
		expect(style).toContain("border-radius:12px");
		const outer = element.getAttribute("style") ?? "";
		expect(outer).toContain(`width:${12192000 / EMU_PER_PX}px`);
		expect(outer).toContain(`height:${6858000 / EMU_PER_PX}px`);
	});

	it("places the group's inner box at the child scale", () => {
		const group =
			`<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="G"/><p:nvPr/></p:nvGrpSpPr>` +
			`<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="400000" cy="300000"/><a:chOff x="0" y="0"/><a:chExt cx="200000" cy="150000"/></a:xfrm></p:grpSpPr>` +
			`<p:sp><p:nvSpPr><p:cNvPr id="5" name="C"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="100000" y="100000"/><a:ext cx="50000" cy="50000"/></a:xfrm></p:spPr></p:sp>` +
			`</p:grpSp>`;
		const deck = model({ "ppt/slides/slide2.xml": slide(`${EMPTY_TREE}${group}`) });
		const element = render(deck, 0);
		const shapes = withClass(element, "pptx-shape");
		const style = shapes[0]?.getAttribute("style") ?? "";
		expect(style).toContain("left:10.5px");
	});
});
