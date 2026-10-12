/**
 * Manual QA: extracting archives from the row context menu and the Inspector.
 *
 * Proves, against the real app (production build, isolated HOME and userData):
 *  1. a row per offered format (zip, tar, tgz, gz, 7z, and — when the tools
 *     exist — tar.bz2 / tar.xz) shows 압축 해제 / Extract in its context menu
 *  2. clicking it writes the right folder — or, for a bare .gz, the single
 *     uncompressed file — next to the archive with the right contents
 *  3. the Inspector action bar extracts another archive
 *  3b. double-clicking or pressing Enter on an archive extracts it in place
 *      (the same as the context menu) instead of opening it in another app
 *  4. a plain (non-archive) row shows neither
 *
 * Fixtures are built at run time in a temp dir (never committed): zips with the
 * app's own fflate, tars/7z with the system `tar` (bsdtar), the single-file gz
 * with Node's zlib.
 * Evidence: the directory passed as argv[2], else
 * `.omo/evidence/ai-finder-app/archive-extract`.
 * Run from the repo root after `bun run build`:
 *   bun scripts/manual-qa/run-qa-archive-extract.mjs [evidence-dir]
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { zipSync } from "fflate";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { rmRetry } from "./platform.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const EVIDENCE = process.argv[2] ?? join(REPO, ".omo", "evidence", "ai-finder-app", "archive-extract");
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

const HOME = join(tmpdir(), "ulw-archive-home");
const QA_ROOT = join(HOME, "ArchiveQA");
const USER_DATA = join(tmpdir(), "ulw-archive-data");
rmSync(HOME, { recursive: true, force: true });
rmSync(USER_DATA, { recursive: true, force: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hasBin(name) {
	const finder = process.platform === "win32" ? "where" : "which";
	try {
		execFileSync(finder, [name], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** A source folder whose name matches the archive stem, so extraction de-nests it. */
function seedFolder(name, content) {
	const dir = join(QA_ROOT, "build", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "inside.txt"), content);
	return dir;
}

function run(program, args) {
	execFileSync(program, args, { stdio: "ignore" });
}

/**
 * The formats to exercise, each built into QA_ROOT. `kind: "file"` marks the
 * bare gz, whose output is a file rather than a folder. `available` gates a
 * format on the tool it needs, so the lane still runs where a tool is missing.
 */
function fixture() {
	mkdirSync(join(QA_ROOT, "build"), { recursive: true });
	writeFileSync(join(QA_ROOT, "plain.txt"), "not an archive\n");

	const entries = [
		{ archive: "alpha.zip", output: "alpha", content: "alpha content", build: () => writeFileSync(join(QA_ROOT, "alpha.zip"), zipSync({ "alpha/": new Uint8Array(0), "alpha/inside.txt": new Uint8Array(Buffer.from("alpha content")) })) },
		{ archive: "beta.tar", output: "beta", content: "beta content", build: () => { seedFolder("beta", "beta content"); run("tar", ["-cf", join(QA_ROOT, "beta.tar"), "-C", join(QA_ROOT, "build"), "beta"]); } },
		{ archive: "gamma.tgz", output: "gamma", content: "gamma content", build: () => { seedFolder("gamma", "gamma content"); run("tar", ["-czf", join(QA_ROOT, "gamma.tgz"), "-C", join(QA_ROOT, "build"), "gamma"]); } },
		{ archive: "delta.7z", output: "delta", content: "delta content", build: () => { seedFolder("delta", "delta content"); run("tar", ["-a", "-cf", join(QA_ROOT, "delta.7z"), "-C", join(QA_ROOT, "build"), "delta"]); } },
		{ archive: "solo.txt.gz", output: "solo.txt", content: "solo gz content", file: true, build: () => writeFileSync(join(QA_ROOT, "solo.txt.gz"), gzipSync(Buffer.from("solo gz content"))) },
		{ archive: "insp.zip", output: "insp", content: "insp content", inspector: true, build: () => writeFileSync(join(QA_ROOT, "insp.zip"), zipSync({ "insp/": new Uint8Array(0), "insp/inside.txt": new Uint8Array(Buffer.from("insp content")) })) },
		{ archive: "dbl.zip", output: "dbl", content: "dbl content", opened: true, build: () => writeFileSync(join(QA_ROOT, "dbl.zip"), zipSync({ "dbl/": new Uint8Array(0), "dbl/inside.txt": new Uint8Array(Buffer.from("dbl content")) })) },
		{ archive: "ent.7z", output: "ent", content: "ent content", opened: true, build: () => { seedFolder("ent", "ent content"); run("tar", ["-a", "-cf", join(QA_ROOT, "ent.7z"), "-C", join(QA_ROOT, "build"), "ent"]); } },
	];
	if (hasBin("bzip2")) {
		entries.push({ archive: "eps.tar.bz2", output: "eps", content: "eps content", build: () => { seedFolder("eps", "eps content"); run("tar", ["-cjf", join(QA_ROOT, "eps.tar.bz2"), "-C", join(QA_ROOT, "build"), "eps"]); } });
	}
	if (hasBin("xz")) {
		entries.push({ archive: "zeta.tar.xz", output: "zeta", content: "zeta content", build: () => { seedFolder("zeta", "zeta content"); run("tar", ["-cJf", join(QA_ROOT, "zeta.tar.xz"), "-C", join(QA_ROOT, "build"), "zeta"]); } });
	}

	for (const entry of entries) {
		try {
			entry.build();
		} catch (error) {
			console.log(`SKIP ${entry.archive}: ${String(error).split("\n")[0]}`);
			entry.available = false;
		}
	}
	return entries;
}

function check(label, value, expected) {
	const ok = value === expected;
	console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(value)} (expected ${JSON.stringify(expected)})`);
	if (!ok) process.exitCode = 1;
}

async function waitFor(predicate, { timeoutMs = 20000, label, stepMs = 100 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		last = await predicate();
		if (last) return last;
		await sleep(stepMs);
	}
	throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const rowFor = (page, name) =>
	page
		.locator('[role="row"]')
		.filter({ has: page.locator(".row__label", { hasText: new RegExp(`^${escapeRegExp(name)}$`) }) })
		.first();

const menuLabels = (page) => page.locator('[role="menuitem"]').allInnerTexts();
const actionLabels = (page) => page.locator(".inspector-actions .inspector-action span").allInnerTexts();

async function openRowMenu(page, name) {
	await page.locator(".toast").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
	const row = rowFor(page, name);
	await row.waitFor({ timeout: 15_000 });
	await row.click({ button: "right" });
	await page.waitForSelector('[role="menuitem"]');
	await sleep(400);
}

async function closeMenu(page) {
	await page.keyboard.press("Escape");
	await page.waitForSelector('[role="menuitem"]', { state: "detached" });
}

const entries = fixture();
console.log(`INFO fixtures: ${entries.filter((entry) => entry.available !== false).map((entry) => entry.archive).join(", ")}`);

const app = await launchFinder({ userDataDir: USER_DATA, env: { HOME, USERPROFILE: HOME, AUTORAG_QA_ROOT: QA_ROOT } });
try {
	const page = await finderWindow(app, 30_000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
	await page.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
	await page.waitForSelector(".toolbar-title", { timeout: 60_000 });
	await page.locator('[role="row"]').first().waitFor({ timeout: 30_000 });

	// 1+2. Every offered format extracts from its row's context menu.
	for (const entry of entries) {
		if (entry.available === false || entry.inspector === true || entry.opened === true) continue;
		await openRowMenu(page, entry.archive);
		check(`${entry.archive} menu offers Extract`, (await menuLabels(page)).includes("Extract"), true);
		if (entry.archive === "alpha.zip") await page.screenshot({ path: join(EVIDENCE, "1-context-menu.png") });
		await page.getByRole("menuitem", { name: "Extract", exact: true }).click();

		const expected = join(QA_ROOT, entry.output);
		await waitFor(() => existsSync(expected), { label: `${entry.archive} -> ${expected}` });
		if (entry.file === true) {
			check(`${entry.archive} wrote ${entry.output}`, readFileSync(expected, "utf8"), entry.content);
		} else {
			check(`${entry.archive} restored inside.txt`, readFileSync(join(expected, "inside.txt"), "utf8"), entry.content);
		}
		await sleep(300);
	}

	// 3. The Inspector action bar extracts another archive.
	await rowFor(page, "insp.zip").click();
	await page.waitForSelector(".inspector-actions");
	check("Inspector offers Extract for an archive", (await actionLabels(page)).includes("Extract"), true);
	await page.screenshot({ path: join(EVIDENCE, "2-inspector-actions.png") });
	await page.locator(".inspector-actions").getByRole("button", { name: "Extract", exact: true }).click();
	await waitFor(() => existsSync(join(QA_ROOT, "insp", "inside.txt")), { label: "insp extraction" });
	check("Inspector extract wrote the folder", readFileSync(join(QA_ROOT, "insp", "inside.txt"), "utf8"), "insp content");

	// 3b. Opening an archive — double-click or Enter — extracts it in place,
	// exactly like the context menu, instead of handing it to the OS default app.
	await rowFor(page, "dbl.zip").dblclick();
	await waitFor(() => existsSync(join(QA_ROOT, "dbl", "inside.txt")), { label: "double-click extraction" });
	check("double-click extracted the folder", readFileSync(join(QA_ROOT, "dbl", "inside.txt"), "utf8"), "dbl content");
	await page.screenshot({ path: join(EVIDENCE, "2b-double-click-extract.png") });
	await rowFor(page, "ent.7z").click();
	// Enter acts on the focused row: let the click's selection land before the key.
	await sleep(300);
	await page.keyboard.press("Enter");
	await waitFor(() => existsSync(join(QA_ROOT, "ent", "inside.txt")), { label: "Enter extraction" });
	check("Enter extracted the folder", readFileSync(join(QA_ROOT, "ent", "inside.txt"), "utf8"), "ent content");

	// 4. A plain file offers neither.
	await openRowMenu(page, "plain.txt");
	const plainMenu = await menuLabels(page);
	check("plain file menu has no Extract", plainMenu.includes("Extract"), false);
	await closeMenu(page);
	await rowFor(page, "plain.txt").click();
	await page.waitForSelector(".inspector-actions");
	check("plain file Inspector has no Extract", (await actionLabels(page)).includes("Extract"), false);
	await page.screenshot({ path: join(EVIDENCE, "3-plain-file.png") });
} finally {
	try {
		process.kill(app.process().pid, "SIGKILL");
	} catch {
		// Already gone.
	}
	await app.close().catch(() => undefined);
}

rmRetry(HOME);
rmRetry(USER_DATA);
console.log(`EVIDENCE ${EVIDENCE}`);
console.log(process.exitCode === 1 ? "RESULT FAIL" : "RESULT PASS");
