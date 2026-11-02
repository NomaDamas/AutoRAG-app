/**
 * Manual QA — no Everything daemon outlives the app, however the app ends (Windows, issue #349).
 *
 * Windows starts one `everything.exe -startup` per profile for file-name search. It is a separate program the app
 * only stops from its own quit path, so an app that vanished without running it (a force-kill, a crash, a test
 * harness that kills the process) left the daemon behind: one per profile, each pinning that profile's folder, and
 * they piled up. This lane ends the app three ways and asserts the profile's daemon is gone afterwards and the
 * profile folder can be deleted:
 *
 *   - quit:  the app quits itself (the path that always worked);
 *   - tree:  `taskkill /T /F` on the main process (its children die with it);
 *   - main:  `taskkill /F` on the main process alone, which is what left the daemon behind.
 *
 * Each round first waits for the daemon to appear, so a round that never started one fails instead of passing
 * empty. macOS and Linux keep their fsearch daemon across quits on purpose, so there is nothing to check there.
 *
 *   bun run build
 *   bun scripts/manual-qa/run-qa-finder-force-quit.mjs      # FORCE_QUIT_ROUNDS per mode (default 2)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { isWindows, sleep } from "./platform.mjs";

if (!isWindows) {
	console.log("SKIP  the Everything daemon exists on Windows only");
	process.exit(0);
}

const ROUNDS = Number(process.env.FORCE_QUIT_ROUNDS ?? 2);
const DAEMON_APPEARS_MS = 60_000;
const DAEMON_GONE_MS = 10_000;
const MODES = ["quit", "tree", "main"];

const WORK = realpathSync(mkdtempSync(join(tmpdir(), "autorag-qa-force-quit-")));
const QA_ROOT = join(WORK, "root");
mkdirSync(join(QA_ROOT, "one"), { recursive: true });
writeFileSync(join(QA_ROOT, "one", "a.txt"), "x\n");

const results = [];
const check = (label, ok, detail) => {
	results.push({ label, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : ` :: ${detail}`}`);
};

/** Pids of the Everything daemons whose command line points into `profile`. */
function daemonsOf(profile) {
	const quoted = profile.replaceAll("'", "''");
	const script = `Get-CimInstance Win32_Process -Filter "Name='everything.exe'" | Where-Object { $_.CommandLine -like '*${quoted}*' } | ForEach-Object { $_.ProcessId }`;
	const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
	return out.split(/\r?\n/).filter((line) => /^\d+$/.test(line.trim())).map(Number);
}

async function waitFor(probe, ms) {
	const started = Date.now();
	for (;;) {
		const value = probe();
		if (value) return { value, ms: Date.now() - started };
		if (Date.now() - started >= ms) return { value: null, ms: Date.now() - started };
		await sleep(300);
	}
}

function removable(path) {
	try {
		rmSync(path, { recursive: true, force: false });
		return null;
	} catch (error) {
		return error.code ?? String(error);
	}
}

try {
	for (const mode of MODES) {
		for (let round = 1; round <= ROUNDS; round += 1) {
			const label = `${mode} round ${round}`;
			const profile = join(WORK, `profile-${mode}-${round}`);
			const app = await launchFinder({ userDataDir: profile, env: { AUTORAG_QA_ROOT: QA_ROOT } });
			try {
				await finderWindow(app, 30_000);
				// Not `app.process().pid`: on Windows that is the `cmd.exe` Playwright launches Electron through, and killing it
				// leaves the app running.
				const mainPid = await app.evaluate(() => process.pid);
				const started = await waitFor(() => daemonsOf(profile).length > 0, DAEMON_APPEARS_MS);
				check(`${label}: the app started its Everything daemon`, started.value === true, `${started.ms} ms after the window`);
				if (mode === "quit") await app.evaluate(({ app: electronApp }) => setTimeout(() => electronApp.quit(), 0)).catch(() => undefined);
				else if (mode === "tree") execFileSync("taskkill", ["/T", "/F", "/PID", String(mainPid)], { stdio: "ignore" });
				else execFileSync("taskkill", ["/F", "/PID", String(mainPid)], { stdio: "ignore" });
				const gone = await waitFor(() => daemonsOf(profile).length === 0, DAEMON_GONE_MS);
				const left = daemonsOf(profile);
				check(`${label}: no daemon outlives the app`, left.length === 0, left.length === 0 ? `gone after ${gone.ms} ms` : `still running: ${left.join(",")}`);
				// The helper processes of a killed app can hold files for a moment; the daemon must not be what pins the folder.
				const freed = await waitFor(() => removable(profile) === null, DAEMON_GONE_MS);
				check(`${label}: the profile folder can be deleted`, freed.value === true, freed.value === true ? `after ${freed.ms} ms` : String(removable(profile)));
			} finally {
				for (const pid of daemonsOf(profile)) {
					try {
						execFileSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
					} catch {
						/* already gone */
					}
				}
				await app.close().catch(() => undefined);
			}
		}
	}
} finally {
	rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
