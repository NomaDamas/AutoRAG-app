/**
 * Manual QA — memory soak and per-interaction cost (FS layer roadmap #104).
 *
 * Drives the built app through repeated browse cycles against a fixture tree
 * and measures what a long session accumulates:
 *
 *   - renderer JS heap after a forced GC (CDP `HeapProfiler.collectGarbage`),
 *     sampled after a warm-up and after the soak, so the delta is retained
 *     memory, not garbage waiting for collection;
 *   - main-process RSS (Electron's own `process.memoryUsage().rss`);
 *   - main event-loop delay p99 (`perf_hooks.monitorEventLoopDelay`) over the soak;
 *   - how many `index:status` IPC calls one selection change triggers (wrapped
 *     inside main through `ipcMain`'s invoke handler, so nothing in the app
 *     changes for the measurement).
 *
 * A cycle: open each fixture folder through its row, click rows down the list,
 * toggle Quick Look on some, switch view modes list → icons → columns → list,
 * open/close a tab, and come back up. Fixture folders hold files only, so a
 * cycle never touches the user's real folders.
 *
 * Gates (FS roadmap stage 1 acceptance) are enforced only with
 * `SOAK_ENFORCE=1`; without it the lane reports numbers and always passes, so
 * a baseline run on an unfixed tree records its figures instead of failing.
 *
 *   bun run build
 *   bun scripts/manual-qa/run-qa-finder-memory-soak.mjs              # report
 *   SOAK_ENFORCE=1 bun scripts/manual-qa/run-qa-finder-memory-soak.mjs  # gate
 *
 * Knobs: SOAK_CYCLES (default 40), SOAK_WARMUP (default 5).
 * Evidence: `.omo/evidence/ai-finder-app/qa-memory-soak/result.json`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { chord, sleep } from "./platform.mjs";

const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-memory-soak");
mkdirSync(EVIDENCE, { recursive: true });

const CYCLES = Number(process.env.SOAK_CYCLES ?? 40);
const WARMUP = Number(process.env.SOAK_WARMUP ?? 5);
const ENFORCE = process.env.SOAK_ENFORCE === "1";
/** Stage 1 gates: retained renderer heap per cycle, and index:status calls per click. */
const MAX_HEAP_GROWTH_PER_CYCLE_MB = 0.25;
const MAX_INDEX_STATUS_PER_CLICK = 0;
const MAX_LOOP_P99_MS = 100;

const WORK = realpathSync(mkdtempSync(join(tmpdir(), "autorag-qa-soak-")));
const USER_DATA = join(WORK, "user-data");
const QA_ROOT = join(WORK, "root");
const FOLDERS = ["alpha", "beta", "gamma"];
const FILES_PER_FOLDER = 400;
for (const folder of FOLDERS) {
	const dir = join(QA_ROOT, folder);
	mkdirSync(dir, { recursive: true });
	for (let index = 0; index < FILES_PER_FOLDER; index += 1) {
		const ext = ["txt", "md", "csv", "json"][index % 4];
		writeFileSync(join(dir, `${folder}-${String(index).padStart(4, "0")}.${ext}`), `${folder} ${index}\n`);
	}
}

const results = [];
const check = (label, ok, detail) => {
	results.push({ label, ok, detail });
	console.log(`${ok ? "PASS" : ENFORCE ? "FAIL" : "INFO"}  ${label}${detail === undefined ? "" : ` :: ${detail}`}`);
};

let app;
try {
	app = await launchFinder({ userDataDir: USER_DATA, env: { AUTORAG_QA_ROOT: QA_ROOT } });
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(15_000);
	const pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 300)));
	let rendererGone = false;
	page.on("crash", () => {
		rendererGone = true;
	});

	// Main-side probes: index:status call counter and event-loop delay histogram.
	await app.evaluate(({ ipcMain }) => {
		const handlers = ipcMain._invokeHandlers;
		const original = handlers.get("index:status");
		globalThis.__soakIndexStatusCalls = 0;
		if (original !== undefined) {
			handlers.set("index:status", (...args) => {
				globalThis.__soakIndexStatusCalls += 1;
				return original(...args);
			});
		}
		globalThis.__soakHasIndexProbe = original !== undefined;
	});
	const mainProbe = () =>
		app.evaluate(() => ({
			indexStatusCalls: globalThis.__soakIndexStatusCalls,
			hasIndexProbe: globalThis.__soakHasIndexProbe,
			rss: process.memoryUsage().rss,
			loopP99: globalThis.__soakLoop === undefined ? null : globalThis.__soakLoop.percentile(99) / 1e6,
			loopMax: globalThis.__soakLoop === undefined ? null : globalThis.__soakLoop.max / 1e6,
		}));
	const startLoopMonitor = () =>
		app.evaluate(() => {
			const { monitorEventLoopDelay } = process.getBuiltinModule("node:perf_hooks");
			globalThis.__soakLoop?.disable();
			globalThis.__soakLoop = monitorEventLoopDelay({ resolution: 10 });
			globalThis.__soakLoop.enable();
		});

	const cdp = await page.context().newCDPSession(page);
	await cdp.send("HeapProfiler.enable");
	const retainedHeap = async () => {
		for (let pass = 0; pass < 3; pass += 1) await cdp.send("HeapProfiler.collectGarbage");
		// `performance.memory` is bucketed without --enable-precise-memory-info; CDP is exact.
		const { usedSize } = await cdp.send("Runtime.getHeapUsage");
		return usedSize;
	};
	await page.locator(".sidebar__item", { hasText: "QA" }).click();
	await page.waitForSelector(`[data-path="${join(QA_ROOT, FOLDERS[0])}"]`);
	await page.locator('.seg__button[aria-label="List"]').click();

	const rows = page.locator('[role="row"]');
	const openFolder = async (folder) => {
		await page.locator(".sidebar__item", { hasText: "QA" }).click();
		const row = page.locator(`[data-path="${join(QA_ROOT, folder)}"]`).first();
		await row.waitFor();
		await row.dblclick();
		await page.locator(`[data-path="${join(QA_ROOT, folder, `${folder}-0000.txt`)}"]`).first().waitFor();
	};
	const cycle = async () => {
		for (const folder of FOLDERS) {
			await openFolder(folder);
			const count = Math.min(await rows.count(), 16);
			for (let index = 0; index < count; index += 1) {
				await rows.nth(index).click();
				if (index % 5 === 0) {
					await page.keyboard.press("Space");
					await sleep(150);
					await page.keyboard.press("Escape");
				}
			}
			for (let step = 0; step < 6; step += 1) await page.keyboard.press("ArrowDown");
		}
		await page.locator('.seg__button[aria-label="Icons"]').click();
		await sleep(150);
		await page.locator('.seg__button[aria-label="Columns"]').click();
		await sleep(150);
		await page.locator('.seg__button[aria-label="List"]').click();
		await page.keyboard.press(chord("t"));
		await sleep(150);
		await page.keyboard.press(chord("w"));
		await sleep(150);
	};

	// 1. Per-interaction IPC cost: clicks inside an already-listed folder.
	await openFolder(FOLDERS[0]);
	await sleep(1500);
	const beforeClicks = await mainProbe();
	const CLICKS = 10;
	for (let index = 0; index < CLICKS; index += 1) {
		await rows.nth(index).click();
		await sleep(80);
	}
	await sleep(500);
	const afterClicks = await mainProbe();
	const perClick = (afterClicks.indexStatusCalls - beforeClicks.indexStatusCalls) / CLICKS;
	check("index:status probe installed", afterClicks.hasIndexProbe === true, String(afterClicks.hasIndexProbe));

	// 2. Warm-up, then the soak.
	for (let index = 0; index < WARMUP; index += 1) await cycle();
	await sleep(1000);
	const heapStart = await retainedHeap();
	const rssStart = (await mainProbe()).rss;
	await startLoopMonitor();
	const started = Date.now();
	const samples = [];
	for (let index = 0; index < CYCLES; index += 1) {
		await cycle();
		if ((index + 1) % 10 === 0) {
			const heap = await retainedHeap();
			const probe = await mainProbe();
			samples.push({ cycle: index + 1, heapMB: +(heap / 1e6).toFixed(1), mainRssMB: +(probe.rss / 1e6).toFixed(1) });
			console.log(`INFO  cycle ${index + 1}: heap ${(heap / 1e6).toFixed(1)} MB, main RSS ${(probe.rss / 1e6).toFixed(1)} MB`);
		}
	}
	await sleep(1500);
	const heapEnd = await retainedHeap();
	const end = await mainProbe();
	const growthPerCycleMB = (heapEnd - heapStart) / 1e6 / CYCLES;

	const summary = {
		cycles: CYCLES,
		seconds: Math.round((Date.now() - started) / 1000),
		heapStartMB: +(heapStart / 1e6).toFixed(1),
		heapEndMB: +(heapEnd / 1e6).toFixed(1),
		heapGrowthPerCycleMB: +growthPerCycleMB.toFixed(3),
		mainRssStartMB: +(rssStart / 1e6).toFixed(1),
		mainRssEndMB: +(end.rss / 1e6).toFixed(1),
		mainLoopP99Ms: end.loopP99 === null ? null : +end.loopP99.toFixed(1),
		mainLoopMaxMs: end.loopMax === null ? null : +end.loopMax.toFixed(1),
		indexStatusPerClick: perClick,
		samples,
		pageErrors,
	};
	console.log(`INFO  summary ${JSON.stringify(summary)}`);

	check("renderer stayed alive through the soak", !rendererGone);
	check("no page errors during the soak", pageErrors.length === 0, pageErrors[0]);
	check(
		`retained renderer heap grows ≤ ${MAX_HEAP_GROWTH_PER_CYCLE_MB} MB/cycle`,
		growthPerCycleMB <= MAX_HEAP_GROWTH_PER_CYCLE_MB,
		`${growthPerCycleMB.toFixed(3)} MB/cycle (${summary.heapStartMB} → ${summary.heapEndMB} MB over ${CYCLES})`,
	);
	check(
		`a selection click sends ≤ ${MAX_INDEX_STATUS_PER_CLICK} index:status IPC`,
		perClick <= MAX_INDEX_STATUS_PER_CLICK,
		`${perClick} per click`,
	);
	check(
		`main event-loop delay p99 < ${MAX_LOOP_P99_MS} ms`,
		summary.mainLoopP99Ms !== null && summary.mainLoopP99Ms < MAX_LOOP_P99_MS,
		`${summary.mainLoopP99Ms} ms (max ${summary.mainLoopMaxMs} ms)`,
	);
	await page.screenshot({ path: join(EVIDENCE, "end.png") });
	writeFileSync(join(EVIDENCE, "result.json"), `${JSON.stringify({ summary, checks: results }, null, 2)}\n`);
} finally {
	if (app !== undefined) await app.close().catch(() => undefined);
	rmSync(WORK, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${ENFORCE ? "" : " (report mode)"}`);
if (ENFORCE && failed.length > 0) process.exitCode = 1;
