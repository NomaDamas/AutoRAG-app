// Drives the zero-question first run end to end in the built app: the folder
// pre-scan, the keyword-only config write, the real first index (parsed mirror +
// MinSync's bundled SPLADE encoder, no dense model), the generated tour, and the
// plans sheet that ends the first run.
//
// There is now ONE window: the Finder window itself opens with the pending flag
// and hosts the first-run overlay (`.fr-root`), so this lane drives that window
// through `data-screen` = setup → ready → tour → plans. No permission screen is
// shown: the run starts on its own and the tour is the only interaction.
//
// The first run scans the OS's own default folders (Desktop, Documents,
// Downloads, iCloud Drive), and Electron resolves those from the OS — on macOS
// `HOME` in the launch env does not move `app.getPath("documents")` (verified) —
// so the fixtures go in this process's home. The QA runner boots a throwaway VM
// home, where that is disposable; a host run writes them into the real home, so
// existing files are never overwritten and every created file is removed at the
// end. AUTORAG_HOME / AUTORAG_CONFIG point inside a temp dir either way, so the
// user's own config and index are never touched.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_PANEL, finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { homeDir, rmRetry } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/onboarding");
mkdirSync(EVIDENCE, { recursive: true });

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};
const info = (message) => console.log(`INFO ${message}`);

// ── fixtures ─────────────────────────────────────────────────────────────────
// Distinctive facts so the generated tour question (`demo`) and the duplicate
// family have real material; realistic Korean and English documents.
const HOME = homeDir();
const DOCS = join(HOME, "Documents");
const DESK = join(HOME, "Desktop");
// A host run writes the fixtures into the developer's real home and indexes whatever already lives
// there; the QA runner boots a throwaway VM home by default. Warn so a host run is never a surprise.
if (process.platform === "darwin") {
	const inVm = spawnSync("sysctl", ["-n", "kern.hv_vmm_present"], { encoding: "utf8" }).stdout?.trim() === "1";
	if (!inVm) console.warn("[onboarding] WARNING: not in a VM; the first run will scan and index this machine's real Desktop/Documents/Downloads");
}
mkdirSync(DOCS, { recursive: true });
mkdirSync(DESK, { recursive: true });
const createdFixtures = [];
/** Write a fixture, never clobbering a file that was already there, and remember what to remove. */
const put = (dir, name, text) => {
	const path = join(dir, name);
	if (existsSync(path)) return path;
	writeFileSync(path, text);
	createdFixtures.push(path);
	return path;
};
put(DOCS, "3분기-회의록.md", "# 3분기 회의록\n\n마케팅 비용은 전분기보다 18% 줄었습니다.\n신규 고객은 412명 늘었습니다.\n");
put(DOCS, "q3-report.md", "# Q3 report\n\nOperating cost fell because of the vendor change.\nRevenue grew 12% quarter over quarter.\n");
// A duplicate pair: the same quarterly summary with one number changed, so dupey groups them.
const summary = "# Quarterly summary\n\nMarketing spend fell 18% against the prior quarter.\nNew customers grew by 412.\n";
put(DOCS, "report.md", summary);
put(DOCS, "report (1).md", summary.replace("412", "413"));
put(DESK, "budget-notes.txt", "Budget summary for the third quarter.\n");

const WORK = mkdtempSync(join(tmpdir(), "autorag-onboarding-"));
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config", "config.json");
mkdirSync(AUTORAG_HOME, { recursive: true });
mkdirSync(join(WORK, "config"), { recursive: true });
const env = {
	AUTORAG_HOME,
	AUTORAG_CONFIG: CONFIG,
	AUTORAG_SKIP_DUPEY_CHECK: "1",
};
const userDataDir = join(WORK, "user-data");

const errors = [];
/** Screenshot the window (the overlay and the Finder UI behind it) once its spring motion has settled. */
const shot = async (page, name) => {
	await page.waitForTimeout(900);
	await page.screenshot({ path: join(EVIDENCE, name) });
};
/** Read the overlay's current screen, or null once it is gone. */
const screen = (page) => page.evaluate(() => document.querySelector(".fr-root")?.getAttribute("data-screen") ?? null);
/** Wait for a coach bubble for `id`; false when it never arrives (an optional step was skipped). */
const stepArrives = (page, id, timeout = 12_000) =>
	page.waitForSelector(`.fr-coach[data-step="${id}"]`, { timeout }).then(() => true, () => false);
/** Per-step assertions on the surface the coach points at. */
const checkStep = async (page, id) => {
	if (id === "cite") check("the cite step points at a citation chip", (await page.locator(".cite").count()) > 0);
	if (id === "evidenceFolder") check("the evidence-folder step offers its button", (await page.locator('[data-action="evidence-folder"]').count()) === 1);
	if (id === "versions") check("the versions step shows the inspector Versions section", (await page.locator('[data-section="versions"]').count()) === 1);
};
/** Move past a coach step: Enter in the composer at `ask`, the bubble's next button otherwise (the evidence-folder step's own button when the bubble has none). */
const advance = async (page, id) => {
	if (id === "ask") return page.locator('[data-ai-tab]:not(.hidden) textarea').first().press("Enter");
	const next = page.locator(`.fr-coach[data-step="${id}"] [data-action="tour-next"]`);
	if ((await next.count()) > 0) return next.click();
	return page.locator(`.fr-coach[data-step="${id}"] [data-action="evidence-folder"]`).first().click();
};

const DEMO_STEPS = ["question", "ask", "answer", "cite", "evidence", "evidenceFolder"];

let app;
try {
	app = await launchFinder({ userDataDir, env, onboarding: true, language: "ko" });
	const page = await finderWindow(app, 30_000);
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});

	await page.waitForSelector(".fr-root[data-screen]", { timeout: 30_000 });
	info(`the first run opened on the ${await screen(page)} screen`);

	check("no permission screen blocks the first run", (await screen(page)) !== "permission" && (await page.locator('[data-action="open-fda"]').count()) === 0);

	// setup: one progress bar while main pre-scans, plans exclusions, writes the
	// keyword-only config, runs the first index and prepares the tour.
	await page.waitForSelector('.fr-root[data-screen="setup"]', { timeout: 60_000 });
	await page.waitForSelector('.fr-setup [role="progressbar"]', { timeout: 60_000 });
	check("the setup screen shows a title", (await page.locator(".fr-setup h1.fr-title").count()) === 1);
	await shot(page, "02-setup-start.png");
	const progress = () => page.evaluate(() => Number(document.querySelector('.fr-setup [role="progressbar"]')?.getAttribute("aria-valuenow") ?? 0));
	await page.waitForFunction(() => Number(document.querySelector('.fr-setup [role="progressbar"]')?.getAttribute("aria-valuenow") ?? 0) > 0, null, { timeout: 180_000 });
	check("the setup progress bar advances past 0", (await progress()) > 0, String(await progress()));
	await shot(page, "03-setup-progress.png");
	check("the setup screen never failed", (await page.locator('[data-action="setup-retry"]').count()) === 0, await page.locator(".fr-setup").innerText().catch(() => ""));

	// ready: the run finished on its own, whatever the balance of the default folders.
	await page.waitForSelector('.fr-root[data-screen="ready"]', { timeout: 600_000 });
	check("the ready screen is shown", (await page.locator(".fr-ready").count()) === 1);
	const status = await page.evaluate(() => window.autorag.onboarding.status());
	info(`ready in ${status.finishedAt ?? "?"} (started ${status.startedAt ?? "?"}); demo=${status.demo === null ? "none" : "yes"}`);
	check("the run reached the ready stage", status.stage === "ready", JSON.stringify(status.stage));
	check("the progress bar reached 100", status.progress === 100, String(status.progress));
	check("the ready stage carries no error", status.error === null, String(status.error));
	check("the ready screen offers the start button", (await page.locator('.fr-ready [data-action="first-run-start"]').count()) === 1);
	await shot(page, "04-ready.png");

	// the tour: Enter (or the button) raises the cinematic welcome, then every
	// coach mark the data supports. A run without a callable model has no demo
	// question, and one without a duplicate family has no duplicates/versions.
	await page.keyboard.press("Enter");
	// The stage fades out before the tour mounts; click only if Enter did not start it.
	const viaEnter = await page.waitForSelector('.fr-root[data-screen="tour"]', { timeout: 5_000 }).then(() => true, () => false);
	if (!viaEnter) await page.locator('[data-action="first-run-start"]').click();
	check("Enter on the ready screen starts the tour", viaEnter);
	await page.waitForSelector('.fr-root[data-screen="tour"]', { timeout: 15_000 });
	await page.waitForSelector(".fr-cinema", { timeout: 15_000 });
	// The title card is on screen for about three seconds; capture it once its reveal has played.
	await page.waitForTimeout(1200);
	await page.screenshot({ path: join(EVIDENCE, "05-tour-cinema.png") });
	check("the tour opens on the cinematic welcome", await stepArrives(page, "welcome"));
	check("a coach mark offers both next and skip", (await page.locator('.fr-coach[data-step="welcome"] [data-action="tour-next"]').count()) === 1 && (await page.locator('.fr-coach[data-step="welcome"] [data-action="tour-skip"]').count()) === 1);
	await shot(page, "05-tour-welcome.png");
	await advance(page, "welcome");

	const walked = ["welcome"];
	for (const id of DEMO_STEPS) {
		if (!(await stepArrives(page, id))) {
			info(`tour step ${id} was skipped (no demo question)`);
			break;
		}
		walked.push(id);
		await checkStep(page, id);
		await shot(page, `06-tour-${id}.png`);
		await advance(page, id);
	}
	if (await stepArrives(page, "duplicates")) {
		walked.push("duplicates");
		await shot(page, "06-tour-duplicates.png");
		await advance(page, "duplicates");
		if (await stepArrives(page, "versions")) {
			walked.push("versions");
			await checkStep(page, "versions");
			await shot(page, "06-tour-versions.png");
			await advance(page, "versions");
		}
	} else {
		info("tour steps duplicates/versions were skipped (no duplicate family)");
	}
	info(`tour walked: ${walked.join(" → ")}`);
	check("the tour walked at least the welcome step", walked[0] === "welcome");

	// plans: the end of the first run. Signing in is real; the lane takes the
	// free path so it never needs an account.
	await page.waitForSelector('.fr-root[data-screen="plans"]', { timeout: 30_000 });
	check("the plans sheet is shown", (await page.locator(".fr-plans").count()) === 1);
	check("every plan is offered", (await page.locator(".fr-plans [data-plan]").count()) === 4, String(await page.locator(".fr-plans [data-plan]").count()));
	check("both sign-in providers are offered", (await page.locator(".fr-plans [data-signin]").count()) === 2, String(await page.locator(".fr-plans [data-signin]").count()));
	await shot(page, "07-plans.png");
	await page.locator('.fr-plans [data-action="plans-later"]').click();

	// the overlay leaves (the Finder is already usable behind it) and the first
	// run is marked done.
	await page.waitForSelector(".fr-root", { state: "detached", timeout: 30_000 });
	check("the first-run overlay is gone after the tour", (await page.locator(".fr-root").count()) === 0);
	check("the Finder is usable behind the finished first run", await page.locator(".sidebar__item").first().isVisible());

	// the keyword-only first run: parsed mirror + SPLADE, no dense embedder.
	if (existsSync(CONFIG)) {
		const raw = JSON.parse(readFileSync(CONFIG, "utf8"));
		check("keyword-only: semantic search is off in the shared config", raw.appIndexing?.semanticSearch === false, JSON.stringify(raw.appIndexing));
		check("keyword-only: no dense embedder was written", raw.minSync?.embedder === undefined, JSON.stringify(raw.minSync));
		check("the default folders were written as search paths", Array.isArray(raw.searchPaths) && raw.searchPaths.length > 0, JSON.stringify(raw.searchPaths));
		check("the first index lives under AUTORAG_HOME", String(raw.workspacePath ?? "").startsWith(AUTORAG_HOME), String(raw.workspacePath));
		check("keyword-only: the parsed mirror exists", existsSync(join(AUTORAG_HOME, "workspace", ".autorag", "parsed", "stage")) && existsSync(join(AUTORAG_HOME, "workspace", ".autorag", "parsed", "files")));
	} else {
		check("the first run wrote the shared config", false, `${CONFIG} is missing`);
	}

	// a relaunch on the same profile must go straight to the Finder.
	await page.screenshot({ path: join(EVIDENCE, "08-finder-after-first-run.png") });
	await app.close();
	app = undefined;
	app = await launchFinder({ userDataDir, env, onboarding: true, language: "ko" });
	const relaunched = await finderWindow(app, 30_000);
	await relaunched.waitForSelector(".sidebar__item", { timeout: 30_000 }).catch(() => undefined);
	await relaunched.waitForTimeout(1500);
	check("a relaunch on the same profile shows no first-run overlay", (await relaunched.locator(".fr-root").count()) === 0);
	await relaunched.screenshot({ path: join(EVIDENCE, "09-relaunch-no-overlay.png") });

	check("no renderer errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (error) {
	failures.push(String(error));
	console.error(error);
} finally {
	// The first index leaves background helpers pointing into WORK (fsearch-cli
	// watch); kill them by their command line before deleting it.
	const killHelpers = () => {
		if (process.platform !== "win32") spawnSync("pkill", ["-9", "-f", WORK]);
	};
	killHelpers();
	if (app !== undefined) {
		const pid = app.process().pid;
		const closed = await Promise.race([app.close().then(() => true, () => true), new Promise((resolve) => setTimeout(() => resolve(false), 30_000))]);
		if (!closed && pid !== undefined) {
			info("the app did not close within 30s; killing its process tree");
			if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)]);
			else spawnSync("pkill", ["-9", "-P", String(pid)]);
		}
	}
	killHelpers();
	// Remove only the fixture files this lane created; never the folders or a
	// developer's own files.
	for (const path of createdFixtures) {
		try {
			rmSync(path, { force: true });
		} catch {
			// Best effort.
		}
	}
	rmRetry(WORK);
}
console.log(failures.length === 0 ? "onboarding QA passed" : `onboarding QA FAILED: ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
