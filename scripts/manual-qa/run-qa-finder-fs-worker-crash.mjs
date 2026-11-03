/**
 * Manual QA — the filesystem worker can die without taking the app with it
 * (FS roadmap #101).
 *
 * Listings, watches, and Finder metadata run in an Electron utility process.
 * This lane opens a folder in two tabs, SIGKILLs that process mid-session,
 * and asserts what the user would see:
 *
 *   - the window stays up (main and renderer never exit);
 *   - main forks a new worker (a new pid, restarts = 1);
 *   - the open tab shows a file created while the worker was dead,
 *     which only a fresh listing can know about, and the file ops work again;
 *   - live watches are back: a file created after recovery appears on its own;
 *   - a second kill also recovers (no one-shot restart);
 *   - a worker restart while the page has no render frame (its renderer
 *     crashed) does not take main down, and the reloaded page lists again
 *     (Sentry ELECTRON-K: `sendPort` threw "Render frame was disposed").
 *
 *   bun run build
 *   bun scripts/manual-qa/run-qa-finder-fs-worker-crash.mjs
 *
 * Evidence: `.omo/evidence/ai-finder-app/qa-fs-worker-crash/result.json`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, fsWorkerDiagnostics, launchFinder, ROOT } from "./launch-finder.mjs";
import { chord, cssAttr, isWindows, sleep } from "./platform.mjs";

const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-fs-worker-crash");
mkdirSync(EVIDENCE, { recursive: true });
/** Issue #101 acceptance: the open tab's listing comes back. The bounds are hang ceilings, not speed gates (a fork takes ~1 s on macOS, 3.6-5.5 s on Windows). */
const RECOVERY_BOUND_MS = 60_000;
const LIVE_BOUND_MS = 60_000;

const WORK = realpathSync(mkdtempSync(join(tmpdir(), "autorag-qa-worker-crash-")));
const QA_ROOT = join(WORK, "root");
const FOLDER = join(QA_ROOT, "crash");
mkdirSync(FOLDER, { recursive: true });
for (let index = 0; index < 30; index += 1) writeFileSync(join(FOLDER, `file-${String(index).padStart(2, "0")}.txt`), `${index}\n`);

const results = [];
const check = (label, ok, detail) => {
	results.push({ label, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : ` :: ${detail}`}`);
};

const killWorker = (pid) => {
	try {
		process.kill(pid, "SIGKILL");
		return true;
	} catch (error) {
		console.log(`INFO  kill ${pid}: ${String(error)}`);
		return false;
	}
};

/** Resolves with the elapsed ms once `probe()` is truthy, or null at the deadline. */
async function within(boundMs, probe) {
	const started = Date.now();
	while (Date.now() - started < boundMs * 2) {
		if (await probe()) return Date.now() - started;
		await sleep(50);
	}
	return null;
}

let app;
const rounds = [];
try {
	app = await launchFinder({ userDataDir: join(WORK, "user-data"), env: { AUTORAG_QA_ROOT: QA_ROOT } });
	const child = app.process();
	let mainExited = false;
	child.once("exit", () => {
		mainExited = true;
	});
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(15_000);
	// The list virtualizes rows: a Windows window opens shorter than macOS's, so size it
	// to mount the 30-file fixture plus the rows this lane adds (the probes read the DOM).
	await page.setViewportSize({ width: 1500, height: 1100 }).catch(() => {});
	let rendererGone = false;
	page.on("crash", () => {
		rendererGone = true;
	});
	const row = (path) => page.locator(`[data-path="${cssAttr(path)}"]`).first();
	await page.locator(".sidebar__item", { hasText: "QA" }).click();
	await row(FOLDER).dblclick();
	await row(join(FOLDER, "file-00.txt")).waitFor();
	// A second tab on the same folder: both must recover.
	await page.keyboard.press(chord("t"));
	await page.locator(".sidebar__item", { hasText: "QA" }).click();
	await row(FOLDER).dblclick();
	await row(join(FOLDER, "file-00.txt")).waitFor();
	await page.locator(".tab").first().click();
	await row(join(FOLDER, "file-00.txt")).waitFor();

	for (let round = 1; round <= 2; round += 1) {
		const before = await fsWorkerDiagnostics(app);
		check(`round ${round}: a worker is running`, Number.isInteger(before.pid), `pid ${before.pid}`);
		killWorker(before.pid);
		// Written while no worker runs: only a relist after the restart can show it.
		const whileDead = join(FOLDER, `while-dead-${round}.txt`);
		writeFileSync(whileDead, "created while the worker was down\n");
		const killedAt = Date.now();
		// The window and the page survive a dead worker.
		await sleep(200);
		check(`round ${round}: main survives the worker's death`, !mainExited);
		check(`round ${round}: the renderer survives the worker's death`, !rendererGone);
		// Focus repaints are not allowed to mask the test: no focus/visibility event is sent.
		const recoveredMs = await within(RECOVERY_BOUND_MS, async () => (await row(whileDead).count()) > 0);
		const totalMs = recoveredMs === null ? null : Date.now() - killedAt;
		check(
			`round ${round}: the open tab relists after the kill (ceiling ${RECOVERY_BOUND_MS} ms)`,
			totalMs !== null && totalMs <= RECOVERY_BOUND_MS,
			`${totalMs} ms`,
		);
		const after = await fsWorkerDiagnostics(app);
		check(`round ${round}: main forked a new worker`, after.pid !== before.pid && after.restarts === round, `pid ${before.pid} → ${after.pid}, restarts ${after.restarts}`);
		// The rows that were there are still there (no empty flash left behind).
		check(`round ${round}: the existing rows are still shown`, (await row(join(FOLDER, "file-29.txt")).count()) > 0 || (await page.locator('[role="row"]').count()) >= 10);
		// Live watches came back with the new worker.
		const afterRecovery = join(FOLDER, `after-recovery-${round}.txt`);
		writeFileSync(afterRecovery, "created after recovery\n");
		const liveMs = await within(LIVE_BOUND_MS, async () => (await row(afterRecovery).count()) > 0);
		check(`round ${round}: live changes reach the tab again`, liveMs !== null && liveMs <= LIVE_BOUND_MS, `${liveMs} ms`);
		// The other tab on the folder recovered too.
		await page.locator(".tab").nth(1).click();
		const otherMs = await within(LIVE_BOUND_MS, async () => (await row(afterRecovery).count()) > 0);
		check(`round ${round}: the second tab recovered too`, otherMs !== null, `${otherMs} ms`);
		await page.locator(".tab").first().click();
		rounds.push({ round, beforePid: before.pid, afterPid: after.pid, recoveredMs: totalMs, liveMs, otherTabMs: otherMs });
	}

	// File operations work on the new worker: rename through the UI.
	const target = join(FOLDER, "file-01.txt");
	await row(target).click({ button: "right" });
	await page.getByRole("menuitem", { name: "Rename" }).click();
	const input = page.locator("input.row__rename");
	await input.fill("renamed-after-crash.txt");
	await input.press("Enter");
	const renamed = await within(LIVE_BOUND_MS, async () => (await row(join(FOLDER, "renamed-after-crash.txt")).count()) > 0);
	check("a rename after two restarts lands", renamed !== null, `${renamed} ms`);
	await page.screenshot({ path: join(EVIDENCE, "end.png") });
	check("main never exited", !mainExited);
	check("the renderer never crashed", !rendererGone);

	// ELECTRON-K: the worker restarts while the Finder page has no render frame.
	// Unfixed, main throws from the restart timer; Electron's uncaught-exception
	// handler then wedges main, so every probe is bounded and main's stderr is read.
	const mainErrors = [];
	let skippedFrameless = false;
	child.stderr?.on("data", (chunk) => {
		for (const line of String(chunk).split(/\r?\n/u)) {
			// The host's own warning: proof the restart really met a page with no frame.
			if (line.startsWith("[fs-worker] page ") && line.includes("has no frame for a port")) skippedFrameless = true;
			else if (/Render frame was disposed|Uncaught|JavaScript error occurred in the main process/u.test(line)) mainErrors.push(line.trim().slice(0, 400));
		}
	});
	const bounded = (promise, ms = 5000) => Promise.race([promise, sleep(ms).then(() => null)]);
	const beforeGone = await fsWorkerDiagnostics(app);
	await app.evaluate(({ BrowserWindow }) => {
		for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().endsWith("/index.html") && window.isVisible()) window.webContents.forcefullyCrashRenderer();
	});
	const crashedMs = await within(LIVE_BOUND_MS, async () => rendererGone);
	check("frameless: the Finder renderer is gone", crashedMs !== null, `${crashedMs} ms`);
	killWorker(beforeGone.pid);
	const restartedMs = await within(15_000, async () => {
		if (mainExited || mainErrors.length > 0) return true;
		const now = await bounded(fsWorkerDiagnostics(app).catch(() => null));
		return now !== null && now.restarts === beforeGone.restarts + 1 && Number.isInteger(now.pid) && now.pid !== beforeGone.pid;
	});
	// The restart timer is where the throw happened; give a late throw time to land.
	await sleep(1500);
	const responsive = (await bounded(app.evaluate(() => true).catch(() => false))) === true;
	check(
		"frameless: main survives a worker restart with no render frame",
		!mainExited && mainErrors.length === 0 && responsive && restartedMs !== null,
		`restart ${restartedMs} ms, responsive ${responsive}, errors ${JSON.stringify(mainErrors)}`,
	);
	check("frameless: the restart met the page with no frame and skipped it", skippedFrameless);
	if (!responsive || mainErrors.length > 0) throw new Error("main is wedged after the frameless restart");
	// Playwright never re-attaches a Page whose renderer crashed (it stays "Target crashed"), so the
	// reloaded document is driven from main: its real preload bridge, over the port the new worker sent.
	await app.evaluate(({ BrowserWindow }) => {
		for (const window of BrowserWindow.getAllWindows()) if (window.webContents.isCrashed()) window.webContents.reload();
	});
	const inFinder = (source) =>
		app.evaluate(async ({ BrowserWindow }, code) => {
			const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith("/index.html"));
			if (window === undefined || window.webContents.isCrashed() || window.webContents.isLoading()) return null;
			return window.webContents.executeJavaScript(code);
		}, source);
	const listed = (name) => `window.autorag.fs.listDir(${JSON.stringify(FOLDER)}).then((listing) => JSON.stringify(listing).includes(${JSON.stringify(name)}), () => false)`;
	const relistMs = await within(LIVE_BOUND_MS, async () => (await bounded(inFinder(listed("file-29.txt")).catch(() => null))) === true);
	check("frameless: the reloaded page lists through the new worker", relistMs !== null, `${relistMs} ms`);
	const afterReload = join(FOLDER, "after-reload.txt");
	writeFileSync(afterReload, "created after the reload\n");
	const reloadLiveMs = await within(LIVE_BOUND_MS, async () => (await bounded(inFinder(listed("after-reload.txt")).catch(() => null))) === true);
	check("frameless: the reloaded page sees a file created after it reloaded", reloadLiveMs !== null, `${reloadLiveMs} ms`);
	// What the user sees: the reloaded window's own listing shows the fixture folder, not an empty one.
	const rowShown = `document.querySelector(${JSON.stringify(`[data-path="${cssAttr(FOLDER)}"]`)}) !== null`;
	const rowMs = await within(LIVE_BOUND_MS, async () => (await bounded(inFinder(rowShown).catch(() => null))) === true);
	const emptyShown = await bounded(inFinder(`document.body.innerText.includes("Empty folder")`).catch(() => null));
	check("frameless: the reloaded window renders its folder's rows", rowMs !== null, `${rowMs} ms, empty-folder text ${emptyShown}`);
	const after = await fsWorkerDiagnostics(app);
	check("frameless: no further restart was needed", after.restarts === beforeGone.restarts + 1, `restarts ${after.restarts}`);
	const png = await app.evaluate(async ({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith("/index.html"));
		return window === undefined ? null : (await window.webContents.capturePage()).toPNG().toString("base64");
	});
	if (png !== null) writeFileSync(join(EVIDENCE, "after-frameless-restart.png"), Buffer.from(png, "base64"));
	check("main never exited (after the frameless restart)", !mainExited);
} catch (error) {
	check("lane ran to completion", false, String(error).slice(0, 400));
} finally {
	writeFileSync(join(EVIDENCE, "result.json"), `${JSON.stringify({ rounds, checks: results }, null, 2)}\n`);
	// A wedged main never answers close: kill it so the lane reports instead of timing out.
	if (app !== undefined) {
		const closed = await Promise.race([app.close().then(() => true, () => true), sleep(10_000).then(() => false)]);
		if (!closed) app.process().kill("SIGKILL");
	}
	rmSync(WORK, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
