/**
 * Manual QA: the in-app right-click → Services submenu (macOS).
 *
 * Right-clicking a row must offer what Finder's own right-click → Services
 * offers for those files — Keka, a Terminal "New Terminal at Folder", Quick
 * Actions — and a click must perform the service on the selection, with the
 * paths intact. Proven against the real system:
 *   1. a temporary Quick Action ("AutoRAG QA Probe <pid>") is registered with
 *      the OS (`pbs -update`); it records its arguments to a file;
 *   2. right-click a file → Services lists it; click → the probe received the
 *      exact absolute path (spaces and Hangul included);
 *   3. a two-row selection hands both paths over;
 *   4. the empty-space menu acts on the folder in view;
 *   5. a folder-only service ("New Terminal at Folder") shows for a folder row
 *      and not for a file row; this app's own Finder workflows never appear;
 *   6. when Keka is installed: Services → Keka → Send to Keka launches Keka.
 *
 * macOS Services registration is per-user and ignores a throwaway $HOME, so the
 * probe lives in the real ~/Library/Services for the length of the run and is
 * always removed (and `pbs -update` re-run) in `finally`. The app itself uses a
 * throwaway profile and a throwaway QA root.
 *
 * Evidence: .omo/evidence/ai-finder-app/services/.
 * Run from the repo root after `bun run build`:
 *   bun scripts/manual-qa/run-qa-finder-services.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { macServiceWorkflow, shellQuote } from "../../src/main/os-menu-integration.ts";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { isMac, rmRetry } from "./platform.mjs";

if (!isMac) {
	console.log("SKIP services: macOS Services exist on macOS only");
	process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(HERE, "..", "..", ".omo", "evidence", "ai-finder-app", "services");
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

const WORK = realpathSync(mkdtempSync(join(tmpdir(), "autorag-qa-services-")));
const QA_ROOT = join(WORK, "root");
const USER_DATA = join(WORK, "user-data");
const PROBE_OUT = join(WORK, "probe-out.txt");
const PROBE_NAME = `AutoRAG QA Probe ${process.pid}`;
const PROBE_DIR = join(homedir(), "Library", "Services", `${PROBE_NAME}.workflow`);
const PBS = "/System/Library/CoreServices/pbs";
const HAS_KEKA = existsSync("/Applications/Keka.app");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(label, value, expected) {
	const ok = JSON.stringify(value) === JSON.stringify(expected);
	console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(value)} (expected ${JSON.stringify(expected)})`);
	if (!ok) process.exitCode = 1;
}

async function waitFor(predicate, { timeoutMs = 20_000, label, stepMs = 150 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		last = await predicate();
		if (last) return last;
		await sleep(stepMs);
	}
	throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

/**
 * The arguments the probe recorded, or null before it ran. The probe reports the
 * Hangul name decomposed (NFD) while the fixture is written composed (NFC); on
 * APFS both are one file, so the lane compares in NFC.
 */
const probeArgs = () => (existsSync(PROBE_OUT) ? readFileSync(PROBE_OUT, "utf8").trimEnd().split("\n").map((line) => line.normalize("NFC")) : null);

function installProbe() {
	mkdirSync(join(PROBE_DIR, "Contents"), { recursive: true });
	writeFileSync(
		join(PROBE_DIR, "Contents", "Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>NSServices</key><array><dict>
<key>NSMenuItem</key><dict><key>default</key><string>${PROBE_NAME}</string></dict>
<key>NSMessage</key><string>runWorkflowAsService</string>
<key>NSRequiredContext</key><dict><key>NSApplicationIdentifier</key><string>com.apple.finder</string></dict>
<key>NSSendFileTypes</key><array><string>public.item</string></array>
</dict></array></dict></plist>
`,
	);
	// Written to a temp name and renamed, so a half-written file never reads as "ran".
	const script = `printf '%s\\n' "$@" > ${shellQuote(`${PROBE_OUT}.tmp`)} && mv ${shellQuote(`${PROBE_OUT}.tmp`)} ${shellQuote(PROBE_OUT)}`;
	writeFileSync(join(PROBE_DIR, "Contents", "document.wflow"), macServiceWorkflow(script));
	execFileSync(PBS, ["-update"]);
}

function removeProbe() {
	rmSync(PROBE_DIR, { recursive: true, force: true });
	try {
		execFileSync(PBS, ["-update"]);
	} catch {
		// Best effort: the workflow directory is already gone.
	}
}

const FILE = join(QA_ROOT, "한글 보고서 (final) 'v2'.txt");
const OTHER = join(QA_ROOT, "photo.txt");
const FOLDER = join(QA_ROOT, "docs");

function fixture() {
	mkdirSync(FOLDER, { recursive: true });
	writeFileSync(FILE, "services qa\n");
	writeFileSync(OTHER, "second\n");
	writeFileSync(join(FOLDER, "readme.md"), "# docs\n");
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rowFor = (page, name) =>
	page
		.locator('[role="row"]')
		.filter({ has: page.locator(".row__label", { hasText: new RegExp(`^${escapeRegExp(name)}$`) }) })
		.first();
const menuLabels = (page) => page.locator('[role="menuitem"]').allInnerTexts();

async function openRowMenu(page, name) {
	await page.locator(".toast").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
	const row = rowFor(page, name);
	await row.waitFor({ timeout: 15_000 });
	await row.click({ button: "right" });
	await page.waitForSelector('[role="menuitem"]');
	await sleep(400);
}

async function openBackgroundMenu(page) {
	await page.locator(".toast").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
	const listBox = await page.locator(".list").boundingBox();
	if (listBox === null) throw new Error("no listing");
	await page.mouse.click(listBox.x + listBox.width / 2, listBox.y + listBox.height - 24, { button: "right" });
	await page.waitForSelector('[role="menuitem"]');
	await sleep(400);
}

async function closeMenu(page) {
	await page.keyboard.press("Escape");
	await page.waitForSelector('[role="menuitem"]', { state: "detached" });
}

/** The services arrive after the menu opens (the OS is asked per right-click). */
async function openServices(page) {
	const parent = page.getByRole("menuitem", { name: "Services", exact: true });
	await parent.waitFor({ timeout: 15_000 });
	await parent.hover();
	await sleep(300);
}

fixture();
let app;
try {
	installProbe();
	// The OS needs a moment to publish the new service to `pbs -dump_pboard`.
	await sleep(2500);

	app = await launchFinder({ userDataDir: USER_DATA, env: { AUTORAG_QA_ROOT: QA_ROOT } });
	const page = await finderWindow(app, 30_000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
	await page.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
	await page.waitForSelector(".toolbar-title", { timeout: 60_000 });
	await page.locator('[role="row"]').first().waitFor({ timeout: 30_000 });

	// 1+2. A file row lists the registered service; clicking it hands over the exact path.
	await openRowMenu(page, "한글 보고서 (final) 'v2'.txt");
	await openServices(page);
	let labels = await menuLabels(page);
	check("file menu has a Services parent", labels.includes("Services"), true);
	check("Services lists the registered Quick Action", labels.includes(PROBE_NAME), true);
	check("Services never lists this app's own Finder workflows", labels.some((label) => label.startsWith("AutoRAG에") || label.startsWith("Ask AutoRAG") || label.startsWith("Show in AutoRAG")), false);
	check("a folder-only service is not offered for a file", labels.includes("New Terminal at Folder"), false);
	await page.screenshot({ path: join(EVIDENCE, "1-file-services.png") });
	await page.getByRole("menuitem", { name: PROBE_NAME, exact: true }).click();
	await waitFor(() => probeArgs() !== null, { label: "the probe service to run" });
	check("the service received the exact path", probeArgs(), [FILE]);
	rmSync(PROBE_OUT, { force: true });

	// 3. A two-row selection hands both paths over.
	await rowFor(page, "photo.txt").click();
	await rowFor(page, "한글 보고서 (final) 'v2'.txt").click({ modifiers: ["Meta"] });
	await rowFor(page, "photo.txt").click({ button: "right" });
	await page.waitForSelector('[role="menuitem"]');
	await sleep(400);
	await openServices(page);
	await page.screenshot({ path: join(EVIDENCE, "2-multi-services.png") });
	await page.getByRole("menuitem", { name: PROBE_NAME, exact: true }).click();
	await waitFor(() => probeArgs() !== null, { label: "the probe service to run on two rows" });
	check("both selected paths arrived", [...(probeArgs() ?? [])].sort(), [FILE, OTHER].sort());
	rmSync(PROBE_OUT, { force: true });

	// 4. A folder row offers the folder-only service; the empty-space menu acts on the folder in view.
	await openRowMenu(page, "docs");
	await openServices(page);
	labels = await menuLabels(page);
	check("a folder row offers New Terminal at Folder", labels.includes("New Terminal at Folder"), true);
	await page.screenshot({ path: join(EVIDENCE, "3-folder-services.png") });
	await closeMenu(page);

	await openBackgroundMenu(page);
	await openServices(page);
	await page.screenshot({ path: join(EVIDENCE, "4-background-services.png") });
	await page.getByRole("menuitem", { name: PROBE_NAME, exact: true }).click();
	await waitFor(() => probeArgs() !== null, { label: "the probe service to run on the folder in view" });
	check("the empty-space menu acted on the folder in view", probeArgs(), [QA_ROOT]);
	rmSync(PROBE_OUT, { force: true });

	// 5. A real third-party service: Keka's group opens a second-level popout, and the click launches Keka.
	if (HAS_KEKA) {
		const kekaWasRunning = (() => {
			try {
				execFileSync("/usr/bin/pgrep", ["-x", "Keka"]);
				return true;
			} catch {
				return false;
			}
		})();
		await openRowMenu(page, "한글 보고서 (final) 'v2'.txt");
		await openServices(page);
		const group = page.getByRole("menuitem", { name: "Keka", exact: true });
		await group.waitFor({ timeout: 15_000 });
		await group.hover();
		await sleep(300);
		await page.screenshot({ path: join(EVIDENCE, "5-keka-group.png") });
		labels = await menuLabels(page);
		check("Keka's three services sit under its group", ["Send to Keka", "Extract using Keka", "Compress using Keka"].every((name) => labels.includes(name)), true);
		// Present in the DOM is not enough: a clipped popout still has buttons. The leaf must be what the user would hit at its centre.
		const box = await page.getByRole("menuitem", { name: "Send to Keka", exact: true }).boundingBox();
		const hit =
			box === null
				? null
				: await page.evaluate(
						({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="menuitem"]')?.textContent?.trim() ?? null,
						{ x: box.x + box.width / 2, y: box.y + box.height / 2 },
					);
		check("the nested popout is visible: the leaf is what a click at its centre hits", hit, "Send to Keka");
		await page.getByRole("menuitem", { name: "Send to Keka", exact: true }).click();
		const launched = await waitFor(
			() => {
				try {
					execFileSync("/usr/bin/pgrep", ["-x", "Keka"]);
					return true;
				} catch {
					return false;
				}
			},
			{ label: "Keka to launch", timeoutMs: 15_000 },
		).catch(() => false);
		check("Send to Keka launched Keka", launched === true || kekaWasRunning, true);
		if (!kekaWasRunning) {
			try {
				execFileSync("/usr/bin/osascript", ["-e", 'tell application "Keka" to quit']);
			} catch {
				// Already closed.
			}
		}
	} else {
		console.log("SKIP keka: /Applications/Keka.app is not installed");
	}

	await page.screenshot({ path: join(EVIDENCE, "6-final.png") });
} finally {
	removeProbe();
	if (app !== undefined) await app.close().catch(() => undefined);
	rmRetry(WORK);
}

console.log(`EVIDENCE ${EVIDENCE}`);
console.log(process.exitCode === 1 ? "RESULT FAIL" : "RESULT PASS");
