/**
 * Manual QA — Contacts work-in-progress view and the removed Access column.
 *
 *  1. Clicking the People group's "Contacts" item opens the work-in-progress
 *     view ("준비중 · Work in progress") with no rows, no toast, and no
 *     fs:listDir handler error.
 *  2. The Finder column header no longer shows "Access", and rows carry only
 *     the Index pill.
 *
 * Run from the repo root: `bun scripts/manual-qa/run-qa-finder-contacts-wip.mjs`
 */

import { _electron } from "playwright";
import { mkdirSync } from "node:fs";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const EVIDENCE = `${ROOT}/.omo/evidence/ai-finder-app/qa-contacts-wip/`;
mkdirSync(EVIDENCE, { recursive: true });

const app = await _electron.launch({ args: ["."], cwd: ROOT });
const results = [];
const check = (label, pass) => {
	results.push({ label, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
};
try {
	const page = await app.firstWindow();
	const handlerErrors = [];
	page.on("console", (message) => {
		if (/Error occurred in handler/i.test(message.text())) handlerErrors.push(message.text());
	});
	await page.waitForSelector('[role="row"]', { timeout: 30000 });

	// 1. Contacts opens the work-in-progress view.
	await page.getByLabel("Places").getByRole("button", { name: "Contacts", exact: true }).click();
	await page.waitForSelector("text=준비중 · Work in progress", { timeout: 10000 });
	check("Contacts click shows the work-in-progress view", true);
	check("no not-linked toast on Contacts", (await page.locator("text=아직 연결되지 않았습니다").count()) === 0);
	check("no rows in the work-in-progress view", (await page.locator('[role="row"]').count()) === 0);
	check("no fs:listDir handler error after the Contacts click", handlerErrors.length === 0);
	await page.screenshot({ path: `${EVIDENCE}/contacts-wip-view.png` });

	// 2. Back on a folder, the Access column is gone.
	await page.getByLabel("Places").getByRole("button", { name: "Recents", exact: true }).click();
	await page.waitForSelector('[role="row"]', { timeout: 10000 });
	const headerText = await page.locator(".col-header").innerText();
	check(`column header has no Access (got "${headerText.replace(/\s+/g, " ").trim()}")`, !/\bAccess\b/.test(headerText));
	check("rows still render the Index pill", (await page.locator(".row .pill").count()) > 0);
	await page.screenshot({ path: `${EVIDENCE}/finder-without-access.png` });
	await Bun.write(`${EVIDENCE}/result.json`, JSON.stringify({ results, handlerErrors }, null, 2));
} catch (error) {
	results.push({ label: `script error: ${error instanceof Error ? error.message : String(error)}`, pass: false });
	console.log("FAIL  script-level error:", error instanceof Error ? error.message : String(error));
} finally {
	await app.close();
}
const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
