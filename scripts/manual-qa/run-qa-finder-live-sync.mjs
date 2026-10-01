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
	} catch (error) {
		process.stderr.write(`[qa] run.log append failed: ${error instanceof Error ? error.message : String(error)}\n`);
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
	} catch (error) {
		process.stderr.write(`[qa] run.log append failed: ${error instanceof Error ? error.message : String(error)}\n`);
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
	electronLines = [];
	electronEvents = [];
	electronBuffer = "";
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
	} catch (error) {
		if (error instanceof SyntaxError) {
			return null;
		}
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return null;
		}
		throw error;
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

async function installLiveRefreshProbe(page, label) {
	const initialToastCount = await page.locator(".toast").count();
	if (initialToastCount !== 0) {
		throw new Error(`${label} started with ${initialToastCount} toast element(s)`);
	}
	await page.evaluate((probeLabel) => {
		const grid = document.querySelector('[role="grid"]');
		if (grid === null) {
			throw new Error('live refresh probe could not find [role="grid"]');
		}
		const state = {
			initialRowCount: grid.querySelectorAll('[role="row"]').length,
			minRowCount: Number.POSITIVE_INFINITY,
			emptyFlashCount: 0,
			toastSeen: false,
			samples: 0,
		};
		const sample = () => {
			const rowCount = grid.querySelectorAll('[role="row"]').length;
			const toastCount = document.querySelectorAll(".toast").length;
			state.minRowCount = Math.min(state.minRowCount, rowCount);
			state.emptyFlashCount += rowCount === 0 ? 1 : 0;
			state.toastSeen ||= toastCount > 0;
			state.samples += 1;
		};
		sample();
		const observer = new MutationObserver(sample);
		observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
		window.__liveSyncRefreshProbes ??= {};
		window.__liveSyncRefreshProbes[probeLabel] = { state, observer };
	}, label);
}

async function finishLiveRefreshProbe(page, label, observationDeadlineMs) {
	if (observationDeadlineMs !== undefined) {
		const remainingMs = observationDeadlineMs - Date.now();
		if (remainingMs > 0) {
			await waitFor(
				() => Date.now() >= observationDeadlineMs,
				{ timeoutMs: remainingMs + 100, label: `${label} full observation window` },
			);
		}
	}
	return page.evaluate((probeLabel) => {
		const probe = window.__liveSyncRefreshProbes?.[probeLabel];
		if (probe === undefined) {
			throw new Error(`live refresh probe ${probeLabel} was not installed`);
		}
		probe.observer.disconnect();
		delete window.__liveSyncRefreshProbes[probeLabel];
		return probe.state;
	}, label);
}

async function installS14ListCallRecorder() {
	return app.evaluate(({ BrowserWindow, ipcMain }) => {
		globalThis.__qaListCalls = [];
		const invokeHandlers = ipcMain?._invokeHandlers;
		if (invokeHandlers instanceof Map) {
			const original = invokeHandlers.get("fs:listDir");
			if (typeof original !== "function") {
				throw new Error("ipcMain._invokeHandlers has no fs:listDir handler");
			}
			const wrapped = (...args) => {
				const path = args[1];
				if (typeof path === "string") {
					globalThis.__qaListCalls.push({ path, timestampMs: Date.now() });
				}
				return original(...args);
			};
			invokeHandlers.set("fs:listDir", wrapped);
			globalThis.__qaS14Hook = { kind: "ipcMain._invokeHandlers", original };
			return "ipcMain._invokeHandlers";
		}
		const window = BrowserWindow.getAllWindows()[0];
		if (window === undefined) {
			throw new Error("no BrowserWindow available for S14 fallback hook");
		}
		const listener = (_event, channel, ...args) => {
			const path = args[0];
			if (channel === "fs:listDir" && typeof path === "string") {
				globalThis.__qaListCalls.push({ path, timestampMs: Date.now() });
			}
		};
		window.webContents.on("ipc-message", listener);
		globalThis.__qaS14Hook = { kind: "webContents.on('ipc-message')", listener, webContents: window.webContents };
		return "webContents.on('ipc-message')";
	});
}

async function removeS14ListCallRecorder() {
	if (app === null) return;
	await app.evaluate(({ ipcMain }) => {
		const hook = globalThis.__qaS14Hook;
		if (hook?.kind === "ipcMain._invokeHandlers") {
			const invokeHandlers = ipcMain?._invokeHandlers;
			if (invokeHandlers instanceof Map) {
				invokeHandlers.set("fs:listDir", hook.original);
			}
		} else if (hook?.kind === "webContents.on('ipc-message')") {
			hook.webContents.removeListener("ipc-message", hook.listener);
		}
		delete globalThis.__qaS14Hook;
		delete globalThis.__qaListCalls;
	});
}

async function readS14ListCalls() {
	return app.evaluate(() => globalThis.__qaListCalls ?? []);
}

async function activeTabPath(page) {
	return page.evaluate(() => ({
		title: document.querySelector(".tab--active .tab__title")?.textContent?.trim() ?? null,
		crumbs: [...document.querySelectorAll(".crumb")].map((element) => element.textContent?.trim() ?? ""),
	}));
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
	await installLiveRefreshProbe(page, "S1");
	const started = Date.now();
	writeFileSync(join(FIXTURE_DIR, "new-note.txt"), "created by live-sync S1\n", "utf8");
	await rowFor(page, "new-note.txt").waitFor({ timeout: LIVE_BOUND_MS });
	const elapsedMs = Date.now() - started;
	if (elapsedMs > LIVE_BOUND_MS) throw new Error(`row appeared after ${elapsedMs}ms > ${LIVE_BOUND_MS}ms`);
	const probe = await finishLiveRefreshProbe(page, "S1", started + LIVE_BOUND_MS);
	if (probe.emptyFlashCount !== 0) throw new Error(`S1 empty-list flash count ${probe.emptyFlashCount} > 0`);
	if (probe.toastSeen) throw new Error("S1 live refresh showed a toast");
	await page.screenshot({ path: join(EVIDENCE, "S1.png") });
	pass(
		"S1 create",
		`new-note.txt visible in ${elapsedMs}ms <= ${LIVE_BOUND_MS}ms; minRows=${probe.minRowCount} >= 1; emptyFlashCount=${probe.emptyFlashCount} <= 0; toastSeen=${probe.toastSeen ? 1 : 0} <= 0; observedWindow=${LIVE_BOUND_MS}ms`,
	);
}

async function runS2(page) {
	await installLiveRefreshProbe(page, "S2");
	const started = Date.now();
	rmSync(join(FIXTURE_DIR, "new-note.txt"), { force: true });
	await waitFor(
		async () => (await rowFor(page, "new-note.txt").count()) === 0,
		{ timeoutMs: LIVE_BOUND_MS, label: "new-note.txt row to disappear" },
	);
	const elapsedMs = Date.now() - started;
	if (elapsedMs > LIVE_BOUND_MS) throw new Error(`row disappeared after ${elapsedMs}ms > ${LIVE_BOUND_MS}ms`);
	const probe = await finishLiveRefreshProbe(page, "S2", started + LIVE_BOUND_MS);
	if (probe.emptyFlashCount !== 0) throw new Error(`S2 empty-list flash count ${probe.emptyFlashCount} > 0`);
	if (probe.toastSeen) throw new Error("S2 live refresh showed a toast");
	await page.screenshot({ path: join(EVIDENCE, "S2.png") });
	pass(
		"S2 delete",
		`new-note.txt row count 0 in ${elapsedMs}ms <= ${LIVE_BOUND_MS}ms; minRows=${probe.minRowCount} >= 1; emptyFlashCount=${probe.emptyFlashCount} <= 0; toastSeen=${probe.toastSeen ? 1 : 0} <= 0; observedWindow=${LIVE_BOUND_MS}ms`,
	);
}

async function runS3(page) {
	await rowFor(page, "selected-file.txt").click();
	const selectedBefore = await page.locator('[role="row"][aria-selected="true"]').allInnerTexts();
	await installLiveRefreshProbe(page, "S3");
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
	const probe = await finishLiveRefreshProbe(page, "S3", started + LIVE_BOUND_MS);
	if (probe.emptyFlashCount !== 0) throw new Error(`S3 empty-list flash count ${probe.emptyFlashCount} > 0`);
	if (probe.toastSeen) throw new Error("S3 live refresh showed a toast");
	await page.screenshot({ path: join(EVIDENCE, "S3.png") });
	pass(
		"S3 rename",
		`new row present, old row count 0, selection unchanged in ${elapsedMs}ms <= ${LIVE_BOUND_MS}ms; minRows=${probe.minRowCount} >= 1; emptyFlashCount=${probe.emptyFlashCount} <= 0; toastSeen=${probe.toastSeen ? 1 : 0} <= 0; observedWindow=${LIVE_BOUND_MS}ms`,
	);
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
	const toastCount = await page.locator(".toast").count();
	if (toastCount !== 0) {
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
	pass("S7 folder gone", `active tab ${FIXTURE_FOLDER}, toastCount=${toastCount} <= 0, in ${elapsedMs}ms <= ${LIVE_BOUND_MS}ms`);
}

async function runS8(page) {
	const started = Date.now();
	await page.getByRole("button", { name: "Documents" }).click();
	await waitForElectronLine(
		(line) => line.includes(`[fs-watch] unwatch ${FIXTURE_DIR}`),
		{ timeoutMs: LIVE_BOUND_MS, label: "fixture directory unwatch diagnostic" },
	);
	const errors = electronLines.filter((line) => line.includes("[fs-watch]") && line.includes("Error"));
	if (errors.length !== 0) throw new Error(`fs-watch errors: ${JSON.stringify(errors)}`);
	const last = electronLines.find((line) => line.includes(`[fs-watch] unwatch ${FIXTURE_DIR}`));
	const elapsedMs = Date.now() - started;
	if (elapsedMs > LIVE_BOUND_MS) throw new Error(`unwatch took ${elapsedMs}ms > ${LIVE_BOUND_MS}ms`);
	pass("S8 no leak", `unwatch observed=${JSON.stringify(last)} in ${elapsedMs}ms <= ${LIVE_BOUND_MS}ms; fs-watch Error count ${errors.length} <= 0`);
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
	pass(
		"S9 inactive and focus resync",
		`inactive refresh ${inactiveMs}ms <= ${LIVE_BOUND_MS}ms; stack ${beforeChildren.length} -> ${afterChildren.length} in ${resyncMs}ms <= ${LIVE_BOUND_MS}ms`,
	);
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
	const row = rowFor(page, "zz-live.txt");
	try {
		await row.scrollIntoViewIfNeeded();
		await row.waitFor({ state: "visible", timeout: LIVE_BOUND_MS });
		const rowVisibleAt = Date.now();
		const elapsedMs = rowVisibleAt - writeStarted;
		const directListMs = await page.evaluate(async (path) => {
			const started = performance.now();
			await window.autorag.fs.listDir(path);
			return Math.round(performance.now() - started);
		}, bulkDir);
		const errors = electronLines.filter((line) => line.includes("[fs-watch]") && line.includes("Error"));
		appendLog(`S10 timing: write=${writeStarted} batch=${batchAt} row=${rowVisibleAt} directListMs=${directListMs}`);
		if (elapsedMs > LIVE_BOUND_MS) throw new Error(`bulk live create took ${elapsedMs}ms > ${LIVE_BOUND_MS}ms; batchDelta=${batchAt - writeStarted}ms; directListMs=${directListMs}`);
		if (errors.length !== 0) throw new Error(`fs-watch errors during bulk: ${JSON.stringify(errors)}; directListMs=${directListMs}`);
		if (directListMs > LIVE_BOUND_MS) {
			throw new Error(`product performance: direct fs.list(${bulkDir}) took ${directListMs}ms > ${LIVE_BOUND_MS}ms`);
		}
		pass(
			"S10 scale",
			`zz-live.txt visible in ${elapsedMs}ms <= ${LIVE_BOUND_MS}ms; batchDelta=${batchAt - writeStarted}ms <= ${LIVE_BOUND_MS}ms; directListMs=${directListMs}ms <= ${LIVE_BOUND_MS}ms`,
		);
	} catch (error) {
		const rowVisibleAt = Date.now();
		const elapsedMs = rowVisibleAt - writeStarted;
		const directListMs = await page.evaluate(async (path) => {
			const started = performance.now();
			await window.autorag.fs.listDir(path);
			return Math.round(performance.now() - started);
		}, bulkDir);
		appendLog(`S10 timing: write=${writeStarted} batch=${batchAt} row=${rowVisibleAt} directListMs=${directListMs}`);
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}; elapsedMs=${elapsedMs}ms; batchDelta=${batchAt - writeStarted}ms; directListMs=${directListMs}`,
		);
	}
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
	pass(
		"S11 scroll kept",
		`scrollTop ${before} -> ${after} (delta ${delta}px) <= 32px in ${elapsedMs}ms <= ${LIVE_BOUND_MS}ms; batchDelta=${batchAt - writeStarted}ms <= ${LIVE_BOUND_MS}ms`,
	);
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
	const elapsedMs = Date.now() - started;
	appendTo(UNWATCHED_LOG, `window=${LIVE_BOUND_MS}ms elapsed=${elapsedMs}ms matchingLines=${JSON.stringify(lines)}`);
	pass(
		"negative control",
		`unwatched batch line count ${lines.length} <= 0 within configured ${LIVE_BOUND_MS}ms window; polling settled at ${elapsedMs}ms`,
	);
}

async function runS12(page) {
	await page.locator(".sidebar").getByRole("button", { name: "Downloads", exact: true }).click();
	await page.locator('[role="row"]').filter({ has: page.getByText(FIXTURE_FOLDER, { exact: true }) }).dblclick();
	await rowFor(page, "selected-file.txt").waitFor({ timeout: 10_000 });
	const renameTarget = join(FIXTURE_DIR, "rename-before.txt");
	await rowFor(page, "rename-before.txt").click({ button: "right" });
	await page.getByRole("menuitem", { name: "이름 변경", exact: true }).click();
	const renameInput = page.getByRole("textbox", { name: "새 이름", exact: true });
	await renameInput.waitFor({ state: "visible", timeout: 10_000 });
	const createdDuringRename = join(FIXTURE_DIR, "created-during-rename.txt");
	const createStarted = Date.now();
	writeFileSync(createdDuringRename, "created while rename editor is open\n", "utf8");
	await rowFor(page, "created-during-rename.txt").waitFor({ timeout: LIVE_BOUND_MS });
	const createElapsedMs = Date.now() - createStarted;
	if (createElapsedMs > LIVE_BOUND_MS) throw new Error(`unrelated create took ${createElapsedMs}ms > ${LIVE_BOUND_MS}ms`);
	const editorAfterCreateCount = await page.locator('input.row__rename[aria-label="새 이름"]').count();
	if (editorAfterCreateCount !== 1) {
		throw new Error("rename editor closed after an unrelated file was created");
	}
	const deleteStarted = Date.now();
	rmSync(renameTarget, { force: true });
	await waitFor(
		async () => (await page.locator('input.row__rename[aria-label="새 이름"]').count()) === 0,
		{ timeoutMs: LIVE_BOUND_MS, label: "rename editor to close after its file vanished" },
	);
	const deleteElapsedMs = Date.now() - deleteStarted;
	if (deleteElapsedMs > LIVE_BOUND_MS) throw new Error(`rename editor close took ${deleteElapsedMs}ms > ${LIVE_BOUND_MS}ms`);
	const editorAfterDeleteCount = await page.locator('input.row__rename[aria-label="새 이름"]').count();
	await page.screenshot({ path: join(EVIDENCE, "S12.png") });
	pass(
		"S12 rename editor lifecycle",
		`editorAfterCreate=${editorAfterCreateCount} >= 1 in ${createElapsedMs}ms <= ${LIVE_BOUND_MS}ms; editorAfterDelete=${editorAfterDeleteCount} <= 0 in ${deleteElapsedMs}ms <= ${LIVE_BOUND_MS}ms`,
	);
}

async function runS13(page) {
	await page.locator(".sidebar").getByRole("button", { name: "Downloads", exact: true }).click();
	await page.locator('[role="row"]').filter({ has: page.getByText(FIXTURE_FOLDER, { exact: true }) }).dblclick();
	await rowFor(page, "selected-file.txt").waitFor({ timeout: 10_000 });
	await page.getByRole("button", { name: "New tab ⌘T", exact: true }).click();
	const watchStarted = Date.now();
	await rowFor(page, "sub").dblclick();
	await page.locator(".tab--active .tab__title").filter({ hasText: "sub" }).waitFor({ timeout: 10_000 });
	await waitForElectronLine(
		(line) => line.includes(`[fs-watch] watch ${join(FIXTURE_DIR, "sub")}`),
		{ timeoutMs: LIVE_BOUND_MS, label: "subfolder watch diagnostic" },
	);
	const watchElapsedMs = Date.now() - watchStarted;
	if (watchElapsedMs > LIVE_BOUND_MS) throw new Error(`subfolder watch took ${watchElapsedMs}ms > ${LIVE_BOUND_MS}ms`);
	const closeStarted = Date.now();
	await page.locator(".tab--active .tab__close[aria-label='Close tab ⌘W']").click();
	await waitForElectronLine(
		(line) => line.includes(`[fs-watch] unwatch ${join(FIXTURE_DIR, "sub")}`),
		{ timeoutMs: LIVE_BOUND_MS, label: "subfolder unwatch diagnostic after close" },
	);
	const closeElapsedMs = Date.now() - closeStarted;
	if (closeElapsedMs > LIVE_BOUND_MS) throw new Error(`subfolder unwatch took ${closeElapsedMs}ms > ${LIVE_BOUND_MS}ms`);
	await page.screenshot({ path: join(EVIDENCE, "S13.png") });
	pass(
		"S13 close tab unwatch",
		`subfolder watch observed in ${watchElapsedMs}ms <= ${LIVE_BOUND_MS}ms; close-tab unwatch observed in ${closeElapsedMs}ms <= ${LIVE_BOUND_MS}ms`,
	);
}

async function runS14(page) {
	await page.locator(".sidebar").getByRole("button", { name: "Downloads", exact: true }).click();
	await page.locator('[role="row"]').filter({ has: page.getByText(FIXTURE_FOLDER, { exact: true }) }).dblclick();
	await rowFor(page, "selected-file.txt").waitFor({ timeout: 10_000 });
	const tabPathBefore = await activeTabPath(page);
	const rowsBefore = await page.locator('[role="row"]').count();
	if (rowsBefore < 1) throw new Error(`S14 requires an initial non-empty listing, got ${rowsBefore} rows`);

	const hookKind = await installS14ListCallRecorder();
	appendLog(`INFO S14 list-call hook=${hookKind}`);
	await installLiveRefreshProbe(page, "S14");
	const seq = (await page.evaluate(async () => (await window.autorag.live.layers()).seq)) + 1;
	const sentAt = await app.evaluate(({ BrowserWindow }, payload) => {
		const window = BrowserWindow.getAllWindows()[0];
		if (window === undefined) {
			throw new Error("no BrowserWindow available for S14 live message");
		}
		const timestampMs = Date.now();
		window.webContents.send("live:message", {
			seq: payload.seq,
			dirs: [{ dir: payload.fixtureDir, changes: [], overflow: true, dirGone: false }],
			layers: [],
			reconciled: ["dupey"],
		});
		return timestampMs;
	}, { fixtureDir: FIXTURE_DIR, seq });
	let probe = null;
	try {
		const listCall = await waitFor(
			async () => (await readS14ListCalls()).find((call) => call.path === FIXTURE_DIR && call.timestampMs >= sentAt),
			{ timeoutMs: LIVE_BOUND_MS, label: "S14 fixture fs:listDir call" },
		);
		const listCallDelayMs = listCall.timestampMs - sentAt;
		if (listCallDelayMs > LIVE_BOUND_MS) {
			throw new Error(`S14 fixture fs:listDir call took ${listCallDelayMs}ms > ${LIVE_BOUND_MS}ms`);
		}
		await waitFor(
			async () => (await page.locator('[role="row"]').count()) >= 1,
			{ timeoutMs: LIVE_BOUND_MS, label: "S14 rows to remain rendered" },
		);
		probe = await finishLiveRefreshProbe(page, "S14", sentAt + LIVE_BOUND_MS);
		const toastCount = await page.locator(".toast").count();
		const rowsAfter = await page.locator('[role="row"]').count();
		const tabPathAfter = await activeTabPath(page);
		const tabPathUnchanged = JSON.stringify(tabPathAfter) === JSON.stringify(tabPathBefore);
		appendLog(`S14 details: sentAt=${sentAt} listCall=${listCall.timestampMs} listCallDelay=${listCallDelayMs} rowsAfter=${rowsAfter} tabPathBefore=${JSON.stringify(tabPathBefore)} tabPathAfter=${JSON.stringify(tabPathAfter)}`);
		if (probe.minRowCount < 1) throw new Error(`S14 minRows ${probe.minRowCount} < 1`);
		if (probe.emptyFlashCount !== 0) throw new Error(`S14 empty-list flash count ${probe.emptyFlashCount} > 0`);
		if (probe.toastSeen) throw new Error("S14 live refresh showed a toast");
		if (toastCount !== 0) throw new Error(`S14 toastCount ${toastCount} > 0`);
		if (!tabPathUnchanged) throw new Error(`S14 tab path changed: before=${JSON.stringify(tabPathBefore)} after=${JSON.stringify(tabPathAfter)}`);
		await page.screenshot({ path: join(EVIDENCE, "S14.png") });
		pass(
			"S14 overflow relist",
			`listCallDelay=${listCallDelayMs}ms <= ${LIVE_BOUND_MS}ms; minRows=${probe.minRowCount} >= 1; emptyFlashCount=${probe.emptyFlashCount} <= 0; toastCount=${toastCount} == 0; tabPathUnchanged=${tabPathUnchanged}`,
		);
	} finally {
		if (probe === null) {
			try {
				await finishLiveRefreshProbe(page, "S14");
			} catch (error) {
				appendLog(`INFO S14 probe cleanup: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		await removeS14ListCallRecorder();
	}
}

async function main() {
	overallTimer = setTimeout(() => {
		appendLog(`FAIL overall timeout: exceeded ${OVERALL_TIMEOUT_MS}ms`);
		exitCode = 1;
		void closeApp().finally(() => process.exit(exitCode));
	}, OVERALL_TIMEOUT_MS);
	appendLog("INFO IS-9 overflow real-surface injection: S14 sends live:message overflow and records fs:listDir relist");
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

	page = await startSession("F");
	await runScenario("S12", page, () => runS12(page));
	await finishSession();

	page = await startSession("G");
	await runScenario("S13", page, () => runS13(page));
	await finishSession();

	page = await startSession("H");
	await runScenario("S14", page, () => runS14(page));
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
