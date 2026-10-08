/**
 * Manual QA — the app quits cleanly while folder watches are live (FS roadmap #104).
 *
 * Regression for the shutdown abort: `will-quit` started the watcher teardown
 * without awaiting it, so `@parcel/watcher`'s native unsubscribe completed
 * inside `node::FreeEnvironment` and threw into a dying environment
 * (`napi_fatal_error` → SIGABRT, "Electron quit unexpectedly").
 *
 * Each round launches the built app on a fixture root, opens a folder so its
 * watch is live, switches folders (so a subscribe/unsubscribe is in flight),
 * then calls `app.quit()` from main and records how the process exited. A
 * clean round exits with code 0 and no signal; on macOS no new
 * `Electron-*.ips` crash report may appear during the lane.
 *
 *   bun run build
 *   bun scripts/manual-qa/run-qa-finder-quit-clean.mjs    # QUIT_ROUNDS (default 20)
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, fsWorkerDiagnostics, launchFinder, ROOT } from "./launch-finder.mjs";
import { isMac, sleep } from "./platform.mjs";

const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-quit-clean");
mkdirSync(EVIDENCE, { recursive: true });
const ROUNDS = Number(process.env.QUIT_ROUNDS ?? 20);

const WORK = realpathSync(mkdtempSync(join(tmpdir(), "autorag-qa-quit-")));
const QA_ROOT = join(WORK, "root");
for (const folder of ["one", "two", "three"]) {
	mkdirSync(join(QA_ROOT, folder), { recursive: true });
	for (let index = 0; index < 20; index += 1) writeFileSync(join(QA_ROOT, folder, `${folder}-${index}.txt`), "x\n");
}

const REPORTS = join(homedir(), "Library", "Logs", "DiagnosticReports");
// The fs worker is an `Electron Helper` process: its crash reports carry that name.
const crashReports = () => (isMac && existsSync(REPORTS) ? readdirSync(REPORTS).filter((name) => /^Electron.*\.ips$/.test(name)) : []);
const reportsBefore = new Set(crashReports());

const results = [];
const check = (label, ok, detail) => {
	results.push({ label, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : ` :: ${detail}`}`);
};

const rounds = [];
try {
	for (let round = 1; round <= ROUNDS; round += 1) {
		const app = await launchFinder({ userDataDir: join(WORK, `user-data-${round}`), env: { AUTORAG_QA_ROOT: QA_ROOT } });
		const child = app.process();
		const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
		try {
			const page = await finderWindow(app, 30_000);
			await page.locator(".sidebar__item", { hasText: "QA" }).click();
			await page.locator(`[data-path="${join(QA_ROOT, "one")}"]`).first().dblclick();
			await page.locator(`[data-path="${join(QA_ROOT, "one", "one-0.txt")}"]`).first().waitFor({ timeout: 15_000 });
			await sleep(300 + (round % 5) * 150);
			// Switch folders and quit at once: the old watch's unsubscribe is in flight.
			await page.locator(".sidebar__item", { hasText: "QA" }).click();
			await page.locator(`[data-path="${join(QA_ROOT, "two")}"]`).first().dblclick();
		} catch (error) {
			console.log(`INFO  round ${round} setup: ${String(error).slice(0, 200)}`);
		}
		// The worker must release its watches and exit with the app, never outlive it.
		const workerPid = await fsWorkerDiagnostics(app).then((diagnostics) => diagnostics.pid).catch(() => null);
		await app.evaluate(({ app: electronApp }) => {
			setTimeout(() => electronApp.quit(), 0);
		}).catch(() => undefined);
		const timeout = sleep(20_000).then(() => ({ code: null, signal: "timeout" }));
		const outcome = await Promise.race([exited, timeout]);
		if (outcome.signal === "timeout") child.kill("SIGKILL");
		let workerAlive = false;
		if (workerPid !== null) {
			try {
				process.kill(workerPid, 0);
				workerAlive = true;
			} catch {
				workerAlive = false;
			}
		}
		rounds.push({ round, workerPid, workerAlive, ...outcome });
		console.log(`INFO  round ${round}: code=${outcome.code} signal=${outcome.signal} worker=${workerPid} alive=${workerAlive}`);
	}
} finally {
	rmSync(WORK, { recursive: true, force: true });
}

const unclean = rounds.filter((round) => round.code !== 0 || round.signal !== null);
check(`all ${ROUNDS} quits exit 0 without a signal`, unclean.length === 0, JSON.stringify(unclean));
const orphans = rounds.filter((round) => round.workerPid === null || round.workerAlive);
check(`every round had an fs worker and none outlived the app`, orphans.length === 0, JSON.stringify(orphans));
await sleep(3000);
const newReports = crashReports().filter((name) => !reportsBefore.has(name));
if (isMac) check("no new Electron crash report during the lane", newReports.length === 0, newReports.join(", "));
writeFileSync(join(EVIDENCE, "result.json"), `${JSON.stringify({ rounds, newReports, checks: results }, null, 2)}\n`);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
