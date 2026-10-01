/**
 * Manual QA: Finder live filesystem synchronization.
 *
 * Run after `timeout 300 bunx electron-vite build`:
 *   timeout 300 bun scripts/manual-qa/run-qa-finder-live-sync.mjs
 */

import { launchFinder } from "./launch-finder.mjs";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const EVIDENCE = join(REPO, ".omo", "evidence", "fs-live-sync", "qa-live-sync");
const RUN_LOG = join(EVIDENCE, "run.log");
const UNWATCHED_LOG = join(EVIDENCE, "unwatched.log");
let USER_DATA = join(tmpdir(), `ulw-live-sync-qa-${process.pid}-initial`);
const DOWNLOADS = join(homedir(), "Downloads");
const FIXTURE_DIR = join(DOWNLOADS, "ulw-live-sync-qa");
const OTHER_DIR = join(DOWNLOADS, "ulw-live-sync-qa-other");
const UNWATCHED_DIR = join(DOWNLOADS, "ulw-live-sync-qa-unwatched");
const FIXTURE_FOLDER = "ulw-live-sync-qa";
let SNAPSHOT = join(USER_DATA, "dupey-cache", "version-families.json");
const OVERALL_TIMEOUT_MS = 12 * 60 * 1000;
const LIVE_BOUND_MS = 1500;
const DUPLICATE_BODY = `${"Live sync duplicate fixture. ".repeat(80)}\n`;
const DUMP_DIAGNOSTICS = process.env.QA_DUMP === "1";

let app = null;
let cleanupComplete = false;
let overallTimer = null;
let exitCode = 0;
let electronLines = [];
let electronEvents = [];
let electronBuffer = "";
let sessionNumber = 0;

mkdirSync(EVIDENCE, { recursive: true });
rmSync(USER_DATA, { recursive: true, force: true });
rmSync(RUN_LOG, { force: true });
rmSync(UNWATCHED_LOG, { force: true });

function appendTo(path, line) {
	writeFileSync(path, `${line}\n`, { encoding: "utf8", flag: "a" });
}

function appendLog(line) {
	process.stdout.write(`${line}\n`);
	try {
		appendTo(RUN_LOG, line);
	} catch {
		// The process-exit cleanup still removes all QA state.
	}
}

function pass(label, observable) {
	appendLog(`PASS ${label}: ${observable}`);
}

function fail(label, observable) {
	exitCode = 1;
	appendLog(`FAIL ${label}: ${observable}`);
}

function removeFixtures() {
	for (const path of [FIXTURE_DIR, OTHER_DIR, UNWATCHED_DIR]) {
		rmSync(path, { recursive: true, force: true });
	}
}

function cleanupOnExit() {
	if (cleanupComplete) return;
	cleanupComplete = true;
	removeFixtures();
	rmSync(USER_DATA, { recursive: true, force: true });
	try {
		appendTo(
			RUN_LOG,
			`CLEANUP app=${app === null ? "closed" : "open"} userData=${existsSync(USER_DATA) ? "present" : "removed"} fixtures=${
				[FIXTURE_DIR, OTHER_DIR, UNWATCHED_DIR].every((path) => !existsSync(path)) ? "removed" : "present"
			}`,
		);
	} catch {
		// No further cleanup is possible during process exit.
	}
}

process.on("exit", cleanupOnExit);
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		exitCode = 1;
		void closeApp().finally(() => process.exit(exitCode));
	});
}

async function closeApp() {
	if (app === null) return;
	try {
		await app.close();
		appendLog("INFO app closed");
	} catch (error) {
		exitCode = 1;
		appendLog(`FAIL app close: ${error instanceof Error ? error.message : String(error)}`);
	}
	app = null;
}

async function startSession(label) {
	sessionNumber += 1;
	USER_DATA = join(tmpdir(), `ulw-live-sync-qa-${process.pid}-${sessionNumber}-${label}`);
	SNAPSHOT = join(USER_DATA, "dupey-cache", "version-families.json");
	rmSync(USER_DATA, { recursive: true, force: true });
	setupFixtures();
	app = await launchFinder({
		userDataDir: USER_DATA,
		env: { AUTORAG_FS_WATCH_DIAG: "1" },
	});
	const stdout = app.process().stdout;
	if (stdout !== null) {
		stdout.setEncoding("utf8");
		stdout.on("data", (chunk) => {
			electronBuffer += String(chunk);
			const lines = electronBuffer.split(/\r?\n/);
			electronBuffer = lines.pop() ?? "";
			for (const line of lines) {
				if (line === "") continue;
				electronLines.push(line);
				electronEvents.push({ text: line, timestampMs: Date.now() });
				appendLog(`ELECTRON ${line}`);
			}
		});
	}
	const page = await app.firstWindow();
	page.on("console", (message) => appendLog(`RENDERER console.${message.type()}: ${message.text()}`));
	page.on("pageerror", (error) => appendLog(`RENDERER pageerror: ${error.message}`));
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.waitForSelector('[role="row"]', { timeout: 60_000 });
	return page;
}

async function finishSession() {
	await closeApp();
	removeFixtures();
	rmSync(USER_DATA, { recursive: true, force: true });
	appendLog(`SESSION CLEANUP userData=${existsSync(USER_DATA) ? "present" : "removed"} fixtures=${
		[FIXTURE_DIR, OTHER_DIR, UNWATCHED_DIR].every((path) => !existsSync(path)) ? "removed" : "present"
	}`);
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

async function waitFor(predicate, { timeoutMs, label, stepMs = 50 }) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		last = await predicate();
		if (last) return last;
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
	throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

async function dumpFixtureFamily(page, label) {
	const liveLayers = await page.evaluate(() => window.autorag.live.layers());
	const liveFamily = liveLayers.layers
		.find((layer) => layer.layer === "dupey")
		?.data?.families?.find((family) => family.head.startsWith(`${FIXTURE_DIR}/`) || family.members.some((member) => member.path.startsWith(`${FIXTURE_DIR}/`)));
	const snapshot = readJson(SNAPSHOT);
	const snapshotFamily = snapshot?.families?.find((family) => family.head.startsWith(`${FIXTURE_DIR}/`) || family.members.some((member) => member.path.startsWith(`${FIXTURE_DIR}/`)));
	appendLog(`${label} live.fixtureFamily=${JSON.stringify(liveFamily ?? null)}`);
	appendLog(`${label} snapshot.fixtureFamily=${JSON.stringify(snapshotFamily ?? null)}`);
	appendLog(`${label} snapshot.fixtureStampKeys=${JSON.stringify(Object.keys(snapshot?.stamps ?? {}).filter((path) => path.startsWith(`${FIXTURE_DIR}/`) || path.startsWith(`${OTHER_DIR}/`)))}`);
}

function rowFor(page, name) {
	return page.locator('[role="row"]').filter({ has: page.getByText(name, { exact: true }) });
}

function familyForFixture(snapshot) {
	const known = new Set([
		...readdirSync(FIXTURE_DIR, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => join(FIXTURE_DIR, entry.name)),
		join(OTHER_DIR, "quarterly-report.txt"),
	]);
	return (snapshot?.families ?? []).find(
		(family) => known.has(family.head) && family.members.some((member) => known.has(member.path)),
	);
}

function setupFixtures() {
	if (lstatSync(DOWNLOADS).isSymbolicLink()) {
		throw new Error(`Downloads is a symlink: ${DOWNLOADS}`);
	}
	removeFixtures();
	mkdirSync(join(FIXTURE_DIR, "sub"), { recursive: true });
	mkdirSync(OTHER_DIR, { recursive: true });
	mkdirSync(UNWATCHED_DIR, { recursive: true });
	const otherCopy = join(OTHER_DIR, "quarterly-report.txt");
	writeFileSync(otherCopy, DUPLICATE_BODY, "utf8");
	const oldDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
	utimesSync(otherCopy, oldDate, oldDate);
	for (const name of ["quarterly-report.txt", "quarterly-report-copy.txt", "quarterly-report-copy 2.txt", "quarterly-report-copy 3.txt", "quarterly-report (1).txt"]) {
		writeFileSync(join(FIXTURE_DIR, name), DUPLICATE_BODY, "utf8");
	}
	writeFileSync(join(FIXTURE_DIR, "selected-file.txt"), "selection fixture\n", "utf8");
	writeFileSync(join(FIXTURE_DIR, "rename-before.txt"), "rename fixture\n", "utf8");
}

async function waitForElectronLine(predicate, options) {
	return waitFor(() => electronLines.find(predicate), options);
}

async function runScenario(label, page, scenario, screenshot = true) {
	try {
		await scenario();
		return true;
	} catch (error) {
		const observable = error instanceof Error ? error.message : String(error);
		fail(label, observable);
		if (screenshot) {
			try {
				await page.screenshot({ path: join(EVIDENCE, `${label}.png`) });
			} catch (screenshotError) {
				appendLog(`INFO ${label} screenshot unavailable: ${screenshotError instanceof Error ? screenshotError.message : String(screenshotError)}`);
			}
		}
		return false;
	}
}

async function runS1(page) {
	await page.locator(".sidebar").getByRole("button", { name: "Downloads", exact: true }).click();
	await page.locator('[role="row"]').filter({ has: page.getByText(FIXTURE_FOLDER, { exact: true }) }).dblclick();
	await rowFor(page, "selected-file.txt").waitFor({ timeout: 30_000 });
	await waitForElectronLine(
		(line) => line.includes(`[fs-watch] watch ${FIXTURE_DIR}`),
		{ timeoutMs: 1500, label: "fixture directory watch diagnostic" },
	);
	const started = Date.now();
	writeFileSync(join(FIXTURE_DIR, "new-note.txt"), "created by live-sync S1\n", "utf8");
	await rowFor(page, "new-note.txt").waitFor({ timeout: LIVE_BOUND_MS });
	const elapsedMs = Date.now() - started;
	if (elapsedMs > LIVE_BOUND_MS) throw new Error(`row appeared after ${elapsedMs}ms > ${LIVE_BOUND_MS}ms`);
	await page.screenshot({ path: join(EVIDENCE, "S1.png") });
	pass("S1 create", `new-note.txt visible in ${elapsedMs}ms <= ${LIVE_BOUND_MS}ms`);
}

async function runS2(page) {
	const started = Date.now();
	rmSync(join(FIXTURE_DIR, "new-note.txt"), { force: true });
	await waitFor(
		async () => (await rowFor(page, "new-note.txt").count()) === 0,
		{ timeoutMs: LIVE_BOUND_MS, label: "new-note.txt row to disappear" },
	);
	const elapsedMs = Date.now() - started;
	if (elapsedMs > LIVE_BOUND_MS) throw new Error(`row disappeared after ${elapsedMs}ms > ${LIVE_BOUND_MS}ms`);
	await page.screenshot({ path: join(EVIDENCE, "S2.png") });
	pass("S2 delete", `new-note.txt row count 0 in ${elapsedMs}ms <= ${LIVE_BOUND_MS}ms`);
}

async function runS3(page) {
	await rowFor(page, "selected-file.txt").click();
	const selectedBefore = await page.locator('[role="row"][aria-selected="true"]').allInnerTexts();
	const started = Date.now();
	renameSync(join(FIXTURE_DIR, "rename-before.txt"), join(FIXTURE_DIR, "rename-after.txt"));
	await waitFor(
		async () => (await rowFor(page, "rename-before.txt").count()) === 0 && (await rowFor(page, "rename-after.txt").count()) === 1,
		{ timeoutMs: LIVE_BOUND_MS, label: "rename-before.txt to disappear and rename-after.txt to appear" },
	);
	const selectedAfter = await page.locator('[role="row"][aria-selected="true"]').allInnerTexts();
	if (JSON.stringify(selectedAfter) !== JSON.stringify(selectedBefore)) {
		throw new Error(`selection changed: before=${JSON.stringify(selectedBefore)} after=${JSON.stringify(selectedAfter)}`);
	}
	const elapsedMs = Date.now() - started;
	if (elapsedMs > LIVE_BOUND_MS) throw new Error(`rename appeared after ${elapsedMs}ms > ${LIVE_BOUND_MS}ms`);
	await page.screenshot({ path: join(EVIDENCE, "S3.png") });
	pass("S3 rename", `new row present, old row count 0, selection unchanged in ${elapsedMs}ms <= ${LIVE_BOUND_MS}ms`);
}

async function openStack(page, family) {
	const headName = family.head.split("/").pop() ?? family.head;
	const headRow = rowFor(page, headName);
	try {
		await headRow.locator(".row__stackbadge").waitFor({ state: "visible", timeout: 10_000 });
	} catch (error) {
		appendLog(`STACK badge diagnostic: rows=${JSON.stringify(await page.locator('[role="row"] .row__label').allInnerTexts())}`);
		throw error;
	}
	const badge = headRow.locator(".row__stackbadge");
	await badge.click();
	await page.locator(".row--child").first().waitFor({ timeout: 10_000 });
	return {
		headRow,
		badge,
		children: () => page.locator(".row--child .row__label").allInnerTexts(),
	};
}

async function runS4(page, family) {
	const liveLayers = await page.evaluate(() => window.autorag.live.layers());
	const dupeyLive = liveLayers.layers.find((layer) => layer.layer === "dupey");
	const versionFamilies = await page.evaluate(() => window.autorag.fs.versionFamilies());
	const snapshot = readJson(SNAPSHOT);
	appendLog(`S4 DUMP live.layers dupey=${JSON.stringify(dupeyLive?.data ?? null)}`);
	appendLog(`S4 DUMP fs.versionFamilies=${JSON.stringify(versionFamilies)}`);
	appendLog(`S4 DUMP snapshot=${JSON.stringify(snapshot)}`);
	appendLog(`S4 DUMP snapshot.stamps.keys=${JSON.stringify(Object.keys(snapshot?.stamps ?? {}))}`);
	const headName = family.head.split("/").pop() ?? family.head;
	const domProbe = await page.evaluate((name) => {
		const labels = [...document.querySelectorAll(".row__stackbadge")].map((element) => element.getAttribute("aria-label"));
		const headLabel = [...document.querySelectorAll(".row__label")].find((element) => element.textContent === name);
		const headRow = headLabel?.closest('[role="row"]') ?? null;
		return {
			badgeCount: document.querySelectorAll(".row__stackbadge").length,
			badgeLabels: labels,
			headRowOuterHTML: headRow?.outerHTML ?? null,
			rows: [...document.querySelectorAll('[role="row"]')].map((element) => element.textContent?.trim() ?? ""),
		};
	}, headName);
	appendLog(`S4 DOM probe: ${JSON.stringify(domProbe)}`);
	appendLog(`S4 locator probe: rowFor(page, ${JSON.stringify(headName)}) = page.locator('[role="row"]').filter({ has: page.getByText(${JSON.stringify(headName)}, { exact: true }) }); badge = .row__stackbadge`);
	await page.screenshot({ path: join(EVIDENCE, "S4-debug.png") });
	const victim = join(FIXTURE_DIR, "quarterly-report-copy.txt");
	if (victim === undefined) throw new Error("no non-head fixture member available for S4");
	const stack = await openStack(page, family);
	const before = (await stack.children()).length;
	const started = Date.now();
	rmSync(victim, { force: true });
	await waitFor(
		async () => !(await stack.children()).includes(victim.split("/").pop()),
		{ timeoutMs: LIVE_BOUND_MS, label: "deleted stack child to disappear" },
	);
	const after = (await stack.children()).length;
	const elapsedMs = Date.now() - started;
	if (after !== before - 1) throw new Error(`child count ${before} -> ${after}, expected ${before - 1}`);
	if (elapsedMs > LIVE_BOUND_MS) throw new Error(`stack delete took ${elapsedMs}ms > ${LIVE_BOUND_MS}ms`);
	await page.screenshot({ path: join(EVIDENCE, "S4.png") });
	pass("S4 stack member delete", `child count ${before} -> ${after} in ${elapsedMs}ms <= ${LIVE_BOUND_MS}ms`);
}

async function runS5(page, family) {
	await page.reload();
	await page.waitForSelector('[role="row"]', { timeout: 60_000 });
	await page.getByRole("button", { name: "Downloads" }).click();
	await page.locator('[role="row"]').filter({ has: page.getByText(FIXTURE_FOLDER, { exact: true }) }).dblclick();
	await rowFor(page, "selected-file.txt").waitFor({ timeout: 10_000 });
	family = familyForFixture(readJson(SNAPSHOT)) ?? family;
	const stack = await openStack(page, family);
	const member = join(FIXTURE_DIR, "quarterly-report-copy 2.txt");
	if (member === undefined) throw new Error("no fixture stack member available for S5");
	const before = (await stack.children()).length;
	const started = Date.now();
	writeFileSync(member, `${readFileSync(member, "utf8")}changed externally\n`, "utf8");
	try {
		await waitFor(
			async () => {
				const rows = page.locator('[role="row"]').filter({ has: page.getByText(member.split("/").pop() ?? member, { exact: true }) });
				const count = await rows.count();
				for (let index = 0; index < count; index += 1) {
					const row = rows.nth(index);
					if (!(await row.evaluate((element) => element.classList.contains("row--child")))) return true;
				}
				return false;
			},
			{ timeoutMs: LIVE_BOUND_MS, label: "modified member to become a normal row" },
		);
	} catch (error) {
		await dumpFixtureFamily(page, "S5 FAIL");
		appendLog(`S5 FAIL batchLines=${JSON.stringify(electronLines.filter((line) => line.includes(`[fs-watch] batch ${FIXTURE_DIR}`)))}`);
		throw error;
	}
	const after = (await stack.children()).length;
	const elapsedMs = Date.now() - started;
	if (after !== before - 1) throw new Error(`child count ${before} -> ${after}, expected ${before - 1}`);
	if (elapsedMs > LIVE_BOUND_MS) throw new Error(`stack modify took ${elapsedMs}ms > ${LIVE_BOUND_MS}ms`);
	await page.screenshot({ path: join(EVIDENCE, "S5.png") });
	pass("S5 stack member modify", `normal row and child count ${before} -> ${after} in ${elapsedMs}ms <= ${LIVE_BOUND_MS}ms`);
}

async function runS6(page, family) {
	await page.reload();
	await page.waitForSelector('[role="row"]', { timeout: 60_000 });
	await page.locator(".sidebar").getByRole("button", { name: "Downloads", exact: true }).click();
	await page.locator('[role="row"]').filter({ has: page.getByText(FIXTURE_FOLDER, { exact: true }) }).dblclick();
	await rowFor(page, "selected-file.txt").waitFor({ timeout: 10_000 });
	family = await waitFor(() => {
		const current = familyForFixture(readJson(SNAPSHOT));
		return current !== undefined && current.members.length >= 2 ? current : null;
	}, { timeoutMs: 60_000, label: "clean remaining stack family for S6" });
	const stack = await openStack(page, family);
	const childNames = await stack.children();
	const member = join(FIXTURE_DIR, "quarterly-report-copy 3.txt");
	if (!existsSync(member)) throw new Error(`no fixture stack member available for S6: ${member}`);
	const oldName = member.split("/").pop() ?? member;
	const newName = `${oldName}.renamed`;
	const stamp = readJson(SNAPSHOT)?.stamps?.[member];
	if (stamp === undefined || stamp.dev === "" || stamp.ino === "") {
		throw new Error(`S6 selected member has DIRTY or missing stamp: ${JSON.stringify(stamp)}`);
	}
	const before = (await stack.children()).length;
	if (!childNames.includes(oldName)) throw new Error(`S6 selected member is not a child row: ${oldName}; children=${JSON.stringify(childNames)}`);
	const started = Date.now();
	await page.evaluate(() => {
		window.__liveSyncS6Messages = [];
		window.__liveSyncS6Unsubscribe = window.autorag.live.onMessage((message) => {
			window.__liveSyncS6Messages.push(message);
			console.info(`[QA S6 live message] ${JSON.stringify(message)}`);
		});
	});
	renameSync(member, join(FIXTURE_DIR, newName));
	await waitFor(
		async () => {
			const children = await stack.children();
			return children.includes(newName) && children.length === before;
		},
		{ timeoutMs: 2500, label: "renamed stack member to be remapped" },
	).catch(() => {
		throw new Error(`renamed child ${newName} was not present by 2500ms`);
	});
	const elapsedMs = Date.now() - started;
	if (elapsedMs > 2500) throw new Error(`stack rename took ${elapsedMs}ms > 2500ms`);
	await page.screenshot({ path: join(EVIDENCE, "S6.png") });
	pass("S6 stack member rename", `child count ${before}, renamed child ${newName}, in ${elapsedMs}ms <= 2500ms`);
	if (DUMP_DIAGNOSTICS) {
		await dumpFixtureFamily(page, "S6 +500ms");
		await dumpFixtureFamily(page, "S6 +1500ms");
		await dumpFixtureFamily(page, "S6 +2500ms");
		const s6Messages = await page.evaluate(() => window.__liveSyncS6Messages);
		appendLog(`S6 live.messages=${JSON.stringify(s6Messages)}`);
		const rawBatchLines = electronLines.filter((line) => line.includes(`[fs-watch] batch ${FIXTURE_DIR}`));
		appendLog(`S6 rawBatchLines=${JSON.stringify(rawBatchLines)}`);
	}
}

async function runS7(page) {
	await rowFor(page, "sub").dblclick();
	await page.locator(".tab--active .tab__title").waitFor({ timeout: 10_000 });
	const before = await page.evaluate(() => ({
		tab: document.querySelector(".tab--active .tab__title")?.textContent?.trim() ?? null,
		crumbs: [...document.querySelectorAll(".crumb")].map((element) => element.textContent?.trim() ?? ""),
	}));
	appendLog(`S7 before deletion: ${JSON.stringify(before)}`);
	const started = Date.now();
	rmSync(join(FIXTURE_DIR, "sub"), { recursive: true, force: true });
	try {
		await waitFor(
			async () => (await page.locator(".tab--active .tab__title").textContent())?.trim() === FIXTURE_FOLDER,
			{ timeoutMs: LIVE_BOUND_MS, label: "tab to fall back to fixture folder" },
		);
	} catch (error) {
		const afterFailure = await page.evaluate(() => ({
			tab: document.querySelector(".tab--active .tab__title")?.textContent?.trim() ?? null,
			crumbs: [...document.querySelectorAll(".crumb")].map((element) => element.textContent?.trim() ?? ""),
		}));
		appendLog(`S7 after deletion (failure): ${JSON.stringify(afterFailure)}`);
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}; product defect: ipcRenderer.invoke strips ENOENT code, bridge exists() rethrows, ancestor fallback does not run`,
		);
	}
	if (await page.locator(".toast").count()) {
		throw new Error("toast/status element visible after folder fallback");
	}
	const after = await page.evaluate(() => ({
		tab: document.querySelector(".tab--active .tab__title")?.textContent?.trim() ?? null,
		crumbs: [...document.querySelectorAll(".crumb")].map((element) => element.textContent?.trim() ?? ""),
	}));
	appendLog(`S7 after deletion: ${JSON.stringify(after)}`);
	const elapsedMs = Date.now() - started;
	if (elapsedMs > LIVE_BOUND_MS) throw new Error(`folder fallback took ${elapsedMs}ms > ${LIVE_BOUND_MS}ms`);
	await page.screenshot({ path: join(EVIDENCE, "S7.png") });
	pass("S7 folder gone", `active tab ${FIXTURE_FOLDER}, no toast, in ${elapsedMs}ms <= ${LIVE_BOUND_MS}ms`);
}

async function runS8(page) {
	await page.getByRole("button", { name: "Documents" }).click();
	await waitForElectronLine(
		(line) => line.includes(`[fs-watch] unwatch ${FIXTURE_DIR}`),
		{ timeoutMs: LIVE_BOUND_MS, label: "fixture directory unwatch diagnostic" },
	);
	const errors = electronLines.filter((line) => line.includes("[fs-watch]") && line.includes("Error"));
	if (errors.length !== 0) throw new Error(`fs-watch errors: ${JSON.stringify(errors)}`);
	const last = electronLines.find((line) => line.includes(`[fs-watch] unwatch ${FIXTURE_DIR}`));
	pass("S8 no leak", `unwatch observed=${JSON.stringify(last)}; fs-watch Error count ${errors.length}`);
}

async function runS9(page, family) {
	family = familyForFixture(readJson(SNAPSHOT)) ?? family;
	await page.locator(".sidebar").getByRole("button", { name: "Downloads", exact: true }).click();
	await rowFor(page, FIXTURE_FOLDER).dblclick();
	await rowFor(page, "selected-file.txt").waitFor({ timeout: 10_000 });
	await page.getByRole("button", { name: "New tab ⌘T" }).click();
	await page.getByRole("button", { name: "Documents" }).click();
	const started = Date.now();
	writeFileSync(join(FIXTURE_DIR, "late.txt"), "inactive tab fixture\n", "utf8");
	await page.locator(".tab__title").filter({ hasText: FIXTURE_FOLDER }).click();
	await rowFor(page, "late.txt").waitFor({ timeout: LIVE_BOUND_MS });
	const inactiveMs = Date.now() - started;
	if (inactiveMs > LIVE_BOUND_MS) throw new Error(`inactive tab refresh took ${inactiveMs}ms > ${LIVE_BOUND_MS}ms`);
	const beforeNames = readdirSync(FIXTURE_DIR).filter((name) => !name.startsWith("."));
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await waitForElectronLine(
		(line) => line.includes("[live] layers requested"),
		{ timeoutMs: LIVE_BOUND_MS, label: "focus layer resync diagnostic" },
	);
	const currentFamily = familyForFixture(readJson(SNAPSHOT)) ?? family;
	appendLog(`S9 current family=${JSON.stringify(currentFamily)}`);
	await waitFor(
		async () => (await rowFor(page, currentFamily.head.split("/").pop() ?? currentFamily.head).locator(".row__stackbadge").count()) === 1,
		{ timeoutMs: 10_000, label: "S9 current stack badge" },
	);
	const stackForListing = await openStack(page, currentFamily);
	const renderedNames = await page.locator('[role="row"] .row__label').allInnerTexts();
	const externalChildNames = currentFamily.members
		.map((member) => member.path)
		.filter((memberPath) => dirname(memberPath) !== FIXTURE_DIR)
		.map((memberPath) => memberPath.split("/").pop())
		.filter((name) => name !== undefined);
	const expectedNames = [...new Set([...beforeNames, ...externalChildNames])];
	if (JSON.stringify([...new Set(renderedNames)].sort()) !== JSON.stringify([...expectedNames].sort())) {
		throw new Error(`focus listing mismatch: rendered=${JSON.stringify(renderedNames)} disk=${JSON.stringify(expectedNames)}`);
	}
	const otherCopy = join(OTHER_DIR, "quarterly-report.txt");
	const stack = stackForListing;
	const beforeChildren = await stack.children();
	const startedResync = Date.now();
	rmSync(otherCopy, { force: true });
	const removedAt = Date.now();
	if (existsSync(otherCopy)) throw new Error(`unwatched copy still exists after rmSync: ${otherCopy}`);
	const focusLineStart = electronLines.length;
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	const focusAt = Date.now();
	const focusLine = await waitFor(
		() => electronEvents.slice(focusLineStart).find((event) => event.text.includes("[live] layers requested")),
		{ timeoutMs: LIVE_BOUND_MS, label: "focus resync diagnostic after copy deletion" },
	);
	appendLog(`S9 resync timing: removedAt=${removedAt} focusAt=${focusAt} liveRequestedAt=${focusLine.timestampMs}`);
	await waitFor(
		async () => (await stack.children()).length === beforeChildren.length - 1,
		{ timeoutMs: LIVE_BOUND_MS, label: "focus resync to decrement stack child count" },
	);
	const afterChildren = await stack.children();
	const resyncMs = Date.now() - startedResync;
	if (afterChildren.length !== beforeChildren.length - 1) {
		throw new Error(`unwatched stack child count ${beforeChildren.length} -> ${afterChildren.length}`);
	}
	if (resyncMs > LIVE_BOUND_MS) throw new Error(`focus stack resync took ${resyncMs}ms > ${LIVE_BOUND_MS}ms`);
	pass("S9 inactive and focus resync", `inactive ${inactiveMs}ms, stack ${beforeChildren.length} -> ${afterChildren.length} in ${resyncMs}ms`);
}

async function runS10(page) {
	const bulkDir = join(FIXTURE_DIR, "bulk");
	mkdirSync(bulkDir, { recursive: true });
	for (let index = 0; index < 5000; index += 1) {
		writeFileSync(join(bulkDir, `bulk-${String(index).padStart(4, "0")}.txt`), "");
	}
	await page.locator(".sidebar").getByRole("button", { name: "Downloads", exact: true }).click();
	await page.locator('[role="row"]').filter({ has: page.getByText(FIXTURE_FOLDER, { exact: true }) }).dblclick();
	await rowFor(page, "bulk").waitFor({ timeout: 30_000 });
	await rowFor(page, "bulk").dblclick();
	await rowFor(page, "bulk-0000.txt").waitFor({ timeout: 60_000 });
	const grid = page.locator('[role="grid"]');
	await grid.evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	const writeStarted = Date.now();
	writeFileSync(join(bulkDir, "zz-live.txt"), "scale fixture\n", "utf8");
	const batchEvent = await waitForElectronLine(
		(line) => line.includes(`[fs-watch] batch ${bulkDir}`),
		{ timeoutMs: LIVE_BOUND_MS, label: "bulk fs-watch batch" },
	);
	const batchAt = electronEvents.findLast((event) => event.text === batchEvent && event.timestampMs >= writeStarted)?.timestampMs ?? Date.now();
	const directListMs = await page.evaluate(async (path) => {
		const started = performance.now();
		await window.autorag.fs.listDir(path);
		return Math.round(performance.now() - started);
	}, bulkDir);
	const row = rowFor(page, "zz-live.txt");
	try {
		await row.scrollIntoViewIfNeeded();
		await row.waitFor({ state: "visible", timeout: LIVE_BOUND_MS });
	} catch (error) {
		const rowVisibleAt = Date.now();
		appendLog(`S10 timing: write=${writeStarted} batch=${batchAt} row=${rowVisibleAt} directListMs=${directListMs}`);
		throw new Error(`${error instanceof Error ? error.message : String(error)}; batchDelta=${batchAt - writeStarted}ms; directListMs=${directListMs}`);
	}
	const rowVisibleAt = Date.now();
	const elapsedMs = rowVisibleAt - writeStarted;
	const errors = electronLines.filter((line) => line.includes("[fs-watch]") && line.includes("Error"));
	appendLog(`S10 timing: write=${writeStarted} batch=${batchAt} row=${rowVisibleAt} directListMs=${directListMs}`);
	if (elapsedMs > LIVE_BOUND_MS) throw new Error(`bulk live create took ${elapsedMs}ms > ${LIVE_BOUND_MS}ms; batchDelta=${batchAt - writeStarted}ms; directListMs=${directListMs}`);
	if (errors.length !== 0) throw new Error(`fs-watch errors during bulk: ${JSON.stringify(errors)}; directListMs=${directListMs}`);
	if (directListMs > LIVE_BOUND_MS) {
		throw new Error(`product performance: direct fs.list(${bulkDir}) took ${directListMs}ms > ${LIVE_BOUND_MS}ms`);
	}
	pass("S10 scale", `zz-live.txt visible in ${elapsedMs}ms <= ${LIVE_BOUND_MS}ms; batchDelta=${batchAt - writeStarted}ms directListMs=${directListMs}`);
}

async function runS11(page) {
	const scrollState = async (setMiddle) => page.evaluate((middle) => {
		const row = document.querySelector('[role="row"]');
		let element = row?.parentElement ?? null;
		while (element !== null) {
			if (element.scrollHeight > element.clientHeight) {
				if (middle) element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
				return {
					className: element.className,
					scrollTop: element.scrollTop,
					scrollHeight: element.scrollHeight,
					clientHeight: element.clientHeight,
				};
			}
			element = element.parentElement;
		}
		return null;
	}, setMiddle);
	const beforeState = await scrollState(true);
	if (beforeState === null || beforeState.scrollTop <= 0) {
		throw new Error(`real scroll container did not reach middle: ${JSON.stringify(beforeState)}`);
	}
	const before = beforeState.scrollTop;
	const writeStarted = Date.now();
	writeFileSync(join(FIXTURE_DIR, "bulk", "scroll-live.txt"), "scroll fixture\n", "utf8");
	const batchEvent = await waitForElectronLine(
		(line) => line.includes(`[fs-watch] batch ${join(FIXTURE_DIR, "bulk")}`),
		{ timeoutMs: LIVE_BOUND_MS, label: "scroll fs-watch batch" },
	);
	const batchAt = electronEvents.findLast((event) => event.text === batchEvent && event.timestampMs >= writeStarted)?.timestampMs ?? Date.now();
	const row = rowFor(page, "scroll-live.txt");
	await waitFor(
		async () => (await row.count()) === 1,
		{ timeoutMs: LIVE_BOUND_MS, label: "scroll-live.txt row to be listed" },
	);
	const afterState = await scrollState(false);
	const after = afterState?.scrollTop ?? 0;
	const delta = Math.abs(after - before);
	const rowVisibleAt = Date.now();
	const elapsedMs = rowVisibleAt - writeStarted;
	appendLog(`S11 timing: write=${writeStarted} batch=${batchAt} row=${rowVisibleAt}`);
	if (delta > 32) throw new Error(`scrollTop changed ${delta}px, expected <= 32px`);
	if (elapsedMs > LIVE_BOUND_MS) throw new Error(`scroll-preserving create took ${elapsedMs}ms > ${LIVE_BOUND_MS}ms; batchDelta=${batchAt - writeStarted}ms; scrollDelta=${delta}px`);
	appendLog(`S11 timing: write=${writeStarted} batch=${batchAt} row=${rowVisibleAt}`);
	pass("S11 scroll kept", `scrollTop ${before} -> ${after} (delta ${delta}px) in ${elapsedMs}ms; batchDelta=${batchAt - writeStarted}ms`);
}

async function runNegativeControl() {
	const started = Date.now();
	const target = join(UNWATCHED_DIR, "unwatched.txt");
	writeFileSync(target, "negative control\n", "utf8");
	try {
		await waitFor(
			() => electronLines.find((line) => line.includes(`[fs-watch] batch ${UNWATCHED_DIR}`)),
			{ timeoutMs: LIVE_BOUND_MS, label: "unexpected unwatched batch diagnostic", stepMs: 50 },
		);
		throw new Error("unwatched directory emitted a fs-watch batch");
	} catch (error) {
		if (!(error instanceof Error) || !error.message.startsWith("timed out waiting for unexpected unwatched batch diagnostic")) {
			throw error;
		}
	}
	const lines = electronLines.filter((line) => line.includes(UNWATCHED_DIR));
	appendTo(UNWATCHED_LOG, `window=${LIVE_BOUND_MS}ms elapsed=${Date.now() - started}ms matchingLines=${JSON.stringify(lines)}`);
	pass("negative control", `unwatched batch line count ${lines.length} after ${Date.now() - started}ms`);
}

async function main() {
	overallTimer = setTimeout(() => {
		appendLog(`FAIL overall timeout: exceeded ${OVERALL_TIMEOUT_MS}ms`);
		exitCode = 1;
		void closeApp().finally(() => process.exit(exitCode));
	}, OVERALL_TIMEOUT_MS);
	let page = await startSession("A");
	await runScenario("S1", page, () => runS1(page));
	await runScenario("S2", page, () => runS2(page));
	await runScenario("S3", page, () => runS3(page));
	await runScenario("S7", page, () => runS7(page));
	await runScenario("S8", page, () => runS8(page), false);
	await runScenario("S10", page, () => runS10(page));
	await runScenario("S11", page, () => runS11(page));
	await runScenario("negative", page, runNegativeControl, false);
	await finishSession();

	page = await startSession("B");
	const familyB = await waitFor(() => familyForFixture(readJson(SNAPSHOT)), { timeoutMs: 420_000, label: "S4 startup family" });
	await page.locator(".sidebar").getByRole("button", { name: "Downloads", exact: true }).click();
	await page.locator('[role="row"]').filter({ has: page.getByText(FIXTURE_FOLDER, { exact: true }) }).dblclick();
	await rowFor(page, "selected-file.txt").waitFor({ timeout: 10_000 });
	await runScenario("S4", page, () => runS4(page, familyB));
	await finishSession();

	page = await startSession("C");
	const familyC = await waitFor(() => familyForFixture(readJson(SNAPSHOT)), { timeoutMs: 420_000, label: "S5 startup family" });
	await page.locator(".sidebar").getByRole("button", { name: "Downloads", exact: true }).click();
	await page.locator('[role="row"]').filter({ has: page.getByText(FIXTURE_FOLDER, { exact: true }) }).dblclick();
	await rowFor(page, "selected-file.txt").waitFor({ timeout: 10_000 });
	await runScenario("S5", page, () => runS5(page, familyC));
	await finishSession();

	page = await startSession("D");
	const familyD = await waitFor(() => familyForFixture(readJson(SNAPSHOT)), { timeoutMs: 420_000, label: "S6 startup family" });
	await page.locator(".sidebar").getByRole("button", { name: "Downloads", exact: true }).click();
	await page.locator('[role="row"]').filter({ has: page.getByText(FIXTURE_FOLDER, { exact: true }) }).dblclick();
	await rowFor(page, "selected-file.txt").waitFor({ timeout: 10_000 });
	await runScenario("S6", page, () => runS6(page, familyD));
	await finishSession();

	page = await startSession("E");
	const familyE = await waitFor(() => familyForFixture(readJson(SNAPSHOT)), { timeoutMs: 420_000, label: "S9 startup family" });
	await page.locator(".sidebar").getByRole("button", { name: "Downloads", exact: true }).click();
	await page.locator('[role="row"]').filter({ has: page.getByText(FIXTURE_FOLDER, { exact: true }) }).dblclick();
	await rowFor(page, "selected-file.txt").waitFor({ timeout: 10_000 });
	await runScenario("S9", page, () => runS9(page, familyE));
	await finishSession();
}

try {
	await main();
} catch (error) {
	fail("runner", error instanceof Error ? error.message : String(error));
	await closeApp();
} finally {
	if (overallTimer !== null) clearTimeout(overallTimer);
	appendLog(exitCode === 0 ? "RESULT PASS" : "RESULT FAIL");
	process.exitCode = exitCode;
}
