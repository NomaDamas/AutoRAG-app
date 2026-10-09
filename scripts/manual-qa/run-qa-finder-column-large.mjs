/**
 * Manual QA — a 5,000-file folder in the column view: pane paint cost, mounted
 * rows, per-key cost, and reveal of a row that is not mounted (FS layer
 * roadmap #104, stage 6 / #103: column virtualization).
 *
 * Each run launches the built app on a fresh user-data directory, switches to
 * the column view at a QA root holding one `LARGE` folder of `COLUMN_FILES`
 * files, and measures:
 *
 *   - open: from just before the click on the folder row to the first
 *     animation frame that shows a row in the folder's pane (rAF poll), plus
 *     the renderer's main-thread task time over the open (CDP
 *     `Performance.getMetrics` TaskDuration);
 *   - mounted rows / DOM nodes in the opened pane, and the retained heap delta
 *     after a forced GC;
 *   - arrow keys: the main-thread task time per ArrowDown over `KEYS` presses
 *     (every press re-renders the pane's rows when they are not windowed);
 *   - scroll: scrolling the pane to its end mounts the last row;
 *   - reveal: with the focused row scrolled out of the window, ArrowUp mounts
 *     and shows the new focus inside the pane's viewport.
 *
 * Enrichment (OS kind / icon / Finder metadata) is held inside the filesystem
 * worker (AUTORAG_FS_WORKER_QA=1), as in the large-folder lane, so the numbers
 * are rendering cost, not helper-process cost.
 *
 *   bun run build
 *   bun scripts/manual-qa/run-qa-finder-column-large.mjs
 *
 * Knobs: COLUMN_RUNS (default 3 launches), COLUMN_FILES (default 5000),
 * COLUMN_KEYS (default 40). Evidence:
 * `.omo/evidence/ai-finder-app/qa-column-large/result.json`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { chord, sleep } from "./platform.mjs";

const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-column-large");
mkdirSync(EVIDENCE, { recursive: true });

const RUNS = Number(process.env.COLUMN_RUNS ?? 3);
const COUNT = Number(process.env.COLUMN_FILES ?? 5000);
const KEYS = Number(process.env.COLUMN_KEYS ?? 40);
/** Rows a pane may keep mounted: a generous viewport (60 rows of 27px) plus overscan on both sides. */
const MOUNT_BUDGET = 60 + 2 * 8;

const WORK = realpathSync(mkdtempSync(join(tmpdir(), "autorag-qa-column-large-")));
const QA_ROOT = join(WORK, "root");
const FOLDER = "big";
const BIG = join(QA_ROOT, FOLDER);
const EXTENSIONS = ["txt", "md", "csv", "json"];
const fileName = (index) => `${FOLDER}-${String(index).padStart(5, "0")}.${EXTENSIONS[index % EXTENSIONS.length]}`;
mkdirSync(BIG, { recursive: true });
for (let index = 0; index < COUNT; index += 1) {
	writeFileSync(join(BIG, fileName(index)), `${FOLDER} ${index}\n`);
}
const FIRST = fileName(0);
const LAST = fileName(COUNT - 1);

const results = [];
const check = (label, ok, detail) => {
	results.push({ label, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : ` :: ${detail}`}`);
};

const pane = (page) => page.locator(`.column[data-path="${BIG.replaceAll('"', '\\"')}"]`);

const runs = [];
try {
	for (let run = 0; run < RUNS; run += 1) {
		const userData = mkdtempSync(join(WORK, "user-data-"));
		const app = await launchFinder({ userDataDir: userData, env: { AUTORAG_QA_ROOT: QA_ROOT, AUTORAG_FS_WORKER_QA: "1" } });
		try {
			const page = await finderWindow(app, 30_000);
			page.setDefaultTimeout(30_000);
			const pageErrors = [];
			page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 300)));
			await app.evaluate(async ({ ipcMain }, prefix) => {
				const hold = ipcMain._invokeHandlers.get("fs-worker:qaHoldEnrichment");
				if (hold === undefined) throw new Error("fs-worker:qaHoldEnrichment is not registered (AUTORAG_FS_WORKER_QA=1)");
				await hold({}, prefix, ["enrichEntries", "finderMetadata"]);
			}, `${BIG}/`);
			const cdp = await page.context().newCDPSession(page);
			await cdp.send("HeapProfiler.enable");
			await cdp.send("Performance.enable");
			const metric = async (name) => {
				const { metrics } = await cdp.send("Performance.getMetrics");
				return metrics.find((entry) => entry.name === name)?.value ?? 0;
			};
			const retainedHeap = async () => {
				for (let pass = 0; pass < 3; pass += 1) await cdp.send("HeapProfiler.collectGarbage");
				const { usedSize } = await cdp.send("Runtime.getHeapUsage");
				return usedSize;
			};
			const frames = (count = 2) =>
				page.evaluate(
					(n) =>
						new Promise((resolve) => {
							const tick = (left) => (left === 0 ? resolve(undefined) : requestAnimationFrame(() => tick(left - 1)));
							tick(n);
						}),
					count,
				);

			await page.locator(".sidebar__item", { hasText: "QA" }).click();
			await page.locator(`[data-path="${BIG}"]`).first().waitFor();
			await page.keyboard.press(chord("3"));
			await page.waitForSelector(".column");
			const folderRow = page.locator(`.column-row[data-path="${BIG}"]`);
			await folderRow.waitFor();
			await sleep(3000);

			const heapBefore = await retainedHeap();
			const taskBefore = await metric("TaskDuration");
			await page.evaluate(() => {
				globalThis.__columnMark = performance.now();
			});
			await folderRow.click();
			const openMs = await page
				.waitForFunction(
					(dir) => (document.querySelector(`.column[data-path="${CSS.escape(dir)}"] .column-row`) === null ? null : performance.now() - globalThis.__columnMark),
					BIG,
					{ polling: "raf", timeout: 60_000 },
				)
				.then((handle) => handle.jsonValue());
			await sleep(500);
			const openTaskMs = Math.round(((await metric("TaskDuration")) - taskBefore) * 1000);
			const heapOpen = await retainedHeap();
			const mountedRows = await pane(page).locator(".column-row").count();
			const domNodes = await page.evaluate(() => document.querySelectorAll("*").length);
			await page.screenshot({ path: join(EVIDENCE, `open-${run + 1}.png`) });

			// Arrow keys: focus the first row, then step down KEYS times.
			await pane(page).locator(`.column-row[aria-label="${FIRST}"]`).click();
			await frames();
			const keysBefore = await metric("TaskDuration");
			for (let key = 0; key < KEYS; key += 1) {
				await page.keyboard.press("ArrowDown");
				await frames(1);
			}
			const keyTaskMs = +((((await metric("TaskDuration")) - keysBefore) * 1000) / KEYS).toFixed(2);
			const focusedAfterKeys = await page.locator('.column-row[aria-selected="true"]').getAttribute("aria-label");

			// Scroll the pane to its end: the last row must mount.
			await pane(page).evaluate((element) => {
				element.scrollTop = element.scrollHeight;
			});
			await frames(3);
			const lastMounted = (await pane(page).locator(`.column-row[aria-label="${LAST}"]`).count()) === 1;
			const mountedAtEnd = await pane(page).locator(".column-row").count();

			// Reveal: focus the last row, scroll the pane back to the top (focus is
			// not mounted), then ArrowUp must bring the new focus into view.
			await pane(page).locator(`.column-row[aria-label="${LAST}"]`).click();
			await pane(page).evaluate((element) => {
				element.scrollTop = 0;
			});
			await frames(3);
			const focusUnmounted = (await pane(page).locator(`.column-row[aria-label="${LAST}"]`).count()) === 0;
			await page.keyboard.press("ArrowUp");
			await frames(3);
			const revealed = await page.evaluate((dir) => {
				const scroller = document.querySelector(`.column[data-path="${CSS.escape(dir)}"]`);
				const focused = scroller?.querySelector('.column-row[aria-selected="true"]');
				if (scroller === null || focused === null || focused === undefined) return null;
				const box = focused.getBoundingClientRect();
				const view = scroller.getBoundingClientRect();
				return { label: focused.getAttribute("aria-label"), inView: box.top >= view.top - 1 && box.bottom <= view.bottom + 1 };
			}, BIG);

			const sample = {
				openMs: Math.round(openMs * 10) / 10,
				openTaskMs,
				openHeapMB: +((heapOpen - heapBefore) / 1e6).toFixed(2),
				mountedRows,
				mountedAtEnd,
				domNodes,
				keyTaskMs,
				pageErrors,
			};
			runs.push(sample);
			console.log(`INFO  run ${run + 1}/${RUNS} ${JSON.stringify(sample)}`);
			check(`run ${run + 1}: no page errors`, pageErrors.length === 0, pageErrors[0]);
			check(`run ${run + 1}: ArrowDown ×${KEYS} focuses row ${KEYS}`, focusedAfterKeys === fileName(KEYS), `${focusedAfterKeys}`);
			check(`run ${run + 1}: scrolling to the end mounts the last row`, lastMounted);
			check(`run ${run + 1}: mounted rows ≤ ${MOUNT_BUDGET} at open and at the end`, mountedRows <= MOUNT_BUDGET && mountedAtEnd <= MOUNT_BUDGET, `${mountedRows}/${mountedAtEnd}`);
			check(`run ${run + 1}: focus row is not mounted before the reveal`, focusUnmounted);
			check(`run ${run + 1}: ArrowUp reveals the new focus inside the pane`, revealed?.label === fileName(COUNT - 2) && revealed.inView, JSON.stringify(revealed));
		} finally {
			await app.close().catch(() => undefined);
		}
	}
} finally {
	rmSync(WORK, { recursive: true, force: true });
}

const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : +((sorted[middle - 1] + sorted[middle]) / 2).toFixed(2);
};
const stat = (pick) => {
	const values = runs.map(pick).filter((value) => typeof value === "number");
	return values.length === 0 ? null : { median: median(values), min: Math.min(...values), max: Math.max(...values) };
};
const summary = {
	files: COUNT,
	runs: runs.length,
	openMs: stat((run) => run.openMs),
	openTaskMs: stat((run) => run.openTaskMs),
	openHeapMB: stat((run) => run.openHeapMB),
	mountedRows: stat((run) => run.mountedRows),
	domNodes: stat((run) => run.domNodes),
	keyTaskMs: stat((run) => run.keyTaskMs),
};
console.log(`INFO  summary ${JSON.stringify(summary)}`);
writeFileSync(join(EVIDENCE, "result.json"), `${JSON.stringify({ summary, runs, checks: results }, null, 2)}\n`);
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0 || runs.length < RUNS) process.exitCode = 1;
