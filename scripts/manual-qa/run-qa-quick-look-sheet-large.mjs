/**
 * Manual QA — Quick Look on a large spreadsheet.
 *
 * Space on an xlsx with three sheets of 60,000 rows, and on a 25MB csv, must
 * show the first rows within a couple of seconds and must not freeze the
 * panel while it does. The viewer reads only the rows it draws, and only the
 * sheet being shown; this lane checks that on the production build
 * (`bun run build` first) with real keystrokes:
 *
 *   - Space paints the table (100 rows) quickly, and the page stays responsive;
 *   - the pager walks to the other sheets and each one shows its own data;
 *   - the same keystrokes on a small workbook still work.
 *
 * Fixtures are written here (no Python, no network): a minimal xlsx is zipped
 * with fflate from the repo's own dependency tree.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

const EVIDENCE = process.argv[2] ?? "/tmp/autorag-quicklook-sheet-large";
mkdirSync(EVIDENCE, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "autorag-ql-sheet-"));
const MAX_MS = Number(process.env.QA_SHEET_MAX_MS ?? 4000);
const MAX_BLOCK_MS = Number(process.env.QA_SHEET_MAX_BLOCK_MS ?? 2500);

const column = (index) => String.fromCharCode(65 + index);

/** One worksheet as `sheetData` XML: `rows` rows of `cols` inline strings, the first cell naming the sheet. */
function sheetXml(label, rows, cols) {
	const body = [];
	for (let r = 0; r < rows; r += 1) {
		const cells = [];
		for (let c = 0; c < cols; c += 1) {
			const text = c === 0 ? `${label}-r${r}` : `${label}r${r}c${c}`;
			cells.push(`<c r="${column(c)}${r + 1}" t="inlineStr"><is><t>${text}</t></is></c>`);
		}
		body.push(`<row r="${r + 1}">${cells.join("")}</row>`);
	}
	return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body.join("")}</sheetData></worksheet>`;
}

function workbook(sheets) {
	const names = sheets.map((sheet) => sheet.name);
	const parts = {
		"[Content_Types].xml": strToU8(
			`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${names.map((_name, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
		),
		"_rels/.rels": strToU8(
			`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
		),
		"xl/workbook.xml": strToU8(
			`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
		),
		"xl/_rels/workbook.xml.rels": strToU8(
			`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_name, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`,
		),
	};
	sheets.forEach((sheet, i) => {
		parts[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(sheet.name, sheet.rows, sheet.cols));
	});
	return zipSync(parts, { level: 1 });
}

writeFileSync(join(root, "big-three.xlsx"), workbook([{ name: "Alpha", rows: 60000, cols: 8 }, { name: "Beta", rows: 60000, cols: 8 }, { name: "Gamma", rows: 60000, cols: 8 }]));
writeFileSync(join(root, "tiny.xlsx"), workbook([{ name: "Only", rows: 5, cols: 3 }]));
let csv = "id,name,value\n";
const lines = [];
for (let i = 0; i < 700000; i += 1) lines.push(`${i},row-${i},${(i * 1.5).toFixed(1)}`);
csv += lines.join("\n");
writeFileSync(join(root, "big.csv"), csv);

const results = [];
function check(label, pass, detail = "") {
	results.push({ label, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  (${detail})`}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const app = await launchFinder({ env: { AUTORAG_QA_ROOT: root, AUTORAG_SKIP_DUPEY_CHECK: "1" }, language: "en" });
try {
	const main = await finderWindow(app, 30_000);
	let preview;
	for (let i = 0; i < 600 && preview === undefined; i += 1) {
		preview = (await app.windows()).find((page) => page.url().includes("quick-look.html"));
		if (preview === undefined) await sleep(50);
	}
	if (preview === undefined) throw new Error("Quick Look window did not pre-warm");
	await preview.evaluate(() => {
		window.__block = 0;
		let last = performance.now();
		setInterval(() => {
			const now = performance.now();
			window.__block = Math.max(window.__block, now - last - 8);
			last = now;
		}, 8);
	});
	const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("quick-look.html"))?.isVisible() ?? false);

	async function open(name) {
		// `endsWith` with either separator: a Windows row path ends in `\name`, which `$="/name"` never matches.
		const row = main.locator(`[data-path$="/${name}"], [data-path$="\\\\${name}"]`).first();
		await row.waitFor({ timeout: 30_000 });
		await row.click();
		await sleep(250);
		await preview.evaluate(() => { window.__block = 0; });
		const started = Date.now();
		await main.keyboard.press("Space");
		for (let i = 0; i < 4000 && !(await preview.evaluate(() => document.querySelectorAll(".ql__table td").length > 0).catch(() => false)); i += 1) await sleep(10);
		const elapsed = Date.now() - started;
		await sleep(400);
		return { elapsed, blocked: Math.round(await preview.evaluate(() => window.__block)) };
	}
	async function close() {
		await main.keyboard.press("Space");
		for (let i = 0; i < 200 && (await visible()); i += 1) await sleep(30);
		await sleep(250);
	}
	const firstCell = () => preview.locator(".ql__table th").first().textContent();
	const rowCount = () => preview.locator(".ql__table tr").count();

	// Three large sheets
	let timing = await open("big-three.xlsx");
	check("3x60k-row xlsx paints within the budget", timing.elapsed < MAX_MS, `${timing.elapsed}ms`);
	check("the page is not frozen while it opens", timing.blocked < MAX_BLOCK_MS, `longest stall ${timing.blocked}ms`);
	check("it shows 100 rows", (await rowCount()) === 100, String(await rowCount()));
	check("sheet 1 shows its own data", (await firstCell()) === "Alpha-r0", (await firstCell()) ?? "");
	await preview.screenshot({ path: join(EVIDENCE, "big-three-1.png") });
	const next = preview.getByRole("button", { name: "Next" });
	await next.click();
	await sleep(60);
	for (let i = 0; i < 400 && (await firstCell()) !== "Beta-r0"; i += 1) await sleep(10);
	check("pager reaches sheet 2 with its own data", (await firstCell()) === "Beta-r0", (await firstCell()) ?? "");
	await next.click();
	for (let i = 0; i < 400 && (await firstCell()) !== "Gamma-r0"; i += 1) await sleep(10);
	check("pager reaches sheet 3 with its own data", (await firstCell()) === "Gamma-r0", (await firstCell()) ?? "");
	check("pager label names the sheet", ((await preview.locator(".ql__pager span").textContent()) ?? "") === "Gamma");
	await preview.screenshot({ path: join(EVIDENCE, "big-three-3.png") });
	await preview.getByRole("button", { name: "Previous" }).click();
	for (let i = 0; i < 400 && (await firstCell()) !== "Beta-r0"; i += 1) await sleep(10);
	check("pager walks back to sheet 2", (await firstCell()) === "Beta-r0", (await firstCell()) ?? "");
	await close();

	// Large csv
	timing = await open("big.csv");
	check("700k-row csv paints within the budget", timing.elapsed < MAX_MS, `${timing.elapsed}ms`);
	check("the page is not frozen while it opens", timing.blocked < MAX_BLOCK_MS, `longest stall ${timing.blocked}ms`);
	check("csv shows 100 rows and its header", (await rowCount()) === 100 && (await firstCell()) === "id");
	await preview.screenshot({ path: join(EVIDENCE, "big-csv.png") });
	await close();

	// Small workbook is unchanged
	timing = await open("tiny.xlsx");
	check("small workbook still opens quickly", timing.elapsed < 1500, `${timing.elapsed}ms`);
	check("small workbook shows all 5 rows", (await rowCount()) === 5, String(await rowCount()));
	check("single-sheet workbook has no pager", (await preview.locator(".ql__pager").count()) === 0);
	await close();
} finally {
	await app.close().catch(() => undefined);
	rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
