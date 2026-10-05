import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";

/**
 * Manual QA — Instant Search backed by the fsearch-cli name index.
 *
 * Builds a private fsearch database over a throwaway home, points the built
 * app at it through XDG_DATA_HOME, and verifies against the real UI:
 *   1. the app warms a `fsearch-cli watch` daemon at startup (cold start gone);
 *   2. "파일 이름" answers from the index over the whole machine — it finds a
 *      file the disk walk cannot reach (outside the scanned sidebar places);
 *   3. the scope bar's folder pill narrows the search to the folder in view;
 *   4. the daemon is still live while the app is running.
 *
 * Run `bun run build` first. Evidence lands in the ignored `.omo/` tree.
 */
const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-fsearch-search");
mkdirSync(EVIDENCE, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`);
	if (!ok) failures.push(label);
};

const ALL_LABEL = process.platform === "win32" ? "This Computer" : "This Mac";

const RUN_ID = `qa-fsearch-${Date.now().toString(36)}`;
// A real (non-symlinked) base: fsearch-cli canonicalizes /var and /tmp, and a
// scope that fails to prefix-match the indexed realpaths would hide every hit.
const base = join(homedir(), `.autorag-${RUN_ID}`);
const home = join(base, "home");
const xdg = join(base, "xdg");
const userDataDir = join(base, "userData");
const db = join(xdg, "fsearch", "fsearch.db");
const socket = `${db}.sock`;
const pidFile = join(userDataDir, "fsearch", "watch.pid");
const docsFolder = join(home, "Documents", RUN_ID);
const insideName = `${RUN_ID}-inside.md`;
const outsideName = `${RUN_ID}-outside.md`;

const fsearch = (args) =>
	spawnSync("fsearch-cli", args, { encoding: "utf8", env: { ...process.env, XDG_DATA_HOME: xdg } });

function daemonLive() {
	const result = fsearch(["stats", "--db", db, "--socket", socket]);
	return result.status === 0 && /"live":\s*true/.test(result.stdout);
}

mkdirSync(docsFolder, { recursive: true });
mkdirSync(join(home, "elsewhere"), { recursive: true });
writeFileSync(join(docsFolder, insideName), "# inside\n");
writeFileSync(join(home, "elsewhere", outsideName), "outside the scanned places\n");

// The index is the user's own (fsearch-cli default database); we only build a
// fixture one here because the app is pointed at a throwaway home.
const indexed = fsearch(["index", "--db", db, "--include", home]);
console.log(`index: ${indexed.stdout.trim() || indexed.stderr.trim()}`);
if (!existsSync(db)) {
	console.log("RESULT: FAILED — fsearch-cli could not build the fixture database");
	process.exit(1);
}

let app;
try {
	app = await launchFinder({
		userDataDir,
		env: { HOME: home, USERPROFILE: home, XDG_DATA_HOME: xdg },
	});
	const page = await finderWindow(app);
	page.setDefaultTimeout(10000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 200)}`));
	await page.waitForSelector(".side-search input", { timeout: 30000 });
	await page.waitForSelector(".sidebar__item", { timeout: 30000 });

	const search = page.locator(".side-search input");
	const chip = (label) => page.locator(".scope-chip", { hasText: new RegExp(`^${label}$`) });

	// 1. The app warmed a watch daemon for the default database.
	let live = false;
	for (let attempt = 0; attempt < 40 && !live; attempt += 1) {
		live = daemonLive();
		if (!live) await sleep(500);
	}
	check("the app starts a fsearch-cli watch daemon at launch", live && existsSync(pidFile), `live=${live} pidFile=${existsSync(pidFile)}`);

	// 2. "파일 이름" answers from the index over the whole machine: the outside
	//    file is outside every scanned sidebar place, so only the index can
	//    return it.
	await search.click();
	await chip("파일 이름").click();
	await search.fill(outsideName);
	await search.press("Enter");
	await page.waitForSelector(".scope", { timeout: 15000 });
	const rowNames = () => page.locator('[role="row"] .row__label').allInnerTexts();
	const waitForRow = (name) =>
		page.waitForFunction(
			(wanted) => [...document.querySelectorAll('[role="row"] .row__label')].some((row) => row.textContent === wanted),
			name,
			{ timeout: 15000 },
		);
	await waitForRow(outsideName).catch(() => undefined);
	await sleep(400);
	const allRows = await rowNames();
	check(
		"a filename search finds a file outside the scanned places (index hit)",
		allRows.includes(outsideName),
		JSON.stringify(allRows),
	);
	const defaultScope = (await page.locator(".scope button[aria-pressed='true']").innerText()).trim();
	check("a filename search defaults to the whole machine", defaultScope === ALL_LABEL, defaultScope);
	check(
		"the scope bar reports the index hits",
		/\d+\s*items found/.test(await page.locator(".scope__count").innerText()),
		await page.locator(".scope__count").innerText(),
	);
	await page.mouse.move(2, 2);
	await sleep(500);
	await page.screenshot({ path: join(EVIDENCE, "01-all-index-hit.png") });

	// 3. The scope bar's folder pill narrows the search to the folder in view.
	await page.locator(".sidebar__item", { hasText: "Documents" }).first().click();
	await search.click();
	await search.fill(insideName);
	await search.press("Enter");
	await page.waitForSelector(".scope", { timeout: 15000 });
	await page.locator(".scope button").nth(1).click();
	await page.waitForFunction(
		(all) => document.querySelector(".scope button[aria-pressed='true']")?.textContent?.trim() !== all,
		ALL_LABEL,
		{ timeout: 15000 },
	);
	const scopedButton = (await page.locator(".scope button[aria-pressed='true']").innerText()).trim();
	await waitForRow(insideName).catch(() => undefined);
	await sleep(400);
	const scopedRows = await rowNames();
	check("the folder pill narrows the search to the folder in view", scopedButton !== ALL_LABEL, scopedButton);
	check("the scoped search finds the file under the folder", scopedRows.includes(insideName), JSON.stringify(scopedRows));
	await page.screenshot({ path: join(EVIDENCE, "02-folder-scope.png") });

	// 4. The daemon is still live while the app runs (keep-alive, not one-shot).
	check("the watch daemon is live after searching", daemonLive(), `live=${daemonLive()}`);
} catch (error) {
	console.error(`capture failed: ${String(error).slice(0, 400)}`);
	failures.push("harness error");
} finally {
	if (app !== undefined) {
		// The app leaves the daemon alive on purpose; QA cleans up its fixture.
		try {
			if (existsSync(pidFile)) process.kill(Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10), "SIGTERM");
		} catch (error) {
			console.log(`cleanup: daemon already gone (${String(error).slice(0, 120)})`);
		}
		await app.close().catch(() => undefined);
	}
	try {
		execFileSync("pkill", ["-f", db]);
	} catch {
		// Nothing left to kill.
	}
	rmSync(base, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "\nRESULT: ALL PASS" : `\nRESULT: ${failures.length} FAILURES: ${failures.join(" | ")}`);
console.log(`evidence: ${EVIDENCE}`);
process.exitCode = failures.length === 0 ? 0 : 1;
