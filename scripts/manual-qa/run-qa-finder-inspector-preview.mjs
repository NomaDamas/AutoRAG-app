/**
 * Manual QA — Inspector preview paper and the multi-selection paper stack
 * (real Electron).
 *
 * Builds a fixture folder with four real one-page PDFs, an EXIF JPEG, and a
 * text file, then checks on the running app that:
 *  - selecting a PDF renders the 640px Quick Look tier full-width in the
 *    preview paper — no fixed frame, the image's own aspect sets the height
 *    (paper box height equals the decoded image height), and canvas readback
 *    proves real page content, not a letter tile;
 *  - ⌘-clicking a second file switches the Info panel to the paper stack:
 *    one card per selected file, focused in front, back cards rotated;
 *  - shift-selecting five files fans five papers at distinct angles, every
 *    sheet dog-eared (.page-curl) and shadowed, with the "5개 항목" title
 *    and the per-kind total-size subtitle;
 *  - returning to a single selection restores the full-width preview;
 *  - re-selecting a file the panel already previewed paints the final
 *    full-size paper within two frames — the renderer caches (path, mtime) →
 *    preview + aspect, so there is no fixed-box flash and no height snap.
 * Screenshots land in EVIDENCE.
 *
 * `bun run build` first, then
 * `bun scripts/manual-qa/run-qa-finder-inspector-preview.mjs`
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExifJpeg } from "../../test/support/exif-fixture.ts";
import { buildHwp } from "../../test/support/hwp-fixture.ts";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";

const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-inspector-preview");
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

/** A minimal one-page PDF with `text` on it, xref table computed for real. */
function buildPdf(text) {
	const stream = `BT /F1 28 Tf 72 700 Td (${text}) Tj ET`;
	const bodies = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let out = "%PDF-1.4\n";
	const offsets = [];
	bodies.forEach((body, index) => {
		offsets.push(out.length);
		out += `${index + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}

const home = join(tmpdir(), "ulw-preview-qa-home");
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });

const fixtureName = "ulw-preview-qa";
const folder = join(home, "Documents", fixtureName);
mkdirSync(folder, { recursive: true });
// The Korean names sort after the Latin ones, so the five-file shift range (deck-a → notes.txt) is unchanged.
const FIXTURES = ["deck-a.pdf", "deck-b.pdf", "deck-c.pdf", "deck-d.pdf", "notes.txt", "photo.jpg", "사업계획서.hwp", "회의록.hwpx"];
for (const name of FIXTURES) {
	if (name.endsWith(".pdf")) await Bun.write(join(folder, name), buildPdf(`AutoRAG Meetup ${name}`));
	else if (name.endsWith(".jpg")) await Bun.write(join(folder, name), buildExifJpeg());
	else if (name.endsWith(".hwp")) await Bun.write(join(folder, name), buildHwp(["사업계획서 첫 쪽", "둘째 쪽"], "hwp"));
	else if (name.endsWith(".hwpx")) await Bun.write(join(folder, name), buildHwp(["회의록 첫 쪽"], "hwpx"));
	else await Bun.write(join(folder, name), "preview qa\n");
}
// A stable mtime so the date-range assertion does not depend on run time.
const FIXTURE_MTIME = new Date("2026-01-02T09:05:00Z");
for (const name of FIXTURES) utimesSync(join(folder, name), FIXTURE_MTIME, FIXTURE_MTIME);

const userDataDir = mkdtempSync(join(tmpdir(), "ulw-preview-data-"));

const results = [];
const check = (label, pass, detail = "") => {
	results.push({ label, pass, detail });
	if (!pass) console.log(`FAIL  ${label} ${detail}`);
};

/** Read the preview area straight from the live DOM. */
const probe = (page) =>
	page.evaluate(() => {
		const paper = document.querySelector(".preview-paper");
		const stack = document.querySelector(".preview-stack");
		const img = document.querySelector(".preview-paper img, .preview-stack img");
		// Canvas readback (the protocol answers CORS-readable, so the canvas is
		// not tainted): the luminance spread proves real page content — a blank
		// or fully transparent render spreads ~0.
		let contentSpread = null;
		if (img !== null && img.complete && img.naturalWidth > 0) {
			try {
				const canvas = document.createElement("canvas");
				canvas.width = img.naturalWidth;
				canvas.height = img.naturalHeight;
				const context = canvas.getContext("2d");
				context.drawImage(img, 0, 0);
				const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
				let min = 255;
				let max = 0;
				for (let i = 0; i < data.length; i += 397) {
					const luminance = (data[i] + data[i + 1] + data[i + 2]) / 3;
					if (luminance < min) min = luminance;
					if (luminance > max) max = luminance;
				}
				contentSpread = max - min;
			} catch {
				contentSpread = null;
			}
		}
		const cards = [...document.querySelectorAll(".preview-stack-card")].map((card) => {
			const cardImg = card.querySelector("img");
			const style = getComputedStyle(card);
			return {
				hasImage: cardImg !== null && cardImg.naturalWidth > 0,
				rotate: style.rotate,
				left: Math.round(card.getBoundingClientRect().left),
				boxShadow: style.boxShadow,
				curl: card.querySelector(".page-curl") !== null,
			};
		});
		const rows = [...document.querySelectorAll(".inspector-body dl > div")].map((row) => ({
			label: row.querySelector("dt")?.textContent ?? "",
			value: row.querySelector("dd")?.textContent ?? "",
		}));
		const paperRect = paper?.getBoundingClientRect() ?? null;
		const imgRect = document.querySelector(".preview-paper img")?.getBoundingClientRect() ?? null;
		return {
			mode: stack !== null ? "stack" : paper !== null ? "paper" : "none",
			imgSrc: img?.getAttribute("src") ?? null,
			naturalWidth: img?.naturalWidth ?? 0,
			naturalHeight: img?.naturalHeight ?? 0,
			contentSpread,
			paperBox: paperRect === null ? null : { width: Math.round(paperRect.width), height: Math.round(paperRect.height) },
			imgBox: imgRect === null ? null : { width: Math.round(imgRect.width), height: Math.round(imgRect.height) },
			cards,
			title: document.querySelector(".preview-title")?.textContent ?? "",
			sub: document.querySelector(".preview-sub")?.textContent ?? "",
			rows,
			text: document.querySelector(".inspector-body")?.innerText ?? "",
		};
	});

const valueOf = (rows, label) => rows.find((row) => row.label === label)?.value;
const rowNamed = (page, name) => page.locator('[role="row"]').filter({ hasText: name }).first();

let app;
try {
	app = await launchFinder({ userDataDir, env: { HOME: home } });
	const page = await finderWindow(app, 30000);
	await page.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
	await page.waitForSelector(".toolbar-title", { timeout: 30000 });
	await page.waitForSelector(".sidebar__item", { timeout: 30000 });

	await page.getByLabel("Places").getByRole("button", { name: "Documents", exact: true }).click();
	const fixtureRow = page.locator('[role="row"]').filter({ hasText: fixtureName }).first();
	await fixtureRow.waitFor({ timeout: 30000 });
	await fixtureRow.dblclick();
	await page.waitForFunction((name) => document.querySelector(".toolbar-title")?.textContent === name, fixtureName);
	await rowNamed(page, "deck-a.pdf").waitFor();
	await page.mouse.move(2, 2);

	console.log("phase: single");
	// ------------------------------------------------ single selection: paper
	await rowNamed(page, "deck-a.pdf").click();
	await page.waitForFunction(
		() => {
			const img = document.querySelector(".preview-paper img");
			// Windows has no OS thumbnail provider for a PDF: the first page is drawn in the renderer and arrives as a data: image.
			const src = img?.getAttribute("src") ?? "";
			return img !== null && (src.includes("size=640") || src.startsWith("data:image/")) && img.complete && img.naturalWidth > 0;
		},
		undefined,
		{ timeout: 15000 },
	);
	await new Promise((resolve) => setTimeout(resolve, 300));
	const single = await probe(page);
	await page.screenshot({ path: join(EVIDENCE, "01-single-pdf-preview.png") });

	check("single selection renders the paper mode", single.mode === "paper", single.mode);
	check(
		"the paper img is the 640px preview tier",
		single.imgSrc !== null && ((single.imgSrc.startsWith("autorag-thumb://") && single.imgSrc.includes("size=640")) || (process.platform === "win32" && single.imgSrc.startsWith("data:image/"))),
		String(single.imgSrc),
	);
	check(
		"the preview decodes larger than the 128px tile tier",
		Math.max(single.naturalWidth, single.naturalHeight) > 128,
		`${single.naturalWidth}x${single.naturalHeight}`,
	);
	check(
		"the preview carries real rendered page content, not an empty stub",
		single.contentSpread !== null && single.contentSpread > 60,
		`spread=${single.contentSpread}`,
	);
	check(
		"the paper has no fixed frame: the image fills the panel width and sets the height",
		single.paperBox !== null &&
			single.imgBox !== null &&
			Math.abs(single.paperBox.width - single.imgBox.width) <= 2 &&
			Math.abs(single.paperBox.height - single.imgBox.height) <= 2 &&
			single.imgBox.width >= single.paperBox.width - 2,
		JSON.stringify({ paper: single.paperBox, img: single.imgBox }),
	);
	check("a portrait page renders taller than the old 152px frame", single.imgBox !== null && single.imgBox.height > 200, JSON.stringify(single.imgBox));
	check("the file name still shows under the paper", single.title === "deck-a.pdf", single.title);

	console.log("phase: two");
	// ------------------------------------------- two selections: paper stack
	await page.keyboard.down("Meta");
	await rowNamed(page, "deck-b.pdf").click();
	await page.keyboard.up("Meta");
	await page.waitForFunction(
		() => document.querySelector(".preview-stack") !== null && document.querySelectorAll(".preview-stack-card").length === 2,
		undefined,
		{ timeout: 10000 },
	);
	await page.waitForFunction(
		() => {
			const imgs = [...document.querySelectorAll(".preview-stack-card img")];
			return imgs.length === 2 && imgs.every((img) => img.complete && img.naturalWidth > 0);
		},
		undefined,
		{ timeout: 15000 },
	);
	await new Promise((resolve) => setTimeout(resolve, 300));
	const multi = await probe(page);
	await page.screenshot({ path: join(EVIDENCE, "02-multi-paper-stack.png") });

	check("two-file selection switches the panel to the stack mode", multi.mode === "stack", multi.mode);
	check("the stack fans one card per selected file", multi.cards.length === 2, String(multi.cards.length));
	check("every card shows its own decoded preview", multi.cards.every((card) => card.hasImage));
	check(
		"the back card is rotated and offset, so the fan reads as stacked papers",
		multi.cards.some((card) => card.rotate !== "none" && card.rotate !== "") &&
			new Set(multi.cards.map((card) => card.left)).size === multi.cards.length,
		JSON.stringify(multi.cards.map((card) => ({ rotate: card.rotate, left: card.left }))),
	);
	check("every sheet is dog-eared and shadowed", multi.cards.every((card) => card.curl && card.boxShadow !== "none"), "");
	check("the title counts the selection", multi.title === "2 items", multi.title);
	check("the subtitle carries the kind breakdown and the total size", /PDF document 2 · .+/i.test(multi.sub), multi.sub);
	check("the rows carry the total size", /B$/.test(String(valueOf(multi.rows, "Total size"))), String(valueOf(multi.rows, "Total size")));
	check(
		"the rows carry the modified date for the shared fixture day",
		valueOf(multi.rows, "Date Modified") === "2026-01-02",
		String(valueOf(multi.rows, "Date Modified")),
	);
	check("no single-file action bar in the stack mode", !multi.text.includes("Included in AI search index"), "");

	console.log("phase: five");
	// ------------------------------------------- five selections: full fan
	await rowNamed(page, "deck-a.pdf").click();
	await page.keyboard.down("Shift");
	await rowNamed(page, "notes.txt").click();
	await page.keyboard.up("Shift");
	await page.waitForFunction(
		() => document.querySelectorAll(".preview-stack-card").length === 5,
		undefined,
		{ timeout: 10000 },
	);
	// The text file is gated out of Quick Look (letter tile), so four sheets get previews.
	await page.waitForFunction(
		() => {
			const imgs = [...document.querySelectorAll(".preview-stack-card img")];
			return imgs.length === 4 && imgs.every((img) => img.complete && img.naturalWidth > 0);
		},
		undefined,
		{ timeout: 15000 },
	);
	await new Promise((resolve) => setTimeout(resolve, 300));
	const five = await probe(page);
	await page.screenshot({ path: join(EVIDENCE, "03-five-paper-stack.png") });

	check("five-file selection fans five papers", five.cards.length === 5, String(five.cards.length));
	check("the four visual files show their own decoded previews", five.cards.filter((card) => card.hasImage).length === 4, JSON.stringify(five.cards.map((card) => card.hasImage)));
	check("the text file keeps its letter tile inside its sheet (Quick Look gate)", five.cards.some((card) => !card.hasImage));
	check(
		"the papers sit at distinct angles like a real paper pile",
		new Set(five.cards.map((card) => card.rotate)).size >= 4,
		JSON.stringify(five.cards.map((card) => card.rotate)),
	);
	check("every fanned sheet is dog-eared and shadowed", five.cards.every((card) => card.curl && card.boxShadow !== "none"), "");
	check("the title counts five items", five.title === "5 items", five.title);
	check("the subtitle breaks the kinds down", five.sub.toLowerCase().startsWith("pdf document 4"), five.sub);

	console.log("phase: restore");
	// --------------------------------------------- back to single: restore
	await rowNamed(page, "photo.jpg").click();
	await page.waitForFunction(
		() => {
			const paper = document.querySelector(".preview-paper");
			const img = paper?.querySelector("img");
			return paper !== null && img !== null && img.complete && img.naturalWidth > 0;
		},
		undefined,
		{ timeout: 15000 },
	);
	await new Promise((resolve) => setTimeout(resolve, 300));
	const restored = await probe(page);
	await page.screenshot({ path: join(EVIDENCE, "04-single-image-preview.png") });

	check("returning to a single selection restores the paper mode", restored.mode === "paper", restored.mode);
	check("the image preview decodes its pixels", restored.naturalWidth > 0 && restored.naturalHeight > 0, `${restored.naturalWidth}x${restored.naturalHeight}`);
	check(
		"the restored preview is full-width too",
		restored.paperBox !== null && restored.imgBox !== null && restored.imgBox.width >= restored.paperBox.width - 2,
		JSON.stringify(restored.imgBox),
	);
	check("the image name shows under the paper", restored.title === "photo.jpg", restored.title);

	console.log("phase: reselect");
	// ----------------------- reselect a previewed file: no loading state at all
	// The renderer caches (path, mtime) → preview + aspect, so coming back to a
	// file must paint the final full-width paper on the first frames — never
	// the legacy fixed box, never a height snap.
	await rowNamed(page, "deck-b.pdf").click();
	await page.waitForFunction(
		() => {
			const img = document.querySelector(".preview-paper img");
			return img !== null && img.getAttribute("src")?.includes("size=640") && img.complete && img.naturalWidth > 0;
		},
		undefined,
		{ timeout: 15000 },
	);
	await rowNamed(page, "photo.jpg").click();
	const immediate = await page.evaluate(
		() =>
			new Promise((resolve) =>
				requestAnimationFrame(() =>
					requestAnimationFrame(() => {
						const img = document.querySelector(".preview-paper img");
						const paper = document.querySelector(".preview-paper");
						resolve({
							src: img?.getAttribute("src") ?? null,
							paperHeight: Math.round(paper?.getBoundingClientRect().height ?? 0),
							imgHeight: Math.round(img?.getBoundingClientRect().height ?? 0),
						});
					}),
				),
			),
	);
	check(
		"re-selecting a previewed file paints its full-size paper within two frames — no fixed-box flash, no height snap",
		immediate.src !== null &&
			immediate.src.includes("size=640") &&
			immediate.src.includes("photo.jpg") &&
			Math.abs(immediate.paperHeight - immediate.imgHeight) <= 2 &&
			immediate.paperHeight > 200,
		JSON.stringify(immediate),
	);
	await page.screenshot({ path: join(EVIDENCE, "05-reselected-instant.png") });

	console.log("phase: hwp");
	// ------------------- HWP / HWPX: rhwp draws the real first page in the paper
	// macOS and Windows have no OS thumbnailer for HWP without Hancom's plug-in,
	// so the paper must come from rhwp, not the letter tile or the type icon.
	// rhwp draws one <text> per glyph; each fixture's first glyph tells its paper from the previous file's.
	for (const [name, glyph] of [["사업계획서.hwp", ">사<"], ["회의록.hwpx", ">회<"]]) {
		await rowNamed(page, name).click();
		await page.waitForFunction(
			(own) => {
				const img = document.querySelector(".preview-paper img");
				const paper = document.querySelector(".preview-paper");
				if (!(img instanceof HTMLImageElement) || paper === null || !decodeURIComponent(img.src).includes(own) || !img.complete || img.naturalWidth === 0) return false;
				// Faded in, and the paper's aspect transition has reached the page's own shape.
				const box = paper.getBoundingClientRect();
				return getComputedStyle(img).opacity === "1" && Math.abs(box.height / box.width - img.naturalHeight / img.naturalWidth) < 0.02;
			},
			glyph,
			{ timeout: 15000 },
		);
		const hwp = await probe(page);
		const label = name.endsWith(".hwpx") ? "hwpx" : "hwp";
		// Every pixel: a one-line test document is too sparse for the probe's sampling stride.
		const glyphs = await page.evaluate(() => {
			const img = document.querySelector(".preview-paper img");
			const canvas = document.createElement("canvas");
			canvas.width = img.naturalWidth;
			canvas.height = img.naturalHeight;
			const context = canvas.getContext("2d");
			context.drawImage(img, 0, 0);
			const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
			let dark = 0;
			for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 128 && data[i] + data[i + 1] + data[i + 2] < 300) dark += 1;
			return dark;
		});
		check(`${label} paper renders rhwp's first page, not a tile`, hwp.mode === "paper" && hwp.imgSrc?.startsWith("data:image/svg+xml") === true, hwp.imgSrc?.slice(0, 40) ?? "no img");
		check(`${label} first page carries the document's own text`, decodeURIComponent(hwp.imgSrc ?? "").includes(">첫<"));
		check(`${label} paper paints the page's glyphs`, glyphs > 50, `${glyphs} dark px`);
		check(`${label} paper keeps the A4 portrait shape`, hwp.imgBox !== null && Math.abs(hwp.imgBox.height / hwp.imgBox.width - 297 / 210) < 0.02, JSON.stringify(hwp.imgBox));
		await page.screenshot({ path: join(EVIDENCE, `06-${label}-paper.png`) });
	}

	await Bun.write(join(EVIDENCE, "manifest.json"), `${JSON.stringify({ results, folder }, null, 2)}\n`);
} finally {
	await app?.close();
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed → ${EVIDENCE}`);
if (failed.length > 0 || results.length === 0) process.exitCode = 1;
