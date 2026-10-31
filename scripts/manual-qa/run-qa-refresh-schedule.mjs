import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchFinder, finderWindow } from "./launch-finder.mjs";
import { isolatedToolPath, rmRetry } from "./platform.mjs";

// Automatic refresh cadence against the real app: choosing a cadence writes
// the shared config and registers a real OS job; choosing "직접" removes it.
// macOS: HOME is a scratch directory, so the LaunchAgent lands in the scratch
// home and is bootstrapped into the real launchd domain, then removed again
// before the run ends. Other platforms: the scheduler runs against the real
// per-user crontab / Task Scheduler, restoring them afterwards.
// Production build first: bun run build

const EVIDENCE = fileURLToPath(new URL("../../.omo/evidence/refresh-schedule/", import.meta.url));
mkdirSync(EVIDENCE, { recursive: true });

const root = mkdtempSync(join(tmpdir(), "autorag-qa-schedule-"));
const home = join(root, "home");
const workspace = join(root, "workspace");
mkdirSync(join(workspace, "docs"), { recursive: true });
mkdirSync(home, { recursive: true });
writeFileSync(join(workspace, "docs", "a.txt"), "alpha document about apples\n");
const qaBin = join(root, "bin");
mkdirSync(qaBin, { recursive: true });
const qaPath = isolatedToolPath(qaBin);

const configPath = join(root, "config.json");
writeFileSync(configPath, `${JSON.stringify({
	searchPaths: [join(workspace, "docs")],
	workspacePath: workspace,
	minSync: { enabled: true },
	jikji: false,
	datasources: { slack: { description: "Team Slack", connector: { workspace: "T0QA" } } },
}, null, 2)}\n`);
const readConfig = () => JSON.parse(readFileSync(configPath, "utf8"));
const plistPath = join(home, "Library", "LaunchAgents", "com.autorag.app.refresh.plist");

const fails = [];
const check = (name, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
	if (!ok) fails.push(name);
};
const waitFor = async (predicate, timeoutMs = 10000) => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await predicate();
		if (value) return value;
		if (Date.now() > deadline) return value;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
};

const env = { AUTORAG_CONFIG: configPath, AUTORAG_HOME: root, HOME: home, PATH: qaPath };
const app = await launchFinder({ userDataDir: join(root, "user-data"), env });
const errors = [];
try {
	const page = await finderWindow(app);
	page.on("pageerror", (error) => errors.push(error.message));
	await page.waitForSelector(".sidebar__item");
	await page.locator(".sidebar__item--settings").click();
	await page.waitForSelector(".settings-panel");
	await page.locator(".settings-nav-item", { hasText: "Indexing" }).first().click();
	const local = page.locator('select[aria-label="Local folder refresh interval"]');
	await local.waitFor();

	check("nothing is scheduled by default (manual)", (await local.inputValue()) === "0" && readConfig().appIndexing?.refreshIntervalMs === undefined);
	check("no OS job exists before a cadence is chosen", process.platform !== "darwin" || !existsSync(plistPath));
	check("local cadence offers manual plus the preset cadences", (await local.locator("option").allInnerTexts()).join(",") === "Manual,5 min,15 min,30 min,1 hour,6 hours,Daily");
	await page.screenshot({ path: join(EVIDENCE, "01-manual.png") });

	await local.selectOption({ label: "1 hour" });
	const stored = await waitFor(() => readConfig().appIndexing?.refreshIntervalMs === 3_600_000);
	check("choosing 1 hour writes appIndexing.refreshIntervalMs", stored === true, String(readConfig().appIndexing?.refreshIntervalMs));
	if (process.platform === "darwin") {
		check("a LaunchAgent is registered", (await waitFor(() => existsSync(plistPath))) === true);
		const plist = existsSync(plistPath) ? readFileSync(plistPath, "utf8") : "";
		check("the agent wakes every 30 minutes (cap) and runs the app in plain-Node mode", plist.includes("<integer>1800</integer>") && plist.includes("ELECTRON_RUN_AS_NODE"));
		check("the agent points at the built job", /refresh-job\.js/u.test(plist));
	}
	const note = await waitFor(async () => (await page.locator(".settings-content").innerText()).includes("checks every 30 min"));
	check("the page says the job is active", note === true);
	await page.screenshot({ path: join(EVIDENCE, "02-scheduled.png") });

	await page.locator('select[aria-label="slack refresh interval"]').selectOption({ label: "15 min" });
	check("a datasource cadence is written", (await waitFor(() => readConfig().datasources?.slack?.pollingIntervalMs === 900_000)) === true);
	check("the wake interval follows the shortest cadence (15 minutes)", (await waitFor(async () => (await page.locator(".settings-content").innerText()).includes("checks every 15 min"))) === true);

	await local.selectOption({ label: "Manual" });
	await page.locator('select[aria-label="slack refresh interval"]').selectOption({ label: "Manual" });
	check("manual again clears nothing it should keep", (await waitFor(() => readConfig().datasources?.slack?.pollingIntervalMs === 0)) === true && readConfig().datasources.slack.description === "Team Slack");
	if (process.platform === "darwin") {
		check("the LaunchAgent is removed once nothing is scheduled", (await waitFor(() => !existsSync(plistPath))) === true);
	}
	await page.screenshot({ path: join(EVIDENCE, "03-manual-again.png") });
	check("no renderer errors during the run", errors.length === 0, JSON.stringify(errors.slice(0, 5)));
} finally {
	await app.close();
	if (process.platform === "darwin") {
		// Never leave a job behind, even when an assertion above failed.
		try {
			execFileSync("launchctl", ["bootout", `gui/${process.getuid()}/com.autorag.app.refresh`], { stdio: "ignore" });
		} catch {
			// not loaded
		}
	}
	rmRetry(root);
}

if (fails.length > 0) {
	console.log("FAIL:", fails);
	process.exitCode = 1;
} else {
	console.log(`PASS: a chosen cadence registers a real OS job and manual removes it — evidence in ${EVIDENCE}`);
}
