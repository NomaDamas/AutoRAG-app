// Live QA for the OS file-menu integration (Settings → General → "Add to the
// file right-click menu"). Drives the built app and proves, on macOS:
//   1. the Settings switch writes two Finder Quick Action workflows into the
//      profile's ~/Library/Services, and switching it off removes them;
//   2. running the installed "Ask Dazzi" workflow through the real
//      Automator runtime (`automator -i <file> <workflow>`, the same shell
//      action Finder's Quick Actions run) hands the selected files to the
//      RUNNING app, which attaches them to AI Search — and no second app
//      process stays behind;
//   3. the "Show in Dazzi" workflow opens the file's folder with it selected;
//   4. a cold start with the request flags in argv (what the workflow does when
//      the app is not running) attaches the files on first load.
// Windows has no Automator; there the registry commands are covered by unit tests.
//
// Prerequisites: `bun run build`. Run: bun scripts/manual-qa/run-qa-finder-os-menu.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_PANEL, finderWindow, launchFinder } from "./launch-finder.mjs";
import { homeEnv, isMac } from "./platform.mjs";

if (!isMac) {
	console.log("SKIP os-menu: the Automator lane runs on macOS only");
	process.exit(0);
}

const WORK = realpathSync(mkdtempSync(join(tmpdir(), "autorag-qa-os-menu-")));
const HOME = join(WORK, "home");
const SERVICES = join(HOME, "Library", "Services");
const USER_DATA = join(WORK, "user-data");
const DOCS = join(WORK, "docs");
const OTHER = join(WORK, "other");
for (const directory of [HOME, USER_DATA, DOCS, OTHER]) mkdirSync(directory, { recursive: true });
const BRIEF = join(DOCS, "brief with spaces.md");
const FOLDER = join(DOCS, "한글 폴더");
const REVEAL = join(OTHER, "reveal-me.txt");
const COLD = join(DOCS, "cold-start.md");
mkdirSync(FOLDER);
writeFileSync(BRIEF, "# brief\n");
writeFileSync(REVEAL, "reveal\n");
writeFileSync(COLD, "cold\n");

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
/** Electron processes of this lane's profile, found by its unique user-data-dir. */
const laneProcesses = () => {
	try {
		return execFileSync("/usr/bin/pgrep", ["-f", `user-data-dir=${USER_DATA}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
};
// `automator -i -` reads one input item per line from stdin; a repeated `-i` keeps only the last item.
const runWorkflow = (name, items) => execFileSync("/usr/bin/automator", ["-i", "-", join(SERVICES, `${name}.workflow`)], { encoding: "utf8", input: `${items.join("\n")}\n` });

let app;
try {
	app = await launchFinder({ userDataDir: USER_DATA, env: homeEnv(HOME) });
	let page = await finderWindow(app);

	// 1. The Settings switch writes the workflows.
	await page.locator(".sidebar__item", { hasText: "Settings" }).click();
	const toggle = page.getByRole("switch", { name: "파일 우클릭 메뉴에 추가" });
	await toggle.waitFor({ timeout: 20_000 });
	check("switch starts off, nothing installed", (await toggle.getAttribute("aria-checked")) === "false" && !existsSync(SERVICES));
	await toggle.click();
	const installed = await until(() => existsSync(SERVICES) && readdirSync(SERVICES).length === 2);
	check("switch on writes two workflows", installed !== false, existsSync(SERVICES) ? readdirSync(SERVICES).join(", ") : "no Services dir");
	for (const name of existsSync(SERVICES) ? readdirSync(SERVICES) : []) {
		for (const file of ["Info.plist", "document.wflow"]) execFileSync("/usr/bin/plutil", ["-lint", join(SERVICES, name, "Contents", file)]);
	}

	// 2. Ask Dazzi on the running app: files + a folder, names with spaces and Hangul.
	const before = laneProcesses().length;
	const output = runWorkflow("Ask Dazzi", [BRIEF, FOLDER]);
	console.log(`automator: ${output.trim() || "(no output)"}`);
	const pills = page.locator(`${AI_PANEL} .composer-attach-pill`);
	const attached = await until(async () => (await pills.count()) === 2);
	check("ask: both items attach to AI Search in the running app", attached !== false);
	const titles = attached === false ? [] : await pills.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("title")));
	// APFS treats NFC and NFD names as the same file, and Automator hands paths over decomposed, so compare normalized.
	const normalized = titles.map((title) => title?.normalize("NFC"));
	const exact = titles.includes(FOLDER);
	check("ask: attachments carry the absolute paths", normalized.includes(BRIEF) && normalized.includes(FOLDER.normalize("NFC")), `folder exact=${exact}`);
	await sleep(1500);
	check("ask: no second app process is left behind", laneProcesses().length === before, `${before} → ${laneProcesses().length}`);

	// 3. Show in Dazzi: the file's folder opens with the file selected.
	runWorkflow("Show in Dazzi", [REVEAL]);
	const row = page.locator(`[data-path="${REVEAL}"]`).first();
	const shown = await until(async () => (await row.count()) > 0);
	check("reveal: the folder opens and lists the file", shown !== false);
	check("reveal: the file is selected", shown !== false && /selected/u.test((await row.getAttribute("class")) ?? "") || (await row.getAttribute("aria-selected")) === "true");

	// Switching off removes exactly the workflows.
	await page.locator(".sidebar__item", { hasText: "Settings" }).click().catch(() => {});
	await toggle.click();
	const removed = await until(() => readdirSync(SERVICES).length === 0);
	check("switch off removes the workflows", removed !== false);
	await app.close();
	app = undefined;

	// 4. Cold start: the request rides in argv, exactly as the workflow launches the app.
	app = await launchFinder({
		userDataDir: USER_DATA,
		env: homeEnv(HOME),
		args: ["--autorag-request=ask", `--autorag-path=${COLD}`],
	});
	page = await finderWindow(app);
	const coldPill = page.locator(`${AI_PANEL} .composer-attach-pill`);
	const cold = await until(async () => (await coldPill.count()) === 1, 30_000);
	check("cold start: the file is attached on first load", cold !== false && (await coldPill.first().getAttribute("title")) === COLD);
} catch (error) {
	console.error(error);
	failures += 1;
} finally {
	if (app !== undefined) await app.close().catch(() => {});
	rmSync(WORK, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`FAIL os-menu: ${failures} check(s) failed`);
	process.exit(1);
}
console.log("os-menu QA passed");
