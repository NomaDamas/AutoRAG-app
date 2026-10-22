// Live QA for the `dazzi` command line launcher (build/cli/dazzi). Drives the built app on macOS and proves:
//   1. `dazzi <folder>` handed to the RUNNING app opens that folder in a new tab, with no second app process;
//   2. a second call for the same folder selects the existing tab instead of piling up duplicates;
//   3. `dazzi <file>` shows the file selected in its folder; relative paths and `.` resolve against the caller;
//   4. a cold start through the launcher (no app running) opens the folder on first load.
//
// The launcher is the shipped script, copied into a stand-in `Dazzi.app` whose executable starts this
// checkout's Electron with the same arguments the packaged executable would get. Windows has no shell
// launcher of this kind; there `dazzi.cmd` and the registry changes are covered by unit tests.
//
// Prerequisites: `bun run build`. Run: bun scripts/manual-qa/run-qa-finder-cli.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { homeEnv, isMac } from "./platform.mjs";

if (!isMac) {
	console.log("SKIP cli: the shell launcher is macOS-only");
	process.exit(0);
}

const WORK = realpathSync(mkdtempSync(join(tmpdir(), "autorag-qa-cli-")));
const HOME = join(WORK, "home");
const USER_DATA = join(WORK, "user-data");
const PROJECT = join(WORK, "프로젝트 folder");
const NOTES = join(WORK, "notes");
const REPORT = join(NOTES, "report with spaces.md");
const COLD = join(WORK, "cold-start");
for (const directory of [HOME, USER_DATA, PROJECT, NOTES, COLD]) mkdirSync(directory, { recursive: true });
writeFileSync(join(PROJECT, "inside.txt"), "inside\n");
writeFileSync(REPORT, "# report\n");
writeFileSync(join(COLD, "cold.txt"), "cold\n");

// A bundle shaped like the real one: Contents/Resources/bin/dazzi next to Contents/MacOS/Dazzi.
const APP = join(WORK, "Dazzi.app");
const SHIM = join(APP, "Contents", "Resources", "bin", "dazzi");
mkdirSync(join(APP, "Contents", "Resources", "bin"), { recursive: true });
mkdirSync(join(APP, "Contents", "MacOS"), { recursive: true });
copyFileSync(join(ROOT, "build", "cli", "dazzi"), SHIM);
chmodSync(SHIM, 0o755);
const electron = join(ROOT, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
writeFileSync(join(APP, "Contents", "MacOS", "Dazzi"), `#!/bin/sh\nexec "${electron}" "${ROOT}" \${QA_ELECTRON_FLAGS:+"\$QA_ELECTRON_FLAGS"} "$@"\n`);
chmodSync(join(APP, "Contents", "MacOS", "Dazzi"), 0o755);

let failures = 0;
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === "" ? "" : ` — ${detail}`}`);
	if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (probe, timeoutMs = 20_000) => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value) return value;
		if (Date.now() >= deadline) return false;
		await sleep(150);
	}
};
const laneProcesses = () => {
	try {
		return execFileSync("/usr/bin/pgrep", ["-f", `user-data-dir=${USER_DATA}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
};
/** `dazzi` exactly as a terminal runs it: a login-less env, the caller's cwd, a profile override. */
const dazzi = (args, cwd = WORK) =>
	spawnSync(SHIM, args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...homeEnv(HOME), DAZZI_USER_DATA_DIR: USER_DATA, AUTORAG_SKIP_ONBOARDING: "1" },
	});
const tabs = (page) => page.locator(".tabs .tab");

let app;
try {
	app = await launchFinder({ userDataDir: USER_DATA, env: homeEnv(HOME) });
	const page = await finderWindow(app);
	const before = laneProcesses().length;
	const startTabs = (await tabs(page).count());

	// 1. A folder, given as an absolute path with spaces and Hangul.
	const first = dazzi([PROJECT]);
	check("folder: the command exits 0", first.status === 0, first.stderr.trim());
	const opened = await until(async () => (await page.locator('[data-path="' + join(PROJECT, "inside.txt") + '"]').count()) > 0);
	check("folder: its contents are listed in the running app", opened !== false);
	check("folder: it opened as a new tab", (await tabs(page).count()) === startTabs + 1, `${startTabs} → ${await tabs(page).count()}`);
	await sleep(1500);
	check("folder: no second app process is left behind", laneProcesses().length === before, `${before} → ${laneProcesses().length}`);
	await page.screenshot({ path: join(process.env.QA_OUT ?? WORK, "cli-folder.png") });

	// 2. The same folder again, written relatively from inside it: the tab is reused.
	const again = dazzi(["."], PROJECT);
	check("same folder: the command exits 0", again.status === 0, again.stderr.trim());
	await sleep(1500);
	check("same folder: no duplicate tab", (await tabs(page).count()) === startTabs + 1, `${await tabs(page).count()} tabs`);

	// 3. A file by relative path: its folder opens with the file selected.
	const file = dazzi(["notes/report with spaces.md"]);
	check("file: the command exits 0", file.status === 0, file.stderr.trim());
	const row = page.locator(`[data-path="${REPORT}"]`).first();
	const shown = await until(async () => (await row.count()) > 0);
	check("file: the folder opens and lists the file", shown !== false);
	check("file: the file is selected", shown !== false && ((await row.getAttribute("aria-selected")) === "true" || /selected/u.test((await row.getAttribute("class")) ?? "")));
	await page.screenshot({ path: join(process.env.QA_OUT ?? WORK, "cli-file.png") });

	// 4. Nothing exists: say so, exit non-zero, change nothing.
	const tabsBefore = await tabs(page).count();
	const missing = dazzi(["does-not-exist"]);
	check("missing path: exit 1 with a message", missing.status === 1 && /No such file or directory/u.test(missing.stderr), missing.stderr.trim());
	await sleep(800);
	check("missing path: no tab opens", (await tabs(page).count()) === tabsBefore);

	await app.close();
	app = undefined;
	await until(async () => laneProcesses().length === 0, 15_000);

	// 5. Cold start: no app is running, so the launcher itself starts the app and the request rides in argv.
	// The launcher-started app has no automation channel, so its window is asked for through a debugging port.
	const PORT = 9400 + (process.pid % 400);
	const cold = spawnSync(SHIM, [COLD], {
		cwd: WORK,
		encoding: "utf8",
		env: { ...process.env, ...homeEnv(HOME), DAZZI_USER_DATA_DIR: USER_DATA, AUTORAG_SKIP_ONBOARDING: "1", QA_ELECTRON_FLAGS: `--remote-debugging-port=${PORT}` },
	});
	check("cold start: the command returns at once", cold.status === 0, cold.stderr.trim());
	const started = await until(() => laneProcesses().length > 0, 30_000);
	check("cold start: the launcher started the app", started !== false);
	const { chromium } = await import("playwright");
	const browser = await until(async () => chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => false), 40_000);
	if (browser === false) {
		check("cold start: the app window is reachable", false);
	} else {
		const coldPage = await until(async () => browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().includes("index.html")), 30_000);
		const listed = coldPage !== false && (await until(async () => (await coldPage.locator(`[data-path="${join(COLD, "cold.txt")}"]`).count()) > 0, 30_000));
		check("cold start: the folder is open on first load", listed !== false);
		if (coldPage !== false) await coldPage.screenshot({ path: join(process.env.QA_OUT ?? WORK, "cli-cold.png") });
		await browser.close().catch(() => {});
	}
} catch (error) {
	console.error(error);
	failures += 1;
} finally {
	if (app !== undefined) await app.close().catch(() => {});
	for (const pid of laneProcesses()) {
		try {
			process.kill(Number(pid), "SIGTERM");
		} catch {
			// already gone
		}
	}
	rmSync(WORK, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`FAIL cli: ${failures} check(s) failed`);
	process.exit(1);
}
console.log("cli QA passed");
