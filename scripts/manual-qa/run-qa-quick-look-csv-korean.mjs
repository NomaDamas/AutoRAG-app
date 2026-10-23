/**
 * Manual QA — Quick Look on Korean delimited text tables.
 *
 * Space on a csv/tsv whose Hangul is stored as UTF-8 without a byte order mark
 * (what Python, Node, and most exporters write), as UTF-8 with one, and as
 * CP949 (what Excel on Korean Windows writes) must show the Hangul, not
 * Latin-1 mojibake such as "ì´ë¦". Run on the production build
 * (`bun run build` first) with real keystrokes, and read the screenshots in
 * the evidence directory: the assertions read the DOM text, the screenshots
 * show what a person sees.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

const EVIDENCE = process.env.QA_OUT ?? process.argv[2] ?? "/tmp/autorag-quicklook-csv-korean";
mkdirSync(EVIDENCE, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "autorag-ql-csv-ko-"));

const TEXT = "이름,부서,금액\n김민수,영업,1200\n이지은,마케팅,980\n";
const EXPECTED = ["이름", "부서", "금액", "김민수", "영업", "1200", "이지은", "마케팅", "980"];
// "이름,부서,금액\n김민수,영업,1200\n" as Excel on Korean Windows saves it (CP949).
const CP949 = Uint8Array.from([
	0xc0, 0xcc, 0xb8, 0xa7, 0x2c, 0xba, 0xce, 0xbc, 0xad, 0x2c, 0xb1, 0xdd, 0xbe, 0xd7, 0x0a, 0xb1, 0xe8, 0xb9, 0xce, 0xbc, 0xf6, 0x2c, 0xbf, 0xb5, 0xbe, 0xf7, 0x2c, 0x31,
	0x32, 0x30, 0x30, 0x0a,
]);
const CP949_EXPECTED = ["이름", "부서", "금액", "김민수", "영업", "1200"];

writeFileSync(join(root, "plain-utf8.csv"), TEXT);
writeFileSync(join(root, "with-bom.csv"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(TEXT)]));
writeFileSync(join(root, "tabs.tsv"), TEXT.replaceAll(",", "\t"));
writeFileSync(join(root, "excel-cp949.csv"), CP949);
const fixtures = [
	{ name: "plain-utf8.csv", expected: EXPECTED },
	{ name: "with-bom.csv", expected: EXPECTED },
	{ name: "tabs.tsv", expected: EXPECTED },
	{ name: "excel-cp949.csv", expected: CP949_EXPECTED },
];

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
	const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("quick-look.html"))?.isVisible() ?? false);

	for (const { name, expected } of fixtures) {
		const row = main.locator(`[data-path$="/${name}"], [data-path$="\\\\${name}"]`).first();
		await row.waitFor({ timeout: 30_000 });
		await row.click();
		await sleep(250);
		await main.keyboard.press("Space");
		for (let i = 0; i < 400 && !(await preview.evaluate(() => document.querySelectorAll(".ql__table td").length > 0).catch(() => false)); i += 1) await sleep(25);
		await sleep(300);
		const cells = await preview.locator(".ql__table th, .ql__table td").allTextContents();
		check(`${name} shows its Hangul`, expected.every((cell) => cells.includes(cell)), JSON.stringify(cells));
		await preview.screenshot({ path: join(EVIDENCE, `${name}.png`) });
		await main.keyboard.press("Space");
		for (let i = 0; i < 200 && (await visible()); i += 1) await sleep(30);
		await sleep(250);
	}
} finally {
	await app.close().catch(() => undefined);
	rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
