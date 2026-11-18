/**
 * Live QA — the background refresh job honors the librarian's `refresh.schedule` (librarian 2.13.8+).
 *
 * The OS job (`out/main/refresh-job.js`, run by the app's own Electron as Node, exactly as launchd/cron/Task
 * Scheduler run it) is a background refresh, so `refresh.schedule` gates it like `autorag watch`. This lane runs the
 * real job against a real config and a real index:
 *
 *   - with `refresh.schedule.days` excluding today, the due local refresh is held back: nothing is indexed, the
 *     job log says why, and the schedule state records the pause;
 *   - Settings → Indexing in the real app shows that pause in words (screenshot);
 *   - with today allowed, the next run indexes every file and the pause is cleared;
 *   - a malformed `refresh.schedule` is a config error, like any other invalid field: the job indexes nothing and its
 *     log names the bad entry instead of failing silently.
 *
 *   bun run build
 *   bun scripts/manual-qa/run-qa-live-index-schedule.mjs
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { homeEnv } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-index-schedule");
mkdirSync(EVIDENCE, { recursive: true });
const LOG = join(EVIDENCE, "run.log");
writeFileSync(LOG, "");
const log = (line) => {
	console.log(line);
	appendFileSync(LOG, `${line}\n`);
};
const failures = [];
const check = (label, ok, detail) => {
	log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` — ${detail}`}`);
	if (!ok) failures.push(label);
};

const MODELS = process.env.FASTEMBED_CACHE_DIR ?? join(process.env.HOME ?? "", ".cache", "minsync", "models");
if (!existsSync(MODELS)) {
	console.log(`SKIP: no on-device sparse model cache at ${MODELS}; real indexing cannot run`);
	process.exit(2);
}
const JOB = join(ROOT, "out", "main", "refresh-job.js");
if (!existsSync(JOB)) {
	console.error("out/main/refresh-job.js is missing: run `bun run build` first.");
	process.exit(2);
}
const ELECTRON = createRequire(import.meta.url)("electron");

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-schedule-"));
const CONFIG = join(WORK, "config.json");
const DOCS = join(WORK, "docs");
const WORKSPACE = join(WORK, "workspace");
for (const dir of [DOCS, WORKSPACE, join(WORK, "pi-agent"), join(WORK, "home", ".cache", "minsync")]) mkdirSync(dir, { recursive: true });
if (process.platform !== "win32") symlinkSync(MODELS, join(WORK, "home", ".cache", "minsync", "models"));
const FILES = ["kestrel-plan.md", "osprey-notes.md", "heron-budget.md"];
FILES.forEach((name, i) => writeFileSync(join(DOCS, name), `# ${name}\n\nThe zephyrine audit for site ${i + 1} is owned by team ${i + 1}.\n`));

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const today = DAYS[new Date().getDay()];
const notToday = DAYS.filter((day) => day !== today);
const baseConfig = {
	searchPaths: [DOCS],
	workspacePath: WORKSPACE,
	memoryPath: join(WORK, "memory.json"),
	minSync: { enabled: true, autoInstall: false, embedder: { id: "none" } },
	jikji: false,
	jev: { backend: "sllm" },
	webSearch: { enabled: false },
	appIndexing: { refreshIntervalMs: 60 * 60_000 },
};
const writeConfig = (config) => writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);

const env = {
	...process.env,
	AUTORAG_HOME: join(WORK, "autorag-home"),
	...homeEnv(join(WORK, "home")),
	AUTORAG_CONFIG: CONFIG,
	PI_CODING_AGENT_DIR: join(WORK, "pi-agent"),
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	FASTEMBED_CACHE_DIR: MODELS,
};
const STATE = join(WORK, "app-refresh", "state.json");
const JOB_LOG = join(WORK, "app-refresh", "job.log");
const readState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null);
const jobLog = () => (existsSync(JOB_LOG) ? readFileSync(JOB_LOG, "utf8") : "");
const indexedFiles = () => {
	const docs = join(WORKSPACE, ".minsync");
	if (!existsSync(docs)) return 0;
	const count = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(join(dir, e.name)) : FILES.some((f) => e.name.startsWith(f.replace(/\.md$/, ""))) ? 1 : 0), 0);
	return count(docs);
};

/** One wake-up of the real OS job: the app's Electron as plain Node, as launchd runs it. */
function runJob(label) {
	const started = Date.now();
	const result = spawnSync(ELECTRON, [JOB], { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, cwd: WORK, encoding: "utf8", timeout: 600_000 });
	log(`[${label}] job exit ${result.status} in ${Math.round((Date.now() - started) / 1000)}s`);
	return result.status;
}

try {
	// 1. today is outside the schedule: the due refresh is held back
	writeConfig({ ...baseConfig, refresh: { schedule: { days: notToday } } });
	check("[denied] the job exits cleanly", runJob("denied") === 0);
	const paused = readState();
	log(`[denied] state: ${JSON.stringify(paused)}`);
	check("[denied] the state records the pause with its reason", paused?.paused?.reason === "outside-day", JSON.stringify(paused?.paused));
	check("[denied] nothing was refreshed", paused?.local === null, JSON.stringify(paused?.local));
	check("[denied] the job log says refresh.schedule held it back", /paused: refresh\.schedule \(outside-day\)/.test(jobLog()), jobLog().trim().split("\n").slice(-1)[0]);
	check("[denied] the index holds none of the files", indexedFiles() === 0, String(indexedFiles()));

	// 2. Settings → Indexing in the real app says why
	const userDataDir = join(WORK, "user-data");
	const app = await launchFinder({ userDataDir, env: { ...env, ELECTRON_RENDERER_URL: "" } });
	try {
		const page = await finderWindow(app);
		const pageErrors = [];
		page.on("pageerror", (error) => pageErrors.push(String(error)));
		await page.locator(".sidebar__item--settings").click();
		await page.waitForSelector(".settings-panel");
		await page.locator(".settings-nav-item", { hasText: "Indexing" }).first().click();
		const note = page.getByText("Waiting for an allowed day", { exact: false });
		const visible = await note.waitFor({ timeout: 20_000 }).then(() => true, () => false);
		if (visible) await note.first().scrollIntoViewIfNeeded();
		await page.screenshot({ path: join(EVIDENCE, "01-indexing-paused.png") });
		check("[ui] Settings → Indexing shows the schedule pause", visible, visible ? await note.first().innerText() : "not found");
		check("[ui] no renderer page error", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
	} finally {
		await app.close().catch(() => undefined);
	}

	// 2b. the conditions UI writes a window that excludes now; the next wake-up is held back as outside-window
	rmSync(join(WORK, "app-refresh"), { recursive: true, force: true });
	writeConfig(baseConfig);
	const hh = (h) => `${String((h + 24) % 24).padStart(2, "0")}:00`;
	const hour = new Date().getHours();
	const [start, end] = [hh(hour + 2), hh(hour + 3)];
	const app2 = await launchFinder({ userDataDir: join(WORK, "user-data-2"), env: { ...env, ELECTRON_RENDERER_URL: "" } });
	try {
		const page = await finderWindow(app2);
		await page.locator(".sidebar__item--settings").click();
		await page.waitForSelector(".settings-panel");
		await page.locator(".settings-nav-item", { hasText: "Indexing" }).first().click();
		await page.getByRole("switch", { name: "Only during set hours" }).click();
		const startInput = page.getByLabel("Start time");
		await startInput.waitFor();
		const endInput = page.getByLabel("End time");
		// Equal start and end is rejected, so never let the first edit collide with the other field's current value.
		if ((await endInput.inputValue()) === start) {
			await endInput.fill(end);
			await page.waitForTimeout(500);
			await startInput.fill(start);
		} else {
			await startInput.fill(start);
			await page.waitForTimeout(500);
			await endInput.fill(end);
		}
		await page.waitForTimeout(1000);
		await startInput.scrollIntoViewIfNeeded();
		await page.screenshot({ path: join(EVIDENCE, "02-conditions-window.png") });
		const written = JSON.parse(readFileSync(CONFIG, "utf8")).refresh?.schedule;
		check("[ui] the conditions UI writes refresh.schedule.windows", JSON.stringify(written?.windows) === JSON.stringify([`${start}-${end}`]), JSON.stringify(written));
	} finally {
		await app2.close().catch(() => undefined);
	}
	check("[window] the job exits cleanly", runJob("window") === 0);
	const windowState = readState();
	check("[window] the job held the refresh back as outside-window", windowState?.paused?.reason === "outside-window" && windowState?.local === null, JSON.stringify(windowState));

	// 3. today allowed: the next wake-up indexes everything and clears the pause
	writeConfig({ ...baseConfig, refresh: { schedule: { days: [today] } } });
	check("[allowed] the job exits cleanly", runJob("allowed") === 0);
	const ran = readState();
	log(`[allowed] state: ${JSON.stringify(ran)}`);
	check("[allowed] the local refresh ran and succeeded", ran?.local?.ok === true, JSON.stringify(ran?.local));
	check("[allowed] the pause is cleared", ran?.paused === null, JSON.stringify(ran?.paused));
	check("[allowed] the job log reports the run", /done: local=true/.test(jobLog()), jobLog().trim().split("\n").slice(-1)[0]);

	// 4. a malformed schedule is a config error the job reports, never a silent run or a silent skip
	rmSync(join(WORK, "app-refresh"), { recursive: true, force: true });
	writeConfig({ ...baseConfig, refresh: { schedule: { windows: ["25:99-nope"] } } });
	check("[malformed] the job fails with an error code", runJob("malformed") === 2);
	check("[malformed] the job log names the bad schedule entry", /refresh\.schedule\.windows entry "25:99-nope"/.test(jobLog()), jobLog().trim().split("\n")[0]);
	check("[malformed] nothing was refreshed", readState()?.local == null, JSON.stringify(readState()));
} catch (error) {
	check("lane crashed", false, error instanceof Error ? (error.stack ?? error.message) : String(error));
}

log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
rmSync(WORK, { recursive: true, force: true });
process.exitCode = failures.length === 0 ? 0 : 1;
