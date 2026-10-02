/**
 * Manual QA: the dev window title carries the clone, branch, and commit.
 * Asserts the real BrowserWindow title (not the document title) and the
 * in-window dev label.
 *
 * Run from the repo root after `bun run build`:
 *   bun scripts/manual-qa/run-qa-finder-dev-label.mjs
 */

import { launchFinder, finderWindow } from "./launch-finder.mjs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const EVIDENCE = join(REPO, ".omo", "evidence", "ai-finder-app", "dev-label");
mkdirSync(EVIDENCE, { recursive: true });

const app = await launchFinder({ userDataDir: `/tmp/pw-electron-qa-dev-label-${Date.now()}` });
const page = await finderWindow(app);
await page.waitForSelector('[role="row"]');

const windowTitle = await app.evaluate(({ BrowserWindow }) => {
	const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().endsWith("/index.html"));
	return window?.getTitle() ?? "";
});
const documentTitle = await page.title();
const devLabelText = await page.locator(".status-bar__dev").innerText().catch(() => null);
const bridgeDev = await page.evaluate(() => globalThis.autorag?.dev ?? null);

console.log("WINDOW-TITLE:", JSON.stringify(windowTitle));
console.log("DOCUMENT-TITLE:", JSON.stringify(documentTitle));
console.log("STATUS-BAR-DEV:", JSON.stringify(devLabelText));
console.log("BRIDGE-DEV:", JSON.stringify(bridgeDev));

const ok =
	windowTitle.includes(REPO) &&
	windowTitle.includes("@") &&
	devLabelText !== null &&
	devLabelText.includes(REPO) &&
	bridgeDev?.clonePath === REPO;
console.log("VERDICT:", ok ? "PASS" : "FAIL");

await page.screenshot({ path: join(EVIDENCE, "window-title.png") });
await app.close();
process.exit(ok ? 0 : 1);
