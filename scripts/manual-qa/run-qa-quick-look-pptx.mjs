/**
 * Manual QA — Quick Look for PowerPoint decks.
 *
 * A `.pptx` must open like a PDF: every slide as a paper card in one scrolling
 * column, a page rail, and a `1 / N` pill whose number follows the scroll and
 * the rail. Builds a rich synthetic deck in-script (titled slides, a picture
 * slide, a table slide, a Korean slide, and a deliberately non-alphabetical
 * slide order) plus any of the real decks that are readable locally, drives the
 * production build (`bun run build` first), opens each file with Space from the
 * Finder list, and checks the panel in the DOM. It also measures the pixel
 * variance of a real slide region so a blank page fails.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

const EVIDENCE = process.argv[2] ?? "/tmp/autorag-quicklook-pptx";
mkdirSync(EVIDENCE, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "autorag-ql-pptx-"));

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const NS = `${A} ${P} ${R}`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const rels = (items) =>
	strToU8(
		`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
			items.map((item) => `<Relationship Id="${item.id}" Type="${REL}/${item.type}" Target="${item.target}"/>`).join("") +
			`</Relationships>`,
	);

const THEME = strToU8(
	`<?xml version="1.0"?><a:theme ${A} ${P}><a:themeElements><a:clrScheme name="T">` +
		`<a:dk1><a:sysClr val="windowText" lastClr="202020"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
		`<a:dk2><a:srgbClr val="1F4E79"/></a:dk2><a:lt2><a:srgbClr val="EEF3F8"/></a:lt2>` +
		`<a:accent1><a:srgbClr val="2E74B5"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2>` +
		`<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>` +
		`</a:clrScheme><a:fontScheme name="T"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface="맑은 고딕"/></a:majorFont>` +
		`<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="맑은 고딕"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`,
);

const MASTER = strToU8(
	`<?xml version="1.0"?><p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>` +
		`<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>` +
		`<p:spPr><a:xfrm><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1325563"/></a:xfrm></p:spPr></p:sp>` +
		`</p:spTree></p:cSld>` +
		`<p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4000" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="Calibri Light"/></a:defRPr></a:lvl1pPr></p:titleStyle>` +
		`<p:bodyStyle><a:lvl1pPr marL="342900"><a:buChar char="•"/><a:defRPr sz="2000"/></a:lvl1pPr></p:bodyStyle>` +
		`<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`,
);

const LAYOUT = strToU8(
	`<?xml version="1.0"?><p:sldLayout ${NS}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>` +
		`<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>` +
		`<p:spPr><a:xfrm><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1325563"/></a:xfrm></p:spPr></p:sp>` +
		`</p:spTree></p:cSld></p:sldLayout>`,
);

const titleShape = (text, size = 4000) =>
	`<p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>` +
	`<p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="ko-KR" sz="${size}" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:rPr><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;

const slide = (body) => strToU8(`<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${body}</p:spTree></p:cSld></p:sld>`);

const TABLE =
	`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="7" name="Table"/><p:nvPr/></p:nvGraphicFramePr>` +
	`<p:xfrm><a:off x="838200" y="2100000"/><a:ext cx="8000000" cy="2400000"/></p:xfrm>` +
	`<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>` +
	`<a:tblGrid><a:gridCol w="4000000"/><a:gridCol w="4000000"/></a:tblGrid>` +
	`<a:tr h="600000"><a:tc gridSpan="2"><a:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1600" b="1"/><a:t>분기</a:t></a:r></a:p></a:txBody><a:tcPr><a:solidFill><a:srgbClr val="DEEBF7"/></a:solidFill></a:tcPr></a:tc></a:tr>` +
	`<a:tr h="600000"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1400"/><a:t>매출</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1400"/><a:t>1,234</a:t></a:r></a:p></a:txBody></a:tc></a:tr>` +
	`</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;

// A real PNG for the picture slide.
const seedPath = join(root, "seed.png");
const shotPath = join(root, "photo.png");
writeFileSync(seedPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
execFileSync("sips", ["-z", "200", "320", seedPath, "--out", shotPath], { stdio: "ignore" });
const photo = new Uint8Array(readFileSync(shotPath));

const PICTURE =
	`<p:pic><p:nvPicPr><p:cNvPr id="6" name="Photo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
	`<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
	`<p:spPr><a:xfrm><a:off x="1200000" y="2400000"/><a:ext cx="6000000" cy="3200000"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr></p:pic>`;

const presentation = (ids) =>
	strToU8(
		`<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst>` +
			ids.map((entry) => `<p:sldId r:id="${entry.rid}" id="${entry.id}"/>`).join("") +
			`</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
	);

// Slide order is 3, 1, 4, 2 — deliberately not the file-name order.
const deck = zipSync(
	{
		"ppt/presentation.xml": presentation([
			{ rid: "rId3", id: "256" },
			{ rid: "rId1", id: "257" },
			{ rid: "rId4", id: "258" },
			{ rid: "rId2", id: "259" },
		]),
		"ppt/_rels/presentation.xml.rels": rels([
			{ id: "rId1", type: "slide", target: "slides/slide1.xml" },
			{ id: "rId2", type: "slide", target: "slides/slide2.xml" },
			{ id: "rId3", type: "slide", target: "slides/slide3.xml" },
			{ id: "rId4", type: "slide", target: "slides/slide4.xml" },
		]),
		"ppt/theme/theme1.xml": THEME,
		"ppt/slideMasters/slideMaster1.xml": MASTER,
		"ppt/slideMasters/_rels/slideMaster1.xml.rels": rels([{ id: "rId1", type: "theme", target: "../theme/theme1.xml" }]),
		"ppt/slideLayouts/slideLayout1.xml": LAYOUT,
		"ppt/slideLayouts/_rels/slideLayout1.xml.rels": rels([{ id: "rId1", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" }]),
		"ppt/slides/slide1.xml": slide(`${titleShape("ALPHA-ONE")}${TABLE}`),
		"ppt/slides/slide2.xml": slide(`${titleShape("BRAVO-TWO")}${PICTURE}`),
		"ppt/slides/slide3.xml": slide(titleShape("CHARLIE-THREE")),
		"ppt/slides/slide4.xml": slide(titleShape("안녕하세요-한국어")),
		"ppt/slides/_rels/slide1.xml.rels": rels([{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }]),
		"ppt/slides/_rels/slide2.xml.rels": rels([
			{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
			{ id: "rId2", type: "image", target: "../media/photo.png" },
		]),
		"ppt/slides/_rels/slide3.xml.rels": rels([{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }]),
		"ppt/slides/_rels/slide4.xml.rels": rels([{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }]),
		"ppt/media/photo.png": photo,
	},
	{ level: 6 },
);
writeFileSync(join(root, "Synthetic Deck.pptx"), deck);
rmSync(seedPath);
rmSync(shotPath);

// Real decks the owner keeps locally (skipped when absent, so the lane still runs elsewhere).
const DECKS = "/Users/jeffrey/Downloads";
const REAL = [
	[join(DECKS, "AutoRAG_소개자료_v0.96.pptx"), "autorag-intro"],
	[join(DECKS, "대충 사업 관련/(마커)_오픈소스 착수보고 발표자료_v1.0.pptx"), "kickoff"],
	[join(DECKS, "01-오픈소스-AI-지원사업-2026/오픈소스 발표자료 PPT 통합본_v1.0(최종).pptx"), "integrated"],
	[join(DECKS, "듣는 웹에서 협업하는 웹으로-김찬홍.pptx"), "web"],
];
const present = [];
for (const [source, slug] of REAL) {
	const name = basename(source);
	if (!existsSync(source)) {
		console.log(`SKIP  ${name} (missing)`);
		continue;
	}
	const target = join(root, name);
	try {
		copyFileSync(source, target);
	} catch (error) {
		console.log(`SKIP  ${name} (cloud placeholder: ${error.code ?? error.message})`);
		continue;
	}
	if (statSync(target).size === 0) {
		console.log(`SKIP  ${name} (cloud placeholder: 0 bytes)`);
		rmSync(target, { force: true });
		continue;
	}
	present.push([name, slug]);
}

/** How many slides the package lists, read from its own presentation part. */
function expectedSlides(path) {
	const entries = unzipSync(new Uint8Array(readFileSync(path)));
	const xml = new TextDecoder().decode(entries["ppt/presentation.xml"] ?? new Uint8Array());
	return [...xml.matchAll(/<p:sldId\s/g)].length;
}

const results = [];
function check(label, pass, detail = "") {
	results.push({ label, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  (${detail})`}`);
}

async function poll(read, accept, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	let value = await read();
	while (!accept(value) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 60));
		value = await read();
	}
	return value;
}

const app = await launchFinder({ env: { AUTORAG_QA_ROOT: root, AUTORAG_SKIP_DUPEY_CHECK: "1" }, language: "ko" });

/** Luminance variance of a screenshot region, measured through Electron's nativeImage. */
async function regionVariance(page, clip) {
	const png = await page.screenshot({ clip });
	return app.evaluate(async ({ nativeImage }, base64) => {
		const image = nativeImage.createFromBuffer(Buffer.from(base64, "base64"));
		const size = image.getSize();
		const bitmap = image.getBitmap();
		let sum = 0;
		let sumSq = 0;
		let count = 0;
		for (let index = 0; index + 2 < bitmap.length; index += 4) {
			const luminance = 0.114 * bitmap[index] + 0.587 * bitmap[index + 1] + 0.299 * bitmap[index + 2];
			sum += luminance;
			sumSq += luminance * luminance;
			count += 1;
		}
		const mean = count === 0 ? 0 : sum / count;
		return { variance: count === 0 ? 0 : sumSq / count - mean * mean, mean, width: size.width, height: size.height };
	}, png.toString("base64"));
}

try {
	const main = await finderWindow(app, 30_000);
	const preview = await poll(
		async () => (await app.windows()).find((candidate) => candidate.url().includes("quick-look.html")),
		(candidate) => candidate !== undefined,
		30_000,
	);
	if (preview === undefined) throw new Error("Quick Look window did not pre-warm");
	const bounds = () =>
		app.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("quick-look.html"));
			return window === undefined ? null : { visible: window.isVisible(), bounds: window.getBounds() };
		});

	async function open(name, ready, arg) {
		const row = main.getByRole("row", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first();
		await row.waitFor({ timeout: 30_000 });
		await row.click();
		await main.keyboard.press("Space");
		await poll(() => preview.evaluate(ready, arg).catch(() => false), Boolean, 15_000);
		await poll(async () => (await bounds())?.visible === true, Boolean);
		await new Promise((resolve) => setTimeout(resolve, 600));
	}
	async function close() {
		await main.keyboard.press("Space");
		await poll(async () => (await bounds())?.visible === false, Boolean);
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	const pageText = (index) =>
		preview.evaluate((n) => {
			const paper = document.querySelectorAll(".ql-pages .ql__paper")[n];
			return paper === null || paper === undefined ? "" : paper.textContent ?? "";
		}, index);
	const pill = () => preview.locator(".ql-pages__pill").textContent();
	const reachPage = (index) =>
		preview.evaluate((n) => {
			const scroller = document.querySelector(".ql-pages__scroll");
			const paper = document.querySelectorAll(".ql-pages .ql__paper")[n];
			if (scroller instanceof HTMLElement && paper instanceof HTMLElement) {
				paper.scrollIntoView({ block: "start" });
				scroller.dispatchEvent(new Event("scroll"));
			}
			return true;
		}, index);
	const pageBox = (index) =>
		preview.evaluate((n) => {
			const paper = document.querySelectorAll(".ql-pages .ql__paper")[n];
			if (!(paper instanceof HTMLElement)) return null;
			const rect = paper.getBoundingClientRect();
			return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
		}, index);

	// --- Synthetic deck: order, rail, pill, zoom, and content -----------------
	const deckName = "Synthetic Deck.pptx";
	await open(deckName, () => document.querySelectorAll(".ql-pages .ql__paper").length === 4);
	const pageCount = await preview.locator(".ql-pages .ql__paper").count();
	check("pptx opens as four page cards", pageCount === 4, String(pageCount));
	const railCount = await preview.locator(".ql__rail-item").count();
	check("the rail lists four pages", railCount === 4, String(railCount));
	const railLabels = await preview.locator(".ql__rail-item").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
	check("rail labels count the pages", JSON.stringify(railLabels) === JSON.stringify(["1페이지로 이동", "2페이지로 이동", "3페이지로 이동", "4페이지로 이동"]), JSON.stringify(railLabels));
	check("the pill starts at 1 / 4", ((await pill()) ?? "").includes("1 / 4"), (await pill()) ?? "");
	check("the pill offers zoom", ((await pill()) ?? "").includes("%"), (await pill()) ?? "");

	const firstText = await poll(() => pageText(0), (text) => text.includes("CHARLIE-THREE"));
	check("the first page is the first slide in presentation order, not the file order", firstText.includes("CHARLIE-THREE"), firstText.slice(0, 60));

	const firstBox = await pageBox(0);
	const firstVariance = firstBox === null ? { variance: 0 } : await regionVariance(preview, firstBox);
	check("the first slide is not blank", firstVariance.variance > 3, `variance ${firstVariance.variance?.toFixed(1)}`);
	await preview.screenshot({ path: join(EVIDENCE, "synthetic-page1.png") });

	// Zoom in first, so a rail jump can actually land a page at the top of a
	// column taller than the window (the zoom control is checked here too).
	const zoomPercent = async () => {
		const text = (await pill()) ?? "";
		const match = text.match(/(\d+)%/);
		return match === null ? 0 : Number(match[1]);
	};
	for (let step = 0; step < 8 && (await zoomPercent()) < 130; step += 1) {
		await preview.locator('.ql-pages__pill button[aria-label="확대"]').click();
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	check("the zoom control raises the slide scale", (await zoomPercent()) >= 130, `${await zoomPercent()}%`);

	// Rail jump.
	await preview.locator(".ql__rail-item").nth(2).click();
	await poll(() => pill(), (text) => (text ?? "").includes("3 / 4"));
	check("clicking a rail item jumps to that page", ((await pill()) ?? "").includes("3 / 4"), (await pill()) ?? "");
	const korean = await poll(() => pageText(2), (text) => text.includes("안녕하세요"));
	check("Korean text renders as real text", korean.includes("안녕하세요-한국어"), korean.slice(0, 60));
	await preview.screenshot({ path: join(EVIDENCE, "synthetic-korean.png") });

	// Table page.
	await preview.locator(".ql__rail-item").nth(1).click();
	await poll(() => pill(), (text) => (text ?? "").includes("2 / 4"));
	const tableText = await poll(() => pageText(1), (text) => text.includes("ALPHA-ONE"));
	const tableCells = await preview.evaluate(() => document.querySelectorAll(".ql-pages .ql__paper:nth-child(2) .pptx-table .pptx-cell").length);
	check("the table slide draws its table cells", tableCells >= 3, String(tableCells));
	check("the table slide draws its title", tableText.includes("ALPHA-ONE"), tableText.slice(0, 60));

	// Wheel the pages column to its end: the pill follows the scroll.
	const centre = await preview.evaluate(() => {
		const scroller = document.querySelector(".ql-pages__scroll");
		if (!(scroller instanceof HTMLElement)) return { x: 200, y: 400 };
		const rect = scroller.getBoundingClientRect();
		return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
	});
	await preview.mouse.move(centre.x, centre.y);
	for (let step = 0; step < 6; step += 1) {
		await preview.mouse.wheel(0, 1200);
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	await poll(() => pill(), (text) => (text ?? "").includes("4 / 4"));
	check("scrolling to the end moves the pill to 4 / 4", ((await pill()) ?? "").includes("4 / 4"), (await pill()) ?? "");
	const picture = await poll(
		() =>
			preview.evaluate(() => {
				const image = document.querySelectorAll(".ql-pages .ql__paper")[3]?.querySelector("img");
				return image instanceof HTMLImageElement && image.naturalWidth > 0 ? { width: image.naturalWidth, height: image.naturalHeight } : null;
			}),
		(value) => value !== null,
	);
	check("the picture slide decodes its image", picture !== null && picture.width > 0, JSON.stringify(picture));
	const pictureBox = await pageBox(3);
	const pictureVariance = pictureBox === null ? { variance: 0 } : await regionVariance(preview, pictureBox);
	check("the picture slide is not blank", pictureVariance.variance > 3, `variance ${pictureVariance.variance?.toFixed(1)}`);
	await preview.screenshot({ path: join(EVIDENCE, "synthetic-picture.png") });
	await close();

	// --- Real decks -----------------------------------------------------------
	for (const [name, slug] of present) {
		const path = join(root, name);
		const expected = expectedSlides(path);
		await open(name, (count) => document.querySelectorAll(".ql-pages .ql__paper").length === count, expected);
		const count = await preview.locator(".ql-pages .ql__paper").count();
		check(`${name} shows all ${expected} slides`, count === expected, String(count));
		check(`${name} is a paged slide deck, not a note`, (await preview.locator(".ql__note").count()) === 0);
		const box = await pageBox(0);
		const variance = box === null ? { variance: 0 } : await regionVariance(preview, box);
		check(`${name} first slide is not blank`, variance.variance > 3, `variance ${variance.variance?.toFixed(1)}`);
		await preview.screenshot({ path: join(EVIDENCE, `real-${slug}-page1.png`) });
		await preview.evaluate(() => {
			const scroller = document.querySelector(".ql-pages__scroll");
			if (scroller instanceof HTMLElement) scroller.scrollTop = scroller.scrollHeight;
		});
		await new Promise((resolve) => setTimeout(resolve, 500));
		await preview.screenshot({ path: join(EVIDENCE, `real-${slug}-last.png`) });
		await close();
	}
	if (present.length === 0) console.log("NOTE  no real decks were readable locally; synthetic deck checks ran");
} finally {
	await app.close();
	rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
