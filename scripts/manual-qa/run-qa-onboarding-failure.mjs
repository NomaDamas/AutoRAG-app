// The zero-question first run has ONE failure surface: setup stops and offers a
// single way on, the retry. This lane makes such a stop for real (the AutoRAG
// workspace cannot be written), checks the overlay shows it, then puts the cause
// right and clicks the retry through to ready. Nothing about the run is mocked.
//
// AUTORAG_HOME / AUTORAG_CONFIG point inside a temp dir, so the user's own config
// and index are never touched. The first run scans the OS's own default folders,
// which Electron resolves from the OS (a launch-env `HOME` does not move them on
// macOS), so this lane is meant for the throwaway VM home the QA runner boots;
// fixtures are not needed because the failure does not depend on what is scanned.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { rmRetry } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/onboarding-failure");
mkdirSync(EVIDENCE, { recursive: true });

// The fixture is a POSIX permission check (a read-only workspace), which Windows
// chmod cannot express, so the lane skips there instead of silently passing.
if (process.platform === "win32") {
	console.log("SKIP onboarding-failure: the unwritable-workspace fixture is POSIX-only");
	process.exit(0);
}

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};
const info = (message) => console.log(`INFO ${message}`);
const screenOf = (page) => page.evaluate(() => document.querySelector(".fr-root")?.getAttribute("data-screen") ?? null);

const WORK = mkdtempSync(join(tmpdir(), "autorag-onboarding-failure-"));
const AUTORAG_HOME = join(WORK, "autorag-home");
const WORKSPACE = join(AUTORAG_HOME, "workspace");
const CONFIG = join(WORK, "config", "config.json");
mkdirSync(WORKSPACE, { recursive: true });
mkdirSync(join(WORK, "config"), { recursive: true });
// The workspace the first index must write into is read-only for the whole run,
// so main stops at the index with a real write error.
chmodSync(WORKSPACE, 0o500);

const env = {
	AUTORAG_HOME,
	AUTORAG_CONFIG: CONFIG,
	AUTORAG_WORKSPACE: WORKSPACE,
	AUTORAG_SKIP_DUPEY_CHECK: "1",
};
const userDataDir = join(WORK, "user-data");

const errors = [];
let app;
try {
	app = await launchFinder({ userDataDir, env, onboarding: true, language: "ko" });
	const page = await finderWindow(app, 30_000);
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});

	await page.waitForSelector(".fr-root[data-screen]", { timeout: 30_000 });
	// setup starts on its own. This fixture fails the run within milliseconds, so the setup
	// screen may already show the stop; a retry on screen must mean the run really failed.
	// The DOM is read before the status: `failed` holds until the retry, so the order is safe.
	await page.waitForSelector('.fr-root[data-screen="setup"]', { timeout: 60_000 });
	await page.waitForSelector(".fr-setup", { timeout: 60_000 });
	const retryShown = (await page.locator('[data-action="setup-retry"]').count()) > 0;
	const early = await page.evaluate(() => window.autorag.onboarding.status());
	check("the setup screen offers a retry only on a failed run", !retryShown || early.stage === "failed", `stage=${early.stage} retry=${retryShown}`);
	await page.screenshot({ path: join(EVIDENCE, "01-setup-running.png") });

	// the workspace write fails -> the run stops -> the retry appears.
	await page.waitForSelector('[data-action="setup-retry"]', { timeout: 300_000 });
	const failed = await page.evaluate(() => window.autorag.onboarding.status());
	info(`stopped with stage=${failed.stage} error=${failed.error ?? "(none)"}`);
	check("the stopped run reports the failed stage", failed.stage === "failed", JSON.stringify(failed));
	check("the stopped run carries a reason", typeof failed.error === "string" && failed.error.length > 0, String(failed.error));
	check("the stopped run offers exactly one retry", (await page.locator('[data-action="setup-retry"]').count()) === 1);
	check("the failure is not a leftover success", failed.progress < 100, String(failed.progress));
	await page.screenshot({ path: join(EVIDENCE, "02-setup-failed.png") });

	// put the cause right and retry through to ready.
	chmodSync(WORKSPACE, 0o700);
	await page.locator('[data-action="setup-retry"]').click();
	await page.waitForSelector('[data-action="setup-retry"]', { state: "detached", timeout: 30_000 }).catch(() => undefined);
	await page.waitForSelector('.fr-root[data-screen="ready"]', { timeout: 600_000 });
	const ready = await page.evaluate(() => window.autorag.onboarding.status());
	check("the retry after fixing the cause reaches ready", ready.stage === "ready", JSON.stringify(ready.stage));
	check("the recovered run carries no error", ready.error === null, String(ready.error));
	await page.screenshot({ path: join(EVIDENCE, "03-ready-after-retry.png") });

	// the recovered keyword-only run wrote its config and parsed mirror.
	if (existsSync(CONFIG)) {
		const raw = JSON.parse(readFileSync(CONFIG, "utf8"));
		check("keyword-only: semantic search is off in the shared config", raw.appIndexing?.semanticSearch === false, JSON.stringify(raw.appIndexing));
		check("the recovered index lives under AUTORAG_HOME", String(raw.workspacePath ?? "").startsWith(AUTORAG_HOME), String(raw.workspacePath));
	} else {
		check("the recovered run wrote the shared config", false, `${CONFIG} is missing`);
	}

	check("no renderer errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (error) {
	failures.push(String(error));
	console.error(error);
} finally {
	try {
		chmodSync(WORKSPACE, 0o700);
	} catch {
		// Already writable or gone.
	}
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
	rmRetry(WORK);
}
console.log(failures.length === 0 ? "onboarding failure QA passed" : `onboarding failure QA FAILED: ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
