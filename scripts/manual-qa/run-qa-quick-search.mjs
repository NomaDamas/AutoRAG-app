import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { homeEnv, isMac, sh, sleep } from "./platform.mjs";

/**
 * Live QA — the quick-search launcher (DESIGN.md §2a), against the real built app.
 *
 *   1. A real local index: Settings' own refresh parses and embeds the fixture documents with MinSync and the
 *      on-device Qwen3 model (no stub), so content matches come from the real hybrid search.
 *   2. The real system-wide shortcut: with another app in front (TextEdit on macOS), an OS-level ⌥Space / Alt+Space
 *      (System Events / WScript SendKeys) summons the launcher over it.
 *   3. Keyboard only: type, see name matches and content matches with a snippet, move with the arrows, extend with
 *      Shift, copy the files (⌘C) and the paths (⇧⌘C) — both read back from the real OS clipboard — preview the
 *      focused row with Space (the real Quick Look panel, following ↓, surviving a click into it, closed by Escape
 *      before the launcher), open the action panel (⌘K), Escape twice to close; the app that was in front gets the
 *      foreground back.
 *   4. Mouse: click a row, double-click opens it (recorded in Recents), the Ask row hands the question to a new AI
 *      Search tab in the Finder.
 *   5. Settings → General: the section is there, the switch releases the global shortcut.
 *
 * Run `bun run build` first; needs `minsync` on PATH and the MinSync model cache (`minsync serve` once).
 */

const EVIDENCE = fileURLToPath(new URL(`../../.omo/evidence/quick-search/`, import.meta.url));
const OUT = process.env.QA_OUT ?? EVIDENCE;
mkdirSync(OUT, { recursive: true });

const started = Date.now();
const log = (message) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
// A stuck step must fail the lane with where it stopped, never hold a VM slot for the runner's whole deadline.
const watchdog = setTimeout(() => {
	log("WATCHDOG: the lane did not finish in 6 minutes");
	process.exit(3);
}, 360_000);
watchdog.unref();
const failures = [];
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` :: ${detail}`}`);
	if (!ok) failures.push(label);
};
const waitFor = async (predicate, timeoutMs = 30_000, stepMs = 150) => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await predicate();
		if (value) return value;
		if (Date.now() > deadline) return value;
		await sleep(stepMs);
	}
};

const minsync = sh(process.platform === "win32" ? "where minsync" : "command -v minsync").split(/\r?\n/u)[0]?.trim() ?? "";
const models = join(process.env.HOME ?? "", ".cache", "minsync", "models");
if (minsync === "") {
	console.log("SKIP: no minsync on PATH; the lane needs the real index");
	process.exit(0);
}

const WORK = mkdtempSync(join(tmpdir(), "qa-quick-search-"));
const home = join(WORK, "home");
const docs = join(home, "Documents", "qs-fixtures");
const configPath = join(WORK, "config.json");
mkdirSync(join(home, ".cache", "minsync"), { recursive: true });
mkdirSync(docs, { recursive: true });
try {
	execFileSync("ln", ["-s", models, join(home, ".cache", "minsync", "models")]);
} catch {
	// Windows: the model cache resolves through FASTEMBED_CACHE_DIR below.
}
const FILES = {
	refund: join(docs, "refund-policy.md"),
	travel: join(docs, "bali-trip.md"),
	budget: join(docs, "q3-budget.md"),
	report: join(docs, "report-weekly.md"),
};
writeFileSync(FILES.refund, "# 환불 정책\n\n구매 후 7일 이내에는 사유와 관계없이 전액 환불이 가능합니다. 사용한 제품은 환불되지 않습니다.\n");
writeFileSync(FILES.travel, "# Travel notes\n\nWe flew to Bali and stayed in a homestay near Ubud for two weeks. The rice terraces were stunning.\n");
writeFileSync(FILES.budget, "# Q3 budget\n\nMarketing spend rose 12 percent while cloud hosting costs fell after the migration.\n");
writeFileSync(FILES.report, "# Weekly report\n\nShipped the launcher. Next week: polish keyboard navigation.\n");
writeFileSync(
	configPath,
	`${JSON.stringify({ searchPaths: [docs], workspacePath: join(WORK, "workspace"), memoryPath: join(WORK, "memory.json"), minSync: { enabled: true, autoInstall: false, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } }, jikji: false, webSearch: false, datasources: {} }, null, 2)}\n`,
);

log("launching the built app");
const app = await launchFinder({
	userDataDir: join(WORK, "user-data"),
	env: {
		...homeEnv(home),
		AUTORAG_CONFIG: configPath,
		AUTORAG_HOME: WORK,
		AUTORAG_SKIP_DUPEY_CHECK: "1",
		ELECTRON_RENDERER_URL: "",
		FASTEMBED_CACHE_DIR: models,
		PATH: `${join(minsync, "..")}${delimiter}${process.env.PATH ?? ""}`,
	},
});

const frontmost = () => (isMac ? sh(`osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`).trim() : "");
const pasteboardFiles = () =>
	isMac
		? JSON.parse(
				execFileSync("osascript", ["-l", "JavaScript", "-e", `ObjC.import("AppKit"); const o=$.NSPasteboard.generalPasteboard.readObjectsForClassesOptions($([$.NSURL]), $({NSPasteboardURLReadingFileURLsOnlyKey:true})); const r=[]; if(o){for(let i=0;i<o.count;i++) r.push(ObjC.unwrap(o.objectAtIndex(i).path));} JSON.stringify(r)`]).toString(),
			).map((path) => path.normalize("NFC"))
		: [];
const pasteboardText = () => (isMac ? execFileSync("pbpaste").toString() : "");
const withTimeout = (promise, ms, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} took over ${ms} ms`)), ms))]);
const launcherPage = async () => {
	for (const page of app.windows()) if (page.url().endsWith("/quick-search.html")) return page;
	return null;
};
const launcherVisible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.getTitle() === "Quick Search" && window.isVisible()));

try {
	const finder = await finderWindow(app, 30_000);
	await finder.waitForSelector(".sidebar__item", { timeout: 30_000 });
	log("Finder is up; building the index");

	// ── 1. The real index ──
	const refreshed = await withTimeout(finder.evaluate(() => window.autorag.settings.configRefresh()), 180_000, "the index refresh");
	log("index refresh returned");
	check("Settings' refresh built the real local index", refreshed.ok === true, JSON.stringify({ ok: refreshed.ok, error: refreshed.error, methods: refreshed.methods }));
	const direct = await finder.evaluate(() => window.autorag.fs.contentSearch("homestay vacation"));
	check("the fs worker's content search answers from the index", direct.state === "ok" && direct.hits[0]?.entry.path.endsWith("bali-trip.md"), JSON.stringify(direct.hits.map((hit) => hit.entry.name)));

	log("content search answered");
	// ── 2. The real global shortcut over another app ──
	const registered = await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered("Alt+Space"));
	check("⌥Space is registered system-wide at launch", registered === true);
	const page = await waitFor(launcherPage, 10_000);
	check("the launcher window is pre-created hidden", page !== null && !(await launcherVisible()));
	let outsider = "";
	if (isMac) {
		sh(`open -a TextEdit`);
		await waitFor(() => frontmost() === "TextEdit", 10_000);
		outsider = frontmost();
		// Key code 49 is Space; the OS routes the chord to the app that registered it.
		sh(`osascript -e 'tell application "System Events" to key code 49 using {option down}'`);
	} else {
		sh(`powershell -NoProfile -Command "(New-Object -ComObject WScript.Shell).SendKeys('% ')"`);
	}
	check("the OS-level press summoned the launcher", Boolean(await waitFor(launcherVisible, 8000)), `frontmost before: ${outsider}`);
	await page.bringToFront();
	await page.locator(".qs__input").waitFor();
	check("the query field has the keyboard focus", await page.evaluate(() => document.activeElement?.classList.contains("qs__input") === true));
	await page.screenshot({ path: join(OUT, "01-summoned-recents.png") });

	log("launcher summoned");
	// ── 3. Keyboard ──
	await page.keyboard.type("report");
	await waitFor(async () => (await page.locator(".qs__row[role=option] .qs__name").allInnerTexts()).includes("report-weekly.md"), 10_000);
	const nameRows = await page.locator(".qs__row[role=option] .qs__name").allInnerTexts();
	check("a name match is listed first", nameRows[0] === "report-weekly.md", JSON.stringify(nameRows));
	check("the last row asks Dazzi the query", /report/.test(nameRows.at(-1) ?? "") && /Dazzi/.test(nameRows.at(-1) ?? ""), nameRows.at(-1));

	await page.keyboard.press("Meta+A");
	await page.keyboard.type("환불 기간");
	await waitFor(async () => (await page.locator(".qs__snippet").count()) > 0, 20_000);
	const contentNames = await page.locator(".qs__row[role=option] .qs__name").allInnerTexts();
	const snippet = await page.locator(".qs__snippet").first().innerText();
	check("content search finds the Korean refund policy by meaning", contentNames[0] === "refund-policy.md", JSON.stringify(contentNames));
	check("the content row shows the matched passage", /환불/.test(snippet), snippet);
	await page.screenshot({ path: join(OUT, "02-content-match.png") });

	await page.keyboard.press("Meta+A");
	await page.keyboard.type("md");
	await waitFor(async () => (await page.locator(".qs__row[role=option]").count()) >= 4, 10_000);
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Shift+ArrowDown");
	const selected = await page.locator(".qs__row[aria-selected=true]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-path")));
	check("Shift+↓ extends the selection to two rows", selected.length === 2, JSON.stringify(selected));
	await page.keyboard.press("Meta+C");
	const copied = await waitFor(() => {
		const files = pasteboardFiles();
		return files.length === 2 ? files : null;
	}, 5000);
	check("⌘C put both files on the OS clipboard", isMac ? JSON.stringify(copied) === JSON.stringify(selected) : true, JSON.stringify(copied));
	await page.keyboard.press("Meta+Shift+C");
	const text = await waitFor(() => {
		const value = pasteboardText();
		return value.includes(selected[0] ?? "\u0000") ? value : null;
	}, 5000);
	check("⇧⌘C put both paths on the clipboard as text", isMac ? (text ?? "").split("\n").length === 2 : true, JSON.stringify(text));
	check("copying keeps the launcher open", await launcherVisible());
	await page.screenshot({ path: join(OUT, "03-range-copied.png") });

	// Space previews the focused row in the launcher's own Quick Look panel; the arrows move it along.
	const shownPreview = () =>
		app.evaluate(({ BrowserWindow }) => {
			const shown = BrowserWindow.getAllWindows().filter((window) => window.webContents.getURL().includes("quick-look.html") && window.isVisible());
			return shown.length === 1 ? { title: shown[0].getTitle(), focused: shown[0].isFocused() } : shown.length === 0 ? null : { title: `${shown.length} panels`, focused: false };
		});
	const focusedName = async () => (await page.locator(".qs__row[data-focus=true] .qs__name").innerText()).trim();
	const firstFocus = await focusedName();
	await page.keyboard.press("Space");
	const opened = await waitFor(async () => {
		const shown = await shownPreview();
		return shown?.title === firstFocus ? shown : null;
	}, 10_000);
	check("Space previews the focused row in Quick Look", opened !== null, `${JSON.stringify(await shownPreview())} focused row ${firstFocus}`);
	check("the query keeps its text (Space did not type)", (await page.locator(".qs__input").inputValue()) === "md");
	check("the launcher stays open under the preview", await launcherVisible());
	await sleep(700);
	await page.screenshot({ path: join(OUT, "04-preview-open.png") });
	if (isMac) execFileSync("screencapture", ["-x", join(OUT, "04-preview-screen.png")]);
	await page.keyboard.press("ArrowDown");
	const nextFocus = await focusedName();
	const followed = await waitFor(async () => (await shownPreview())?.title === nextFocus, 10_000);
	check("↓ moves the preview to the next row", Boolean(followed) && nextFocus !== firstFocus, `${firstFocus} -> ${nextFocus}: ${JSON.stringify(await shownPreview())}`);
	const previewPage = await waitFor(async () => {
		for (const candidate of app.windows()) {
			if (!candidate.url().includes("quick-look.html")) continue;
			if ((await candidate.locator(".qlw__name").innerText().catch(() => "")).trim() === nextFocus) return candidate;
		}
		return null;
	}, 5000);
	check("the preview draws the file", previewPage !== null && (await previewPage.locator(".ql__stage").count()) > 0);
	if (previewPage !== null) {
		await previewPage.locator(".ql__stage").click({ position: { x: 40, y: 40 } });
		await sleep(500);
		check("a click into the preview does not dismiss the launcher", (await launcherVisible()) && (await shownPreview()) !== null);
		// The panel reads keys in `before-input-event`, which only OS-level input reaches (Playwright's CDP keys skip it).
		await app.evaluate(({ BrowserWindow }) => {
			const panelWindow = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes("quick-look.html") && window.isVisible());
			panelWindow?.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
			panelWindow?.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
		});
		check("Escape in the preview closes only the preview", Boolean(await waitFor(async () => (await shownPreview()) === null, 5000)) && (await launcherVisible()), JSON.stringify(await shownPreview()));
		check("closing the preview gives the keyboard back to the launcher", Boolean(await waitFor(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.getTitle() === "Quick Search"), 3000)));
	}
	await page.keyboard.press("Space");
	await waitFor(async () => (await shownPreview()) !== null, 10_000);
	await page.keyboard.press("Escape");
	check("Escape in the launcher closes the preview before anything else", Boolean(await waitFor(async () => (await shownPreview()) === null, 5000)) && (await page.locator(".qs__input").inputValue()) === "md" && (await launcherVisible()), JSON.stringify({ preview: await shownPreview(), query: await page.locator(".qs__input").inputValue() }));

	await page.keyboard.press("Meta+K");
	await page.locator(".qs__panel").waitFor();
	const panelItems = await page.locator(".qs__panel .qs__name").allInnerTexts();
	check("⌘K lists the actions for the row", panelItems.length === 7, JSON.stringify(panelItems));
	await page.screenshot({ path: join(OUT, "05-action-panel.png") });
	await page.keyboard.press("Escape");
	check("Escape closes the panel first", (await page.locator(".qs__panel").count()) === 0 && (await launcherVisible()));
	await page.keyboard.press("Escape");
	check("Escape clears the query next", (await page.locator(".qs__input").inputValue()) === "");
	await page.keyboard.press("Escape");
	check("a third Escape hides the launcher", Boolean(await waitFor(async () => !(await launcherVisible()), 3000)));
	if (isMac) check("the app that was in front gets the foreground back", Boolean(await waitFor(() => frontmost() === outsider, 4000)), frontmost());
	if (isMac) {
		// Focus leaving the launcher and its preview for another app is a dismissal: both go away. The launcher is a
		// non-activating panel, so TextEdit stays the active app under it; a different app has to take the focus.
		sh(`osascript -e 'tell application "System Events" to key code 49 using {option down}'`);
		await waitFor(launcherVisible, 8000);
		await page.locator(".qs__input").fill("md");
		await waitFor(async () => (await page.locator(".qs__row[role=option]").count()) >= 2, 10_000);
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Space");
		await waitFor(async () => (await shownPreview()) !== null, 10_000);
		sh(`open -a Finder`);
		const gone = await waitFor(async () => !(await launcherVisible()) && (await shownPreview()) === null, 5000);
		check("switching to another app dismisses the launcher and its preview", Boolean(gone), JSON.stringify({ launcher: await launcherVisible(), preview: await shownPreview(), front: frontmost() }));
	}

	log("keyboard steps done");
	// ── 4. Mouse ──
	await app.evaluate(({ BrowserWindow }) => {
		const launcher = BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Quick Search");
		launcher?.show();
		launcher?.focus();
	});
	await page.locator(".qs__input").fill("weekly");
	const row = page.locator('.qs__row[role=option]', { hasText: "report-weekly.md" });
	await row.waitFor();
	await row.click();
	check("a click selects the row", (await row.getAttribute("aria-selected")) === "true");
	await page.locator(".qs__hint", { hasText: /Copy/ }).click();
	check("the footer's Copy button copies the clicked row", Boolean(await waitFor(() => (isMac ? pasteboardFiles()[0] === FILES.report : true), 5000)));
	const ask = page.locator('.qs__row[role=option]', { hasText: "Dazzi" });
	await ask.dblclick();
	const tab = await waitFor(async () => (await finder.locator('section[aria-label="AI Search"]:not([aria-hidden="true"])').count()) > 0, 10_000);
	check("the Ask row opens AI Search in the Finder with the question", Boolean(tab));
	check("asking hands off: the launcher hides", !(await launcherVisible()));
	await finder.screenshot({ path: join(OUT, "05-ask-handoff.png") });

	log("mouse steps done");
	// ── 5. Settings ──
	await finder.locator(".sidebar__item--settings").click();
	await finder.waitForSelector(".settings-panel");
	const section = finder.locator(".settings-section", { hasText: "Quick Search" }).first();
	await section.waitFor();
	await section.scrollIntoViewIfNeeded();
	await finder.screenshot({ path: join(OUT, "06-settings.png") });
	await section.locator('[data-sidebar-switch="quick-search"]').click();
	check("turning the switch off releases ⌥Space", Boolean(await waitFor(async () => (await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered("Alt+Space"))) === false, 5000)));
	await section.locator('[data-sidebar-switch="quick-search"]').click();
	check("turning it back on registers it again", Boolean(await waitFor(() => app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered("Alt+Space")), 5000)));
} catch (error) {
	check("the lane ran to the end", false, error instanceof Error ? error.message : String(error));
} finally {
	await withTimeout(app.close(), 15_000, "closing the app").catch(() => undefined);
	if (isMac) sh(`osascript -e 'tell application "TextEdit" to quit saving no'`);
	rmSync(WORK, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "ALL PASS" : `FAILED: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
