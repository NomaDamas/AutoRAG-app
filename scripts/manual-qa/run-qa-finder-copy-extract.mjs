/**
 * Manual QA — copying a many-files folder and extracting a wrapped zip, through the real UI.
 *
 * Drives the production build (out/) in a throwaway HOME and proves, asserted on disk byte for byte:
 *
 *   1. ⌘C then ⌘V of a 600-file folder (nested, with an empty folder and a binary file) into another
 *      folder yields an identical tree, and ⌘Z removes it whole;
 *   2. ⇧⌘Z redoes that copy and the tree is identical again (undo recreates it through the same copy);
 *   3. Duplicate on the folder writes "<name> copy" identical to the source, and ⌘Z removes it;
 *   4. pasting a folder into itself writes nothing (the service-level refusal is covered in test/copy-tree.test.ts);
 *   5. Extract on `docs.zip` holding only `docs/…` puts the contents in `docs/` next to the zip, with a
 *      child folder that repeats the name (`docs/docs`, which used to fail) intact and no staging folder left;
 *   6. Extract on a zip with a wrapper folder beside a loose file strips the wrapper;
 *   7. Extract on a 600-file wrapped zip restores every file, with every byte equal.
 *
 * Run from the repo root after `bun run build`:
 * `bun scripts/manual-qa/run-qa-finder-copy-extract.mjs`
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { chord, cssAttr, sleep } from "./platform.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = join(ROOT, ".omo", "evidence", "ai-finder-app", "qa-copy-extract");
mkdirSync(EVIDENCE, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "ulw-copyext-home-"));
const top = join(home, "Documents", "qa-copy-extract");
const dest = join(top, "dest");
const SOURCE = join(top, "bulk");
for (const directory of [top, dest, join(SOURCE, "empty")]) mkdirSync(directory, { recursive: true });

const FILES = 600;
const binary = Buffer.from(Array.from({ length: 70_000 }, (_, index) => (index * 31) & 255));
for (let index = 0; index < FILES; index += 1) {
	const folder = join(SOURCE, `d${index % 9}`, `e${index % 4}`);
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, `f${index}.txt`), `file ${index}\n`.repeat(index % 7 + 1));
}
writeFileSync(join(SOURCE, "blob.bin"), binary);

writeFileSync(
	join(top, "docs.zip"),
	zipSync({
		"docs/": new Uint8Array(0),
		"docs/docs/inner.txt": Buffer.from("inner"),
		"docs/outer.txt": Buffer.from("outer"),
	}),
);
writeFileSync(join(top, "mixed.zip"), zipSync({ "mixed/a.txt": Buffer.from("a"), "loose.txt": Buffer.from("loose") }));
const packed = {};
for (let index = 0; index < FILES; index += 1) packed[`pack/d${index % 9}/f${index}.txt`] = Buffer.from(`packed ${index}`);
writeFileSync(join(top, "pack.zip"), zipSync(packed));

const results = [];
const check = (name, pass, detail) => {
	results.push({ name, pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
};

/** Every file under `dir` as [relative path, sha1], plus every directory, sorted: a tree's whole content. */
function treeOf(dir) {
	const out = [];
	const walk = (current) => {
		for (const name of readdirSync(current)) {
			const path = join(current, name);
			const key = relative(dir, path).replaceAll("\\", "/");
			if (statSync(path).isDirectory()) {
				out.push([`${key}/`, ""]);
				walk(path);
			} else out.push([key, createHash("sha1").update(readFileSync(path)).digest("hex")]);
		}
	};
	walk(dir);
	return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
const sameTree = (a, b) => a.length === b.length && a.every((entry, index) => entry[0] === b[index][0] && entry[1] === b[index][1]);
const names = (dir) => readdirSync(dir).sort();
const waitFor = async (predicate, label, timeoutMs = 60_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await sleep(150);
	}
	console.log(`(timed out waiting for ${label})`);
	return false;
};

const row = (page, path) => page.locator(`[data-path="${cssAttr(path)}"]`);
const waitForRow = (page, path) => row(page, path).first().waitFor({ state: "visible", timeout: 30_000 });
const atTitle = (page, name) =>
	page.waitForFunction((want) => document.querySelector(".toolbar-title")?.textContent === want, name, { timeout: 30_000 });
const clearToast = (page) => page.locator(".toast").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
async function menu(page, path, item) {
	await clearToast(page);
	await row(page, path).first().click({ button: "right" });
	await page.getByRole("menuitem", { name: item, exact: true }).click();
}

const sourceTree = treeOf(SOURCE);
console.log(`fixture: ${top}  source files=${sourceTree.filter(([, hash]) => hash !== "").length}`);

let app = null;
try {
	app = await launchFinder({ userDataDir: mkdtempSync(join(tmpdir(), "ulw-copyext-data-")), env: { HOME: home, AUTORAG_QA_ROOT: top } });
	const page = await finderWindow(app, 60_000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
	await page.setViewportSize({ width: 1500, height: 900 });
	await page.waitForSelector(".toolbar-title", { timeout: 60_000 });
	await atTitle(page, "qa-copy-extract");
	await waitForRow(page, SOURCE);

	/* ------------------------------------------------ 1. ⌘C / ⌘V a folder, ⌘Z */
	await row(page, SOURCE).click();
	await page.keyboard.press(chord("c"));
	await row(page, dest).dblclick();
	await atTitle(page, "dest");
	const copyStarted = Date.now();
	await page.keyboard.press(chord("v"));
	const pasted = join(dest, "bulk");
	await waitFor(() => existsSync(pasted) && sameTree(treeOf(pasted), sourceTree), "pasted tree");
	const copyMs = Date.now() - copyStarted;
	check("⌘C then ⌘V copies a 600-file folder with an identical tree", sameTree(treeOf(pasted), sourceTree), `files=${treeOf(pasted).length} in ${copyMs} ms, dest=${names(dest)}`);
	await page.screenshot({ path: join(EVIDENCE, "1-copied.png") });

	await clearToast(page);
	await page.locator(".list").click({ position: { x: 40, y: 8 } }).catch(() => {});
	await page.keyboard.press(chord("z"));
	const undone = await waitFor(() => !existsSync(pasted), "undo of copy");
	check("⌘Z removes the whole copy", undone, `dest=${names(dest)}`);

	/* ------------------------------------------------------------ 2. ⇧⌘Z redo */
	await clearToast(page);
	await page.locator(".list").click({ position: { x: 40, y: 8 } }).catch(() => {});
	await page.keyboard.press(chord("Shift", "z"));
	await waitFor(() => existsSync(pasted) && sameTree(treeOf(pasted), sourceTree), "redo of copy");
	check("⇧⌘Z redoes the copy and the tree is identical again", existsSync(pasted) && sameTree(treeOf(pasted), sourceTree), `dest=${names(dest)}`);

	/* -------------------------------------------------------- 3. Duplicate + ⌘Z */
	await page.locator("nav.pathbar .path-seg", { hasText: "qa-copy-extract" }).first().click();
	await atTitle(page, "qa-copy-extract");
	await waitForRow(page, SOURCE);
	await menu(page, SOURCE, "Duplicate");
	const dup = join(top, "bulk copy");
	await waitFor(() => existsSync(dup) && sameTree(treeOf(dup), sourceTree), "duplicate");
	check("Duplicate writes 'bulk copy' identical to the source", existsSync(dup) && sameTree(treeOf(dup), sourceTree), `top=${names(top)}`);
	await clearToast(page);
	await page.locator(".list").click({ position: { x: 40, y: 8 } }).catch(() => {});
	await page.keyboard.press(chord("z"));
	await waitFor(() => !existsSync(dup), "undo of duplicate");
	check("⌘Z removes the duplicate", !existsSync(dup), `top=${names(top)}`);

	/* -------------------------------------------- 4. folder pasted into itself */
	await row(page, SOURCE).click();
	await page.keyboard.press(chord("c"));
	await row(page, SOURCE).dblclick();
	await atTitle(page, "bulk");
	const before = treeOf(SOURCE);
	await page.keyboard.press(chord("v"));
	await sleep(1500);
	const after = treeOf(SOURCE);
	check("pasting a folder inside itself changes nothing", sameTree(before, after), `entries ${before.length} -> ${after.length}`);
	await page.screenshot({ path: join(EVIDENCE, "4-into-itself.png") });
	await page.locator("nav.pathbar .path-seg", { hasText: "qa-copy-extract" }).first().click();
	await atTitle(page, "qa-copy-extract");

	/* ------------------------------------------------------------- 5. docs/docs */
	const docsZip = join(top, "docs.zip");
	await waitForRow(page, docsZip);
	await menu(page, docsZip, "Extract");
	const docs = join(top, "docs");
	await waitFor(() => existsSync(join(docs, "docs", "inner.txt")), "docs/docs extraction");
	check(
		"Extract keeps a child folder that repeats the archive name (docs/docs)",
		existsSync(join(docs, "docs", "inner.txt")) && readFileSync(join(docs, "outer.txt"), "utf8") === "outer" && readFileSync(join(docs, "docs", "inner.txt"), "utf8") === "inner",
		`docs=${names(docs)}`,
	);
	await page.screenshot({ path: join(EVIDENCE, "5-docs-docs.png") });

	/* ------------------------------------------------- 6. wrapper beside a loose file */
	const mixedZip = join(top, "mixed.zip");
	await waitForRow(page, mixedZip);
	await menu(page, mixedZip, "Extract");
	const mixed = join(top, "mixed");
	await waitFor(() => existsSync(join(mixed, "a.txt")), "mixed extraction");
	check("Extract strips the wrapper beside a loose file", names(mixed).join(",") === "a.txt,loose.txt", `mixed=${names(mixed)}`);

	/* ------------------------------------------------------ 7. a 600-file wrapped zip */
	const packZip = join(top, "pack.zip");
	await waitForRow(page, packZip);
	const extractStarted = Date.now();
	await menu(page, packZip, "Extract");
	const pack = join(top, "pack");
	const expected = Object.entries(packed).map(([name, body]) => [name.replace(/^pack\//, ""), createHash("sha1").update(body).digest("hex")]);
	const expectedTree = [
		...new Set(expected.map(([name]) => `${name.split("/")[0]}/`)),
	].map((directory) => [directory, ""]).concat(expected).sort((a, b) => (a[0] < b[0] ? -1 : 1));
	await waitFor(() => existsSync(pack) && sameTree(treeOf(pack), expectedTree), "pack extraction");
	const extractMs = Date.now() - extractStarted;
	check("Extract restores all 600 files of a wrapped zip, byte for byte", existsSync(pack) && sameTree(treeOf(pack), expectedTree), `files=${expected.length} in ${extractMs} ms`);

	const hidden = names(top).filter((name) => name.startsWith("."));
	check("no staging folder is left behind", hidden.length === 0, `hidden=${hidden}`);
	await page.screenshot({ path: join(EVIDENCE, "7-extracted.png") });
} catch (error) {
	check("run completed", false, String(error).slice(0, 500));
	if (app !== null) {
		const page = await finderWindow(app).catch(() => null);
		await page?.screenshot({ path: join(EVIDENCE, "failure.png") }).catch(() => undefined);
	}
} finally {
	if (app !== null) await app.close().catch(() => undefined);
}

writeFileSync(join(EVIDENCE, "result.json"), JSON.stringify({ platform: process.platform, checks: results }, null, 2));
const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
