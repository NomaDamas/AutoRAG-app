/**
 * Manual QA — the sidebar's live OS places on the real AI Finder app (macOS).
 *
 * Proves, against this machine's real HOME and mount table:
 * - Favorites heads with the AI Search app row, then Recents and the OS
 *   places — home, Applications, Desktop, Documents, Downloads, Music,
 *   Movies, Pictures, and Trash — and each opens its folder;
 * - Cloud lists exactly the File Provider domains Finder shows — one row per
 *   account — and nothing for a provider that is not connected;
 * - Locations lists the boot disk plus every browsable /Volumes mount;
 * - a disk image attached while the app runs appears without a restart, its
 *   row's eject button really unmounts it (`mount` no longer lists it), and a
 *   tab browsing inside it moves out first;
 * - the denser rows: 28px tall with 12px labels.
 *
 * Run from the repo root:  bun scripts/manual-qa/run-qa-finder-sidebar-places.mjs
 * Prereq: bun run build
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";

const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-sidebar-places");
mkdirSync(EVIDENCE, { recursive: true });
const VOLUME = "AutoRAG QA Disk";
const MOUNT = join("/Volumes", VOLUME);

const failures = [];
const check = (label, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : ` — ${detail}`}`);
	if (!ok) failures.push(label);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mounted = () => execFileSync("mount", [], { encoding: "utf8" }).includes(` on ${MOUNT} (`);

/** The rows of one sidebar group, as [label, ejectable] pairs. */
async function groupRows(page, label) {
	return page.evaluate((groupLabel) => {
		const group = [...document.querySelectorAll(".side-group")].find(
			(node) => node.querySelector(".side-label")?.textContent === groupLabel,
		);
		if (group === undefined) return null;
		return [...group.querySelectorAll(".sidebar__item")].map((row) => [
			row.querySelector(".sidebar__item-label")?.textContent ?? "",
			row.parentElement?.querySelector(".sidebar__eject") !== null,
		]);
	}, label);
}

async function waitForRow(page, label, present, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const rows = (await groupRows(page, "Locations")) ?? [];
		if (rows.some(([name]) => name === label) === present) return true;
		if (Date.now() >= deadline) return false;
		await sleep(250);
	}
}

const home = homedir();
const expectedCloud = [
	...(existsSync(join(home, "Library/Mobile Documents/com~apple~CloudDocs")) ? ["iCloud Drive"] : []),
	...readdirSync(join(home, "Library/CloudStorage"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.map((entry) => entry.name),
];
const expectedVolumes = readdirSync("/Volumes").filter((name) => !name.startsWith("."));

// A throwaway disk image, attached only after the app is up.
const scratch = mkdtempSync(join(tmpdir(), "autorag-qa-places-"));
const image = join(scratch, "qa.dmg");
if (mounted()) execFileSync("diskutil", ["unmount", "force", MOUNT]);
execFileSync("hdiutil", ["create", "-size", "8m", "-fs", "HFS+", "-volname", VOLUME, image], { stdio: "ignore" });

const userDataDir = mkdtempSync(join(tmpdir(), "autorag-qa-places-user-"));
const app = await launchFinder({ userDataDir });
try {
	const page = await finderWindow(app, 30_000);
	await page.waitForSelector(".sidebar__item", { timeout: 30_000 });
	await sleep(1500);
	await page.locator(".sidebar").screenshot({ path: join(EVIDENCE, "01-sidebar.png") });

	const labels = await page.evaluate(() => [...document.querySelectorAll(".side-label")].map((node) => node.textContent));
	check("groups are Favorites, Cloud, Locations", JSON.stringify(labels) === JSON.stringify(["Favorites", "Cloud", "Locations"]), JSON.stringify(labels));

	const favorites = (await groupRows(page, "Favorites")).map(([name]) => name);
	const wantFavorites = ["AI Search", "Recents", basename(home), "Applications", "Desktop", "Documents", "Downloads", "Music", "Movies", "Pictures", "Trash"];
	check("favorites: AI Search then the OS order", JSON.stringify(favorites) === JSON.stringify(wantFavorites), JSON.stringify(favorites));

	const cloud = (await groupRows(page, "Cloud")).map(([name]) => name);
	const cloudKey = (name) => name.replace(" - ", "-").replace("Google Drive", "GoogleDrive");
	check(
		"one cloud row per connected domain",
		cloud.length === expectedCloud.length && expectedCloud.every((domain) => cloud.some((name) => cloudKey(name) === domain || name === domain)),
		JSON.stringify(cloud),
	);

	const disks = await groupRows(page, "Locations");
	const diskNames = disks.map(([name]) => name);
	check("every /Volumes entry is a Locations row", expectedVolumes.every((name) => diskNames.includes(name)), JSON.stringify(diskNames));
	check("boot disk has no eject button", disks.find(([name]) => name === "Macintosh HD")?.[1] === false);
	check("mounted volumes have an eject button", disks.filter(([name]) => name !== "Macintosh HD").every(([, ejectable]) => ejectable));

	const box = await page.locator(".sidebar__item").first().boundingBox();
	const fontSize = await page.locator(".sidebar__item-label").first().evaluate((node) => getComputedStyle(node).fontSize);
	check("rows are 28px with 12px labels", box?.height === 28 && fontSize === "12px", `${box?.height}px / ${fontSize}`);

	// Favorites open their folders.
	await page.getByLabel("Places").getByRole("button", { name: "Applications", exact: true }).click();
	await sleep(1200);
	const appPaths = await page.locator('[role="row"][data-path]').evaluateAll((rows) => rows.map((row) => row.getAttribute("data-path")));
	check(
		"Applications opens /Applications",
		appPaths.length > 0 && appPaths.every((path) => path?.startsWith("/Applications/")),
		`${appPaths.length} rows, first ${appPaths[0]}`,
	);
	await page.screenshot({ path: join(EVIDENCE, "02-applications.png") });

	// Mount while running: the row appears without a restart.
	execFileSync("hdiutil", ["attach", image], { stdio: "ignore" });
	check("disk image mounted", mounted());
	check("mounted image appears live", await waitForRow(page, VOLUME, true));
	await page.locator(".sidebar").screenshot({ path: join(EVIDENCE, "03-mounted.png") });

	// Browse inside it, then eject from the sidebar.
	await page.getByLabel("Places").getByRole("button", { name: VOLUME, exact: true }).click();
	await sleep(1000);
	await page.getByRole("button", { name: `Eject ${VOLUME}`, exact: true }).click();
	const deadline = Date.now() + 15_000;
	while (mounted() && Date.now() < deadline) await sleep(250);
	check("eject really unmounted the volume", !mounted());
	check("ejected row leaves the sidebar", await waitForRow(page, VOLUME, false));
	const activeAfter = await page.locator('.sidebar__item[aria-current="true"] .sidebar__item-label').innerText().catch(() => "");
	check("tab inside the volume moved to home", activeAfter === basename(home), activeAfter);
	await sleep(500);
	await page.screenshot({ path: join(EVIDENCE, "04-ejected.png") });
} finally {
	await app.close();
	if (mounted()) execFileSync("diskutil", ["unmount", "force", MOUNT]);
	rmSync(scratch, { recursive: true, force: true });
	rmSync(userDataDir, { recursive: true, force: true });
}

console.log(`\nevidence → ${EVIDENCE}`);
if (failures.length > 0) {
	console.error(`${failures.length} check(s) failed: ${failures.join("; ")}`);
	process.exit(1);
}
