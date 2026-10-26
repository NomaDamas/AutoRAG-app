import { fileURLToPath } from "node:url";
/**
 * Manual QA — file-name search leaves system folders alone.
 *
 * Builds a throwaway home whose Documents and (on macOS) Google Drive File
 * Provider domain hold both the user's files and folders the OS or the
 * provider keeps for itself (`.Trashes`, `$Recycle.Bin`, Drive's unreadable
 * `.tmp`, `.shortcut-targets-by-id`, ...), then searches the way a user does:
 *   1. a name present in user files AND inside every system folder returns
 *      only the user's rows;
 *   2. a query that matches a system folder's own name returns no such row;
 *   3. the app logs no `fs:search skipping` line for a system folder (the
 *      unreadable `.tmp` used to log EACCES on every search).
 *
 * The file-name index is pointed at an empty XDG dir so the disk walk answers.
 * Run `bun run build` first. Evidence lands in the ignored `.omo/` tree.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-search-system-folders");
mkdirSync(EVIDENCE, { recursive: true });

const failures = [];
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`);
	if (!ok) failures.push(label);
};

const home = mkdtempSync(join(tmpdir(), "qa-sysfolders-home-"));
const userDataDir = mkdtempSync(join(tmpdir(), "qa-sysfolders-data-"));
const xdg = mkdtempSync(join(tmpdir(), "qa-sysfolders-xdg-"));
const docs = join(home, "Documents");
const domain = join(home, "Library", "CloudStorage", "GoogleDrive-qa@example.com");

/** A folder holding `<name>-internal.txt`, the way a system folder would hold files the user never made. */
const systemFolder = (parent, name) => {
	const folder = join(parent, name);
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, "audit-internal.txt"), "internal\n");
	return folder;
};

mkdirSync(join(docs, "Project"), { recursive: true });
writeFileSync(join(docs, "Project", "audit-mine.txt"), "mine\n");
mkdirSync(join(docs, "tmp-notes"), { recursive: true });
for (const name of [".Trashes", ".Spotlight-V100", "$Recycle.Bin", "System Volume Information"]) systemFolder(docs, name);

const unreadable = [];
if (process.platform === "darwin") {
	mkdirSync(join(domain, "My Drive"), { recursive: true });
	writeFileSync(join(domain, "My Drive", "audit-drive.txt"), "drive\n");
	for (const name of [".Trash", ".shortcut-targets-by-id", ".file-revisions-by-id"]) systemFolder(domain, name);
	// Google Drive ships `.tmp` as `d--x------`: it cannot be listed at all.
	const tmp = systemFolder(domain, ".tmp");
	chmodSync(tmp, 0o000);
	unreadable.push(tmp);
}

let app;
let log = "";
try {
	app = await launchFinder({ userDataDir, env: { HOME: home, USERPROFILE: home, XDG_DATA_HOME: xdg } });
	for (const stream of [app.process().stdout, app.process().stderr]) stream?.on("data", (chunk) => (log += String(chunk)));
	const page = await finderWindow(app);
	page.setDefaultTimeout(10000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 200)}`));
	await page.waitForSelector(".side-search input", { timeout: 30000 });

	const search = page.locator(".side-search input");
	const rowLabels = () => page.locator('[role="row"] .row__label').allInnerTexts();
	/** Commit a file-name search and wait until the scope bar and the walk settle. */
	const commit = async (query) => {
		await search.click();
		await search.fill(query);
		await search.press("Enter");
		await page.waitForSelector(".scope", { timeout: 10000 });
		await page.waitForFunction(() => document.querySelectorAll('[role="row"] .row__label').length > 0, null, { timeout: 8000 }).catch(() => undefined);
		await page.waitForTimeout(1500);
		return rowLabels();
	};

	// 1. A name that also sits inside every system folder returns only the user's rows.
	const audit = await commit("audit");
	const expected = process.platform === "darwin" ? ["audit-drive.txt", "audit-mine.txt"] : ["audit-mine.txt"];
	check("a search returns the user's files and none from system folders", JSON.stringify([...audit].sort()) === JSON.stringify(expected), JSON.stringify(audit));
	await page.mouse.move(2, 2);
	await page.screenshot({ path: join(EVIDENCE, "01-audit.png") });

	// 2. A query matching a system folder's own name returns no such row.
	const systemHits = [];
	for (const query of ["trash", "spotlight", "recycle", "volume", "shortcut", "revisions"]) {
		systemHits.push(...(await commit(query)));
	}
	check("a system folder's own name is never a result", systemHits.length === 0, JSON.stringify(systemHits));
	const tmp = await commit("tmp");
	check("`.tmp` is not a result but a user folder named like it is", JSON.stringify(tmp) === JSON.stringify(["tmp-notes"]), JSON.stringify(tmp));
	await page.screenshot({ path: join(EVIDENCE, "02-tmp.png") });

	// 3. No system folder was reported as skipped (the unreadable `.tmp` used to log EACCES).
	const skipped = log.split("\n").filter((line) => line.includes("fs:search skipping"));
	check("the app logs no skipped-folder warning", skipped.length === 0, skipped.slice(0, 3).join(" | "));
} catch (error) {
	console.error(`capture failed: ${String(error).slice(0, 400)}`);
	failures.push("harness error");
} finally {
	await app?.close();
	for (const path of unreadable) chmodSync(path, 0o700);
	rmSync(home, { recursive: true, force: true });
	rmSync(userDataDir, { recursive: true, force: true });
	rmSync(xdg, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "\nRESULT: ALL PASS" : `\nRESULT: ${failures.length} FAILURES: ${failures.join(" | ")}`);
console.log(`evidence: ${EVIDENCE}`);
process.exitCode = failures.length === 0 ? 0 : 1;
