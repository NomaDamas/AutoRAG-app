import { fileURLToPath } from "node:url";
/**
 * Manual QA — the sidebar instant search (mockup "Search redesign").
 *
 * Verifies the relocation and the new behavior against the built app:
 *   1. the field sits at the top of the sidebar, above the nav groups;
 *   2. the toolbar no longer holds a search field;
 *   3. focusing shows the 파일 이름 / 내용 chips, 파일 이름 active;
 *   4. Enter commits a filename search over the whole machine (scope bar, rows);
 *   5. the scope bar's folder pill narrows the commit to the folder in view;
 *   6. 내용 opens a new AI Search tab running the real content search;
 *   7. ⌘F focuses the sidebar field;
 *   8. the toolbar's inspector / AI / Share cluster behaves.
 *
 * Run `bun run build` first. Evidence lands in the ignored `.omo/` tree.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { chord, isMac } from "./platform.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-sidebar-search");
mkdirSync(EVIDENCE, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`);
	if (!ok) failures.push(label);
};

const ALL_LABEL = process.platform === "win32" ? "This Computer" : "This Mac";

const RUN_ID = `ulw-search-qa-${Date.now().toString(36)}`;
const home = mkdtempSync(join(tmpdir(), "ulw-search-home-"));
const userDataDir = mkdtempSync(join(tmpdir(), "ulw-search-data-"));
const docs = join(home, "Documents");
const folder = join(docs, RUN_ID);

mkdirSync(folder, { recursive: true });
writeFileSync(join(folder, "notes.md"), "# notes\napproval notes fixture\n");
writeFileSync(join(folder, "budget.csv"), "item,total\nads,1\n");
writeFileSync(join(folder, "other.txt"), "unrelated\n");

let app;
try {
	app = await launchFinder({ userDataDir, env: { HOME: home, USERPROFILE: home } });
	const page = await finderWindow(app);
	page.setDefaultTimeout(10000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 200)}`));
	await page.waitForSelector(".sidebar-search input, .side-search input", { timeout: 30000 });
	await page.waitForSelector(".sidebar__item", { timeout: 30000 });

	const search = page.locator(".side-search input");
	const chip = (label) => page.locator(".scope-chip", { hasText: new RegExp(`^${label}$`) });

	// 1. Position: the field is above the first nav group.
	const fieldBox = await search.boundingBox();
	const firstItemBox = await page.locator(".sidebar__item").first().boundingBox();
	check(
		"the search field sits at the top of the sidebar, above the nav groups",
		fieldBox !== null && firstItemBox !== null && fieldBox.y < firstItemBox.y,
		JSON.stringify({ field: fieldBox?.y, nav: firstItemBox?.y }),
	);

	// 2. The toolbar no longer carries a search field.
	check(
		"the toolbar has no search field",
		(await page.locator(".toolbar .sidebar-search input, .toolbar .search-wrap").count()) === 0,
		`count=${await page.locator(".toolbar .sidebar-search input, .toolbar .search-wrap").count()}`,
	);
	await page.screenshot({ path: join(EVIDENCE, "01-sidebar-resting.png") });

	// 3. Focus reveals the chips, File Name active by default.
	await search.click();
	await chip("File Name").waitFor({ timeout: 5000 });
	const chipLabels = await page.locator(".scope-chip").allInnerTexts();
	check("focusing shows the two scope chips", JSON.stringify(chipLabels) === JSON.stringify(["File Name", "Content"]), JSON.stringify(chipLabels));
	check("File Name is the default active chip", (await chip("File Name").getAttribute("aria-pressed")) === "true");
	await page.screenshot({ path: join(EVIDENCE, "02-chips-focused.png") });
	await page.locator(".side-search").screenshot({ path: join(EVIDENCE, "02-chips-element.png") });

	// 4. Enter commits a filename search: scope bar + filtered rows.
	await search.fill("notes");
	await search.press("Enter");
	await page.waitForSelector(".scope", { timeout: 10000 });
	// A filename search walks the disk: the scope bar appears at once and the
	// count climbs as results land, so wait for the rows instead of a fixed
	// delay (a cold walk takes about a second).
	await page.waitForFunction(() => document.querySelectorAll('[role="row"] .row__label').length > 0, null, { timeout: 15000 }).catch(() => undefined);
	const scopeCount = await page.locator(".scope__count").innerText();
	const rowNames = await page.locator('[role="row"] .row__label').allInnerTexts();
	check("a filename search shows the scope bar with a count", /\d+\s*items found/.test(scopeCount), scopeCount);
	check("the search filtered to the matching file", rowNames.includes("notes.md") && rowNames.length >= 1, JSON.stringify(rowNames));
	const defaultScope = (await page.locator(".scope button[aria-pressed='true']").innerText()).trim();
	check("a filename search defaults to the whole machine", defaultScope === ALL_LABEL, defaultScope);
	await page.mouse.move(2, 2);
	await sleep(600);
	await page.screenshot({ path: join(EVIDENCE, "03-filename-search.png") });

	// 5. The scope bar's folder pill narrows the commit to the folder in view.
	await page.locator(".scope button").nth(1).click();
	await page.waitForFunction(
		(all) => document.querySelector(".scope button[aria-pressed='true']")?.textContent?.trim() !== all,
		ALL_LABEL,
		{ timeout: 10000 },
	);
	const scopedButton = (await page.locator(".scope button[aria-pressed='true']").innerText()).trim();
	check("the folder pill narrows the commit to the folder in view", scopedButton !== ALL_LABEL, scopedButton);
	await page.screenshot({ path: join(EVIDENCE, "04-folder-scope.png") });

	// 6. 내용 opens a new AI Search tab running the real content search.
	// Clicking the scope bar's folder pill blurred the field, which hides the
	// chips; refocus it the way a user would before picking the 내용 chip.
	await search.click();
	await chip("Content").click();
	await search.fill("approval notes");
	await search.press("Enter");
	await page.locator(".user-msg .user-bubble-wrap").first().waitFor({ timeout: 10000 });
	const bubble = await page.locator(".user-msg .bubble").first().innerText();
	check("Content opens an AI Search tab and sends the query as a user message", bubble.trim() === "approval notes", bubble.trim());
	await sleep(400);
	await page.screenshot({ path: join(EVIDENCE, "05-content-search.png") });

	// 7. ⌘F focuses the sidebar field from anywhere.
	await page.mouse.click(700, 300);
	await page.keyboard.press(chord("f"));
	await sleep(300);
	const focused = await page.evaluate(() => document.activeElement?.matches(".side-search input") ?? false);
	check("⌘F focuses the sidebar search field", focused, String(focused));

	// 8. Toolbar inspector / AI / Share cluster.
	await page.locator('[aria-label="Toggle inspector"]').waitFor({ timeout: 5000 });
	check("the toolbar exposes the inspector toggle", (await page.locator('[aria-label="Toggle inspector"]').count()) === 1);
	const cluster = await page.locator(".toolbar .tgroup button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
	check("the toolbar's right cluster has no AI Search button", JSON.stringify(cluster) === JSON.stringify(isMac ? ["Toggle inspector", "Share"] : ["Toggle inspector"]), JSON.stringify(cluster));
	// The Share item opens the OS share sheet, so it is shown on macOS only.
	const share = page.locator('.toolbar [aria-label="Share"]');
	check("the toolbar exposes Share on macOS only", (await share.count()) === (isMac ? 1 : 0), `count=${await share.count()}`);
	await page.locator(".tabs .tab").first().click();
	await search.fill("");
	await search.press("Enter");
	await page.locator(".scope").waitFor({ state: "detached", timeout: 10000 }).catch(() => undefined);
	await page.locator('[role="row"]').first().click();
	await sleep(200);
	if (isMac) {
		check("Share enables once a row is selected", (await share.isEnabled()), `disabled=${await share.isDisabled()}`);
	}
	await page.screenshot({ path: join(EVIDENCE, "06-toolbar-cluster.png") });
} catch (error) {
	console.error(`capture failed: ${String(error).slice(0, 400)}`);
	failures.push("harness error");
} finally {
	await app?.close();
	rmSync(home, { recursive: true, force: true });
	rmSync(userDataDir, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "\nRESULT: ALL PASS" : `\nRESULT: ${failures.length} FAILURES: ${failures.join(" | ")}`);
console.log(`evidence: ${EVIDENCE}`);
process.exitCode = failures.length === 0 ? 0 : 1;
