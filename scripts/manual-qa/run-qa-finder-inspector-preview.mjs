/**
 * Manual QA — Inspector preview paper and the multi-selection paper stack
 * (real Electron).
 *
 * Builds a fixture folder with two real one-page PDFs, an EXIF JPEG, and a
 * text file, then checks on the running app that:
 *  - selecting a PDF renders the 640px Quick Look tier in the preview paper
 *    (the img URL carries `size=640` and decodes well past tile size), so the
 *    page's real content is visible, not just the letter tile;
 *  - ⌘-clicking a second file switches the Info panel to the paper stack:
 *    `.preview-stack` fans one card per selected file (focused in front), the
 *    title reads "2개 항목", and the rows carry the total size and the
 *    created/modified date ranges;
 *  - returning to a single selection restores the single preview.
 * Screenshots land in EVIDENCE.
 *
 * `bun run build` first, then
 * `bun scripts/manual-qa/run-qa-finder-inspector-preview.mjs`
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExifJpeg } from "../../test/support/exif-fixture.ts";
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
await Bun.write(join(folder, "deck-a.pdf"), buildPdf("AutoRAG Meetup Deck A"));
await Bun.write(join(folder, "deck-b.pdf"), buildPdf("AutoRAG Meetup Deck B"));
await Bun.write(join(folder, "photo.jpg"), buildExifJpeg());
await Bun.write(join(folder, "notes.txt"), "preview qa\n");
// A stable mtime so the date-range assertion does not depend on run time.
const FIXTURE_MTIME = new Date("2026-01-02T09:05:00Z");
for (const name of ["deck-a.pdf", "deck-b.pdf", "photo.jpg", "notes.txt"]) {
	utimesSync(join(folder, name), FIXTURE_MTIME, FIXTURE_MTIME);
}

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
			return { hasImage: cardImg !== null && cardImg.naturalWidth > 0, rotate: style.rotate, left: card.getBoundingClientRect().left };
		});
		const rows = [...document.querySelectorAll(".inspector-body dl > div")].map((row) => ({
			label: row.querySelector("dt")?.textContent ?? "",
			value: row.querySelector("dd")?.textContent ?? "",
		}));
		return {
			mode: stack !== null ? "stack" : paper !== null ? "paper" : "none",
			imgSrc: img?.getAttribute("src") ?? null,
			naturalWidth: img?.naturalWidth ?? 0,
			naturalHeight: img?.naturalHeight ?? 0,
			contentSpread,
			cards,
			title: document.querySelector(".preview-title")?.textContent ?? "",
			sub: document.querySelector(".preview-sub")?.textContent ?? "",
			rows,
			text: document.querySelector(".inspector-body")?.innerText ?? "",
		};
	});

const valueOf = (rows, label) => rows.find((row) => row.label === label)?.value;

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
	await page.locator('[role="row"]').filter({ hasText: "deck-a.pdf" }).waitFor();
	await page.mouse.move(2, 2);

	// ------------------------------------------------ single selection: paper
	await page.locator('[role="row"]').filter({ hasText: "deck-a.pdf" }).first().click();
	await page.waitForFunction(
		() => {
			const img = document.querySelector(".preview-paper img");
			return img !== null && img.getAttribute("src")?.includes("size=640") && img.complete && img.naturalWidth > 0;
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
		single.imgSrc !== null && single.imgSrc.startsWith("autorag-thumb://") && single.imgSrc.includes("size=640"),
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
	check("the file name still shows under the paper", single.title === "deck-a.pdf", single.title);

	// ------------------------------------------- multi selection: paper stack
	await page.keyboard.down("Meta");
	await page.locator('[role="row"]').filter({ hasText: "deck-b.pdf" }).first().click();
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
			new Set(multi.cards.map((card) => Math.round(card.left))).size === multi.cards.length,
		JSON.stringify(multi.cards.map((card) => ({ rotate: card.rotate, left: Math.round(card.left) }))),
	);
	check("the title counts the selection", multi.title === "2개 항목", multi.title);
	check("the subtitle carries the kind breakdown and the total size", /PDF document 2개 · .+/.test(multi.sub), multi.sub);
	check("the rows carry the total size", /B$/.test(String(valueOf(multi.rows, "총 크기"))), String(valueOf(multi.rows, "총 크기")));
	check(
		"the rows carry the modified date for the shared fixture day",
		valueOf(multi.rows, "수정한 날짜") === "2026-01-02",
		String(valueOf(multi.rows, "수정한 날짜")),
	);
	check("no single-file action bar in the stack mode", !multi.text.includes("인덱스 포함"), "");

	// --------------------------------------------- back to single: restore
	await page.locator('[role="row"]').filter({ hasText: "photo.jpg" }).first().click();
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
	await page.screenshot({ path: join(EVIDENCE, "03-single-image-preview.png") });

	check("returning to a single selection restores the paper mode", restored.mode === "paper", restored.mode);
	check("the image preview decodes its pixels", restored.naturalWidth > 0 && restored.naturalHeight > 0, `${restored.naturalWidth}x${restored.naturalHeight}`);
	check("the image name shows under the paper", restored.title === "photo.jpg", restored.title);

	await Bun.write(join(EVIDENCE, "manifest.json"), `${JSON.stringify({ results, folder }, null, 2)}\n`);
} finally {
	await app?.close();
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed → ${EVIDENCE}`);
if (failed.length > 0 || results.length === 0) process.exitCode = 1;
