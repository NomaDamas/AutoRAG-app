import { fileURLToPath } from "node:url";
/**
 * Manual QA — sidebar items must never crash fs:listDir.
 *
 * The reference's Sources group (Slack / Gmail / Notion / Discord / Telegram)
 * is removed until the librarian crawler-CLI datasources are wired (issue #20),
 * so this script guards the crash-to-toast behavior across every remaining
 * place:
 *   1. "Recents" navigates to the virtual Recents listing (no handler error,
 *      no "not linked" toast).
 *   2. No source labels render in the sidebar.
 *   3. Clicking every place button never produces an fs:listDir handler error,
 *      and the only toast that can appear is the friendly not-linked one
 *      (the Crash-to-toast regression guard from #1735).
 *
 * Run from the repo root: `bun scripts/manual-qa/run-qa-finder-nav-guard.mjs`
 * Prereq: `bun run build`
 */

import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { mkdirSync } from "node:fs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const EVIDENCE = `${ROOT}/.omo/evidence/ai-finder-app/qa-nav-guard/`;
mkdirSync(EVIDENCE, { recursive: true });

/** Deferred by issue #20 — must not render. */
const SOURCE_LABELS = ["Slack", "Gmail", "Notion", "Discord", "Telegram"];
/** Every place the sidebar can still show. */
const PLACE_LABELS = ["Desktop", "Downloads", "Documents", "iCloud Drive", "Google Drive", "Dropbox"];
const NOT_LINKED = "아직 연결되지 않았습니다";

const app = await launchFinder();
const results = [];
const check = (label, pass) => {
	results.push({ label, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
};
try {
	// The pre-warmed Quick Look window can register first; firstWindow() would race it.
	const page = await finderWindow(app, 30000);
	const handlerErrors = [];
	page.on("console", (message) => {
		if (/Error occurred in handler/i.test(message.text())) handlerErrors.push(message.text());
	});
	const places = page.getByLabel("Places");
	// Shell-ready, not rows-ready: a home with no files renders the empty state,
	// and this lane is about the sidebar's navigation behavior, not the listing.
	await page.waitForSelector(".toolbar-title", { timeout: 30000 });

	// 1. Recents is a real location: it must navigate cleanly, with no toast.
	await places.getByRole("button", { name: "Recents", exact: true }).click();
	await page.waitForTimeout(800);
	const recentsToasts = await page.locator(".toast").count();
	check("Recents navigates without a not-linked toast", recentsToasts === 0);
	check("no fs:listDir handler error after the Recents click", handlerErrors.length === 0);

	// 2. The Sources group is gone from the sidebar.
	for (const label of SOURCE_LABELS) {
		const count = await places.getByRole("button", { name: label, exact: true }).count();
		check(`no "${label}" sidebar item`, count === 0);
	}

	// 3. Every remaining place click is safe: no handler error, and any toast is
	//    the friendly not-linked message rather than a crash.
	let unexpectedToast = null;
	for (const label of PLACE_LABELS) {
		const button = places.getByRole("button", { name: label, exact: true });
		if ((await button.count()) === 0) continue;
		await button.click();
		await page.waitForTimeout(700);
		for (const text of await page.locator(".toast").allTextContents()) {
			if (!text.includes(NOT_LINKED)) unexpectedToast = `${label}: ${text}`;
		}
	}
	check("no fs:listDir handler error after any place click", handlerErrors.length === 0);
	check(
		`any toast is the not-linked message${unexpectedToast === null ? "" : ` (saw "${unexpectedToast}")`}`,
		unexpectedToast === null,
	);

	// 4. The list region still renders after the clicks.
	await places.getByRole("button", { name: "Documents", exact: true }).click();
	await page.waitForTimeout(700);
	const rows = await page.locator('[role="row"]').count();
	const emptyState =
		(await page.locator(`text=${NOT_LINKED}`).count()) +
		(await page.locator("text=빈 폴더").count()) +
		(await page.locator("text=최근에 연 파일이 없습니다").count());
	check(`view still renders a list or empty state (rows ${rows}, empty ${emptyState})`, rows > 0 || emptyState > 0);

	await page.screenshot({ path: `${EVIDENCE}/after-nav-clicks.png` });
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
